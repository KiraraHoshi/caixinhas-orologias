// Service worker do Orolon Caixinhas: guarda os arquivos do próprio app para abrir sem internet.
// Não acessa nenhum outro endereço.
const CACHE = 'caixinhas-v2.0.5';
const ARQUIVOS = ['./', './index.html', './fontes/cinzel.woff2', './fontes/figtree.woff2', './manifest.webmanifest', './icon.svg?v=2', './icon-192.png?v=2', './icon-512.png?v=2', './icon-maskable-512.png?v=2', './privacy.html', './tema.schema.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(res => { const c = res.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); return res; }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html'))));
});
