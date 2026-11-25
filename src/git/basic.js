import git from 'isomorphic-git';
import { fs, pfs, exists, isDir, readText, writeText, join, GLOBAL_CONFIG, mkdirp, stat } from '../vfs.js';
import {
  Exit, die, hint, base, findRepo, openRepo, repoAt, showPath, repoPath, short,
  parseConfig, configName, editConfigText, splitName, readGlobalConfig, readLocalConfig, getConfig,
  identity, headOid, currentBranch, computeStatus, collapseUntracked, trackingLines,
  unmergedPaths, mergeHead, clearMergeState, treeFiles, readCommit,
} from './core.js';
import { changes, blobReader, diffstat } from './textdiff.js';

// ---------- git init ----------

export async function init(ctx, args) {
  let bare = false, target = null, branch = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--bare') bare = true;
    else if (a === '-b' || a === '--initial-branch') branch = args[++i];
    else if (a.startsWith('--initial-branch=')) branch = a.split('=')[1];
    else if (a.startsWith('-')) { ctx.err.write(`error: unknown option \`${a.replace(/^-+/, '')}'\n`); throw new Exit(129); }
    else target = a;
  }
  const dir = target ? join(target.startsWith('/') ? target : ctx.cwd + '/' + target) : ctx.cwd;
  const gitdir = bare ? dir : dir + '/.git';
  const show = bare ? dir + '/' : dir + '/.git/';
  if (await exists(gitdir + '/HEAD')) {
    ctx.out.write(`Reinitialized existing Git repository in ${show}\n`);
    return 0;
  }
  if (!branch) branch = await getConfig(null, 'init.defaultBranch');
  if (!branch) {
    hint(ctx, [
      "Using 'master' as the name for the initial branch. This default branch name",
      'is subject to change. To configure the initial branch name to use in all',
      'of your new repositories, which will suppress this warning, call:',
      '',
      '\tgit config --global init.defaultBranch <name>',
      '',
      "Names commonly chosen instead of 'master' are 'main', 'trunk' and",
      "'development'. The just-created branch can be renamed via this command:",
      '',
      '\tgit branch -m <name>',
    ]);
    branch = 'master';
  }
  await mkdirp(dir);
  await git.init({ fs, dir, gitdir, bare, defaultBranch: branch });
  ctx.out.write(`Initialized empty Git repository in ${show}\n`);
  return 0;
}

// ---------- git config ----------

export async function config(ctx, args) {
  let scope = null, list = false, unset = false, get = false;
  const rest = [];
  for (const a of args) {
    if (a === '--global') scope = 'global';
    else if (a === '--local') scope = 'local';
    else if (a === '--system') { die(ctx, 'unable to read config file \'/etc/gitconfig\': No such file or directory'); }
    else if (a === '--list' || a === '-l') list = true;
    else if (a === '--unset') unset = true;
    else if (a === '--get') get = true;
    else if (a === '--show-origin' || a === '--show-scope') { /* accepted, ignored */ }
    else if (a.startsWith('-')) { ctx.err.write(`error: unknown option \`${a.replace(/^-+/, '')}'\n`); throw new Exit(129); }
    else rest.push(a);
  }
  const repo = await findRepo(ctx.cwd);

  if (list) {
    const lines = [];
    if (scope !== 'local') for (const e of parseConfig(await readGlobalConfig())) lines.push(`${configName(e)}=${e.value}`);
    if (scope !== 'global' && repo) for (const e of parseConfig(await readLocalConfig(repo))) lines.push(`${configName(e)}=${e.value}`);
    if (scope === 'local' && !repo) die(ctx, '--local can only be used inside a git repository');
    if (lines.length) ctx.out.write(lines.join('\n') + '\n');
    return 0;
  }

  if (!rest.length) {
    ctx.err.write('usage: git config [<options>]\n\n    --global              use global config file\n    --local               use repository config file\n    -l, --list            list all\n    --unset               remove a variable: name\n');
    throw new Exit(129);
  }

  const name = rest[0];
  const parts = splitName(name);
  if (!parts) {
    ctx.err.write(`error: key does not contain a section: ${name}\n`);
    throw new Exit(1);
  }
  const value = rest.length > 1 ? rest.slice(1).join(' ') : null;

  if (value === null && !unset) {
    // Read a value.
    let v;
    if (scope === 'global') v = lookupIn(parseConfig(await readGlobalConfig()), parts);
    else if (scope === 'local') {
      if (!repo) die(ctx, '--local can only be used inside a git repository');
      v = lookupIn(parseConfig(await readLocalConfig(repo)), parts);
    } else v = await getConfig(repo, name);
    if (v === undefined) throw new Exit(1);
    ctx.out.write(v + '\n');
    return 0;
  }

  if (scope === 'global') {
    const text = await readGlobalConfig();
    if (unset && lookupIn(parseConfig(text), parts) === undefined) throw new Exit(5);
    await writeText(GLOBAL_CONFIG, editConfigText(text, name, unset ? null : value));
    return 0;
  }
  if (!repo) die(ctx, 'not in a git directory');
  const text = await readLocalConfig(repo);
  if (unset && lookupIn(parseConfig(text), parts) === undefined) throw new Exit(5);
  await writeText(repo.gitdir + '/config', editConfigText(text, name, unset ? null : value));
  return 0;
}

function lookupIn(entries, p) {
  let v;
  for (const e of entries) if (e.section === p.section && e.sub === p.sub && e.key === p.key) v = e.value;
  return v;
}

// ---------- git status ----------

const LABEL_WIDTH = 12; // "typechange: " is the widest label Git pads to
const label = s => (s + ':').padEnd(LABEL_WIDTH);
const UNMERGED_WIDTH = 17; // "deleted by them: "

export async function statusText(ctx, repo, c, { forCommit = false } = {}) {
  const branch = await currentBranch(repo);
  const head = await headOid(repo);
  const st = await computeStatus(repo);
  const merging = await mergeHead(repo);
  const L = [];

  if (branch) L.push(`On branch ${branch}`);
  else L.push(c.red(`HEAD detached at ${short(head)}`));
  const tracking = branch && head ? await trackingLines(repo, branch) : null;
  if (tracking) { L.push(...tracking); L.push(''); }
  if (!head) { L.push(''); L.push(forCommit ? 'Initial commit' : 'No commits yet'); L.push(''); }

  if (merging) {
    if (st.unmerged.length) {
      L.push('You have unmerged paths.');
      L.push('  (fix conflicts and run "git commit")');
      L.push('  (use "git merge --abort" to abort the merge)');
    } else {
      L.push('All conflicts fixed but you are still merging.');
      L.push('  (use "git commit" to conclude merge)');
    }
    L.push('');
  }

  const p = f => showPath(ctx, repo, f);
  if (st.staged.length) {
    L.push('Changes to be committed:');
    if (!merging) L.push(head ? '  (use "git restore --staged <file>..." to unstage)' : '  (use "git rm --cached <file>..." to unstage)');
    for (const e of st.staged) L.push('\t' + c.green(label(e.type) + p(e.path)));
    L.push('');
  }
  if (st.unmerged.length) {
    L.push('Unmerged paths:');
    L.push('  (use "git add <file>..." to mark resolution)');
    const headFiles = await treeFiles(repo, head);
    const theirFiles = merging ? await treeFiles(repo, merging) : new Map();
    for (const f of st.unmerged) {
      let kind = 'both modified';
      if (!headFiles.has(f) && theirFiles.has(f)) kind = 'deleted by us';
      else if (headFiles.has(f) && !theirFiles.has(f)) kind = 'deleted by them';
      L.push('\t' + c.red((kind + ':').padEnd(UNMERGED_WIDTH) + p(f)));
    }
    L.push('');
  }
  if (st.unstaged.length) {
    L.push('Changes not staged for commit:');
    const anyDeleted = st.unstaged.some(e => e.type === 'deleted');
    L.push(anyDeleted ? '  (use "git add/rm <file>..." to update what will be committed)' : '  (use "git add <file>..." to update what will be committed)');
    L.push('  (use "git restore <file>..." to discard changes in working directory)');
    for (const e of st.unstaged) L.push('\t' + c.red(label(e.type) + p(e.path)));
    L.push('');
  }
  const untracked = collapseUntracked(st.untracked, st.tracked);
  if (untracked.length) {
    L.push('Untracked files:');
    L.push('  (use "git add <file>..." to include in what will be committed)');
    for (const f of untracked) L.push('\t' + c.red(p(f) + (f.endsWith('/') && !p(f).endsWith('/') ? '/' : '')));
    L.push('');
  }

  const committable = st.staged.length > 0 || (merging && !st.unmerged.length);
  if (!committable) {
    if (st.unstaged.length || st.unmerged.length) L.push('no changes added to commit (use "git add" and/or "git commit -a")');
    else if (untracked.length) L.push('nothing added to commit but untracked files present (use "git add" to track)');
    else if (!head) L.push('nothing to commit (create/copy files and use "git add" to track)');
    else L.push('nothing to commit, working tree clean');
  }
  return { text: L.join('\n') + '\n', st, branch, head, committable, merging };
}

export async function status(ctx, args) {
  const repo = await openRepo(ctx);
  const shortFmt = args.includes('-s') || args.includes('--short');
  if (shortFmt) {
    const st = await computeStatus(repo);
    const c = ctx.out.c;
    const rows = new Map();
    for (const e of st.staged) rows.set(e.path, [e.type === 'new file' ? 'A' : e.type === 'deleted' ? 'D' : 'M', ' ']);
    for (const e of st.unstaged) {
      const r = rows.get(e.path) || [' ', ' '];
      r[1] = e.type === 'deleted' ? 'D' : 'M';
      rows.set(e.path, r);
    }
    const lines = [];
    for (const f of st.unmerged) lines.push([f, c.red('UU') + ' ' + showPath(ctx, repo, f)]);
    for (const [f, [x, y]] of rows) lines.push([f, c.green(x) + c.red(y) + ' ' + showPath(ctx, repo, f)]);
    for (const f of collapseUntracked(st.untracked, st.tracked)) lines.push([f, c.red('??') + ' ' + showPath(ctx, repo, f)]);
    lines.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (lines.length) ctx.out.write(lines.map(l => l[1]).join('\n') + '\n');
    ctx.observe('status', { short: true, branch: await currentBranch(repo) });
    return 0;
  }
  const r = await statusText(ctx, repo, ctx.out.c);
  ctx.out.write(r.text);
  ctx.observe('status', { branch: r.branch, head: r.head });
  return 0;
}

// ---------- git add / git rm ----------

// Expand pathspecs to the paths they match in the status matrix.
function matchPaths(spec, paths) {
  if (spec === '.') return paths;
  const glob = /[*?]/.test(spec)
    ? new RegExp('^' + spec.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
    : null;
  return paths.filter(p => (glob ? glob.test(p) : p === spec || p.startsWith(spec + '/')));
}

export async function add(ctx, args) {
  const repo = await openRepo(ctx);
  let all = false, force = false;
  const specs = [];
  for (const a of args) {
    if (a === '-A' || a === '--all') all = true;
    else if (a === '-f' || a === '--force') force = true;
    else if (a === '-u' || a === '--update') all = 'update';
    else if (a === '--') continue;
    else if (a.startsWith('-')) { ctx.err.write(`error: unknown option \`${a.replace(/^-+/, '')}'\n`); throw new Exit(129); }
    else specs.push(a);
  }
  if (!specs.length && !all) {
    ctx.out.write('Nothing specified, nothing added.\n');
    hint(ctx, ["Maybe you wanted to say 'git add .'?", 'Disable this message with "git config advice.addEmptyPathspec false"']);
    return 0;
  }
  const matrix = await git.statusMatrix({ ...base(repo) });
  const unmerged = await unmergedPaths(repo);
  const known = [...new Set([...matrix.map(r => r[0]), ...unmerged])].sort();
  const rows = new Map(matrix.map(r => [r[0], r]));

  let targets = [];
  if (all && !specs.length) targets = known;
  for (const spec of specs) {
    const rel = repoPath(ctx, repo, spec);
    if (rel === null) die(ctx, `${spec}: '${spec}' is outside repository at '${repo.dir}'`);
    const hits = matchPaths(rel, known);
    if (!hits.length) {
      // Is it an ignored file?
      const abs = join(repo.dir, rel);
      if (await exists(abs) && !(await isDir(abs)) && await git.isIgnored({ ...base(repo), filepath: rel })) {
        if (force) { await git.add({ ...base(repo), filepath: rel, force: true }); continue; }
        ctx.err.write(`The following paths are ignored by one of your .gitignore files:\n${spec}\n`);
        hint(ctx, ['Use -f if you really want to add them.', 'Disable this message with "git config advice.addIgnoredFile false"']);
        throw new Exit(1);
      }
      if (rel === '.' || (await isDir(abs))) continue; // empty folder or nothing to add
      die(ctx, `pathspec '${spec}' did not match any files`);
    }
    targets.push(...hits);
  }
  targets = [...new Set(targets)];
  for (const f of targets) {
    const r = rows.get(f);
    const inWorkdir = r ? r[2] !== 0 : await exists(join(repo.dir, f));
    const tracked = r ? r[1] !== 0 || r[3] !== 0 : true;
    if (all === 'update' && !tracked) continue;
    if (inWorkdir) await git.add({ ...base(repo), filepath: f });
    else if (tracked) await git.remove({ ...base(repo), filepath: f });
  }
  return 0;
}

export async function rm(ctx, args) {
  const repo = await openRepo(ctx);
  let cached = false, recursive = false, force = false;
  const specs = [];
  for (const a of args) {
    if (a === '--cached') cached = true;
    else if (a === '-r') recursive = true;
    else if (a === '-f' || a === '--force') force = true;
    else if (a === '-rf' || a === '-fr') { recursive = true; force = true; }
    else if (a === '--') continue;
    else specs.push(a);
  }
  if (!specs.length) { ctx.err.write('usage: git rm [<options>] [--] <file>...\n'); throw new Exit(129); }
  const index = [...(await git.listFiles({ ...base(repo) }))];
  const toRemove = [];
  for (const spec of specs) {
    const rel = repoPath(ctx, repo, spec);
    const hits = rel === null ? [] : matchPaths(rel, index);
    if (!hits.length) die(ctx, `pathspec '${spec}' did not match any files`);
    if (hits.length > 1 || hits[0] !== rel) {
      if (!recursive && rel !== '.') die(ctx, `not removing '${spec}' recursively without -r`);
    }
    toRemove.push(...hits);
  }
  void force;
  for (const f of toRemove) {
    await git.remove({ ...base(repo), filepath: f });
    if (!cached) { try { await pfs.unlink(join(repo.dir, f)); } catch { /* already gone */ } }
    ctx.out.write(`rm '${f}'\n`);
  }
  return 0;
}

// ---------- git commit ----------

function cleanMessage(msg) {
  const lines = msg.split('\n').map(l => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  // Collapse runs of blank lines, like git's whitespace cleanup.
  const out = [];
  for (const l of lines) if (l || out[out.length - 1] !== '') out.push(l);
  return out.join('\n');
}

export async function commit(ctx, args) {
  const repo = await openRepo(ctx);
  const messages = [];
  let all = false, allowEmpty = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-m' || a === '--message') {
      if (i + 1 >= args.length) { ctx.err.write("error: switch `m' requires a value\n"); throw new Exit(129); }
      messages.push(args[++i]);
    } else if (a.startsWith('--message=')) messages.push(a.slice(10));
    else if (/^-[a]*m.+/.test(a) && !a.startsWith('--')) { all = a.includes('a'); messages.push(a.slice(a.indexOf('m') + 1)); }
    else if (a === '-a' || a === '--all') all = true;
    else if (a === '-am' || a === '-ma') {
      all = true;
      if (i + 1 >= args.length) { ctx.err.write("error: switch `m' requires a value\n"); throw new Exit(129); }
      messages.push(args[++i]);
    } else if (a === '--allow-empty') allowEmpty = true;
    else if (a === '--amend') { ctx.err.write('gitGud: git commit --amend is not available in this lab.\n'); throw new Exit(1); }
    else if (a.startsWith('-')) { ctx.err.write(`error: unknown option \`${a.replace(/^-+/, '')}'\n`); throw new Exit(129); }
    else {
      ctx.err.write(`error: pathspec '${a}' did not match any file(s) known to git\n`);
      throw new Exit(1);
    }
  }

  const merging = await mergeHead(repo);
  const unmerged = await unmergedPaths(repo);
  if (unmerged.length) {
    ctx.err.write('error: Committing is not possible because you have unmerged files.\n');
    hint(ctx, ["Fix them up in the work tree, and then use 'git add/rm <file>'", 'as appropriate to mark resolution and make a commit.']);
    die(ctx, 'Exiting because of an unresolved conflict.');
  }

  if (all) {
    const matrix = await git.statusMatrix({ ...base(repo) });
    for (const [f, h, w, s] of matrix) {
      if (s === 0 && h === 0) continue; // untracked
      if (w === 0) { if (s !== 0) await git.remove({ ...base(repo), filepath: f }); }
      else if (s !== 0) await git.add({ ...base(repo), filepath: f });
    }
  }

  const st = await statusText(ctx, repo, ctx.out.c, { forCommit: true });
  if (!st.committable && !allowEmpty) {
    ctx.out.write(st.text);
    throw new Exit(1);
  }

  let message;
  if (messages.length) message = cleanMessage(messages.join('\n\n'));
  else if (merging) {
    let text = '';
    try { text = await readText(repo.gitdir + '/MERGE_MSG'); } catch { /* none */ }
    message = cleanMessage(text.split('\n').filter(l => !l.startsWith('#')).join('\n'));
  } else {
    ctx.err.write('gitGud: this terminal has no text editor. Add a message with -m, for example:\n\n    git commit -m "Describe the change"\n\n');
    throw new Exit(1);
  }
  if (!message) {
    ctx.err.write('Aborting commit due to empty commit message.\n');
    throw new Exit(1);
  }

  const author = await identity(ctx, repo, 'Author');
  const parentOid = st.head;
  const opts = { ...base(repo), message: message + '\n', author, committer: author };
  if (merging) opts.parent = [parentOid, merging];
  const oid = await git.commit(opts);
  if (merging) await clearMergeState(repo);

  const subject = message.split('\n')[0];
  const where = st.branch ? st.branch : 'detached HEAD';
  ctx.out.write(`[${where}${parentOid ? '' : ' (root-commit)'} ${short(oid)}] ${subject}\n`);
  if (!merging) {
    const before = await treeFiles(repo, parentOid);
    const after = await treeFiles(repo, oid);
    const list = await changes(before, after, blobReader(repo), blobReader(repo));
    ctx.out.write(diffstat(ctx.out.c, list, ctx.cols, { summaryOnly: true }));
  }
  ctx.observe('commit', { oid, merge: !!merging });
  return 0;
}

export { stat, readCommit };
