// Creates a real conflict, clicks one Accept link, and checks the file and the merge.
import puppeteer from 'puppeteer-core';
const choice = process.argv[2];           // Current | Incoming | Both
const shot = process.argv[3];
const b = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const p = await b.newPage();
await p.setViewport({ width: 1366, height: 657 });
const errs = [];
p.on('pageerror', e => errs.push(e.message));
await p.goto('http://localhost:5173/', { waitUntil: 'networkidle0', timeout: 60000 });
await p.waitForSelector('.xterm-helper-textarea');
const wait = ms => new Promise(r => setTimeout(r, ms));
const run = async l => { await p.focus('.xterm-helper-textarea'); await p.keyboard.type(l); await p.keyboard.press('Enter'); await wait(700); };
const termText = () => p.$eval('.xterm-rows', e => e.innerText);
for (const l of ['git config --global user.name S', 'git config --global user.email s@x', 'git init', 'git add .', 'git commit -m one', 'git remote add origin /remote/origin.git', 'git push -u origin main']) await run(l);
await p.click('#btn-teammate'); await wait(600);
await p.click('[data-path="/project/index.html"]'); await wait(800);
await p.click('.monaco-editor .view-lines');
await p.keyboard.down('Control'); await p.keyboard.press('Home'); await p.keyboard.up('Control');
for (let i = 0; i < 26; i++) await p.keyboard.press('ArrowDown');
await p.keyboard.press('End'); for (let i = 0; i < 9; i++) await p.keyboard.press('ArrowLeft');
await p.keyboard.type(' Mine.'); await wait(900);
await run('git commit -am mine');
await run('git pull'); await wait(1200);
const labels = await p.$$eval('.codelens-decoration a', as => as.map(a => a.textContent.trim()));
console.log('links:', labels.join(' | '));
if (shot) await p.screenshot({ path: shot });
const link = (await p.$$('.codelens-decoration a'));
for (const a of link) if ((await a.evaluate(e => e.textContent)).includes(`Accept ${choice}`)) { await a.click(); break; }
await wait(1000);
await run('clear');
await run('grep');  // no-op to separate
await run('clear');
await run('cat index.html');
const out = await termText();
const footer = out.split('\n').filter(l => /footer|<<<<|====|>>>>/.test(l)).map(l => l.trim());
console.log(`after Accept ${choice}:`, footer);
await run('git add index.html'); await run('git commit');
await run('clear'); await run('git log --oneline --graph -4');
console.log((await termText()).split('\n').filter(l => l.trim()).slice(0, 7).join('\n'));
console.log('task:', await p.$eval('.task.done:last-of-type .title', e => e.textContent).catch(() => ''), '| strip:', await p.$eval('#state-strip', e => e.textContent));
console.log(errs.length ? errs : 'no errors');
await b.close();
