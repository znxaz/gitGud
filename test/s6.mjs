// Task 6 accepts a heading change, a tagline change, or added HTML, and ignores re-indenting.
import 'fake-indexeddb/auto';
const store = new Map();
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }, configurable: true });
const { seed, readText, writeText, wipeAndSeed } = await import('../src/vfs.js');
const { createShell } = await import('../src/shell/shell.js');
const { TASKS } = await import('../src/tasks.js');
const task = TASKS.find(t => t.id === 'heading');
const term = { write() {} };
const cases = [
  ['re-indent only', t => t.replace('    <h1>Study Planner</h1>', '      <h1>Study Planner</h1>'), false],
  ['heading', t => t.replace('<h1>Study Planner</h1>', '<h1>Exam Planner</h1>'), true],
  ['tagline', t => t.replace('Plan your week. Add a task, then mark it done.', 'One week at a time.'), true],
  ['added html', t => t.replace('</h1>\n', '</h1>\n    <p>Semester 1</p>\n'), true],
];
for (const [name, edit, expect] of cases) {
  await wipeAndSeed();
  const shell = createShell({ getCols: () => 100, clearScreen() {}, afterCommand: async () => {}, observe() {}, getHistory: () => [] });
  for (const l of ['git config --global user.name S', 'git config --global user.email s@x', 'git init', 'git add .', 'git commit -m one']) await shell.runLine(l, term);
  await writeText('/project/index.html', edit(await readText('/project/index.html')));
  await shell.runLine('git commit -am two', term);
  const r = await task.check({});
  console.log(`${(!!r === expect) ? 'ok  ' : 'FAIL'} ${name}: ${r}`);
}
process.exit(0);
