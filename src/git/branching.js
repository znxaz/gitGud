import git from 'isomorphic-git';
import { pfs, join, dirname, mkdirp, readText, writeText, exists } from '../vfs.js';
import {
  Exit, die, hint, base, openRepo, short, revParse, headOid, currentBranch, branchOid, listBranches,
  listRemoteBranches, readCommit, treeFiles, indexFiles, readBlobBytes, hashText, computeStatus,
  unmergedPaths, mergeHead, clearMergeState, isAncestor, mergeBase, identity, trackingLines,
  repoPath, showPath, getConfig, setLocalConfig, conflictStageOid,
} from './core.js';
import { changes, blobReader, diffstat } from './textdiff.js';

const validBranchName = n => !!n && !/(^[-.])|(\.\.)|[\s~^:?*[\\]|(\.lock$)|(\/$)|(^\/)|@\{|\.$/.test(n) && n !== 'HEAD' && n !== '@';

// Remember the previous branch for "git switch -".
const previousBranch = new Map();

// ---------- working tree helpers ----------

async function workOid(repo, path) {
  try { return await hashText(await pfs.readFile(join(repo.dir, path))); } catch { return null; }
}

/**
 * Paths whose local changes would be lost by moving from `fromOid` to `toOid`.
 * Mirrors Git's checks: a path that differs between the two commits must be
 * clean in both the staging area and the working tree.
 */
async function blockedPaths(repo, fromOid, toOid) {
  const from = await treeFiles(repo, fromOid);
  const to = await treeFiles(repo, toOid);
  const index = await indexFiles(repo);
  const dirty = [], untracked = [];
  for (const p of new Set([...from.keys(), ...to.keys()])) {
    const a = from.get(p), b = to.get(p);
    if (a && b && a.oid === b.oid) continue;
    const i = index.get(p);
    const w = await workOid(repo, p);
    if (!a) {
      // New in target. An untracked file in the way is a problem.
      if (i && i.oid !== b?.oid) dirty.push(p);
      else if (!i && w && w !== b?.oid) untracked.push(p);
      continue;
    }
    const indexClean = i && i.oid === a.oid;
    const workClean = w === a.oid;
    const alreadyTarget = b && i && i.oid === b.oid && w === b.oid;
    if (!alreadyTarget && (!indexClean || !workClean)) dirty.push(p);
  }
  return { dirty: dirty.sort(), untracked: untracked.sort() };
}

function reportBlocked(ctx, blocked, verb) {
  const action = verb === 'checkout' ? 'switch branches' : 'merge';
  if (blocked.dirty.length) {
    ctx.err.write(`error: Your local changes to the following files would be overwritten by ${verb}:\n`);
    for (const p of blocked.dirty) ctx.err.write(`\t${p}\n`);
    ctx.err.write(`Please commit your changes or stash them before you ${action}.\n`);
  }
  if (blocked.untracked.length) {
    ctx.err.write(`error: The following untracked working tree files would be overwritten by ${verb}:\n`);
    for (const p of blocked.untracked) ctx.err.write(`\t${p}\n`);
    ctx.err.write(`Please move or remove them before you ${action}.\n`);
  }
  ctx.err.write('Aborting\n');
  throw new Exit(1);
}

// Update the working tree and staging area from one commit to another,
// touching only paths that differ between them (local edits elsewhere stay).
async function applyTreeChange(repo, fromOid, toOid) {
  const from = await treeFiles(repo, fromOid);
  const to = await treeFiles(repo, toOid);
  for (const p of new Set([...from.keys(), ...to.keys()])) {
    const a = from.get(p), b = to.get(p);
    if (a && b && a.oid === b.oid) continue;
    const abs = join(repo.dir, p);
    if (b) {
      await mkdirp(dirname(abs));
      await pfs.writeFile(abs, await readBlobBytes(repo, b.oid));
      await git.add({ ...base(repo), filepath: p });
    } else {
      try { await pfs.unlink(abs); } catch { /* already gone */ }
      await git.remove({ ...base(repo), filepath: p });
      await removeEmptyDirs(repo, dirname(abs));
    }
  }
}

async function removeEmptyDirs(repo, dir) {
  while (dir !== repo.dir && dir.startsWith(repo.dir)) {
    try {
      if ((await pfs.readdir(dir)).length) return;
      await pfs.rmdir(dir);
    } catch { return; }
    dir = dirname(dir);
  }
}

async function localChangeLines(ctx, repo) {
  const st = await computeStatus(repo);
  const rows = new Map();
  for (const e of st.staged) rows.set(e.path, e.type === 'new file' ? 'A' : e.type === 'deleted' ? 'D' : 'M');
  for (const e of st.unstaged) rows.set(e.path, e.type === 'deleted' ? 'D' : 'M');
  return [...rows.entries()].sort().map(([p, k]) => `${k}\t${showPath(ctx, repo, p)}\n`).join('');
}

// ---------- git branch ----------

export async function branch(ctx, args) {
  const repo = await openRepo(ctx);
  const c = ctx.out.c;
  const flags = new Set();
  const names = [];
  for (const a of args) {
    if (/^-[a-zA-Z]+$/.test(a) && !a.startsWith('--')) for (const ch of a.slice(1)) flags.add('-' + ch);
    else if (a.startsWith('--')) flags.add(a);
    else names.push(a);
  }
  const current = await currentBranch(repo);
  const head = await headOid(repo);

  if (flags.has('-d') || flags.has('-D') || flags.has('--delete')) {
    if (!names.length) die(ctx, 'branch name required');
    let code = 0;
    for (const n of names) {
      const oid = await branchOid(repo, n);
      if (!oid) { ctx.err.write(`error: branch '${n}' not found\n`); code = 1; continue; }
      if (n === current) { ctx.err.write(`error: cannot delete branch '${n}' used by worktree at '${repo.dir}'\n`); code = 1; continue; }
      const force = flags.has('-D') || flags.has('--force') || flags.has('-f');
      if (!force) {
        const up = await getConfig(repo, `branch.${n}.merge`);
        let mergedInto = head;
        if (up) {
          const remote = await getConfig(repo, `branch.${n}.remote`);
          const r = await revParse(repo, `refs/remotes/${remote}/${up.replace('refs/heads/', '')}`);
          if (r) mergedInto = r;
        }
        if (!mergedInto || !(await isAncestor(repo, oid, mergedInto))) {
          ctx.err.write(`error: the branch '${n}' is not fully merged\n`);
          hint(ctx, [`If you are sure you want to delete it, run 'git branch -D ${n}'`,
            'Disable this message with "git config advice.forceDeleteBranch false"']);
          code = 1;
          continue;
        }
      }
      await git.deleteBranch({ ...base(repo), ref: n });
      ctx.out.write(`Deleted branch ${n} (was ${short(oid)}).\n`);
    }
    if (code) throw new Exit(code);
    return 0;
  }

  if (flags.has('-m') || flags.has('-M') || flags.has('--move')) {
    let from = current, to;
    if (names.length === 1) to = names[0];
    else if (names.length === 2) [from, to] = names;
    else die(ctx, 'branch name required');
    if (!validBranchName(to)) die(ctx, `'${to}' is not a valid branch name`);
    if (await branchOid(repo, to) && !flags.has('-M')) die(ctx, `a branch named '${to}' already exists`);
    const oid = await branchOid(repo, from);
    if (!oid) {
      if (from === current) {
        // Renaming a branch with no commits only moves HEAD.
        await git.writeRef({ ...base(repo), ref: 'HEAD', value: `refs/heads/${to}`, symbolic: true, force: true });
        return 0;
      }
      die(ctx, `no branch named '${from}'`);
    }
    await git.renameBranch({ ...base(repo), oldref: from, ref: to, checkout: from === current });
    return 0;
  }

  if (flags.has('-u') || names.some(n => n.startsWith('--set-upstream-to'))) {
    die(ctx, 'gitGud: use git push -u origin <branch> to set the upstream branch in this lab.');
  }

  if (names.length && !flags.has('-a') && !flags.has('-r') && !flags.has('-v')) {
    const [name, start] = names;
    if (!validBranchName(name)) die(ctx, `'${name}' is not a valid branch name`);
    if (await branchOid(repo, name)) die(ctx, `a branch named '${name}' already exists`);
    const startOid = start ? await revParse(repo, start) : head;
    if (!startOid) die(ctx, `not a valid object name: '${start || current}'`);
    await git.writeRef({ ...base(repo), ref: `refs/heads/${name}`, value: startOid });
    return 0;
  }

  // List branches.
  const lines = [];
  const verbose = flags.has('-v') || flags.has('-vv');
  const width = Math.max(0, ...(await listBranches(repo)).map(b => b.length));
  const describe = async oid => {
    const cm = await readCommit(repo, oid);
    return `${short(oid)} ${cm.message.split('\n')[0]}`;
  };
  if (!flags.has('-r')) {
    if (!current && head) lines.push('* ' + c.green(`(HEAD detached at ${short(head)})`));
    for (const b of await listBranches(repo)) {
      const oid = await branchOid(repo, b);
      const extra = verbose ? ' '.repeat(width - b.length + 1) + await describe(oid) : '';
      if (b === current) lines.push('* ' + c.green(b) + extra);
      else lines.push('  ' + b + extra);
    }
  }
  if (flags.has('-a') || flags.has('-r')) {
    for (const r of await git.listRemotes(base(repo)).catch(() => [])) {
      try {
        const target = (await readText(`${repo.gitdir}/refs/remotes/${r.remote}/HEAD`)).trim();
        if (target.startsWith('ref: ')) {
          const pre = flags.has('-a') ? 'remotes/' : '';
          lines.push('  ' + c.red(`${pre}${r.remote}/HEAD`) + ' -> ' + target.slice(5).replace('refs/remotes/', ''));
        }
      } catch { /* no remote HEAD */ }
      for (const b of await listRemoteBranches(repo, r.remote)) {
        lines.push('  ' + c.red((flags.has('-a') ? 'remotes/' : '') + `${r.remote}/${b}`));
      }
    }
  }
  if (lines.length) ctx.out.write(lines.join('\n') + '\n');
  ctx.observe('branch', { branch: current });
  return 0;
}

// ---------- git switch / git checkout ----------

async function switchTo(ctx, repo, name, { create = false, start = null, force = false, verb = 'switch' } = {}) {
  const current = await currentBranch(repo);
  const head = await headOid(repo);

  if (create) {
    if (!validBranchName(name)) die(ctx, `'${name}' is not a valid branch name`);
    if (await branchOid(repo, name)) die(ctx, `a branch named '${name}' already exists`);
    const startOid = start ? await revParse(repo, start) : head;
    if (start && !startOid) die(ctx, `invalid reference: ${start}`);
    if (!startOid) {
      // No commits yet: only HEAD moves.
      await git.writeRef({ ...base(repo), ref: 'HEAD', value: `refs/heads/${name}`, symbolic: true, force: true });
      ctx.err.write(`Switched to a new branch '${name}'\n`);
      return;
    }
    if (startOid !== head) {
      const blocked = await blockedPaths(repo, head, startOid);
      if (!force && (blocked.dirty.length || blocked.untracked.length)) reportBlocked(ctx, blocked, 'checkout');
      await applyTreeChange(repo, head, startOid);
    }
    await git.writeRef({ ...base(repo), ref: `refs/heads/${name}`, value: startOid });
    await git.writeRef({ ...base(repo), ref: 'HEAD', value: `refs/heads/${name}`, symbolic: true, force: true });
    if (current) previousBranch.set(repo.dir, current);
    ctx.out.write(await localChangeLines(ctx, repo));
    ctx.err.write(`Switched to a new branch '${name}'\n`);
    return;
  }

  if (name === '-') {
    const prev = previousBranch.get(repo.dir);
    if (!prev) die(ctx, 'invalid reference: @{-1}');
    name = prev;
  }

  let target = await branchOid(repo, name);
  let tracking = null;
  if (!target) {
    // Like Git, create a local branch from a matching remote branch.
    for (const r of await git.listRemotes(base(repo)).catch(() => [])) {
      const oid = await revParse(repo, `refs/remotes/${r.remote}/${name}`);
      if (oid) { target = oid; tracking = r.remote; break; }
    }
    if (!target) {
      if (verb === 'switch') {
        const oid = await revParse(repo, name);
        if (oid) {
          die(ctx, `a branch is expected, got commit '${name}'\nhint: If you want to detach HEAD at the commit, try again with the --detach option.`);
        }
        die(ctx, `invalid reference: ${name}`);
      }
      return 'not-a-branch';
    }
  }
  if (name === current && !tracking) {
    ctx.err.write(`Already on '${name}'\n`);
    const t = await trackingLines(repo, name);
    if (t) ctx.out.write(t.join('\n') + '\n');
    return;
  }
  if (head && target !== head) {
    const blocked = await blockedPaths(repo, head, target);
    if (!force && (blocked.dirty.length || blocked.untracked.length)) reportBlocked(ctx, blocked, 'checkout');
    await applyTreeChange(repo, head, target);
  } else if (!head) {
    await applyTreeChange(repo, null, target);
  }
  if (tracking) {
    await git.writeRef({ ...base(repo), ref: `refs/heads/${name}`, value: target });
    await setLocalConfig(repo, `branch.${name}.remote`, tracking);
    await setLocalConfig(repo, `branch.${name}.merge`, `refs/heads/${name}`);
  }
  await git.writeRef({ ...base(repo), ref: 'HEAD', value: `refs/heads/${name}`, symbolic: true, force: true });
  if (current) previousBranch.set(repo.dir, current);
  ctx.out.write(await localChangeLines(ctx, repo));
  if (tracking) {
    ctx.out.write(`branch '${name}' set up to track '${tracking}/${name}'.\n`);
    ctx.err.write(`Switched to a new branch '${name}'\n`);
  } else {
    ctx.err.write(`Switched to branch '${name}'\n`);
  }
  const t = await trackingLines(repo, name);
  if (t) ctx.out.write(t.join('\n') + '\n');
}

export async function switchCmd(ctx, args) {
  const repo = await openRepo(ctx);
  let create = false, force = false, detach = false;
  const names = [];
  for (const a of args) {
    if (a === '-c' || a === '--create' || a === '-C') create = true;
    else if (a === '-f' || a === '--force' || a === '--discard-changes') force = true;
    else if (a === '-d' || a === '--detach') detach = true;
    else if (a === '-' ) names.push(a);
    else if (a.startsWith('-')) { ctx.err.write(`error: unknown option \`${a.replace(/^-+/, '')}'\n`); throw new Exit(129); }
    else names.push(a);
  }
  if (!names.length) die(ctx, 'missing branch or commit argument');
  if (detach) return detachAt(ctx, repo, names[0]);
  await switchTo(ctx, repo, names[0], { create, start: names[1], force });
  return 0;
}

async function detachAt(ctx, repo, spec) {
  const head = await headOid(repo);
  const oid = await revParse(repo, spec);
  if (!oid) die(ctx, `invalid reference: ${spec}`);
  if (head && oid !== head) {
    const blocked = await blockedPaths(repo, head, oid);
    if (blocked.dirty.length || blocked.untracked.length) reportBlocked(ctx, blocked, 'checkout');
    await applyTreeChange(repo, head, oid);
  }
  const current = await currentBranch(repo);
  if (current) previousBranch.set(repo.dir, current);
  await git.writeRef({ ...base(repo), ref: 'HEAD', value: oid, force: true });
  const cm = await readCommit(repo, oid);
  ctx.err.write(`Note: switching to '${spec}'.

You are in 'detached HEAD' state. You can look around, make experimental
changes and commit them, and you can discard any commits you make in this
state without impacting any branches by switching back to a branch.

If you want to create a new branch to retain commits you create, you may
do so (now or later) by using -c with the switch command. Example:

  git switch -c <new-branch-name>

Or undo this operation with:

  git switch -

Turn off this advice by setting config variable advice.detachedHead to false

HEAD is now at ${short(oid)} ${cm.message.split('\n')[0]}
`);
  return 0;
}

export async function checkout(ctx, args) {
  const repo = await openRepo(ctx);
  const dash = args.indexOf('--');
  if (dash >= 0) return restoreFiles(ctx, repo, args.slice(dash + 1), { source: args.slice(0, dash)[0] || null, staged: !!args.slice(0, dash)[0], worktree: true });
  let create = false, force = false;
  const names = [];
  for (const a of args) {
    if (a === '-b' || a === '-B') create = true;
    else if (a === '-f' || a === '--force') force = true;
    else if (a.startsWith('-') && a !== '-') { ctx.err.write(`error: unknown switch \`${a.replace(/^-+/, '')}'\n`); throw new Exit(129); }
    else names.push(a);
  }
  if (!names.length) return 0;
  if (create) { await switchTo(ctx, repo, names[0], { create, start: names[1], force, verb: 'checkout' }); return 0; }
  const r = await switchTo(ctx, repo, names[0], { force, verb: 'checkout' });
  if (r !== 'not-a-branch') return 0;
  // Not a branch: a commit (detach) or a file (restore).
  if (await revParse(repo, names[0])) {
    if (names.length > 1) return restoreFiles(ctx, repo, names.slice(1), { source: names[0], staged: true, worktree: true });
    return detachAt(ctx, repo, names[0]);
  }
  return restoreFiles(ctx, repo, names, { worktree: true, checkoutWording: true });
}

// ---------- git restore ----------

export async function restore(ctx, args) {
  const repo = await openRepo(ctx);
  let staged = false, worktree = false, source = null;
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--staged' || a === '-S') staged = true;
    else if (a === '--worktree' || a === '-W') worktree = true;
    else if (a === '-SW' || a === '-WS') { staged = true; worktree = true; }
    else if (a.startsWith('--source=')) source = a.slice(9);
    else if (a === '--source' || a === '-s') source = args[++i];
    else if (a.startsWith('-s') && a.length > 2) source = a.slice(2);
    else if (a === '--') continue;
    else if (a.startsWith('-')) { ctx.err.write(`error: unknown option \`${a.replace(/^-+/, '')}'\n`); throw new Exit(129); }
    else paths.push(a);
  }
  if (!staged && !worktree) worktree = true;
  if (!paths.length) die(ctx, 'you must specify path(s) to restore');
  return restoreFiles(ctx, repo, paths, { staged, worktree, source });
}

async function restoreFiles(ctx, repo, paths, { staged = false, worktree = true, source = null, checkoutWording = false }) {
  let srcOid = null;
  if (source) {
    srcOid = await revParse(repo, source);
    if (!srcOid) die(ctx, `could not resolve ${source}`);
  } else if (staged) {
    srcOid = await headOid(repo);
  }
  const srcFiles = srcOid ? await treeFiles(repo, srcOid) : null;
  const index = await indexFiles(repo);
  const unmerged = new Set(await unmergedPaths(repo));
  // Files Git knows about for this restore.
  const known = new Set([...index.keys(), ...unmerged, ...(srcFiles ? srcFiles.keys() : [])]);
  const work = await collectWorkFiles(repo);
  for (const w of work) known.add(w);

  let code = 0;
  for (const spec of paths) {
    const rel = repoPath(ctx, repo, spec);
    const matches = rel === null ? [] : [...known].filter(p => rel === '.' || p === rel || p.startsWith(rel + '/'))
      .filter(p => index.has(p) || unmerged.has(p) || (srcFiles && srcFiles.has(p)));
    if (!matches.length) {
      ctx.err.write(checkoutWording
        ? `error: pathspec '${spec}' did not match any file(s) known to git\n`
        : `error: pathspec '${spec}' did not match any file(s) known to git\n`);
      code = 1;
      continue;
    }
    for (const p of matches.sort()) {
      if (unmerged.has(p) && !srcFiles && worktree && !staged) {
        // Restoring a conflicted path from the staging area: Git refuses.
        ctx.err.write(`error: path '${p}' is unmerged\n`);
        code = 1;
        continue;
      }
      const abs = join(repo.dir, p);
      if (staged) {
        if (srcFiles && srcFiles.has(p)) await git.resetIndex({ ...base(repo), filepath: p, ref: srcOid });
        else await git.remove({ ...base(repo), filepath: p });
      }
      if (worktree) {
        const entry = srcFiles ? srcFiles.get(p) : index.get(p);
        if (entry) {
          await mkdirp(dirname(abs));
          await pfs.writeFile(abs, await readBlobBytes(repo, entry.oid));
        } else if (srcFiles) {
          try { await pfs.unlink(abs); } catch { /* not there */ }
        }
      }
    }
  }
  if (code) throw new Exit(code);
  return 0;
}

async function collectWorkFiles(repo) {
  const out = [];
  const walk = async (dir, rel) => {
    let names = [];
    try { names = await pfs.readdir(dir); } catch { return; }
    for (const n of names) {
      if (n === '.git') continue;
      const abs = dir + '/' + n;
      const r = rel ? rel + '/' + n : n;
      const s = await pfs.stat(abs);
      if (s.isDirectory()) await walk(abs, r);
      else out.push(r);
    }
  };
  await walk(repo.dir, '');
  return out;
}

async function restoreKept(repo, keep) {
  for (const [p, bytes] of keep) {
    if (bytes) await pfs.writeFile(join(repo.dir, p), bytes);
    else { try { await pfs.unlink(join(repo.dir, p)); } catch { /* gone */ } }
  }
}

// ---------- git merge ----------

function mergeMessage(theirsName, currentName, url) {
  const into = ['main', 'master'].includes(currentName) || !currentName ? '' : ` into ${currentName}`;
  if (url) return `Merge branch '${theirsName}' of ${url}${into}`;
  if (theirsName.startsWith('refs/remotes/')) return `Merge remote-tracking branch '${theirsName.slice(13)}'${into}`;
  if (/^[0-9a-f]{40}$/.test(theirsName)) return `Merge commit '${theirsName}'${into}`;
  return `Merge branch '${theirsName}'${into}`;
}

export async function merge(ctx, args) {
  const repo = await openRepo(ctx);
  let noFf = false, ffOnly = false, message = null;
  const names = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--abort') return mergeAbort(ctx, repo);
    if (a === '--continue') return (await import('./basic.js')).commit(ctx, []);
    if (a === '--no-ff') noFf = true;
    else if (a === '--ff-only') ffOnly = true;
    else if (a === '--ff' || a === '--no-edit' || a === '--edit') { /* default here */ }
    else if (a === '-m') message = args[++i];
    else if (a.startsWith('-')) { ctx.err.write(`error: unknown option \`${a.replace(/^-+/, '')}'\n`); throw new Exit(129); }
    else names.push(a);
  }
  if (!names.length) {
    const b = await currentBranch(repo);
    const up = b ? await getConfig(repo, `branch.${b}.merge`) : null;
    if (!up) die(ctx, 'No remote for the current branch.');
    const remote = await getConfig(repo, `branch.${b}.remote`);
    names.push(`${remote}/${up.replace('refs/heads/', '')}`);
  }
  const spec = names[0];
  const theirOid = await revParse(repo, spec);
  if (!theirOid) {
    ctx.err.write(`merge: ${spec} - not something we can merge\n`);
    throw new Exit(1);
  }
  let label = spec;
  const isRemote = !(await branchOid(repo, spec)) && await revParse(repo, `refs/remotes/${spec}`);
  if (isRemote) label = `refs/remotes/${spec}`;
  else if (!(await branchOid(repo, spec))) label = theirOid;
  return doMerge(ctx, repo, theirOid, {
    message: message || mergeMessage(label, await currentBranch(repo)),
    markerLabel: /^[0-9a-f]{40}$/.test(label) ? theirOid : spec,
    noFf, ffOnly,
  });
}

async function mergeAbort(ctx, repo) {
  const mh = await mergeHead(repo);
  if (!mh) die(ctx, 'There is no merge to abort (MERGE_HEAD missing).');
  const head = await headOid(repo);
  const files = await treeFiles(repo, head);
  const index = await indexFiles(repo);
  const unmerged = await unmergedPaths(repo);
  const theirs = await treeFiles(repo, mh);
  // Put back every path the merge touched.
  const touched = new Set([...unmerged]);
  for (const [p, e] of index) if (files.get(p)?.oid !== e.oid) touched.add(p);
  for (const p of theirs.keys()) if (!files.has(p) && await exists(join(repo.dir, p))) touched.add(p);
  for (const p of touched) {
    const abs = join(repo.dir, p);
    const e = files.get(p);
    if (e) {
      await mkdirp(dirname(abs));
      await pfs.writeFile(abs, await readBlobBytes(repo, e.oid));
      await git.add({ ...base(repo), filepath: p });
    } else {
      try { await pfs.unlink(abs); } catch { /* gone */ }
      await git.remove({ ...base(repo), filepath: p });
    }
  }
  await clearMergeState(repo);
  return 0;
}

/**
 * Merge `theirOid` into the current branch, printing what real Git prints.
 * Used by both git merge and git pull.
 */
export async function doMerge(ctx, repo, theirOid, { message, markerLabel, noFf = false, ffOnly = false, pull = false }) {
  const branchName = await currentBranch(repo);
  const head = await headOid(repo);
  const c = ctx.out.c;

  if (await mergeHead(repo)) {
    if ((await unmergedPaths(repo)).length) {
      ctx.err.write('error: Merging is not possible because you have unmerged files.\n');
      hint(ctx, ["Fix them up in the work tree, and then use 'git add/rm <file>'", 'as appropriate to mark resolution and make a commit.']);
      die(ctx, 'Exiting because of an unresolved conflict.');
    }
    ctx.err.write('fatal: You have not concluded your merge (MERGE_HEAD exists).\nPlease, commit your changes before you merge.\n');
    throw new Exit(128);
  }

  if (!head) {
    // Nothing committed yet: the branch simply starts at their commit.
    await applyTreeChange(repo, null, theirOid);
    await git.writeRef({ ...base(repo), ref: `refs/heads/${branchName}`, value: theirOid, force: true });
    return 0;
  }

  if (theirOid === head || await isAncestor(repo, theirOid, head)) {
    ctx.out.write('Already up to date.\n');
    return 0;
  }

  const canFf = await isAncestor(repo, head, theirOid);
  if (canFf && !noFf) {
    const blocked = await blockedPaths(repo, head, theirOid);
    if (blocked.dirty.length || blocked.untracked.length) {
      ctx.out.write(`Updating ${short(head)}..${short(theirOid)}\n`);
      reportBlocked(ctx, blocked, 'merge');
    }
    ctx.out.write(`Updating ${short(head)}..${short(theirOid)}\nFast-forward\n`);
    await applyTreeChange(repo, head, theirOid);
    await git.writeRef({ ...base(repo), ref: `refs/heads/${branchName}`, value: theirOid, force: true });
    const list = await changes(await treeFiles(repo, head), await treeFiles(repo, theirOid), blobReader(repo), blobReader(repo));
    ctx.out.write(diffstat(c, list, ctx.cols));
    ctx.observe('merge', { kind: 'ff', oid: theirOid });
    return 0;
  }
  if (ffOnly) {
    if (pull) {
      hint(ctx, ['Diverging branches can\'t be fast-forwarded, you need to either:', '', '\tgit merge --no-ff', '', 'or:', '', '\tgit rebase', '', 'Disable this message with "git config advice.diverging false"']);
      die(ctx, 'Not possible to fast-forward, aborting.');
    }
    die(ctx, 'Not possible to fast-forward, aborting.');
  }

  // A real three-way merge.
  const baseOid = await mergeBase(repo, head, theirOid);
  const ours = await treeFiles(repo, head);
  const theirs = await treeFiles(repo, theirOid);
  const baseFiles = await treeFiles(repo, baseOid);
  const changedIn = (side, p) => side.get(p)?.oid !== baseFiles.get(p)?.oid;
  const all = [...new Set([...ours.keys(), ...theirs.keys(), ...baseFiles.keys()])].sort();
  const both = all.filter(p => changedIn(ours, p) && changedIn(theirs, p) && ours.get(p)?.oid !== theirs.get(p)?.oid && ours.get(p) && theirs.get(p));
  const theirsOnly = all.filter(p => changedIn(theirs, p) && !changedIn(ours, p));

  const blocked = await blockedPaths(repo, head, theirOid);
  // Only paths the merge will write matter.
  blocked.dirty = blocked.dirty.filter(p => theirsOnly.includes(p) || both.includes(p));
  blocked.untracked = blocked.untracked.filter(p => theirsOnly.includes(p));
  if (blocked.dirty.length || blocked.untracked.length) reportBlocked(ctx, blocked, 'merge');

  const author = await identity(ctx, repo, 'Committer');

  // isomorphic-git rewrites every tracked file when it writes conflicts,
  // so keep unrelated local edits and put them back afterwards.
  const st = await computeStatus(repo);
  const keep = new Map();
  for (const e of [...st.unstaged, ...st.staged]) {
    if (theirsOnly.includes(e.path) || both.includes(e.path) || keep.has(e.path)) continue;
    try { keep.set(e.path, await pfs.readFile(join(repo.dir, e.path))); } catch { keep.set(e.path, null); }
  }

  let result;
  try {
    result = await git.merge({
      ...base(repo),
      ours: branchName,
      theirs: theirOid,
      fastForward: false,
      message,
      author,
      committer: author,
      abortOnConflict: false,
    });
  } catch (err) {
    if (err && err.code === 'MergeConflictError') {
      const data = err.data || {};
      const bothModified = data.bothModified || [];
      const deleteByUs = data.deleteByUs || [];
      const deleteByTheirs = data.deleteByTheirs || [];
      const conflicted = new Set([...bothModified, ...deleteByUs, ...deleteByTheirs]);
      // Stage the cleanly merged paths, as Git does.
      for (const p of all) {
        if (conflicted.has(p)) continue;
        if (theirsOnly.includes(p)) {
          const abs = join(repo.dir, p);
          if (theirs.has(p)) {
            await mkdirp(dirname(abs));
            await pfs.writeFile(abs, await readBlobBytes(repo, theirs.get(p).oid));
            await git.add({ ...base(repo), filepath: p });
          } else {
            try { await pfs.unlink(abs); } catch { /* gone */ }
            await git.remove({ ...base(repo), filepath: p });
          }
        }
      }
      // Git labels conflict markers with HEAD and the name of the other side.
      for (const p of bothModified) {
        const abs = join(repo.dir, p);
        try {
          const text = await readText(abs);
          await writeText(abs, text
            .replace(/^<{7} .*$/gm, '<<<<<<< HEAD')
            .replace(/^>{7} .*$/gm, `>>>>>>> ${markerLabel}`));
        } catch { /* missing */ }
      }
      for (const p of deleteByUs) {
        // Version from their side stays in the tree.
        const e = theirs.get(p);
        if (e) await pfs.writeFile(join(repo.dir, p), await readBlobBytes(repo, e.oid));
      }
      await restoreKept(repo, keep);

      await writeText(`${repo.gitdir}/MERGE_HEAD`, theirOid + '\n');
      await writeText(`${repo.gitdir}/MERGE_MODE`, '');
      await writeText(`${repo.gitdir}/MERGE_MSG`, `${message}\n\n# Conflicts:\n${[...conflicted].sort().map(p => `#\t${p}`).join('\n')}\n`);

      const lines = [];
      for (const p of all) {
        if (both.includes(p) && !conflicted.has(p)) lines.push(`Auto-merging ${p}`);
        if (bothModified.includes(p)) { lines.push(`Auto-merging ${p}`); lines.push(`CONFLICT (content): Merge conflict in ${p}`); }
        if (deleteByUs.includes(p)) lines.push(`CONFLICT (modify/delete): ${p} deleted in HEAD and modified in ${markerLabel}.  Version ${markerLabel} of ${p} left in tree.`);
        if (deleteByTheirs.includes(p)) lines.push(`CONFLICT (modify/delete): ${p} deleted in ${markerLabel} and modified in HEAD.  Version HEAD of ${p} left in tree.`);
      }
      lines.push('Automatic merge failed; fix conflicts and then commit the result.');
      ctx.out.write(lines.join('\n') + '\n');
      ctx.observe('conflict', { files: [...conflicted], theirs: theirOid });
      throw new Exit(1);
    }
    if (err && err.code === 'MergeNotSupportedError') {
      die(ctx, 'gitGud: this merge needs a strategy that is not available in this lab.');
    }
    throw err;
  }

  // isomorphic-git made the merge commit; now update the files to match it.
  await applyTreeChange(repo, head, result.oid);
  await restoreKept(repo, keep);
  const lines = both.map(p => `Auto-merging ${p}`);
  lines.push("Merge made by the 'ort' strategy.");
  ctx.out.write(lines.join('\n') + '\n');
  const list = await changes(ours, await treeFiles(repo, result.oid), blobReader(repo), blobReader(repo));
  ctx.out.write(diffstat(c, list, ctx.cols));
  ctx.observe('merge', { kind: 'merge', oid: result.oid });
  return 0;
}

export { mergeMessage, applyTreeChange, conflictStageOid };
