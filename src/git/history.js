import git from 'isomorphic-git';
import { pfs, join } from '../vfs.js';
import {
  Exit, die, base, openRepo, short, revParse, headOid, currentBranch, revList, readCommit,
  treeFiles, indexFiles, readBlobText, readBlobBytes, hashText, computeStatus, unmergedPaths,
  repoPath, objectType,
} from './core.js';
import { fileDiff, changes, blobReader, diffstat } from './textdiff.js';
import { topoOrder, graphRows } from './graph.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => String(n).padStart(2, '0');

// Git's default date format: "Wed Nov 25 21:32:10 2026 +0200".
export function gitDate(timestamp, timezoneOffset) {
  const d = new Date((timestamp - timezoneOffset * 60) * 1000);
  const off = -timezoneOffset;
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()} ` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

// oid -> decoration labels, in the order Git prints them.
async function decorations(repo) {
  const map = new Map();
  const addTo = (oid, item) => { if (!map.has(oid)) map.set(oid, []); map.get(oid).push(item); };
  const branch = await currentBranch(repo);
  const head = await headOid(repo);
  if (head && !branch) addTo(head, { kind: 'head', name: 'HEAD' });
  for (const b of (await git.listBranches(base(repo))).sort()) {
    try {
      const oid = await git.resolveRef({ ...base(repo), ref: `refs/heads/${b}` });
      addTo(oid, { kind: b === branch ? 'current' : 'branch', name: b });
    } catch { /* broken ref */ }
  }
  for (const r of await git.listRemotes(base(repo)).catch(() => [])) {
    for (const b of (await git.listBranches({ ...base(repo), remote: r.remote }).catch(() => [])).sort()) {
      try {
        const oid = await git.resolveRef({ ...base(repo), ref: `refs/remotes/${r.remote}/${b}` });
        addTo(oid, { kind: 'remote', name: `${r.remote}/${b}` });
      } catch { /* broken ref */ }
    }
  }
  for (const t of await git.listTags(base(repo)).catch(() => [])) {
    try {
      let oid = await git.resolveRef({ ...base(repo), ref: `refs/tags/${t}` });
      const o = await git.readObject({ ...base(repo), oid });
      if (o.type === 'tag') oid = o.object.object;
      addTo(oid, { kind: 'tag', name: t });
    } catch { /* broken tag */ }
  }
  // HEAD -> current first, then the rest.
  const rank = it => (it.kind === 'current' || it.kind === 'head' ? 0 : it.name.endsWith('/HEAD') ? 2 : 1);
  for (const list of map.values()) list.sort((a, b) => rank(a) - rank(b));
  return map;
}

function decorate(c, items) {
  if (!items || !items.length) return '';
  const parts = items.map(it => {
    if (it.kind === 'current') return c.boldCyan('HEAD -> ') + c.boldGreen(it.name);
    if (it.kind === 'head') return c.boldCyan('HEAD');
    if (it.kind === 'branch') return c.boldGreen(it.name);
    if (it.kind === 'remote') return c.boldRed(it.name);
    return c.boldYellow('tag: ' + it.name);
  });
  return ' ' + c.yellow('(') + parts.join(c.yellow(', ')) + c.yellow(')');
}

function header(c, item, decos) {
  const { oid, commit } = item;
  const L = [c.yellow('commit ' + oid) + decorate(c, decos.get(oid))];
  if (commit.parent.length > 1) L.push('Merge: ' + commit.parent.map(short).join(' '));
  L.push(`Author: ${commit.author.name} <${commit.author.email}>`);
  L.push(`Date:   ${gitDate(commit.author.timestamp, commit.author.timezoneOffset)}`);
  L.push('');
  const msg = commit.message.replace(/\n+$/, '');
  for (const line of msg.split('\n')) L.push(line ? '    ' + line : '');
  return L.join('\n') + '\n';
}

async function commitDiff(c, repo, item) {
  const parent = item.commit.parent[0] || null;
  const before = await treeFiles(repo, parent);
  const after = await treeFiles(repo, item.oid);
  const list = await changes(before, after, blobReader(repo), blobReader(repo));
  return { text: list.map(ch => fileDiff(c, ch.path, ch.a, ch.b)).join(''), list };
}

// ---------- git log ----------

export async function log(ctx, args) {
  const repo = await openRepo(ctx);
  let oneline = false, patch = false, all = false, limit = Infinity, stat = false, graph = false;
  const revs = [];
  const paths = [];
  let afterDashes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (afterDashes) { paths.push(a); continue; }
    if (a === '--') afterDashes = true;
    else if (a === '--oneline' || a === '--pretty=oneline' || a === '--format=oneline') oneline = a === '--oneline' ? 'abbrev' : 'full';
    else if (a === '-p' || a === '--patch') patch = true;
    else if (a === '--all') all = true;
    else if (a === '--stat') stat = true;
    else if (a === '--graph') graph = true;
    else if (a === '--decorate' || a === '--no-abbrev-commit' || a === '--abbrev-commit') { /* default */ }
    else if (/^-\d+$/.test(a)) limit = parseInt(a.slice(1), 10);
    else if (a === '-n' || a === '--max-count') limit = parseInt(args[++i], 10);
    else if (/^-n\d+$/.test(a)) limit = parseInt(a.slice(2), 10);
    else if (a.startsWith('--max-count=')) limit = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('-')) { ctx.err.write(`fatal: unrecognized argument: ${a}\n`); throw new Exit(128); }
    else revs.push(a);
  }

  const tips = [];
  const exclude = [];
  if (all) {
    for (const b of await git.listBranches(base(repo))) tips.push(await revParse(repo, `refs/heads/${b}`));
    for (const r of await git.listRemotes(base(repo)).catch(() => [])) {
      for (const b of await git.listBranches({ ...base(repo), remote: r.remote }).catch(() => [])) {
        if (b !== 'HEAD') tips.push(await revParse(repo, `refs/remotes/${r.remote}/${b}`));
      }
    }
    const h = await headOid(repo);
    if (h) tips.push(h);
  }
  for (const r of revs) {
    const range = r.match(/^(.*)\.\.(.*)$/);
    if (range) {
      const a = await revParse(repo, range[1] || 'HEAD');
      const b = await revParse(repo, range[2] || 'HEAD');
      if (!a || !b) die(ctx, `ambiguous argument '${r}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
      tips.push(b); exclude.push(a);
      continue;
    }
    const oid = await revParse(repo, r);
    if (!oid) {
      die(ctx, `ambiguous argument '${r}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
    }
    tips.push(oid);
  }
  if (!tips.length) {
    const h = await headOid(repo);
    if (!h) {
      const b = await currentBranch(repo);
      die(ctx, `your current branch '${b}' does not have any commits yet`);
    }
    tips.push(h);
  }

  let list = await revList(repo, [...new Set(tips.filter(Boolean))], { exclude });
  if (paths.length) {
    const rels = paths.map(p => repoPath(ctx, repo, p)).filter(Boolean);
    const kept = [];
    for (const item of list) {
      const before = await treeFiles(repo, item.commit.parent[0] || null);
      const after = await treeFiles(repo, item.oid);
      const touched = rels.some(rel => [...new Set([...before.keys(), ...after.keys()])]
        .some(p => (p === rel || p.startsWith(rel + '/')) && before.get(p)?.oid !== after.get(p)?.oid));
      if (touched) kept.push(item);
    }
    list = kept;
  }
  if (graph) list = topoOrder(list);
  list = list.slice(0, limit);
  const decos = await decorations(repo);
  const c = ctx.out.c;
  const rows = graph ? graphRows(list, c) : null;
  const out = [];
  for (let n = 0; n < list.length; n++) {
    const item = list[n];
    const last = n === list.length - 1;
    let lines;
    if (oneline) {
      lines = [c.yellow(oneline === 'full' ? item.oid : short(item.oid)) + decorate(c, decos.get(item.oid)) + ' ' + item.commit.message.split('\n')[0]];
    } else {
      lines = header(c, item, decos).replace(/\n$/, '').split('\n');
      if ((patch || stat) && item.commit.parent.length <= 1) {
        const d = await commitDiff(c, repo, item);
        if (stat) {
          const st = diffstat(c, d.list, ctx.cols).split('\n').filter(l => l && !/^ (create|delete) mode/.test(l));
          if (st.length) lines.push('', ...st);
        }
        if (patch && d.text) lines.push('', ...d.text.replace(/\n$/, '').split('\n'));
      }
      if (!last) lines.push('');
    }
    if (!rows) { out.push(...lines); continue; }
    const r = rows[n];
    const prefixes = [r.first, ...r.connectors];
    lines.forEach((l, k) => out.push(((k < prefixes.length ? prefixes[k] : r.cont) + l).replace(/\s+$/, '')));
    for (let k = lines.length; k < prefixes.length; k++) out.push(prefixes[k].replace(/\s+$/, ''));
  }
  if (out.length) ctx.out.write(out.join('\n') + '\n');
  ctx.observe('log', { oneline: !!oneline, count: list.length, head: await headOid(repo), patch, all });
  return 0;
}

// ---------- git show ----------

export async function show(ctx, args) {
  const repo = await openRepo(ctx);
  const specs = args.filter(a => !a.startsWith('-'));
  const c = ctx.out.c;
  if (!specs.length) specs.push('HEAD');
  const decos = await decorations(repo);
  const blocks = [];
  for (const spec of specs) {
    // rev:path shows a file as it was in that commit.
    const colon = spec.indexOf(':');
    if (colon >= 0) {
      const rev = spec.slice(0, colon) || null;
      const path = spec.slice(colon + 1).replace(/^\.\//, '');
      const oid = rev ? await revParse(repo, rev) : null;
      if (rev && !oid) die(ctx, `invalid object name '${rev}'.`);
      let files;
      if (oid) files = await treeFiles(repo, oid);
      else files = await indexFiles(repo);
      const entry = files.get(path);
      if (!entry) die(ctx, rev ? `path '${path}' does not exist in '${rev}'` : `path '${path}' does not exist (neither on disk nor in the index)`);
      blocks.push(await readBlobText(repo, entry.oid));
      continue;
    }
    const oid = await revParse(repo, spec);
    if (!oid) {
      if (spec === 'HEAD') {
        die(ctx, "ambiguous argument 'HEAD': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'");
      }
      die(ctx, `ambiguous argument '${spec}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
    }
    const type = await objectType(repo, oid);
    if (type === 'blob') { blocks.push(await readBlobText(repo, oid)); continue; }
    if (type === 'tree') {
      const { tree } = await git.readTree({ ...base(repo), oid });
      blocks.push(`tree ${spec}\n\n` + tree.map(e => e.path + (e.type === 'tree' ? '/' : '')).join('\n') + '\n');
      continue;
    }
    const commit = await readCommit(repo, oid);
    const item = { oid, commit };
    let text = header(c, item, decos);
    if (commit.parent.length <= 1) {
      const d = await commitDiff(c, repo, item);
      if (d.text) text += '\n' + d.text;
      ctx.observe('show', { oid, files: d.list.map(x => x.path) });
    } else {
      ctx.observe('show', { oid, files: [] });
    }
    blocks.push(text);
  }
  ctx.out.write(blocks.join('\n'));
  return 0;
}

// ---------- git diff ----------

export async function diff(ctx, args) {
  const repo = await openRepo(ctx);
  let staged = false, statOnly = false, nameOnly = false;
  const revs = [], paths = [];
  let afterDashes = false;
  for (const a of args) {
    if (afterDashes) { paths.push(a); continue; }
    if (a === '--') afterDashes = true;
    else if (a === '--staged' || a === '--cached') staged = true;
    else if (a === '--stat') statOnly = true;
    else if (a === '--name-only') nameOnly = true;
    else if (a.startsWith('-')) { ctx.err.write(`error: invalid option: ${a}\n`); throw new Exit(129); }
    else revs.push(a);
  }
  // Separate revisions from paths when no "--" is given.
  const realRevs = [];
  for (const r of revs) {
    const range = r.match(/^(.*?)\.\.(.*)$/);
    if (range) { realRevs.push(range[1] || 'HEAD', range[2] || 'HEAD'); continue; }
    if (await revParse(repo, r)) realRevs.push(r);
    else {
      const rel = repoPath(ctx, repo, r);
      const known = rel !== null && (await pfs.stat(join(repo.dir, rel)).then(() => true, () => false));
      if (!known) {
        die(ctx, `ambiguous argument '${r}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
      }
      paths.push(r);
    }
  }
  const relPaths = paths.map(p => repoPath(ctx, repo, p)).filter(p => p !== null);
  const inPaths = p => !relPaths.length || relPaths.some(r => r === '.' || p === r || p.startsWith(r + '/'));

  const reader = blobReader(repo);
  const workReader = async p => await pfs.readFile(join(repo.dir, p));
  let aMap, bMap, readA = reader, readB = reader;
  const unmerged = await unmergedPaths(repo);

  if (realRevs.length >= 2) {
    aMap = await treeFiles(repo, await revParse(repo, realRevs[0]));
    bMap = await treeFiles(repo, await revParse(repo, realRevs[1]));
  } else if (realRevs.length === 1) {
    aMap = await treeFiles(repo, await revParse(repo, realRevs[0]));
    if (staged) bMap = await indexFiles(repo);
    else { bMap = await workingFiles(repo); readB = workReader; }
  } else if (staged) {
    aMap = await treeFiles(repo, await headOid(repo));
    bMap = await indexFiles(repo);
    for (const u of unmerged) { aMap.delete(u); bMap.delete(u); }
  } else {
    aMap = await indexFiles(repo);
    bMap = await workingFiles(repo, aMap);
    readB = workReader;
    for (const u of unmerged) { aMap.delete(u); bMap.delete(u); }
  }
  for (const m of [aMap, bMap]) for (const k of [...m.keys()]) if (!inPaths(k)) m.delete(k);
  const list = await changes(aMap, bMap, readA, readB);
  const c = ctx.out.c;
  let text = '';
  if (!staged && !realRevs.length) for (const u of unmerged) if (inPaths(u)) text += `* Unmerged path ${u}\n`;
  if (nameOnly) text += list.map(x => x.path).join('\n') + (list.length ? '\n' : '');
  else if (statOnly) text += diffstat(c, list, ctx.cols).split('\n').filter(l => !/^ (create|delete) mode/.test(l)).join('\n');
  else text += list.map(ch => fileDiff(c, ch.path, ch.a, ch.b)).join('');
  if (text) ctx.out.write(text);
  ctx.observe('diff', {
    staged: staged && realRevs.length === 0,
    unstaged: !staged && realRevs.length === 0,
    revs: realRevs.length,
    files: list.map(x => x.path),
    empty: list.length === 0,
  });
  return 0;
}

// Working tree files that Git would compare: tracked paths only.
async function workingFiles(repo, indexMap) {
  const idx = indexMap || await indexFiles(repo);
  const map = new Map();
  for (const [p, e] of idx) {
    let bytes;
    try { bytes = await pfs.readFile(join(repo.dir, p)); } catch { continue; }
    map.set(p, { oid: await hashText(bytes), mode: e.mode });
  }
  return map;
}

export { readBlobBytes, computeStatus };
