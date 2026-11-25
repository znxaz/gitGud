import {
  pfs, HOME, PROJECT, resolve, dirname, basename, stat, isDir, exists, mkdirp, rmrf, readdirSafe,
  tildify, writeText, readText,
} from '../vfs.js';
import { palette, stripAnsi } from './ansi.js';
import { columns } from './columns.js';
import { runGit, GIT_SUBCOMMANDS } from '../git/index.js';
import { findRepo, listBranches } from '../git/core.js';

export const BUILTINS = ['cat', 'cd', 'clear', 'cp', 'echo', 'git', 'help', 'history', 'ls', 'mkdir', 'mv', 'pwd', 'rm', 'touch', 'whoami'];

// ---------- tokenizer ----------

/**
 * Split a command line into words and operators.
 * Words keep track of whether any part was quoted (quoted parts are not globbed).
 */
export function tokenize(line) {
  const tokens = [];
  let i = 0;
  let word = null;
  const flush = () => { if (word) { tokens.push(word); word = null; } };
  const ensure = () => { if (!word) word = { type: 'word', text: '', quoted: false, globs: false }; };
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') { flush(); i++; continue; }
    if (ch === '#' && !word) break; // comment
    if (ch === '\'') {
      ensure();
      const end = line.indexOf('\'', i + 1);
      if (end < 0) return { error: 'unexpected EOF while looking for matching `\'\'' };
      word.text += line.slice(i + 1, end);
      word.quoted = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      ensure();
      word.quoted = true;
      i++;
      let closed = false;
      while (i < line.length) {
        const c = line[i];
        if (c === '"') { closed = true; i++; break; }
        if (c === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) { word.text += line[i + 1]; i += 2; continue; }
        if (c === '$') {
          const m = line.slice(i).match(/^\$(HOME|USER|PWD)\b/);
          if (m) { word.text += `\u0000${m[1]}\u0000`; i += m[0].length; continue; }
        }
        word.text += c; i++;
      }
      if (!closed) return { error: 'unexpected EOF while looking for matching `"\'' };
      continue;
    }
    if (ch === '\\') {
      ensure();
      if (i + 1 < line.length) word.text += line[i + 1];
      i += 2;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '>>' || two === '2>') {
      flush();
      if (two === '2>' && line[i + 2] === '&' && line[i + 3] === '1') { tokens.push({ type: 'op', text: '2>&1' }); i += 4; continue; }
      tokens.push({ type: 'op', text: two }); i += 2; continue;
    }
    if (ch === ';' || ch === '>' || ch === '|' || ch === '<' || ch === '&') {
      flush();
      tokens.push({ type: 'op', text: ch }); i++; continue;
    }
    ensure();
    if (ch === '$') {
      const m = line.slice(i).match(/^\$(HOME|USER|PWD)\b/);
      if (m) { word.text += `\u0000${m[1]}\u0000`; i += m[0].length; continue; }
    }
    if (ch === '~' && word.text === '' && (line[i + 1] === undefined || line[i + 1] === '/' || line[i + 1] === ' ')) {
      word.text += '\u0000TILDE\u0000'; i++; continue;
    }
    if (ch === '*' || ch === '?') word.globs = true;
    word.text += ch;
    i++;
  }
  flush();
  return { tokens };
}

// ---------- shell ----------

export function createShell({ getCols, clearScreen, afterCommand, observe, getHistory }) {
  const state = { cwd: PROJECT, oldpwd: PROJECT };

  const expandVars = (text, cwd) => text
    .replace(/\u0000TILDE\u0000/g, HOME === '/' ? '' : HOME)
    .replace(/\u0000HOME\u0000/g, HOME)
    .replace(/\u0000USER\u0000/g, 'user')
    .replace(/\u0000PWD\u0000/g, cwd);

  async function expandWord(w, cwd) {
    let text = expandVars(w.text, cwd);
    if (w.text.startsWith('\u0000TILDE\u0000') && text === '') text = HOME;
    if (!w.globs || w.quoted) return [text];
    // Glob only in the last path part: "*.html", "src/*.js".
    const dir = text.includes('/') ? text.slice(0, text.lastIndexOf('/') + 1) : '';
    const pat = text.slice(dir.length);
    if (dir.includes('*') || dir.includes('?')) return [text];
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const names = (await readdirSafe(resolve(cwd, dir || '.'))).filter(n => re.test(n) && (pat.startsWith('.') || !n.startsWith('.'))).sort();
    return names.length ? names.map(n => dir + n) : [text];
  }

  function streams(write, isTTY) {
    return { write, c: palette(isTTY), isTTY };
  }

  async function runLine(line, term) {
    const parsed = tokenize(line);
    if (parsed.error) { term.write(`bash: ${parsed.error}\n`); return 2; }
    const tokens = parsed.tokens;
    if (!tokens.length) return 0;
    // Split into commands joined by ; && ||
    const commands = [];
    let cur = [];
    let joiner = ';';
    for (const t of tokens) {
      if (t.type === 'op' && (t.text === ';' || t.text === '&&' || t.text === '||')) {
        commands.push({ tokens: cur, joiner }); cur = []; joiner = t.text; continue;
      }
      cur.push(t);
    }
    commands.push({ tokens: cur, joiner });
    let last = 0;
    for (const cmd of commands) {
      if (cmd.joiner === '&&' && last !== 0) continue;
      if (cmd.joiner === '||' && last === 0) continue;
      if (!cmd.tokens.length) {
        if (commands.length > 1) { term.write(`bash: syntax error near unexpected token \`${cmd.joiner}'\n`); return 2; }
        continue;
      }
      last = await runCommand(cmd.tokens, term);
      await afterCommand();
    }
    return last;
  }

  async function runCommand(tokens, term) {
    const words = [];
    let redirect = null, errRedirect = null, errToOut = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'op') {
        if (t.text === '>' || t.text === '>>' || t.text === '2>') {
          const target = tokens[i + 1];
          if (!target || target.type !== 'word') { term.write('bash: syntax error near unexpected token `newline\'\n'); return 2; }
          const path = resolve(state.cwd, (await expandWord(target, state.cwd))[0]);
          if (t.text === '2>') errRedirect = path;
          else redirect = { path, append: t.text === '>>' };
          i++;
          continue;
        }
        if (t.text === '2>&1') { errToOut = true; continue; }
        if (t.text === '|') { term.write('gitGud: pipes (|) are not available in this lab.\n'); return 1; }
        term.write(`bash: syntax error near unexpected token \`${t.text}'\n`);
        return 2;
      }
      words.push(...(await expandWord(t, state.cwd)));
    }
    if (!words.length) return 0;

    let captured = '';
    let capturedErr = '';
    const termWrite = s => term.write(s);
    const out = redirect ? streams(s => { captured += s; }, false) : streams(termWrite, true);
    const err = errRedirect ? streams(s => { capturedErr += s; }, false)
      : errToOut && redirect ? streams(s => { captured += stripAnsi(s); }, false)
      : streams(termWrite, true);

    if (redirect) {
      const parent = dirname(redirect.path);
      if (!(await isDir(parent))) { term.write(`bash: ${tildifyArg(redirect.path)}: No such file or directory\n`); return 1; }
      if (await isDir(redirect.path)) { term.write(`bash: ${tildifyArg(redirect.path)}: Is a directory\n`); return 1; }
      // bash creates or empties the file before the command runs.
      if (!redirect.append) await writeText(redirect.path, '');
      else if (!(await exists(redirect.path))) await writeText(redirect.path, '');
    }

    const ctx = {
      cwd: state.cwd,
      out, err,
      cols: getCols(),
      observe,
    };
    let code;
    try {
      code = await exec(words, ctx, term);
    } finally {
      if (redirect) {
        const prev = redirect.append ? await readText(redirect.path).catch(() => '') : '';
        await writeText(redirect.path, prev + stripAnsi(captured));
      }
      if (errRedirect) await writeText(errRedirect, stripAnsi(capturedErr));
    }
    return code;
  }

  const tildifyArg = p => p;

  async function exec(words, ctx, term) {
    const [cmd, ...args] = words;
    const o = ctx.out, e = ctx.err;
    switch (cmd) {
      case 'git': return runGit(ctx, args);
      case 'pwd': o.write(state.cwd + '\n'); return 0;
      case 'whoami': o.write('user\n'); return 0;
      case 'clear': clearScreen(); return 0;
      case 'help': o.write(HELP_TEXT); return 0;
      case 'history': {
        const h = getHistory();
        o.write(h.map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join('\n') + (h.length ? '\n' : ''));
        return 0;
      }
      case 'cd': {
        let target = args[0];
        if (args.length > 1) { e.write('bash: cd: too many arguments\n'); return 1; }
        if (!target) target = HOME;
        if (target === '-') { target = state.oldpwd; o.write(target + '\n'); }
        const p = resolve(state.cwd, target);
        const s = await stat(p);
        if (!s) { e.write(`bash: cd: ${args[0]}: No such file or directory\n`); return 1; }
        if (!s.isDirectory()) { e.write(`bash: cd: ${args[0]}: Not a directory\n`); return 1; }
        state.oldpwd = state.cwd;
        state.cwd = p;
        return 0;
      }
      case 'echo': {
        let newline = true;
        let rest = args;
        while (rest[0] && /^-[neE]+$/.test(rest[0])) { if (rest[0].includes('n')) newline = false; rest = rest.slice(1); }
        o.write(rest.join(' ') + (newline ? '\n' : ''));
        return 0;
      }
      case 'cat': return cat(args, ctx);
      case 'ls': return ls(args, ctx);
      case 'mkdir': return mkdir(args, ctx);
      case 'touch': return touch(args, ctx);
      case 'rm': return rm(args, ctx);
      case 'mv': case 'cp': return mvcp(cmd, args, ctx);
      case 'nano': case 'vim': case 'vi': case 'code': case 'emacs': case 'notepad':
        e.write('gitGud: this terminal has no text editor. Click a file in the explorer to edit it.\n');
        return 1;
      default:
        e.write(`${cmd}: command not found\n`);
        void term;
        return 127;
    }
  }

  async function cat(args, ctx) {
    let code = 0;
    if (!args.length) { ctx.err.write('gitGud: cat needs a file name.\n'); return 1; }
    for (const a of args) {
      const p = resolve(state.cwd, a);
      const s = await stat(p);
      if (!s) { ctx.err.write(`cat: ${a}: No such file or directory\n`); code = 1; continue; }
      if (s.isDirectory()) { ctx.err.write(`cat: ${a}: Is a directory\n`); code = 1; continue; }
      ctx.out.write(await readText(p));
    }
    return code;
  }

  const sortNames = names => names.sort((a, b) => {
    const ka = a.replace(/^\.+/, ''), kb = b.replace(/^\.+/, '');
    const r = ka.localeCompare(kb, 'en', { sensitivity: 'base' });
    return r || a.localeCompare(b);
  });

  async function ls(args, ctx) {
    let all = false, almost = false, long = false, one = false;
    const paths = [];
    for (const a of args) {
      if (a.startsWith('-') && a.length > 1) {
        for (const ch of a.slice(1)) {
          if (ch === 'a') all = true;
          else if (ch === 'A') almost = true;
          else if (ch === 'l') long = true;
          else if (ch === '1') one = true;
          else if ('hGF'.includes(ch)) { /* accepted */ }
          else { ctx.err.write(`ls: invalid option -- '${ch}'\nTry 'ls --help' for more information.\n`); return 2; }
        }
      } else paths.push(a);
    }
    if (!paths.length) paths.push('.');
    const c = ctx.out.c;
    let code = 0;
    const sections = [];
    const files = [];
    for (const a of paths) {
      const p = resolve(state.cwd, a);
      const s = await stat(p);
      if (!s) { ctx.err.write(`ls: cannot access '${a}': No such file or directory\n`); code = 2; continue; }
      if (!s.isDirectory()) { files.push({ name: a, path: p, s }); continue; }
      let names = await readdirSafe(p);
      if (!all && !almost) names = names.filter(n => !n.startsWith('.'));
      sortNames(names);
      if (all) names = ['.', '..', ...names];
      const entries = [];
      for (const n of names) {
        const full = n === '.' ? p : n === '..' ? dirname(p) : p + '/' + n;
        entries.push({ name: n, path: full, s: await stat(full) });
      }
      sections.push({ title: a, entries });
    }
    const render = entries => {
      if (long) {
        const rows = entries.map(en => {
          const d = en.s && en.s.isDirectory();
          const size = d ? 4096 : (en.s?.size ?? 0);
          const dt = new Date(en.s?.mtimeMs || Date.now());
          const mon = dt.toLocaleString('en', { month: 'short' });
          const time = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
          return { perm: d ? 'drwxr-xr-x' : '-rw-r--r--', size, date: `${mon} ${String(dt.getDate()).padStart(2)} ${time}`, name: d ? c.dir(en.name) : en.name };
        });
        const sw = Math.max(...rows.map(r => String(r.size).length), 1);
        const total = Math.ceil(entries.reduce((s, en) => s + (en.s?.isDirectory() ? 4 : Math.ceil((en.s?.size || 0) / 4096) * 4), 0));
        return [`total ${total}`, ...rows.map(r => `${r.perm} 1 user user ${String(r.size).padStart(sw)} ${r.date} ${r.name}`)].join('\n');
      }
      const names = entries.map(en => en.name);
      const deco = (n, i) => (entries[i].s && entries[i].s.isDirectory() ? c.dir(n) : n);
      if (one || !ctx.out.isTTY) return names.map((n, i) => deco(n, i)).join('\n');
      return columns(names, ctx.cols, deco);
    };
    const blocks = [];
    if (files.length) blocks.push(render(files));
    for (const s of sections) {
      const body = s.entries.length ? render(s.entries) : (long ? 'total 0' : '');
      if (paths.length > 1) blocks.push(`${s.title}:` + (body ? '\n' + body : ''));
      else if (body) blocks.push(body);
    }
    const text = blocks.join('\n\n');
    if (text) ctx.out.write(text + '\n');
    return code;
  }

  async function mkdir(args, ctx) {
    const parents = args.includes('-p') || args.includes('--parents');
    const dirs = args.filter(a => !a.startsWith('-'));
    if (!dirs.length) { ctx.err.write('mkdir: missing operand\nTry \'mkdir --help\' for more information.\n'); return 1; }
    let code = 0;
    for (const d of dirs) {
      const p = resolve(state.cwd, d);
      if (parents) {
        try { await mkdirp(p); } catch { ctx.err.write(`mkdir: cannot create directory \u2018${d}\u2019: Not a directory\n`); code = 1; }
        continue;
      }
      if (await exists(p)) { ctx.err.write(`mkdir: cannot create directory \u2018${d}\u2019: File exists\n`); code = 1; continue; }
      if (!(await isDir(dirname(p)))) { ctx.err.write(`mkdir: cannot create directory \u2018${d}\u2019: No such file or directory\n`); code = 1; continue; }
      await pfs.mkdir(p);
    }
    return code;
  }

  async function touch(args, ctx) {
    const files = args.filter(a => !a.startsWith('-'));
    if (!files.length) { ctx.err.write('touch: missing file operand\nTry \'touch --help\' for more information.\n'); return 1; }
    let code = 0;
    for (const f of files) {
      const p = resolve(state.cwd, f);
      if (!(await isDir(dirname(p)))) { ctx.err.write(`touch: cannot touch '${f}': No such file or directory\n`); code = 1; continue; }
      const s = await stat(p);
      if (s && s.isDirectory()) continue;
      // Rewriting the same bytes updates the modification time.
      if (s) await pfs.writeFile(p, await pfs.readFile(p));
      else await writeText(p, '');
    }
    return code;
  }

  async function rm(args, ctx) {
    let recursive = false, force = false;
    const targets = [];
    for (const a of args) {
      if (a.startsWith('-') && a.length > 1 && a !== '--') {
        for (const ch of a.slice(1)) {
          if (ch === 'r' || ch === 'R') recursive = true;
          else if (ch === 'f') force = true;
          else if (ch === 'i' || ch === 'v') { /* accepted */ }
          else { ctx.err.write(`rm: invalid option -- '${ch}'\nTry 'rm --help' for more information.\n`); return 1; }
        }
      } else if (a !== '--') targets.push(a);
    }
    if (!targets.length) {
      if (force) return 0;
      ctx.err.write('rm: missing operand\nTry \'rm --help\' for more information.\n');
      return 1;
    }
    let code = 0;
    for (const t of targets) {
      const p = resolve(state.cwd, t);
      if (p === '/') { ctx.err.write("rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n"); code = 1; continue; }
      if (basename(t) === '.' || basename(t) === '..') { ctx.err.write(`rm: refusing to remove '.' or '..' directory: skipping '${t}'\n`); code = 1; continue; }
      const s = await stat(p);
      if (!s) { if (!force) { ctx.err.write(`rm: cannot remove '${t}': No such file or directory\n`); code = 1; } continue; }
      if (s.isDirectory() && !recursive) { ctx.err.write(`rm: cannot remove '${t}': Is a directory\n`); code = 1; continue; }
      if (state.cwd === p || state.cwd.startsWith(p + '/')) {
        await rmrf(p);
        continue;
      }
      await rmrf(p);
    }
    return code;
  }

  async function mvcp(cmd, args, ctx) {
    const names = args.filter(a => !a.startsWith('-'));
    if (names.length < 2) {
      ctx.err.write(`${cmd}: missing ${names.length ? 'destination file operand after \'' + names[0] + '\'' : 'file operand'}\nTry '${cmd} --help' for more information.\n`);
      return 1;
    }
    const src = resolve(state.cwd, names[0]);
    let dst = resolve(state.cwd, names[1]);
    const s = await stat(src);
    if (!s) { ctx.err.write(`${cmd}: cannot stat '${names[0]}': No such file or directory\n`); return 1; }
    if (s.isDirectory()) { ctx.err.write(`gitGud: ${cmd} works on files only in this lab.\n`); return 1; }
    if (await isDir(dst)) dst = dst + '/' + basename(src);
    if (!(await isDir(dirname(dst)))) { ctx.err.write(`${cmd}: cannot create regular file '${names[1]}': No such file or directory\n`); return 1; }
    const bytes = await pfs.readFile(src);
    await pfs.writeFile(dst, bytes);
    if (cmd === 'mv') await pfs.unlink(src);
    return 0;
  }

  // ---------- completion ----------

  async function complete(before) {
    // Find the start of the word under the cursor (ignoring quotes for simplicity).
    let start = before.length;
    while (start > 0 && before[start - 1] !== ' ') start--;
    const word = before.slice(start);
    const prior = before.slice(0, start).trim().split(/\s+/).filter(Boolean);
    const lastOp = prior.length ? prior[prior.length - 1] : '';
    const atCommand = !prior.length || ['&&', '||', ';'].includes(lastOp);
    if (atCommand) {
      return { start, candidates: BUILTINS.filter(b => b.startsWith(word)) };
    }
    // Words of the current command only.
    let cmdWords = prior;
    for (let i = prior.length - 1; i >= 0; i--) if (['&&', '||', ';'].includes(prior[i])) { cmdWords = prior.slice(i + 1); break; }
    if (cmdWords[0] === 'git' && cmdWords.length === 1) {
      return { start, candidates: GIT_SUBCOMMANDS.filter(s => s.startsWith(word)) };
    }
    if (cmdWords[0] === 'git' && ['switch', 'merge', 'checkout', 'branch', 'push', 'pull', 'log', 'diff', 'show'].includes(cmdWords[1]) && !word.includes('/')) {
      const repo = await findRepo(state.cwd);
      const branches = repo ? await listBranches(repo) : [];
      const extra = ['push', 'pull', 'fetch'].includes(cmdWords[1]) ? ['origin'] : [];
      const names = [...extra, ...branches].filter(b => b.startsWith(word));
      if (!['checkout', 'log', 'diff', 'show'].includes(cmdWords[1]) || names.length) {
        const files = cmdWords[1] === 'checkout' ? await fileCandidates(word) : [];
        return { start, candidates: [...new Set([...names, ...files])] };
      }
    }
    if (word.startsWith('--source=')) {
      const repo = await findRepo(state.cwd);
      const branches = repo ? await listBranches(repo) : [];
      return { start: start + 9, candidates: ['HEAD', ...branches].filter(b => b.startsWith(word.slice(9))) };
    }
    return { start, candidates: await fileCandidates(word) };
  }

  async function fileCandidates(word) {
    const slash = word.lastIndexOf('/');
    const dirPart = slash >= 0 ? word.slice(0, slash + 1) : '';
    const namePart = word.slice(slash + 1);
    const dir = resolve(state.cwd, dirPart || '.');
    const names = (await readdirSafe(dir)).filter(n => n.startsWith(namePart) && (namePart.startsWith('.') || !n.startsWith('.')));
    const out = [];
    for (const n of sortNames(names)) out.push(dirPart + n + ((await isDir(dir + '/' + n)) ? '/' : ''));
    return out;
  }

  function prompt() {
    return `\x1b[1;32muser@git-lab\x1b[0m:\x1b[1;34m${tildify(state.cwd)}\x1b[0m$ `;
  }

  return { runLine, complete, prompt, state };
}

const HELP_TEXT = `Shell commands
  ls [-a] [-l] [path]    list files (-a shows hidden files)
  cd <dir>               change directory (cd .. goes up, cd ~ goes home)
  pwd                    print the current directory
  cat <file>             print a file
  echo <text>            print text. Use > to write a file, >> to add to it
  mkdir [-p] <dir>       make a directory (-p makes parent directories too)
  touch <file>           make an empty file
  rm [-r] <path>         remove a file (-r removes a directory)
  mv, cp <from> <to>     move or copy a file
  clear                  clear the terminal
  history                list earlier commands

Git
  git help               list the Git commands in this lab

Keys
  Up / Down              earlier commands
  Tab                    complete a file name
  Ctrl+C                 cancel the line
  Ctrl+L                 clear the terminal

Edit files by clicking them in the explorer.
`;
