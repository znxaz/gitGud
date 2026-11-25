import LightningFS from '@isomorphic-git/lightning-fs';
import git from 'isomorphic-git';

// The name must never change between releases, or every learner's work is lost on refresh.
export const FS_NAME = 'git-lab';
export const fs = new LightningFS(FS_NAME);
export const pfs = fs.promises;

export const HOME = '/';
export const PROJECT = '/project';
export const REMOTE = '/remote/origin.git';
export const GLOBAL_CONFIG = '/.gitconfig';

// ---------- paths ----------

export function normalize(p) {
  const abs = p.startsWith('/');
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
}

export function resolve(cwd, p) {
  if (p === '~' || p.startsWith('~/')) p = HOME + p.slice(1);
  return normalize(p.startsWith('/') ? p : cwd + '/' + p);
}

export function join(...parts) {
  return normalize(parts.join('/'));
}

export function dirname(p) {
  const n = normalize(p);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '/' : n.slice(0, i);
}

export function basename(p) {
  const n = normalize(p);
  return n.slice(n.lastIndexOf('/') + 1);
}

export function relative(from, to) {
  const a = normalize(from).split('/').filter(Boolean);
  const b = normalize(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = a.slice(i).map(() => '..');
  return [...up, ...b.slice(i)].join('/') || '.';
}

// Display a path the way bash does in the prompt.
export function tildify(p) {
  if (p === HOME) return '~';
  if (HOME === '/') return '~' + p;
  return p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p;
}

// ---------- helpers ----------

export async function stat(p) {
  try { return await pfs.stat(p); } catch { return null; }
}

export async function exists(p) {
  return (await stat(p)) !== null;
}

export async function isDir(p) {
  const s = await stat(p);
  return !!s && s.isDirectory();
}

export async function readText(p) {
  return await pfs.readFile(p, 'utf8');
}

export async function writeText(p, text) {
  await pfs.writeFile(p, text, 'utf8');
}

export async function mkdirp(p) {
  const parts = normalize(p).split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += '/' + part;
    const s = await stat(cur);
    if (!s) await pfs.mkdir(cur);
    else if (!s.isDirectory()) throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
  }
}

export async function rmrf(p) {
  const s = await stat(p);
  if (!s) return;
  if (s.isDirectory()) {
    for (const name of await pfs.readdir(p)) await rmrf(p + '/' + name);
    await pfs.rmdir(p);
  } else {
    await pfs.unlink(p);
  }
}

export async function readdirSafe(p) {
  try { return await pfs.readdir(p); } catch { return []; }
}

export async function flush() {
  try { await pfs.flush(); } catch { /* nothing to flush */ }
}

// ---------- starting state ----------

export const SEED_FILES = {
  'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Study Planner</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <h1>Study Planner</h1>
    <p class="tagline">Plan your week. Add a task, then mark it done.</p>
  </header>

  <main>
    <form id="add-form">
      <input id="new-task" type="text" placeholder="New task" autocomplete="off">
      <button type="submit">Add</button>
    </form>
    <ul id="tasks">
      <li>Read chapter 3</li>
      <li>Finish the lab report</li>
    </ul>
    <p id="count"></p>
  </main>

  <footer>Made by the CS lab group.</footer>

  <script src="script.js"></script>
</body>
</html>
`,
  'style.css': `body {
  font-family: Arial, Helvetica, sans-serif;
  background: #f4f4f4;
  color: #222222;
  margin: 0;
  padding: 24px;
}

header {
  border-bottom: 2px solid #2b6cb0;
  margin-bottom: 16px;
}

h1 {
  color: #2b6cb0;
  margin: 0 0 4px 0;
}

.tagline {
  color: #555555;
  margin: 0 0 12px 0;
}

form {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

input {
  flex: 1;
  padding: 6px;
}

li {
  cursor: pointer;
  padding: 4px 0;
}

li.done {
  text-decoration: line-through;
  color: #888888;
}

footer {
  margin-top: 24px;
  font-size: 13px;
  color: #777777;
}
`,
  'script.js': `const form = document.getElementById('add-form');
const input = document.getElementById('new-task');
const list = document.getElementById('tasks');
const count = document.getElementById('count');

function updateCount() {
  const total = list.children.length;
  const done = list.querySelectorAll('li.done').length;
  count.textContent = done + ' of ' + total + ' tasks done';
}

form.addEventListener('submit', function (event) {
  event.preventDefault();
  const text = input.value.trim();
  if (text === '') return;
  const item = document.createElement('li');
  item.textContent = text;
  list.appendChild(item);
  input.value = '';
  updateCount();
});

list.addEventListener('click', function (event) {
  if (event.target.tagName === 'LI') {
    event.target.classList.toggle('done');
    updateCount();
  }
});

updateCount();
`,
  'README.md': `# Study Planner

A small web page for planning study tasks.

## Files

- index.html: the page
- style.css: colours and layout
- script.js: adds tasks and marks them done

Open the preview to see the page.
`,
};

// Lab machine defaults. These are set on the lab computers, not by the learner.
export const SEED_GLOBAL_CONFIG = `[init]
\tdefaultBranch = main
[pull]
\trebase = false
`;

export const SEED_HEADING = 'Study Planner';

export async function seed() {
  await mkdirp(PROJECT);
  for (const [name, text] of Object.entries(SEED_FILES)) {
    await writeText(`${PROJECT}/${name}`, text);
  }
  await writeText(GLOBAL_CONFIG, SEED_GLOBAL_CONFIG);
  await mkdirp(REMOTE);
  // An empty bare repository, like a new repository on a hosting site.
  await git.init({ fs, dir: REMOTE, gitdir: REMOTE, bare: true, defaultBranch: 'main' });
  await flush();
}

export async function ensureSeeded() {
  const root = await readdirSafe('/');
  if (root.length === 0) await seed();
}

export async function wipeAndSeed() {
  await fs.init(FS_NAME, { wipe: true });
  await seed();
}
