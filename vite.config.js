import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const monacoEsm = fileURLToPath(new URL('./node_modules/monaco-editor/esm/vs', import.meta.url));

// Writes sw.js into the build with the full list of emitted files,
// so the service worker can cache everything on the first visit.
function offlineServiceWorker() {
  return {
    name: 'offline-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter(f => f !== 'sw.js');
      const version = Date.now().toString(36);
      const source = `
const CACHE = 'git-lab-${version}';
const FILES = ${JSON.stringify(['./', ...files.map(f => './' + f)])};
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('git-lab-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // The page itself: network first, so a new deploy shows on the next load.
  // Offline, fall back to the cached copy.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./', copy)); }
        return res;
      }).catch(() => caches.match('./'))
    );
    return;
  }
  // Scripts, styles and fonts have content hashes in their names, so the cache is safe.
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(hit => hit ||
      fetch(event.request).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(event.request, copy)); }
        return res;
      }).catch(() => caches.match('./')))
  );
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  base: './',
  resolve: {
    alias: { 'monaco-esm': monacoEsm },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
  plugins: [offlineServiceWorker()],
});
