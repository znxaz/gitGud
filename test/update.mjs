// After a new deploy, one reload must show the new page (the service worker must not serve the old one).
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync } from 'node:fs';
const b = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const p = await b.newPage();
await p.goto('http://localhost:4173/git-lab/', { waitUntil: 'networkidle0' });
await p.evaluate(() => navigator.serviceWorker.ready);
await p.reload({ waitUntil: 'networkidle0' }); // now controlled by the service worker
const html = readFileSync('dist/index.html', 'utf8');
writeFileSync('dist/index.html', html.replace('<title>gitGud</title>', '<title>gitGud NEW</title>'));
await p.reload({ waitUntil: 'networkidle0' });
console.log('title after 1 reload:', await p.title());
writeFileSync('dist/index.html', html);
await b.close();
