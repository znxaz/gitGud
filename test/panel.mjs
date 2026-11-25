import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const p = await b.newPage();
await p.setViewport({ width: 1366, height: 657 });
const errs = [];
p.on('pageerror', e => errs.push(e.message));
await p.goto('http://localhost:5173/', { waitUntil: 'networkidle0', timeout: 60000 });
await p.waitForSelector('.xterm-helper-textarea');
for (const l of ['git config --global user.name "Sara Haddad"', 'git config --global user.email sara@example.com', 'git init', 'git status', 'git add .', 'git commit -m "First commit"']) {
  await p.focus('.xterm-helper-textarea'); await p.keyboard.type(l); await p.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 700));
}
await p.screenshot({ path: process.argv[2] });
console.log(errs.length ? errs : 'no errors');
await b.close();
