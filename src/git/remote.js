import git from 'isomorphic-git';
import { fs, pfs, join, basename, mkdirp, exists, isDir, readdirSafe, readText } from '../vfs.js';
import {
  Exit, die, hint, base, openRepo, repoAt, short, headOid, currentBranch, branchOid, getConfig,
  setLocalConfig, hasObject, isAncestor, openRemotePath, listRemoteBranches, revParse,
} from './core.js';
import { doMerge, mergeMessage, applyTreeChange } from './branching.js';

// ---------- moving objects between two repositories ----------

/**
 * Copy every object reachable from `tips` that `dst` does not have yet.
 * Objects are read and written through isomorphic-git in their stored
 * (deflated) form, so the hashes on both sides are identical.
 */
export async function transferObjects(src, dst, tips) {
  const seen = new Set();
  const toCopy = [];
  const visitTree = async oid => {
    if (seen.has(oid)) return;
    seen.add(oid);
    if (await hasObject(dst, oid)) return;
    toCopy.push(oid);
    const { tree } = await git.readTree({ ...base(src), oid });
    for (const e of tree) {
      if (e.type === 'tree') await visitTree(e.oid);
      else if (e.type === 'blob' && !seen.has(e.oid)) {
        seen.add(e.oid);
        if (!(await hasObject(dst, e.oid))) toCopy.push(e.oid);
      }
    }
  };
  const stack = [...tips.filter(Boolean)];
  while (stack.length) {
    const oid = stack.pop();
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (await hasObject(dst, oid)) continue; // dst has it, so it has its history too
    toCopy.push(oid);
    const { commit } = await git.readCommit({ ...base(src), oid });
    await visitTree(commit.tree);
    stack.push(...commit.parent);
  }
  let bytes = 0;
  for (const oid of toCopy) {
    const o = await git.readObject({ ...base(src), oid, format: 'deflated' });
    bytes += o.object.length;
    await git.writeObject({ ...base(dst), oid, type: o.type, object: o.object, format: 'deflated' });
  }
  return { count: toCopy.length, bytes };
}

function humanBytes(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

function rate(bytes, ms) {
  const perSec = bytes / Math.max(ms, 1) * 1000;
  if (perSec < 1024) return `${Math.round(perSec)} bytes/s`;
  if (perSec < 1024 * 1024) return `${(perSec / 1024).toFixed(2)} KiB/s`;
  return `${(perSec / 1024 / 1024).toFixed(2)} MiB/s`;
}

// Git prints "From /remote/origin" without the ".git" ending.
const displayUrl = url => url.replace(/\/+$/, '').replace(/\.git$/, '');

function cannotRead(ctx, what) {
  ctx.err.write(`fatal: '${what}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n`);
  throw new Exit(128);
}

async function remoteUrl(repo, name) {
  return await getConfig(repo, `remote.${name}.url`);
}

async function openRemote(ctx, repo, name) {
  let url = await remoteUrl(repo, name);
  const isPath = !url && (name.startsWith('/') || name.startsWith('.'));
  if (!url && !isPath) cannotRead(ctx, name);
  if (!url) url = name;
  const remote = await openRemotePath(repo.dir, url);
  if (!remote) cannotRead(ctx, url);
  return { url, remote, name: isPath ? null : name };
}

async function remoteHeads(remote) {
  const out = new Map();
  for (const b of await git.listBranches({ fs, gitdir: remote.gitdir })) {
    try { out.set(b, await git.resolveRef({ fs, gitdir: remote.gitdir, ref: `refs/heads/${b}` })); } catch { /* broken */ }
  }
  return out;
}

// ---------- git remote ----------

export async function remoteCmd(ctx, args) {
  const repo = await openRepo(ctx);
  const sub = args[0];
  if (!sub || sub === '-v' || sub === '--verbose') {
    const remotes = await git.listRemotes(base(repo));
    const lines = [];
    for (const r of remotes) {
      if (sub) { lines.push(`${r.remote}\t${r.url} (fetch)`); lines.push(`${r.remote}\t${r.url} (push)`); }
      else lines.push(r.remote);
    }
    if (lines.length) ctx.out.write(lines.join('\n') + '\n');
    return 0;
  }
  if (sub === 'add') {
    const [name, url] = args.slice(1).filter(a => !a.startsWith('-'));
    if (!name || !url) { ctx.err.write('usage: git remote add [<options>] <name> <url>\n'); throw new Exit(129); }
    if (await remoteUrl(repo, name)) { ctx.err.write(`error: remote ${name} already exists.\n`); throw new Exit(3); }
    await git.addRemote({ ...base(repo), remote: name, url });
    return 0;
  }
  if (sub === 'remove' || sub === 'rm') {
    const name = args[1];
    if (!name || !(await remoteUrl(repo, name))) { ctx.err.write(`error: No such remote: '${name}'\n`); throw new Exit(2); }
    await git.deleteRemote({ ...base(repo), remote: name });
    // Remove its remote-tracking branches too.
    const dir = `${repo.gitdir}/refs/remotes/${name}`;
    for (const f of await readdirSafe(dir)) { try { await pfs.unlink(`${dir}/${f}`); } catch { /* nested */ } }
    try { await pfs.rmdir(dir); } catch { /* not empty or missing */ }
    return 0;
  }
  if (sub === 'get-url') {
    const url = await remoteUrl(repo, args[1]);
    if (!url) { ctx.err.write(`error: No such remote '${args[1]}'\n`); throw new Exit(2); }
    ctx.out.write(url + '\n');
    return 0;
  }
  if (sub === 'set-url') {
    const [name, url] = args.slice(1);
    if (!(await remoteUrl(repo, name))) { ctx.err.write(`error: No such remote '${name}'\n`); throw new Exit(2); }
    await setLocalConfig(repo, `remote.${name}.url`, url);
    return 0;
  }
  if (sub === 'show') {
    const name = args[1] || 'origin';
    const url = await remoteUrl(repo, name);
    if (!url) cannotRead(ctx, name);
    ctx.out.write(`* remote ${name}\n  Fetch URL: ${url}\n  Push  URL: ${url}\n`);
    return 0;
  }
  ctx.err.write(`error: unknown subcommand: \`${sub}'\n`);
  throw new Exit(129);
}

// ---------- git fetch ----------

export async function fetchFrom(ctx, repo, remoteName, { quietIfNothing = true } = {}) {
  const { url, remote, name } = await openRemote(ctx, repo, remoteName);
  const heads = await remoteHeads(remote);
  const started = Date.now();
  const { count, bytes } = await transferObjects(remote, repo, [...heads.values()]);
  const updates = [];
  if (name) {
    for (const [b, oid] of heads) {
      const ref = `refs/remotes/${name}/${b}`;
      let old = null;
      try { old = await git.resolveRef({ ...base(repo), ref }); } catch { /* new */ }
      if (old === oid) continue;
      let kind = 'new';
      if (old) kind = (await isAncestor(repo, old, oid)) ? 'ff' : 'forced';
      await git.writeRef({ ...base(repo), ref, value: oid, force: true });
      updates.push({ b, old, oid, kind, local: `${name}/${b}` });
    }
  }
  const e = ctx.err;
  if (count) {
    e.write(`remote: Enumerating objects: ${count}, done.\n`);
    e.write(`remote: Counting objects: 100% (${count}/${count}), done.\n`);
    e.write(`remote: Total ${count} (delta 0), reused 0 (delta 0), pack-reused 0\n`);
    e.write(`Unpacking objects: 100% (${count}/${count}), ${humanBytes(bytes)} | ${rate(bytes, Date.now() - started)}, done.\n`);
  }
  if (updates.length) {
    e.write(`From ${displayUrl(url)}\n`);
    const w = Math.max(10, ...updates.map(u => u.b.length));
    for (const u of updates) {
      if (u.kind === 'new') e.write(` * [new branch]      ${u.b.padEnd(w)} -> ${u.local}\n`);
      else if (u.kind === 'ff') e.write(`   ${`${short(u.old)}..${short(u.oid)}`.padEnd(17)} ${u.b.padEnd(w)} -> ${u.local}\n`);
      else e.write(` + ${`${short(u.old)}...${short(u.oid)}`.padEnd(17)} ${u.b.padEnd(w)} -> ${u.local}  (forced update)\n`);
    }
  }
  void quietIfNothing;
  return { url, remote, heads, name };
}

export async function fetch(ctx, args) {
  const repo = await openRepo(ctx);
  const names = args.filter(a => !a.startsWith('-'));
  let remoteName = names[0];
  if (!remoteName) {
    const b = await currentBranch(repo);
    remoteName = (b && await getConfig(repo, `branch.${b}.remote`)) || 'origin';
    if (!(await remoteUrl(repo, remoteName))) {
      const remotes = await git.listRemotes(base(repo));
      if (!remotes.length) {
        die(ctx, 'No remote repository specified.  Please, specify either a URL or a\nremote name from which new revisions should be fetched.');
      }
      remoteName = remotes[0].remote;
    }
  }
  await fetchFrom(ctx, repo, remoteName);
  ctx.observe('fetch', {});
  return 0;
}

// ---------- git pull ----------

export async function pull(ctx, args) {
  const repo = await openRepo(ctx);
  let rebase = null, ffOnly = false;
  const names = [];
  for (const a of args) {
    if (a === '--rebase' || a === '-r') rebase = true;
    else if (a === '--no-rebase') rebase = false;
    else if (a === '--ff-only') ffOnly = true;
    else if (a === '--no-edit' || a === '--ff' || a === '--no-ff') { /* default here */ }
    else if (a.startsWith('-')) { ctx.err.write(`error: unknown option \`${a.replace(/^-+/, '')}'\n`); throw new Exit(129); }
    else names.push(a);
  }
  const branchName = await currentBranch(repo);
  if (!branchName) die(ctx, 'gitGud: pull needs a branch. Switch to a branch first.');
  let remoteName = names[0];
  let remoteBranch = names[1];
  if (!remoteName) {
    remoteName = await getConfig(repo, `branch.${branchName}.remote`);
    const merge = await getConfig(repo, `branch.${branchName}.merge`);
    if (!remoteName || !merge) {
      const remotes = await git.listRemotes(base(repo));
      if (!remotes.length) {
        die(ctx, 'No remote repository specified.  Please, specify either a URL or a\nremote name from which new revisions should be fetched.');
      }
      ctx.err.write(`There is no tracking information for the current branch.
Please specify which branch you want to merge with.
See git-pull(1) for details.

    git pull <remote> <branch>

If you wish to set tracking information for this branch you can do so with:

    git branch --set-upstream-to=${remotes[0].remote}/<branch> ${branchName}

`);
      throw new Exit(1);
    }
    remoteBranch = merge.replace(/^refs\/heads\//, '');
  }
  if (!remoteBranch) remoteBranch = branchName;

  const fetched = await fetchFrom(ctx, repo, remoteName);
  const theirOid = fetched.heads.get(remoteBranch);
  if (!theirOid) {
    if (names[1]) die(ctx, `couldn't find remote ref ${remoteBranch}`);
    ctx.err.write(`Your configuration specifies to merge with the ref 'refs/heads/${remoteBranch}'\nfrom the remote, but no such ref was fetched.\n`);
    throw new Exit(1);
  }

  if (rebase === null) {
    const cfg = await getConfig(repo, 'pull.rebase');
    if (cfg !== undefined) rebase = cfg === 'true' || cfg === 'merges' || cfg === 'interactive';
  }
  if (rebase) {
    die(ctx, 'gitGud: rebase is not available in this lab. Run git pull --no-rebase to merge.');
  }
  if (!ffOnly && (await getConfig(repo, 'pull.ff')) === 'only') ffOnly = true;

  const head = await headOid(repo);
  const diverged = head && !(await isAncestor(repo, head, theirOid)) && !(await isAncestor(repo, theirOid, head));
  if (diverged && rebase === null && !ffOnly) {
    hint(ctx, [
      'You have divergent branches and need to specify how to reconcile them.',
      'You can do so by running one of the following commands sometime before',
      'your next pull:',
      '',
      '  git config pull.rebase false  # merge',
      '  git config pull.rebase true   # rebase',
      '  git config pull.ff only       # fast-forward only',
      '',
      'You can replace "git config" with "git config --global" to set a default',
      'preference for all repositories. You can also pass --rebase, --no-rebase,',
      'or --ff-only on the command line to override the configured default per',
      'invocation.',
    ]);
    die(ctx, 'Need to specify how to reconcile divergent branches.');
  }

  const url = displayUrl(fetched.url);
  const code = await doMerge(ctx, repo, theirOid, {
    message: mergeMessage(remoteBranch, branchName, url),
    markerLabel: theirOid,
    ffOnly,
    pull: true,
  });
  ctx.observe('pull', { theirs: theirOid });
  return code;
}

// ---------- git push ----------

export async function push(ctx, args) {
  const repo = await openRepo(ctx);
  let setUpstream = false, force = false;
  const names = [];
  for (const a of args) {
    if (a === '-u' || a === '--set-upstream') setUpstream = true;
    else if (a === '-f' || a === '--force' || a === '--force-with-lease') force = true;
    else if (a.startsWith('-')) { ctx.err.write(`error: unknown option \`${a.replace(/^-+/, '')}'\n`); throw new Exit(129); }
    else names.push(a);
  }
  const branchName = await currentBranch(repo);
  let remoteName = names[0];
  let refspec = names[1];

  if (!remoteName) {
    const up = branchName ? await getConfig(repo, `branch.${branchName}.remote`) : null;
    if (up) remoteName = up;
    else {
      const remotes = await git.listRemotes(base(repo));
      if (!remotes.length) {
        ctx.err.write(`fatal: No configured push destination.
Either specify the URL from the command-line or configure a remote repository using

    git remote add <name> <url>

and then push using the remote name

    git push <name>

`);
        throw new Exit(128);
      }
      if (!branchName) die(ctx, 'You are not currently on a branch.');
      ctx.err.write(`fatal: The current branch ${branchName} has no upstream branch.
To push the current branch and set the remote as upstream, use

    git push --set-upstream ${remotes.length === 1 ? remotes[0].remote : 'origin'} ${branchName}

To have this happen automatically for branches without a tracking
upstream, see 'push.autoSetupRemote' in 'git help config'.

`);
      throw new Exit(128);
    }
  }

  if (!refspec) {
    if (!branchName) die(ctx, 'You are not currently on a branch.\nTo push the history leading to the current (detached HEAD)\nstate now, use\n\n    git push origin HEAD:<name-of-remote-branch>\n');
    refspec = branchName;
    const mergeRef = await getConfig(repo, `branch.${branchName}.merge`);
    const upRemote = await getConfig(repo, `branch.${branchName}.remote`);
    if (mergeRef && upRemote === remoteName) refspec = `${branchName}:${mergeRef.replace('refs/heads/', '')}`;
  }
  let [srcName, dstName] = refspec.includes(':') ? refspec.split(':') : [refspec, refspec];
  if (srcName.startsWith('+')) { force = true; srcName = srcName.slice(1); }
  if (srcName === 'HEAD') srcName = branchName || 'HEAD';
  if (dstName === 'HEAD') dstName = branchName;

  const { url, remote, name } = await openRemote(ctx, repo, remoteName);
  const srcOid = srcName === 'HEAD' ? await headOid(repo) : await branchOid(repo, srcName) || await revParse(repo, srcName);
  if (!srcOid) {
    ctx.err.write(`error: src refspec ${srcName} does not match any\nerror: failed to push some refs to '${url}'\n`);
    throw new Exit(1);
  }

  let remoteOid = null;
  try { remoteOid = await git.resolveRef({ fs, gitdir: remote.gitdir, ref: `refs/heads/${dstName}` }); } catch { /* new branch */ }

  const finishUpstream = async () => {
    if (setUpstream && name && branchName) {
      await setLocalConfig(repo, `branch.${srcName}.remote`, name);
      await setLocalConfig(repo, `branch.${srcName}.merge`, `refs/heads/${dstName}`);
      ctx.out.write(`branch '${srcName}' set up to track '${name}/${dstName}'.\n`);
    }
  };

  if (remoteOid === srcOid) {
    ctx.err.write('Everything up-to-date\n');
    await finishUpstream();
    return 0;
  }

  const e = ctx.err;
  const c = e.c;
  if (remoteOid && !force) {
    const known = await hasObject(repo, remoteOid);
    const ff = known && await isAncestor(repo, remoteOid, srcOid);
    if (!ff) {
      e.write(`To ${url}\n`);
      e.write(c.red(` ! [rejected]        ${srcName} -> ${dstName} (${known ? 'non-fast-forward' : 'fetch first'})`) + '\n');
      e.write(c.red(`error: failed to push some refs to '${url}'`) + '\n');
      if (known) {
        hint(ctx, [
          'Updates were rejected because the tip of your current branch is behind',
          'its remote counterpart. If you want to integrate the remote changes,',
          "use 'git pull' before pushing again.",
          "See the 'Note about fast-forwards' in 'git push --help' for details.",
        ]);
      } else {
        hint(ctx, [
          'Updates were rejected because the remote contains work that you do not',
          'have locally. This is usually caused by another repository pushing to',
          'the same ref. If you want to integrate the remote changes, use',
          "'git pull' before pushing again.",
          "See the 'Note about fast-forwards' in 'git push --help' for details.",
        ]);
      }
      ctx.observe('push-rejected', { reason: known ? 'non-fast-forward' : 'fetch first' });
      throw new Exit(1);
    }
  }

  // Pushing into the checked-out branch of a repository with a working tree.
  if (!remote.bare) {
    const theirBranch = await currentBranch(remote);
    if (theirBranch === dstName) {
      e.write(`To ${url}\n`);
      e.write(`remote: error: refusing to update checked out branch: refs/heads/${dstName}\n`);
      e.write('remote: error: By default, updating the current branch in a non-bare repository\n');
      e.write('remote: is denied, because it will make the index and work tree inconsistent\n');
      e.write('remote: with what you pushed, and will require \'git reset --hard\' to match\n');
      e.write('remote: the work tree to HEAD.\n');
      e.write(c.red(` ! [remote rejected] ${srcName} -> ${dstName} (branch is currently checked out)`) + '\n');
      e.write(c.red(`error: failed to push some refs to '${url}'`) + '\n');
      throw new Exit(1);
    }
  }

  const started = Date.now();
  const { count, bytes } = await transferObjects(repo, remote, [srcOid]);
  await git.writeRef({ fs, gitdir: remote.gitdir, ref: `refs/heads/${dstName}`, value: srcOid, force: true });
  if (name) await git.writeRef({ ...base(repo), ref: `refs/remotes/${name}/${dstName}`, value: srcOid, force: true });

  if (count) {
    e.write(`Enumerating objects: ${count}, done.\n`);
    e.write(`Counting objects: 100% (${count}/${count}), done.\n`);
    e.write(`Writing objects: 100% (${count}/${count}), ${humanBytes(bytes)} | ${rate(bytes, Date.now() - started)}, done.\n`);
    e.write(`Total ${count} (delta 0), reused 0 (delta 0), pack-reused 0\n`);
  }
  e.write(`To ${url}\n`);
  if (!remoteOid) e.write(` * [new branch]      ${srcName} -> ${dstName}\n`);
  else if (force && !(await isAncestor(repo, remoteOid, srcOid))) e.write(` + ${`${short(remoteOid)}...${short(srcOid)}`} ${srcName} -> ${dstName} (forced update)\n`);
  else e.write(`   ${`${short(remoteOid)}..${short(srcOid)}`.padEnd(17)} ${srcName} -> ${dstName}\n`);
  await finishUpstream();
  ctx.observe('push', { oid: srcOid, branch: dstName });
  return 0;
}

// ---------- git clone ----------

export async function clone(ctx, args) {
  const names = args.filter(a => !a.startsWith('-'));
  if (!names.length) {
    ctx.err.write('fatal: You must specify a repository to clone.\n\nusage: git clone [<options>] [--] <repo> [<dir>]\n');
    throw new Exit(129);
  }
  const [srcArg, dirArg] = names;
  const srcPath = join(srcArg.startsWith('/') ? srcArg : ctx.cwd + '/' + srcArg);
  const remote = await openRemotePath('/', srcPath);
  const dirName = dirArg || basename(srcPath).replace(/\.git$/, '');
  const dst = join(dirName.startsWith('/') ? dirName : ctx.cwd + '/' + dirName);
  if (await exists(dst) && (!(await isDir(dst)) || (await readdirSafe(dst)).length)) {
    die(ctx, `destination path '${dirArg || dirName}' already exists and is not an empty directory.`);
  }
  if (!remote) die(ctx, `repository '${srcArg}' does not exist`);

  ctx.err.write(`Cloning into '${dirArg || dirName}'...\n`);
  let headBranch = null;
  try {
    const h = (await readText(remote.gitdir + '/HEAD')).trim();
    if (h.startsWith('ref: refs/heads/')) headBranch = h.slice(16);
  } catch { /* detached */ }
  const heads = await remoteHeads(remote);
  if (!heads.has(headBranch)) headBranch = heads.size ? [...heads.keys()][0] : headBranch || 'main';

  await mkdirp(dst);
  await git.init({ fs, dir: dst, defaultBranch: headBranch });
  const repo = repoAt(dst);
  await git.addRemote({ ...base(repo), remote: 'origin', url: srcPath });
  await transferObjects(remote, repo, [...heads.values()]);
  for (const [b, oid] of heads) await git.writeRef({ ...base(repo), ref: `refs/remotes/origin/${b}`, value: oid, force: true });

  if (!heads.size) {
    ctx.err.write('warning: You appear to have cloned an empty repository.\n');
    ctx.err.write('done.\n');
    ctx.observe('clone', { dir: dst });
    return 0;
  }
  await git.writeRef({ ...base(repo), ref: 'refs/remotes/origin/HEAD', value: `refs/remotes/origin/${headBranch}`, symbolic: true, force: true });
  const oid = heads.get(headBranch);
  await git.writeRef({ ...base(repo), ref: `refs/heads/${headBranch}`, value: oid, force: true });
  await setLocalConfig(repo, `branch.${headBranch}.remote`, 'origin');
  await setLocalConfig(repo, `branch.${headBranch}.merge`, `refs/heads/${headBranch}`);
  await applyTreeChange(repo, null, oid);
  ctx.err.write('done.\n');
  ctx.observe('clone', { dir: dst });
  return 0;
}

export { listRemoteBranches };
