import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { columns } from './columns.js';

const HISTORY_KEY = 'git-lab:history';
const HISTORY_MAX = 300;

// Visible length of a string that may contain ANSI colour codes.
const visibleLength = s => s.replace(/\x1b\[[0-9;]*m/g, '').length;

// VS Code's default dark terminal palette.
const THEME = {
  background: '#181818',
  foreground: '#cccccc',
  cursor: '#cccccc',
  cursorAccent: '#181818',
  selectionBackground: '#264f78',
  black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
  blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543',
  brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
};

/**
 * A terminal with a bash-like line editor.
 * `run(line)` executes a command line; `complete(line, cursor)` returns completion data.
 */
export class LabTerminal {
  constructor(container, { prompt, run, complete }) {
    this.getPrompt = prompt;
    this.run = run;
    this.completer = complete;
    this.buffer = '';
    this.cursor = 0;
    this.cursorRow = 0; // rows between the prompt start and the cursor
    this.busy = false;
    this.queue = [];
    this.lastTab = 0;
    this.history = loadHistory();
    this.historyIndex = this.history.length;
    this.draft = '';

    this.term = new Terminal({
      fontFamily: "Consolas, 'Cascadia Mono', 'Courier New', monospace",
      fontSize: 14,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: 'block',
      convertEol: true,
      scrollback: 5000,
      theme: THEME,
      allowProposedApi: false,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(container);
    this.term.onData(data => this.onData(data));
    this.term.attachCustomKeyEventHandler(e => {
      // Let the browser copy a selection with Ctrl+C instead of cancelling the line.
      if (e.type === 'keydown' && e.ctrlKey && e.key === 'c' && this.term.hasSelection()) {
        navigator.clipboard?.writeText(this.term.getSelection()).catch(() => {});
        this.term.clearSelection();
        return false;
      }
      if (e.type === 'keydown' && e.ctrlKey && e.key === 'v') return false; // browser paste
      return true;
    });
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  resize() {
    try { this.fit.fit(); } catch { /* container hidden */ }
  }

  get cols() { return this.term.cols || 80; }

  write(text) { this.term.write(text); }

  focus() { this.term.focus(); }

  clear() { this.term.clear(); }

  showPrompt() {
    this.promptText = this.getPrompt();
    this.buffer = '';
    this.cursor = 0;
    this.cursorRow = 0;
    this.term.write(this.promptText);
  }

  // ---------- input ----------

  onData(data) {
    if (this.busy) {
      if (data === '\x03') return; // commands finish quickly; nothing to interrupt
      this.queue.push(data);
      return;
    }
    // Pasted text with several lines: run each line in order.
    if (data.length > 1 && /[\r\n]/.test(data) && !data.startsWith('\x1b')) {
      const parts = data.replace(/\r\n/g, '\r').replace(/\n/g, '\r').split('\r');
      const last = parts.pop();
      this.pasteQueue = [...parts.map(p => p + '\r'), last].filter(p => p !== '');
      this.drainPaste();
      return;
    }
    this.handle(data);
  }

  drainPaste() {
    while (this.pasteQueue && this.pasteQueue.length && !this.busy) {
      const chunk = this.pasteQueue.shift();
      if (chunk.endsWith('\r')) {
        this.insert(chunk.slice(0, -1));
        this.handle('\r');
      } else {
        this.insert(chunk);
      }
    }
  }

  handle(data) {
    switch (data) {
      case '\r': return this.submit();
      case '\x7f': case '\b': return this.backspace();
      case '\x03': return this.cancelLine();
      case '\x0c': return this.clearScreen();
      case '\t': return this.tab();
      case '\x01': case '\x1b[H': case '\x1bOH': case '\x1b[1~': return this.moveTo(0);
      case '\x05': case '\x1b[F': case '\x1bOF': case '\x1b[4~': return this.moveTo(this.buffer.length);
      case '\x1b[D': return this.moveTo(this.cursor - 1);
      case '\x1b[C': return this.moveTo(this.cursor + 1);
      case '\x1b[1;5D': case '\x1bb': return this.moveTo(this.wordLeft());
      case '\x1b[1;5C': case '\x1bf': return this.moveTo(this.wordRight());
      case '\x1b[A': return this.historyMove(-1);
      case '\x1b[B': return this.historyMove(1);
      case '\x1b[3~': return this.deleteForward();
      case '\x15': return this.setLine(this.buffer.slice(this.cursor), 0); // Ctrl+U
      case '\x0b': return this.setLine(this.buffer.slice(0, this.cursor), this.cursor); // Ctrl+K
      case '\x17': { // Ctrl+W
        const start = this.wordLeft();
        return this.setLine(this.buffer.slice(0, start) + this.buffer.slice(this.cursor), start);
      }
      default:
        if (data.startsWith('\x1b')) return; // other escape sequences are ignored
        // Printable text, including pasted text without newlines.
        this.insert(data.replace(/[\x00-\x1f\x7f]/g, ''));
    }
  }

  insert(text) {
    if (!text) return;
    this.setLine(this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor), this.cursor + text.length);
  }

  backspace() {
    if (this.cursor === 0) return;
    this.setLine(this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor), this.cursor - 1);
  }

  deleteForward() {
    if (this.cursor >= this.buffer.length) return;
    this.setLine(this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1), this.cursor);
  }

  wordLeft() {
    let i = this.cursor;
    while (i > 0 && this.buffer[i - 1] === ' ') i--;
    while (i > 0 && this.buffer[i - 1] !== ' ') i--;
    return i;
  }

  wordRight() {
    let i = this.cursor;
    while (i < this.buffer.length && this.buffer[i] === ' ') i++;
    while (i < this.buffer.length && this.buffer[i] !== ' ') i++;
    return i;
  }

  moveTo(pos) {
    pos = Math.max(0, Math.min(this.buffer.length, pos));
    if (pos === this.cursor) return;
    this.setLine(this.buffer, pos);
  }

  // Redraw the whole input line. Handles lines that wrap across rows.
  setLine(text, cursor) {
    const cols = this.cols;
    const promptLen = visibleLength(this.promptText);
    let out = '';
    if (this.cursorRow > 0) out += `\x1b[${this.cursorRow}A`;
    out += '\r\x1b[J' + this.promptText + text;
    const end = promptLen + text.length;
    if (end > 0 && end % cols === 0) out += '\r\n'; // leave the pending-wrap state
    const endRow = Math.floor(end / cols);
    const target = promptLen + cursor;
    const targetRow = Math.floor(target / cols);
    const targetCol = target % cols;
    if (endRow > targetRow) out += `\x1b[${endRow - targetRow}A`;
    out += '\r';
    if (targetCol > 0) out += `\x1b[${targetCol}C`;
    this.term.write(out);
    this.buffer = text;
    this.cursor = cursor;
    this.cursorRow = targetRow;
  }

  // Move the terminal cursor to the end of the input, ready for output.
  moveToEnd() {
    const cols = this.cols;
    const promptLen = visibleLength(this.promptText);
    const end = promptLen + this.buffer.length;
    const endRow = Math.floor(end / cols);
    let out = '';
    if (endRow > this.cursorRow) out += `\x1b[${endRow - this.cursorRow}B`;
    out += '\r';
    if (end % cols > 0) out += `\x1b[${end % cols}C`;
    this.term.write(out);
  }

  cancelLine() {
    this.moveToEnd();
    this.term.write('^C\r\n');
    this.historyIndex = this.history.length;
    this.showPrompt();
  }

  clearScreen() {
    this.term.clear();
    this.term.write('\x1b[H\x1b[2J');
    const text = this.buffer, cur = this.cursor;
    this.promptText = this.getPrompt();
    this.cursorRow = 0;
    this.term.write(this.promptText);
    this.setLine(text, cur);
  }

  historyMove(dir) {
    if (!this.history.length) return;
    if (this.historyIndex === this.history.length) this.draft = this.buffer;
    const next = this.historyIndex + dir;
    if (next < 0 || next > this.history.length) return;
    this.historyIndex = next;
    const text = next === this.history.length ? this.draft : this.history[next];
    this.setLine(text, text.length);
  }

  async tab() {
    const now = Date.now();
    const double = now - this.lastTab < 600;
    this.lastTab = now;
    const result = await this.completer(this.buffer.slice(0, this.cursor));
    if (!result) return;
    const { start, candidates } = result;
    if (!candidates.length) return;
    const word = this.buffer.slice(start, this.cursor);
    if (candidates.length === 1) {
      const c = candidates[0];
      const suffix = c.endsWith('/') ? '' : ' ';
      const replacement = c + suffix;
      this.setLine(this.buffer.slice(0, start) + replacement + this.buffer.slice(this.cursor), start + replacement.length);
      return;
    }
    const common = commonPrefix(candidates);
    if (common.length > word.length) {
      this.setLine(this.buffer.slice(0, start) + common + this.buffer.slice(this.cursor), start + common.length);
      return;
    }
    if (double) {
      // Show the options below, like bash does on the second Tab.
      const text = this.buffer, cur = this.cursor;
      this.moveToEnd();
      const names = candidates.map(c => c.replace(/\/$/, '').split('/').pop() + (c.endsWith('/') ? '/' : ''));
      this.term.write('\r\n' + columns(names, this.cols) + '\r\n');
      this.promptText = this.getPrompt();
      this.cursorRow = 0;
      this.term.write(this.promptText);
      this.buffer = '';
      this.cursor = 0;
      this.setLine(text, cur);
    }
  }

  async submit() {
    const line = this.buffer;
    this.moveToEnd();
    this.term.write('\r\n');
    if (line.trim()) {
      if (this.history[this.history.length - 1] !== line) this.history.push(line);
      if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
      saveHistory(this.history);
    }
    this.historyIndex = this.history.length;
    this.draft = '';
    this.busy = true;
    try {
      await this.run(line);
    } catch (err) {
      console.error(err);
      this.term.write(`\x1b[31merror: ${err && err.message ? err.message : err}\x1b[0m\r\n`);
    }
    this.busy = false;
    this.showPrompt();
    const queued = this.queue.splice(0);
    for (const q of queued) this.onData(q);
    this.drainPaste();
  }
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}

function saveHistory(h) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch { /* storage full */ }
}

export function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
}

function commonPrefix(list) {
  let p = list[0];
  for (const s of list) while (!s.startsWith(p)) p = p.slice(0, -1);
  return p;
}
