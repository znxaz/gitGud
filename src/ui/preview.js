import { pfs, PROJECT, resolve, exists, readText } from '../vfs.js';

const MIME = {
  css: 'text/css', js: 'text/javascript', html: 'text/html', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', json: 'application/json', txt: 'text/plain',
};
const mimeOf = p => MIME[p.slice(p.lastIndexOf('.') + 1).toLowerCase()] || 'application/octet-stream';
const isLocal = v => v && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(v.trim());

/**
 * Renders /project/index.html in an iframe. style.css, script.js and other
 * relative references are read from the virtual filesystem and given blob URLs.
 */
export class Preview {
  constructor({ pane, frame, missing }) {
    this.pane = pane;
    this.frame = frame;
    this.missing = missing;
    this.urls = [];
    this.timer = null;
    this.visible = false;
  }

  setVisible(v) {
    this.visible = v;
    this.pane.hidden = !v;
    if (v) this.refresh();
  }

  schedule() {
    if (!this.visible) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 250);
  }

  async blobFor(path) {
    const bytes = await pfs.readFile(path);
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(path) }));
    this.urls.push(url);
    return url;
  }

  async refresh() {
    if (!this.visible) return;
    const indexPath = PROJECT + '/index.html';
    if (!(await exists(indexPath))) {
      this.missing.hidden = false;
      this.frame.removeAttribute('src');
      return;
    }
    this.missing.hidden = true;
    const old = this.urls;
    this.urls = [];
    const html = await readText(indexPath);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const attrs = [['link', 'href'], ['script', 'src'], ['img', 'src'], ['source', 'src'], ['audio', 'src'], ['video', 'src']];
    for (const [tag, attr] of attrs) {
      for (const el of doc.querySelectorAll(`${tag}[${attr}]`)) {
        const value = el.getAttribute(attr);
        if (!isLocal(value)) continue;
        const path = resolve(PROJECT, value.split(/[?#]/)[0]);
        if (await exists(path)) el.setAttribute(attr, await this.blobFor(path));
      }
    }
    // Keep the scroll position across reloads.
    let scroll = 0;
    try { scroll = this.frame.contentWindow.scrollY || 0; } catch { /* not loaded */ }
    const doctype = /^\s*<!doctype/i.test(html) ? '<!DOCTYPE html>\n' : '';
    const pageUrl = URL.createObjectURL(new Blob([doctype + doc.documentElement.outerHTML], { type: 'text/html' }));
    this.urls.push(pageUrl);
    this.frame.onload = () => {
      try { this.frame.contentWindow.scrollTo(0, scroll); } catch { /* ignore */ }
      for (const u of old) URL.revokeObjectURL(u);
    };
    this.frame.src = pageUrl;
  }
}
