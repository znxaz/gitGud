import puppeteer from 'puppeteer-core';
const shots = process.env.SHOTS || 'test/screenshots';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-first-run'] });
const page = await browser.newPage();
await page.setViewport({ width: 1366, height: 657 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
page.on('requestfailed', r => errors.push('requestfailed: ' + r.url()));
await page.goto('http://localhost:4173/git-lab/', { waitUntil: 'networkidle0' });
await page.waitForSelector('.xterm-helper-textarea');
const type = async line => { await page.focus('.xterm-helper-textarea'); await page.keyboard.type(line, { delay: 2 }); await page.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 700)); };
const steps = JSON.parse(process.argv[2] || '[]');
for (const s of steps) {
  if (s.startsWith('@shot ')) { await page.screenshot({ path: `${shots}/${s.slice(6)}.png` }); continue; }
  if (s.startsWith('@click ')) { await page.click(s.slice(7)); await new Promise(r => setTimeout(r, 700)); continue; }
  if (s.startsWith('@reload')) { await page.reload({ waitUntil: 'networkidle0' }); await new Promise(r => setTimeout(r, 1000)); continue; }
  if (s.startsWith('@key ')) { await page.focus('.xterm-helper-textarea'); await page.keyboard.press(s.slice(5)); await new Promise(r => setTimeout(r, 300)); continue; }
  if (s.startsWith('@text ')) { await page.focus('.xterm-helper-textarea'); await page.keyboard.type(s.slice(6)); await new Promise(r => setTimeout(r, 300)); continue; }
  if (s.startsWith('@press ')) { const [, key, n] = s.split(' '); for (let i = 0; i < (Number(n) || 1); i++) { if (key.includes('+')) { const [m, k] = key.split('+'); await page.keyboard.down(m); await page.keyboard.press(k); await page.keyboard.up(m); } else await page.keyboard.press(key); } await new Promise(r => setTimeout(r, 150)); continue; }
  if (s.startsWith('@type ')) { await page.keyboard.type(s.slice(6)); await new Promise(r => setTimeout(r, 900)); continue; }
  if (s.startsWith('@wait ')) { await new Promise(r => setTimeout(r, Number(s.slice(6)))); continue; }
  if (s.startsWith('@eval ')) { console.log('eval:', await page.evaluate(s.slice(6))); continue; }
  await type(s);
}
console.log('strip:', await page.$eval('#state-strip', e => e.textContent));
console.log('current task:', await page.$eval('.task.current .title', e => e.textContent).catch(() => 'none'));
console.log(errors.length ? errors.join('\n') : 'no errors');
await browser.close();
