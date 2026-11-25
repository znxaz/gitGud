import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
const { seed, pfs, writeText, readText } = await import('../src/vfs.js');
const { createShell } = await import('../src/shell/shell.js');
const { teammateCommit } = await import('../src/git/teammate.js');
const raw = process.argv.includes('--raw');
await seed();
const obs = [];
const shell = createShell({ getCols: () => 100, clearScreen() {}, afterCommand: async () => {}, observe: (k, d) => obs.push(k), getHistory: () => [] });
let buf = '';
const term = { write: s => { buf += s; } };
const script = readFileSync(process.argv[2], 'utf8').split('\n');
let tm = 0;
for (const line of script) {
  if (!line.trim()) continue;
  if (line.startsWith('@teammate')) { const r = await teammateCommit(tm++); console.log('## teammate', JSON.stringify(r)); continue; }
  if (line.startsWith('@write ')) { const [, p, ...rest] = line.split(' '); await writeText(p, rest.join(' ').replace(/\n/g, '\n')); continue; }
  if (line.startsWith('@sed ')) { const [p, from, to] = line.slice(5).split('|'); const t = await readText(p.trim()); await writeText(p.trim(), t.replace(from, to)); continue; }
  buf = '';
  await shell.runLine(line, term);
  const out = raw ? buf.replace(/\x1b/g, '\e') : buf.replace(/\x1b\[[0-9;]*m/g, '');
  if (!process.argv.includes('--quiet')) console.log(`$ ${line}\n${out}`);
}
console.log(`${process.argv[2]}: ${obs.length} Git outputs recorded`);
process.exit(0);
