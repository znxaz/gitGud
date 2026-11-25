import * as monaco from './monaco-entry.js';
// Relative path on purpose: Vite's dev pre-bundler breaks "?worker" imports that go through an alias.
import EditorWorker from '../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker';
import { readText, writeText, exists, basename, dirname, tildify } from '../vfs.js';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

monaco.editor.defineTheme('git-lab-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1f1f1f',
    'editor.lineHighlightBackground': '#2a2d2e80',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#cccccc',
    'editorGutter.background': '#1f1f1f',
    'editorWidget.background': '#202020',
    'editorWidget.border': '#313131',
    'focusBorder': '#0078d4',
    'scrollbarSlider.background': '#79797966',
  },
});

const SAVE_DELAY = 400;

// ---------- merge conflicts ----------

// Each conflict block: line numbers of <<<<<<<, ======= and >>>>>>>.
function findConflicts(model) {
  const blocks = [];
  const n = model.getLineCount();
  for (let i = 1; i <= n; i++) {
    if (!model.getLineContent(i).startsWith('<<<<<<<')) continue;
    let mid = -1, end = -1;
    for (let j = i + 1; j <= n; j++) {
      const line = model.getLineContent(j);
      if (mid < 0 && line.startsWith('=======')) mid = j;
      else if (mid > 0 && line.startsWith('>>>>>>>')) { end = j; break; }
    }
    if (mid < 0 || end < 0) break;
    blocks.push({ start: i, mid, end });
    i = end;
  }
  return blocks;
}

// Replace one conflict block with the chosen side(s), like VS Code's
// "Accept Current Change", "Accept Incoming Change" and "Accept Both Changes".
function acceptConflict(model, startLine, choice) {
  const block = findConflicts(model).find(b => b.start === startLine);
  if (!block) return;
  const lines = from => to => {
    const out = [];
    for (let l = from; l <= to; l++) out.push(model.getLineContent(l));
    return out;
  };
  const current = lines(block.start + 1)(block.mid - 1);
  const incoming = lines(block.mid + 1)(block.end - 1);
  const keep = choice === 'current' ? current : choice === 'incoming' ? incoming : [...current, ...incoming];
  const last = model.getLineCount();
  let range, text;
  if (keep.length) {
    range = new monaco.Range(block.start, 1, block.end, model.getLineMaxColumn(block.end));
    text = keep.join('\n');
  } else if (block.end < last) {
    range = new monaco.Range(block.start, 1, block.end + 1, 1);
    text = '';
  } else {
    range = new monaco.Range(block.start, 1, block.end, model.getLineMaxColumn(block.end));
    text = '';
  }
  model.pushEditOperations([], [{ range, text }], () => null);
}

for (const choice of ['current', 'incoming', 'both']) {
  monaco.editor.registerCommand(`git-lab.accept-${choice}`, (_accessor, uri, line) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model) acceptConflict(model, line, choice);
  });
}

monaco.languages.registerCodeLensProvider(['html', 'css', 'javascript', 'markdown', 'ini', 'plaintext'], {
  provideCodeLenses(model) {
    const lenses = [];
    for (const b of findConflicts(model)) {
      const range = new monaco.Range(b.start, 1, b.start, 1);
      const args = [model.uri.toString(), b.start];
      lenses.push(
        { range, command: { id: 'git-lab.accept-current', title: 'Accept Current Change', arguments: args } },
        { range, command: { id: 'git-lab.accept-incoming', title: 'Accept Incoming Change', arguments: args } },
        { range, command: { id: 'git-lab.accept-both', title: 'Accept Both Changes', arguments: args } },
      );
    }
    return { lenses, dispose() {} };
  },
  resolveCodeLens(_model, lens) { return lens; },
});

const LANGS = {
  html: ['html', 'HTML'], htm: ['html', 'HTML'], css: ['css', 'CSS'], js: ['javascript', 'JavaScript'],
  md: ['markdown', 'Markdown'], gitconfig: ['ini', 'Git Config'], ini: ['ini', 'Ini'],
};

export function languageOf(path) {
  const name = basename(path);
  if (name === '.gitconfig' || name === 'config') return LANGS.gitconfig;
  if (name === '.gitignore') return ['plaintext', 'Ignore'];
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return LANGS[ext] || ['plaintext', 'Plain Text'];
}

export class Editors {
  constructor({ container, tabsEl, emptyEl, onSaved, onActive, onCursor }) {
    this.tabsEl = tabsEl;
    this.emptyEl = emptyEl;
    this.onSaved = onSaved;
    this.onActive = onActive;
    this.onCursor = onCursor;
    this.tabs = [];
    this.active = null;
    this.applying = false;
    this.editor = monaco.editor.create(container, {
      model: null,
      theme: 'git-lab-dark',
      fontFamily: "Consolas, 'Cascadia Mono', 'Courier New', monospace",
      fontSize: 14,
      lineHeight: 19,
      tabSize: 2,
      insertSpaces: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      wordWrap: 'off',
      smoothScrolling: false,
      cursorBlinking: 'blink',
      padding: { top: 4 },
      fixedOverflowWidgets: true,
    });
    this.editor.onDidChangeCursorPosition(e => this.onCursor(e.position));
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.flush());
    this.updateEmpty();
  }

  find(path) { return this.tabs.find(t => t.path === path); }

  async open(path) {
    let tab = this.find(path);
    if (!tab) {
      let text;
      try { text = await readText(path); } catch { return; }
      const [lang] = languageOf(path);
      const model = monaco.editor.createModel(text, lang, monaco.Uri.file(path));
      // Git hashes depend on line endings: always LF, like the files on disk.
      model.setEOL(monaco.editor.EndOfLineSequence.LF);
      tab = { path, model, viewState: null, dirty: false, timer: null, conflicts: [] };
      this.markConflicts(tab);
      model.onDidChangeContent(() => {
        this.markConflicts(tab);
        if (this.applying) return;
        tab.dirty = true;
        this.renderTabs();
        clearTimeout(tab.timer);
        tab.timer = setTimeout(() => this.save(tab), SAVE_DELAY);
      });
      this.tabs.push(tab);
    }
    this.activate(tab);
  }

  // Colour conflict regions the way VS Code does. The markers are plain text:
  // the learner edits them or uses the Accept links above each conflict.
  markConflicts(tab) {
    const model = tab.model;
    const decos = [];
    const whole = (from, to, className, label) => {
      if (to < from) return;
      decos.push({ range: new monaco.Range(from, 1, to, 1), options: { isWholeLine: true, className } });
      if (label) {
        const end = model.getLineMaxColumn(from);
        decos.push({ range: new monaco.Range(from, 1, from, end), options: { afterContentClassName: label } });
      }
    };
    for (const { start, mid, end } of findConflicts(model)) {
      whole(start, start, 'conflict-current-header', 'conflict-label-current');
      whole(start + 1, mid - 1, 'conflict-current');
      whole(mid + 1, end - 1, 'conflict-incoming');
      whole(end, end, 'conflict-incoming-header', 'conflict-label-incoming');
    }
    tab.conflicts = model.deltaDecorations(tab.conflicts, decos);
  }

  activate(tab) {
    if (this.active && this.active !== tab) this.active.viewState = this.editor.saveViewState();
    this.active = tab;
    this.editor.setModel(tab ? tab.model : null);
    if (tab && tab.viewState) this.editor.restoreViewState(tab.viewState);
    this.renderTabs();
    this.updateEmpty();
    this.onActive(tab ? tab.path : null);
    if (tab) this.editor.focus();
  }

  async close(tab) {
    if (tab.dirty) await this.save(tab);
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    if (this.active === tab) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)] || null);
    tab.model.dispose();
    this.renderTabs();
  }

  async save(tab) {
    clearTimeout(tab.timer);
    tab.timer = null;
    if (!tab.dirty) return;
    tab.dirty = false;
    try {
      await writeText(tab.path, tab.model.getValue());
    } catch (err) {
      console.error('save failed', err);
      tab.dirty = true;
    }
    this.renderTabs();
    await this.onSaved(tab.path);
  }

  // Save everything now. Called before every shell command.
  async flush() {
    for (const t of this.tabs) if (t.dirty) await this.save(t);
  }

  // The shell or Git may have changed files: update open tabs to match the disk.
  async syncFromDisk() {
    for (const tab of [...this.tabs]) {
      if (tab.dirty) continue;
      if (!(await exists(tab.path))) { await this.closeWithoutSave(tab); continue; }
      let text;
      try { text = await readText(tab.path); } catch { continue; }
      if (text === tab.model.getValue()) continue;
      this.applying = true;
      try {
        // An edit operation keeps undo history and the cursor where possible.
        tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text }], () => null);
      } finally {
        this.applying = false;
      }
    }
  }

  async closeWithoutSave(tab) {
    clearTimeout(tab.timer);
    tab.dirty = false;
    await this.close(tab);
  }

  updateEmpty() {
    this.emptyEl.hidden = !!this.active;
  }

  renderTabs() {
    const el = this.tabsEl;
    el.textContent = '';
    const names = this.tabs.map(t => basename(t.path));
    for (const tab of this.tabs) {
      const div = document.createElement('div');
      div.className = 'tab' + (tab === this.active ? ' active' : '') + (tab.dirty ? ' dirty' : '');
      div.setAttribute('role', 'tab');
      div.setAttribute('aria-selected', tab === this.active ? 'true' : 'false');
      div.title = tab.path;
      const name = document.createElement('span');
      name.textContent = basename(tab.path);
      div.appendChild(name);
      // Same name open twice: show the folder, like VS Code.
      if (names.filter(n => n === basename(tab.path)).length > 1) {
        const d = document.createElement('span');
        d.className = 'dir';
        d.textContent = tildify(dirname(tab.path));
        div.appendChild(d);
      }
      const close = document.createElement('button');
      close.className = 'close';
      close.type = 'button';
      close.setAttribute('aria-label', 'Close ' + basename(tab.path));
      close.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="m8 8.71 3.65 3.65.7-.7L8.71 8l3.64-3.65-.7-.7L8 7.29 4.35 3.65l-.7.7L7.29 8l-3.64 3.65.7.7L8 8.71Z"/></svg>';
      close.addEventListener('click', e => { e.stopPropagation(); this.close(tab); });
      div.addEventListener('click', () => this.activate(tab));
      div.addEventListener('auxclick', e => { if (e.button === 1) this.close(tab); });
      el.appendChild(div);
      if (tab === this.active) requestAnimationFrame(() => div.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    }
  }

  layout() { this.editor.layout(); }
}
