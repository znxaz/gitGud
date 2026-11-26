import { readdirSafe, stat, exists, isDir, mkdirp, writeText, dirname, join, PROJECT } from '../vfs.js';

const KEY = 'git-lab:tree-open';
const CHEVRON = '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M5.7 13.7 5 13l4.6-4.6L5 3.7l.7-.7 5.3 5.3-5.3 5.4Z"/></svg>';

const sortEntries = list => list.sort((a, b) => {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
});

const extClass = name => {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return { html: 'html', css: 'css', js: 'js', md: 'md' }[ext] || '';
};
const extLabel = name => ({ html: '<>', css: '#', js: 'JS', md: 'M↓' }[extClass(name)] || '');

export class FileTree {
  constructor(el, { onOpen, onCreate }) {
    this.el = el;
    this.onOpen = onOpen;
    this.onCreate = onCreate;
    this.activePath = null;
    this.selectedDir = PROJECT; // where New File puts the file
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY)); } catch { /* none */ }
    this.open = new Set(saved || [PROJECT]);
    this.busy = null;
    el.addEventListener('click', e => this.onClick(e));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.onClick(e); }
    });
  }

  saveOpen() {
    try { localStorage.setItem(KEY, JSON.stringify([...this.open])); } catch { /* full */ }
  }

  async onClick(e) {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    const path = row.dataset.path;
    if (row.dataset.kind === 'dir') {
      this.selectedDir = path;
      if (this.open.has(path)) this.open.delete(path); else this.open.add(path);
      this.saveOpen();
      await this.refresh();
      this.el.querySelector(`[data-path="${CSS.escape(path)}"]`)?.focus();
    } else if (row.dataset.kind === 'file') {
      this.selectedDir = dirname(path);
      this.onOpen(path);
    }
  }

  // ---------- New File ----------

  // Show a name box inside the selected folder, like VS Code's New File.
  async startNewFile() {
    let dir = this.selectedDir;
    if (!(await isDir(dir))) dir = (await isDir(PROJECT)) ? PROJECT : '/';
    if (dir !== '/') { this.open.add(dir); this.saveOpen(); }
    await this.refresh();

    const depth = dir === '/' ? 0 : dir.split('/').filter(Boolean).length;
    const row = document.createElement('div');
    row.className = 'tree-row editing';
    row.style.paddingLeft = `${8 + depth * 12}px`;
    const spacer = document.createElement('span');
    spacer.className = 'twistie';
    const input = document.createElement('input');
    input.className = 'tree-input';
    input.type = 'text';
    input.id = 'new-file-name';
    input.setAttribute('aria-label', `New file name in ${dir}`);
    input.spellcheck = false;
    input.autocomplete = 'off';
    row.append(spacer, input);
    const msg = document.createElement('div');
    msg.className = 'tree-msg';
    msg.style.marginLeft = `${8 + depth * 12 + 16}px`;
    msg.hidden = true;

    // Put the box first inside the folder, or at the top for the root.
    const folderRow = dir === '/' ? null : this.el.querySelector(`.tree-row[data-path="${CSS.escape(dir)}"]`);
    if (folderRow) folderRow.after(row, msg);
    else this.el.prepend(row, msg);
    input.focus();

    let done = false;
    const finish = () => { done = true; row.remove(); msg.remove(); };
    const check = async () => {
      const name = input.value.trim();
      if (!name) return null;
      if (/[\\:*?"<>|]/.test(name)) return 'A file name cannot contain \\ : * ? " < > |';
      const parts = name.split('/').filter(Boolean);
      if (!parts.length || name.startsWith('/')) return 'Type a file name, for example notes.txt';
      if (parts.some(p => p === '.' || p === '..')) return 'A file name cannot be . or ..';
      if (parts.includes('.git')) return 'Git uses the name .git. Choose another name.';
      if (await exists(join(dir, name))) return `A file or folder called ${name} is already here.`;
      return '';
    };
    const create = async () => {
      if (done) return;
      const problem = await check();
      if (problem === null) { finish(); return; }
      if (problem) { msg.textContent = problem; msg.hidden = false; input.focus(); return; }
      const path = join(dir, input.value.trim());
      finish();
      await mkdirp(dirname(path));
      await writeText(path, '');
      // Expand every folder down to the new file so it is visible.
      for (let d = dirname(path); d !== '/' && !this.open.has(d); d = dirname(d)) this.open.add(d);
      this.saveOpen();
      await this.refresh();
      await this.onCreate(path);
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation(); // the tree's own Enter handling must not run
      if (e.key === 'Enter') { e.preventDefault(); create(); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(); }
    });
    input.addEventListener('input', () => { msg.hidden = true; });
    input.addEventListener('blur', () => {
      // Clicking away creates the file if the name is good, otherwise cancels.
      setTimeout(async () => {
        if (done) return;
        const problem = await check();
        if (problem) finish(); else create();
      }, 0);
    });
  }

  setActive(path) {
    this.activePath = path;
    for (const r of this.el.querySelectorAll('.tree-row')) r.classList.toggle('active', r.dataset.path === path);
  }

  // Rebuild the tree from the filesystem. Several calls in a row share one rebuild.
  refresh() {
    if (this.busy) { this.again = true; return this.busy; }
    this.busy = (async () => {
      do {
        this.again = false;
        const frag = document.createDocumentFragment();
        await this.renderDir('/', 0, frag);
        this.el.textContent = '';
        this.el.appendChild(frag);
      } while (this.again);
      this.busy = null;
    })();
    return this.busy;
  }

  async renderDir(dir, depth, into) {
    const names = await readdirSafe(dir);
    const entries = [];
    for (const name of names) {
      if (name === '.git') continue; // hidden, as in VS Code
      const path = (dir === '/' ? '' : dir) + '/' + name;
      const s = await stat(path);
      if (!s) continue;
      entries.push({ name, path, dir: s.isDirectory() });
    }
    for (const e of sortEntries(entries)) {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.dataset.path = e.path;
      row.tabIndex = 0;
      row.setAttribute('role', 'treeitem');
      row.style.paddingLeft = `${8 + depth * 12}px`;
      if (e.name.startsWith('.')) row.classList.add('dotfile');
      if (e.path === this.activePath) row.classList.add('active');
      // A bare repository's internals are not shown.
      const bare = e.dir && e.name.endsWith('.git') && await exists(e.path + '/HEAD');
      const twistie = document.createElement('span');
      twistie.className = 'twistie';
      const label = document.createElement('span');
      label.className = 'name';
      label.textContent = e.name;
      if (e.dir && !bare) {
        row.dataset.kind = 'dir';
        twistie.innerHTML = CHEVRON;
        const isOpen = this.open.has(e.path);
        row.classList.toggle('open', isOpen);
        row.setAttribute('aria-expanded', String(isOpen));
        row.append(twistie, label);
        into.appendChild(row);
        if (isOpen) await this.renderDir(e.path, depth + 1, into);
      } else if (bare) {
        row.dataset.kind = 'bare';
        row.classList.add('leaf-dir');
        row.title = 'A bare repository. Git uses it as the remote.';
        row.append(twistie, label);
        into.appendChild(row);
      } else {
        row.dataset.kind = 'file';
        const ext = document.createElement('span');
        ext.className = 'ext ' + extClass(e.name);
        ext.textContent = extLabel(e.name);
        twistie.style.width = '4px';
        row.append(twistie, ext, label);
        into.appendChild(row);
      }
    }
  }
}
