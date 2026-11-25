import git from 'isomorphic-git';
import { fs, pfs, dirname, isDir, exists, readText, writeText, GLOBAL_CONFIG, relative, join } from '../vfs.js';

// ---------- exit handling ----------

export class Exit extends Error {
  constructor(code) { super('exit ' + code); this.code = code; }
}

export function die(ctx, msg, code = 128) {
  ctx.err.write(`fatal: ${msg}\n`);
  throw new Exit(code);
}

export function hint(ctx, lines) {
  const y = ctx.err.c.yellow;
  for (const l of lines) ctx.err.write(y(l === '' ? 'hint:' : `hint: ${l}`) + '\n');
}

// ---------- repositories ----------

export function repoAt(dir) {
  return { dir, gitdir: dir + '/.git', cache: {} };
}

export function base(repo) {
  const o = { fs, gitdir: repo.gitdir, cache: repo.cache };
  if (repo.dir) o.dir = repo.dir;
  return o;
}

export async function findRepo(cwd) {
  let d = cwd;
  for (;;) {
    if (await isDir(d + '/.git')) return repoAt(d);
    if (d === '/') return null;
    d = dirname(d);
  }
}

export async function openRepo(ctx) {
  const repo = await findRepo(ctx.cwd);
  if (!repo) die(ctx, 'not a git repository (or any of the parent directories): .git');
  return repo;
}

// Path of a repo file as Git shows it, relative to the current directory.
export function showPath(ctx, repo, filepath) {
  return relative(ctx.cwd, join(repo.dir, filepath));
}

// Turn a path typed in the shell into a path relative to the repo root.
// Returns null when it points outside the repository.
export function repoPath(ctx, repo, arg) {
  const abs = arg.startsWith('/') ? arg : join(ctx.cwd, arg);
  const norm = join(abs);
  if (norm === repo.dir) return '.';
  if (!norm.startsWith(repo.dir + '/')) return null;
  return norm.slice(repo.dir.length + 1);
}

export const short = oid => oid.slice(0, 7);
export const ZERO = '0000000000000000000000000000000000000000';

// ---------- config ----------

// A small reader/writer for git-config files. Keeps the layout Git uses.
export function parseConfig(text) {
  const entries = [];
  let section = null, sub = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const head = line.match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]$/);
    if (head) {
      section = head[1].toLowerCase();
      sub = head[2] !== undefined ? head[2].replace(/\\(.)/g, '$1') : null;
      if (section.includes('.')) { const i = section.indexOf('.'); sub = section.slice(i + 1); section = section.slice(0, i); }
      continue;
    }
    const kv = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/);
    if (kv && section) {
      let value = kv[2] === undefined ? 'true' : kv[2];
      value = value.replace(/\s+[#;].*$/, '');
      if (/^".*"$/.test(value)) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
      entries.push({ section, sub, key: kv[1].toLowerCase(), value });
    }
  }
  return entries;
}

export function configName(e) {
  return e.sub !== null ? `${e.section}.${e.sub}.${e.key}` : `${e.section}.${e.key}`;
}

export function splitName(name) {
  const first = name.indexOf('.');
  const last = name.lastIndexOf('.');
  if (first < 0) return null;
  const section = name.slice(0, first).toLowerCase();
  const key = name.slice(last + 1).toLowerCase();
  const sub = first === last ? null : name.slice(first + 1, last);
  if (!key || !section) return null;
  return { section, sub, key, rawKey: name.slice(last + 1) };
}

function quoteValue(v) {
  return /^\s|\s$|[#;"\\]/.test(v) ? '"' + v.replace(/(["\\])/g, '\\$1') + '"' : v;
}

// Set or unset a key in config text, keeping everything else in place.
export function editConfigText(text, name, value) {
  const parts = splitName(name);
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let section = null, sub = null, sectionEnd = -1, found = -1;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const head = line.match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]$/);
    if (head) {
      section = head[1].toLowerCase();
      sub = head[2] !== undefined ? head[2] : null;
      return;
    }
    if (section === parts.section && sub === parts.sub) {
      sectionEnd = i;
      const kv = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*(=|$)/);
      if (kv && kv[1].toLowerCase() === parts.key) found = i;
    }
  });
  if (value === null) {
    if (found >= 0) lines.splice(found, 1);
  } else if (found >= 0) {
    lines[found] = `\t${parts.rawKey} = ${quoteValue(value)}`;
  } else if (sectionEnd >= 0) {
    lines.splice(sectionEnd + 1, 0, `\t${parts.rawKey} = ${quoteValue(value)}`);
  } else {
    // A section header with no keys yet also counts as the section.
    let headerIdx = -1;
    lines.forEach((raw, i) => {
      const head = raw.trim().match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]$/);
      if (head && head[1].toLowerCase() === parts.section && (head[2] ?? null) === parts.sub) headerIdx = i;
    });
    const entry = `\t${parts.rawKey} = ${quoteValue(value)}`;
    if (headerIdx >= 0) lines.splice(headerIdx + 1, 0, entry);
    else {
      lines.push(parts.sub !== null ? `[${parts.section} "${parts.sub}"]` : `[${parts.section}]`);
      lines.push(entry);
    }
  }
  return lines.join('\n') + '\n';
}

export async function readGlobalConfig() {
  try { return await readText(GLOBAL_CONFIG); } catch { return ''; }
}

export async function readLocalConfig(repo) {
  try { return await readText(repo.gitdir + '/config'); } catch { return ''; }
}

function lookup(entries, name) {
  const p = splitName(name);
  if (!p) return undefined;
  let v;
  for (const e of entries) if (e.section === p.section && e.sub === p.sub && e.key === p.key) v = e.value;
  return v;
}

// Local config overrides global config, like Git.
export async function getConfig(repo, name) {
  if (repo) {
    const v = lookup(parseConfig(await readLocalConfig(repo)), name);
    if (v !== undefined) return v;
  }
  return lookup(parseConfig(await readGlobalConfig()), name);
}

export async function setLocalConfig(repo, name, value) {
  const text = await readLocalConfig(repo);
  await writeText(repo.gitdir + '/config', editConfigText(text, name, value));
}

// ---------- identity ----------

export function now() {
  return { timestamp: Math.floor(Date.now() / 1000), timezoneOffset: new Date().getTimezoneOffset() };
}

export async function identity(ctx, repo, role = 'Author') {
  const name = await getConfig(repo, 'user.name');
  const email = await getConfig(repo, 'user.email');
  if (name && email) return { name, email, ...now() };
  ctx.err.write(
`${role} identity unknown

*** Please tell me who you are.

Run

  git config --global user.email "you@example.com"
  git config --global user.name "Your Name"

to set your account's default identity.
Omit --global to set the identity only in this repository.

`);
  if (!email) die(ctx, "unable to auto-detect email address (got 'user@git-lab.(none)')");
  die(ctx, `empty ident name (for <${email}>) not allowed`);
}

// ---------- refs ----------

export async function headOid(repo) {
  try { return await git.resolveRef({ ...base(repo), ref: 'HEAD' }); } catch { return null; }
}

// Branch name, or null when HEAD is detached.
export async function currentBranch(repo) {
  try {
    const head = (await readText(repo.gitdir + '/HEAD')).trim();
    if (head.startsWith('ref: refs/heads/')) return head.slice('ref: refs/heads/'.length);
    return null;
  } catch { return null; }
}

export async function branchOid(repo, name) {
  try { return await git.resolveRef({ ...base(repo), ref: `refs/heads/${name}` }); } catch { return null; }
}

export async function listBranches(repo) {
  return (await git.listBranches(base(repo))).sort();
}

export async function listRemoteBranches(repo, remote) {
  try { return (await git.listBranches({ ...base(repo), remote })).filter(b => b !== 'HEAD').sort(); } catch { return []; }
}

export async function hasObject(repo, oid) {
  try { await git.readObject({ ...base(repo), oid, format: 'deflated' }); return true; } catch { return false; }
}

// Resolve a revision such as HEAD, main, origin/main, a1b2c3d, HEAD~2, main^.
export async function revParse(repo, spec) {
  if (!spec) return null;
  const m = spec.match(/^(.*?)((?:[~^]\d*)*)$/);
  let name = m[1] || 'HEAD';
  const suffix = m[2];
  if (name === '@') name = 'HEAD';
  let oid = null;
  if (name === 'HEAD') oid = await headOid(repo);
  else {
    const candidates = name.startsWith('refs/') ? [name]
      : [`refs/heads/${name}`, `refs/tags/${name}`, `refs/remotes/${name}`, `refs/remotes/${name}/HEAD`];
    for (const ref of candidates) {
      try { oid = await git.resolveRef({ ...base(repo), ref }); break; } catch { /* next */ }
    }
    if (!oid && /^[0-9a-f]{4,40}$/.test(name)) {
      try { oid = await git.expandOid({ ...base(repo), oid: name }); } catch { oid = null; }
    }
  }
  if (!oid) return null;
  // Peel annotated tags.
  try {
    const o = await git.readObject({ ...base(repo), oid });
    if (o.type === 'tag') oid = o.object.object;
  } catch { return null; }
  const steps = suffix.match(/[~^]\d*/g) || [];
  for (const step of steps) {
    const n = step.length > 1 ? parseInt(step.slice(1), 10) : 1;
    try {
      if (step[0] === '~') {
        for (let i = 0; i < n; i++) {
          const c = await git.readCommit({ ...base(repo), oid });
          if (!c.commit.parent.length) return null;
          oid = c.commit.parent[0];
        }
      } else if (n > 0) {
        const c = await git.readCommit({ ...base(repo), oid });
        if (c.commit.parent.length < n) return null;
        oid = c.commit.parent[n - 1];
      }
    } catch { return null; }
  }
  return oid;
}

export async function objectType(repo, oid) {
  try { return (await git.readObject({ ...base(repo), oid, format: 'content' })).type; } catch { return null; }
}

// ---------- commits ----------

export async function readCommit(repo, oid) {
  return (await git.readCommit({ ...base(repo), oid })).commit;
}

// All commits reachable from the tips, newest first. Each commit appears once.
export async function revList(repo, tips, { exclude = [] } = {}) {
  const seen = new Set();
  const hidden = new Set();
  for (const oid of exclude) for (const c of await revList(repo, [oid])) hidden.add(c.oid);
  const queue = [];
  const out = [];
  let order = 0;
  const push = async oid => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const commit = await readCommit(repo, oid);
    queue.push({ oid, commit, order: order++ });
  };
  for (const t of tips) if (t) await push(t);
  while (queue.length) {
    // Newest committer date first; on equal dates, the one found first.
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i], b = queue[best];
      if (a.commit.committer.timestamp > b.commit.committer.timestamp ||
        (a.commit.committer.timestamp === b.commit.committer.timestamp && a.order < b.order)) best = i;
    }
    const item = queue.splice(best, 1)[0];
    if (!hidden.has(item.oid)) out.push(item);
    for (const p of item.commit.parent) await push(p);
  }
  return out;
}

export async function commitCount(repo, oid) {
  if (!oid) return 0;
  return (await revList(repo, [oid])).length;
}

export async function isAncestor(repo, ancestor, oid) {
  if (ancestor === oid) return true;
  try { return await git.isDescendent({ ...base(repo), oid, ancestor, depth: -1 }); } catch { return false; }
}

export async function mergeBase(repo, a, b) {
  try {
    const r = await git.findMergeBase({ ...base(repo), oids: [a, b] });
    return r[0] || null;
  } catch { return null; }
}

// ---------- trees, index and working tree ----------

// path -> { oid, mode } for every file in a commit.
export async function treeFiles(repo, commitOid) {
  const map = new Map();
  if (!commitOid) return map;
  await git.walk({
    ...base(repo),
    trees: [git.TREE({ ref: commitOid })],
    map: async (filepath, [entry]) => {
      if (filepath === '.' || !entry) return true;
      if ((await entry.type()) === 'blob') map.set(filepath, { oid: await entry.oid(), mode: await entry.mode() });
      return true;
    },
  });
  return map;
}

// path -> { oid, mode } for every entry in the staging area.
export async function indexFiles(repo) {
  const map = new Map();
  try {
    await git.walk({
      ...base(repo),
      trees: [git.STAGE()],
      map: async (filepath, [entry]) => {
        if (filepath === '.' || !entry) return true;
        if ((await entry.type()) === 'blob') map.set(filepath, { oid: await entry.oid(), mode: await entry.mode() });
        return true;
      },
    });
  } catch { /* no index yet */ }
  return map;
}

export async function readBlobText(repo, oid) {
  const { blob } = await git.readBlob({ ...base(repo), oid });
  return new TextDecoder().decode(blob);
}

export async function readBlobBytes(repo, oid) {
  return (await git.readBlob({ ...base(repo), oid })).blob;
}

export async function hashText(bytes) {
  return (await git.hashBlob({ object: bytes })).oid;
}

// Paths with conflict stages in the index. isomorphic-git does not expose
// these, so the index file header and entry flags are read directly.
export async function unmergedPaths(repo) {
  let buf;
  try { buf = await pfs.readFile(repo.gitdir + '/index'); } catch { return []; }
  if (!buf || buf.length < 12) return [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0) !== 0x44495243) return [];
  const version = dv.getUint32(4);
  if (version !== 2 && version !== 3) return [];
  const count = dv.getUint32(8);
  const dec = new TextDecoder();
  const set = new Set();
  let off = 12;
  for (let i = 0; i < count && off + 62 <= buf.length; i++) {
    const flags = dv.getUint16(off + 60);
    const extended = version >= 3 && (flags & 0x4000) ? 2 : 0;
    const stage = (flags >> 12) & 3;
    const start = off + 62 + extended;
    let end = start;
    while (end < buf.length && buf[end] !== 0) end++;
    if (stage) set.add(dec.decode(buf.subarray(start, end)));
    off += (end - off + 8) & ~7;
  }
  return [...set].sort();
}

// Read one stage (1 base, 2 ours, 3 theirs) of a conflicted path from the index.
export async function conflictStageOid(repo, filepath, stage) {
  let buf;
  try { buf = await pfs.readFile(repo.gitdir + '/index'); } catch { return null; }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = dv.getUint32(4);
  const count = dv.getUint32(8);
  const dec = new TextDecoder();
  let off = 12;
  for (let i = 0; i < count && off + 62 <= buf.length; i++) {
    const flags = dv.getUint16(off + 60);
    const extended = version >= 3 && (flags & 0x4000) ? 2 : 0;
    const start = off + 62 + extended;
    let end = start;
    while (end < buf.length && buf[end] !== 0) end++;
    const name = dec.decode(buf.subarray(start, end));
    if (name === filepath && ((flags >> 12) & 3) === stage) {
      return [...buf.subarray(off + 40, off + 60)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    off += (end - off + 8) & ~7;
  }
  return null;
}

export async function mergeHead(repo) {
  try { return (await readText(repo.gitdir + '/MERGE_HEAD')).trim() || null; } catch { return null; }
}

export async function clearMergeState(repo) {
  for (const f of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE']) {
    try { await pfs.unlink(`${repo.gitdir}/${f}`); } catch { /* not there */ }
  }
}

/**
 * The state of every path, worked out from isomorphic-git's statusMatrix.
 * staged:   HEAD vs staging area      { path, type: 'new file' | 'modified' | 'deleted' }
 * unstaged: staging area vs work tree { path, type: 'modified' | 'deleted' }
 * untracked: paths not in the staging area and not ignored
 * unmerged: paths with conflict stages
 */
export async function computeStatus(repo) {
  const matrix = await git.statusMatrix({ ...base(repo) });
  const unmerged = await unmergedPaths(repo);
  const unmergedSet = new Set(unmerged);
  const staged = [], unstaged = [], untracked = [], tracked = [];
  for (const [path, h, w, s] of matrix) {
    if (unmergedSet.has(path)) { tracked.push(path); continue; }
    if (s !== 0) tracked.push(path);
    if (h === 0 && s !== 0) staged.push({ path, type: 'new file' });
    else if (h === 1 && s === 0) staged.push({ path, type: 'deleted' });
    else if (h === 1 && (s === 3 || (s === 2 && w === 2))) staged.push({ path, type: 'modified' });

    if (s === 0) { if (w !== 0) untracked.push(path); }
    else if (w === 0) unstaged.push({ path, type: 'deleted' });
    else if ((s === 1 && w === 2) || s === 3) unstaged.push({ path, type: 'modified' });
  }
  return { staged, unstaged, untracked, unmerged, tracked, matrix };
}

// Git shows an untracked folder as "folder/" when nothing inside it is tracked.
export function collapseUntracked(untracked, tracked) {
  const trackedDirs = new Set();
  for (const t of tracked) {
    const parts = t.split('/');
    for (let i = 1; i < parts.length; i++) trackedDirs.add(parts.slice(0, i).join('/'));
  }
  const out = new Set();
  for (const f of untracked) {
    const parts = f.split('/');
    let shown = f;
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!trackedDirs.has(d)) { shown = d + '/'; break; }
    }
    out.add(shown);
  }
  return [...out].sort();
}

// ---------- upstream tracking ----------

export async function upstreamOf(repo, branch) {
  if (!branch) return null;
  const remote = await getConfig(repo, `branch.${branch}.remote`);
  const merge = await getConfig(repo, `branch.${branch}.merge`);
  if (!remote || !merge) return null;
  const rbranch = merge.replace(/^refs\/heads\//, '');
  const name = `${remote}/${rbranch}`;
  const ref = `refs/remotes/${name}`;
  let oid = null;
  try { oid = await git.resolveRef({ ...base(repo), ref }); } catch { /* gone */ }
  return { remote, branch: rbranch, name, ref, oid };
}

export async function aheadBehind(repo, a, b) {
  const A = new Set((await revList(repo, [a])).map(c => c.oid));
  const B = new Set((await revList(repo, [b])).map(c => c.oid));
  let ahead = 0, behind = 0;
  for (const x of A) if (!B.has(x)) ahead++;
  for (const x of B) if (!A.has(x)) behind++;
  return { ahead, behind };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The "Your branch is ..." lines used by status, switch and checkout.
export async function trackingLines(repo, branch) {
  const up = await upstreamOf(repo, branch);
  if (!up) return null;
  if (!up.oid) {
    return [`Your branch is based on '${up.name}', but the upstream is gone.`,
      '  (use "git branch --unset-upstream" to fixup)'];
  }
  const head = await branchOid(repo, branch);
  if (!head) return null;
  const { ahead, behind } = await aheadBehind(repo, head, up.oid);
  if (!ahead && !behind) return [`Your branch is up to date with '${up.name}'.`];
  if (ahead && !behind) {
    return [`Your branch is ahead of '${up.name}' by ${plural(ahead, 'commit')}.`,
      '  (use "git push" to publish your local commits)'];
  }
  if (!ahead && behind) {
    return [`Your branch is behind '${up.name}' by ${plural(behind, 'commit')}, and can be fast-forwarded.`,
      '  (use "git pull" to update your local branch)'];
  }
  return [`Your branch and '${up.name}' have diverged,`,
    `and have ${ahead} and ${behind} different commits each, respectively.`,
    '  (use "git pull" if you want to integrate the remote branch with yours)'];
}

// ---------- remotes on the local filesystem ----------

// Find the git directory for a remote URL that is a path in the virtual filesystem.
export async function openRemotePath(fromDir, url) {
  const p = url.startsWith('/') ? join(url) : join(fromDir, url);
  if (await isDir(p + '/.git')) return { dir: p, gitdir: p + '/.git', cache: {}, path: p, bare: false };
  if (await exists(p + '/HEAD') && await isDir(p + '/objects')) return { gitdir: p, cache: {}, path: p, bare: true };
  return null;
}

export { plural };
