import './polyfill.js';
import './style.css';
import { ensureSeeded, wipeAndSeed, flush, PROJECT, tildify } from './vfs.js';
import { LabTerminal, clearHistory } from './shell/terminal.js';
import { createShell } from './shell/shell.js';
import { TaskRunner, observe, clearProgress } from './tasks.js';
import { Editors, languageOf } from './ui/editor.js';
import { FileTree } from './ui/filetree.js';
import { Preview } from './ui/preview.js';
import { TaskPanel } from './ui/taskpanel.js';

const $ = id => document.getElementById(id);
const LAYOUT_KEY = 'git-lab:layout';
const BRANCH_ICON = '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M5 3.5a1.5 1.5 0 1 1-2 1.41v6.18a1.5 1.5 0 1 1 1 0V9.2c.4.35 1 .6 1.9.6h2.2c1.3 0 2.1-.7 2.3-1.85a1.5 1.5 0 1 1 1-.02C11.17 9.6 9.87 10.8 8.1 10.8H5.9c-.75 0-1.4-.2-1.9-.55V4.91A1.5 1.5 0 0 1 5 3.5Zm-1.5.5a.5.5 0 1 0 1 0 .5.5 0 0 0-1 0Zm0 8.5a.5.5 0 1 0 1 0 .5.5 0 0 0-1 0Zm8-5.5a.5.5 0 1 0 1 0 .5.5 0 0 0-1 0Z"/></svg>';

function loadLayout() {
  try { return { terminalHeight: null, tasks: true, preview: false, ...JSON.parse(localStorage.getItem(LAYOUT_KEY)) }; } catch { return { terminalHeight: null, tasks: true, preview: false }; }
}
const layout = loadLayout();
const saveLayout = () => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* full */ } };

async function start() {
  await ensureSeeded();

  let panel = null;
  const runner = new TaskRunner(ids => panel && panel.completed(ids));

  const tree = new FileTree($('tree'), {
    onOpen: path => editors.open(path),
    // A file made with the New File button: save it, open it, update the strip and tasks.
    onCreate: async path => {
      await flush();
      await editors.open(path);
      await refreshState();
    },
  });
  $('btn-new-file').addEventListener('click', () => tree.startNewFile());

  const editors = new Editors({
    container: $('editor'),
    tabsEl: $('tabs'),
    emptyEl: $('editor-empty'),
    onSaved: async () => {
      await flush();
      preview.schedule();
      await refreshState();
    },
    onActive: path => {
      tree.setActive(path);
      $('sb-lang').textContent = path ? languageOf(path)[1] : '';
      $('sb-cursor').textContent = path ? 'Ln 1, Col 1' : '';
      $('window-title').textContent = path ? `${path.split('/').pop()} - ${tildify(path.slice(0, path.lastIndexOf('/')) || '/')}` : 'project';
    },
    onCursor: pos => { $('sb-cursor').textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`; },
  });

  const preview = new Preview({ pane: $('preview-pane'), frame: $('preview-frame'), missing: $('preview-missing') });

  // Everything that depends on repository state, refreshed after each command or save.
  async function refreshState() {
    const { branch } = await panel.updateStrip();
    $('sb-branch').innerHTML = branch ? `${BRANCH_ICON}<span>${branch}</span>` : '';
    await runner.evaluate();
  }

  let term;
  const shell = createShell({
    getCols: () => term.cols,
    clearScreen: () => term.clear(),
    observe,
    getHistory: () => term.history,
    afterCommand: async () => {
      await flush();
      await tree.refresh();
      await editors.syncFromDisk();
      preview.schedule();
      await refreshState();
    },
  });

  term = new LabTerminal($('terminal'), {
    prompt: () => shell.prompt(),
    complete: before => shell.complete(before),
    run: async line => {
      await editors.flush();
      await shell.runLine(line, { write: s => term.write(s) });
    },
  });

  panel = new TaskPanel({
    runner,
    listEl: $('task-list'),
    stripEl: $('state-strip'),
    nudgeEl: $('nudge'),
    countEl: $('task-count'),
    teammateBtn: $('btn-teammate'),
    teammateNote: $('teammate-note'),
    getCwd: () => shell.state.cwd,
    afterTeammate: async () => { await flush(); await refreshState(); },
  });

  await tree.refresh();
  await refreshState();
  term.write('\x1b[2mType help to see the commands.\x1b[0m\r\n');
  term.showPrompt();
  term.focus();

  // ---------- layout controls ----------
  const wb = $('workbench');
  const setTasks = on => {
    layout.tasks = on;
    wb.classList.toggle('tasks-hidden', !on);
    $('btn-tasks').setAttribute('aria-pressed', String(on));
    saveLayout();
  };
  const setPreview = on => {
    layout.preview = on;
    $('editor-area').classList.toggle('with-preview', on);
    $('btn-preview').setAttribute('aria-pressed', String(on));
    preview.setVisible(on);
    saveLayout();
  };
  setTasks(layout.tasks);
  setPreview(layout.preview);
  $('btn-tasks').addEventListener('click', () => setTasks(!layout.tasks));
  $('btn-tasks-close').addEventListener('click', () => setTasks(false));
  $('btn-preview').addEventListener('click', () => setPreview(!layout.preview));
  $('btn-preview-reload').addEventListener('click', () => preview.refresh());

  // Terminal height: about 30% by default, drag the sash to resize.
  const panelEl = $('panel');
  const center = $('center');
  const applyHeight = h => {
    const max = center.clientHeight - 140;
    panelEl.style.height = Math.max(120, Math.min(max, h)) + 'px';
  };
  if (layout.terminalHeight) applyHeight(layout.terminalHeight);
  const sash = $('sash');
  sash.addEventListener('pointerdown', e => {
    e.preventDefault();
    sash.setPointerCapture(e.pointerId);
    sash.classList.add('dragging');
    const startY = e.clientY;
    const startH = panelEl.getBoundingClientRect().height;
    const move = ev => applyHeight(startH + (startY - ev.clientY));
    const up = () => {
      sash.classList.remove('dragging');
      sash.removeEventListener('pointermove', move);
      sash.removeEventListener('pointerup', up);
      layout.terminalHeight = panelEl.getBoundingClientRect().height;
      saveLayout();
    };
    sash.addEventListener('pointermove', move);
    sash.addEventListener('pointerup', up);
  });
  sash.addEventListener('dblclick', () => { panelEl.style.height = ''; layout.terminalHeight = null; saveLayout(); });
  $('panel').addEventListener('mousedown', () => setTimeout(() => term.focus(), 0));

  // ---------- reset ----------
  const backdrop = $('dialog-backdrop');
  const closeDialog = () => { backdrop.hidden = true; $('btn-reset').focus(); };
  $('btn-reset').addEventListener('click', () => { backdrop.hidden = false; $('dialog-cancel').focus(); });
  $('dialog-cancel').addEventListener('click', closeDialog);
  backdrop.addEventListener('keydown', e => { if (e.key === 'Escape') closeDialog(); });
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) closeDialog(); });
  $('dialog-ok').addEventListener('click', async () => {
    $('dialog-ok').disabled = true;
    await wipeAndSeed();
    clearProgress();
    clearHistory();
    localStorage.removeItem('git-lab:tree-open');
    location.reload();
  });

  // Write the filesystem to IndexedDB before the page goes away.
  const save = () => { editors.flush().then(flush); };
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
}

start().catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:auto 0 0 0;margin:0;padding:8px;background:#5a1d1d;color:#fff;font:12px monospace">gitGud could not start: ${String(err && err.message || err)}</pre>`);
});

// Cache the app so it works offline after the first visit.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

export { PROJECT };
