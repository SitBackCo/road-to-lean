/* Ascend service worker — offline app shell. Never caches the System (Cloudflare Worker) API. */
const VERSION = 'rtl-ascend-2', ART = 'rtl-art-3', MINE = 'rtl-';
const PAGE = './index.html', REST = ['./zxing.min.js', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const END = '<!--winter-arc:end-->'; // the build writes this as the very last thing in the app page
const scopePath = () => new URL(self.registration.scope).pathname;
const isAppPage = url => url.origin === self.location.origin && (url.pathname === scopePath() || url.pathname === scopePath() + 'index.html');
// only a real, complete copy of the app page may replace the stored one: not an error page, a redirect, some other page,
// or a download that stopped part-way (the whole page is there only when it ends with the app's own end mark)
const looksRight = r => !!r && r.ok && r.status === 200 && !r.redirected && r.type === 'basic' && /text\/html/i.test(r.headers.get('content-type') || '');
async function storePage(r) {
  if (!looksRight(r)) return false;
  const text = await r.text(), at = text.lastIndexOf(END);
  if (at < 0 || text.length - at > 400) return false;
  const c = await caches.open(VERSION);
  await c.put(PAGE, new Response(text, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  return true;
}
// installing always asks the server itself (never the browser's own short-term copy, which can be up to 10 minutes old on GitHub Pages)
const direct = u => new Request(u, { cache: 'reload' });
self.addEventListener('install', e => {
  e.waitUntil(fetch(direct(PAGE)).then(storePage).then(ok => { if (!ok) throw new Error('the app page did not arrive whole'); return caches.open(VERSION); })
    .then(c => c.addAll(REST.map(direct))).then(() => self.skipWaiting()));
});
// only this app's own old caches are removed; anything else stored for this site is left alone
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.indexOf(MINE) === 0 && k !== VERSION && k !== ART).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const fonts = url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com';
  if (!sameOrigin && !fonts) return; // the System's API and everything else go straight to the network
  if (req.mode === 'navigate') {
    if (!isAppPage(url)) return; // some other page on this site: not ours to store
    // open instantly from the device's copy, and fetch a newer copy in the background. waitUntil keeps the worker alive until
    // that copy is completely stored, so an update is never cut off half-way.
    const fresh = fetch(req, { cache: 'no-cache' });
    e.waitUntil(fresh.then(r => storePage(r.clone())).catch(() => false));
    e.respondWith(caches.open(VERSION).then(c => c.match(PAGE)).then(hit => hit || fresh));
    return;
  }
  if (sameOrigin && req.headers.has('range')) return; // a video asking for part of its file: straight to the network, which answers parts properly
  if (sameOrigin && (url.pathname.includes('/art/') || url.pathname.endsWith('/foods.json'))) { // every picture and the built-in food list: kept on the device once fetched, across app updates (each address names its own version)
    e.respondWith(caches.open(ART).then(c => c.match(req).then(hit => hit || fetch(req).then(r => { if (r && r.ok) c.put(req, r.clone()); return r; }))));
    return;
  }
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
// iPhone reminders: the Worker sends water and protein reminders here; tapping one opens the app at the right place
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Ascend', { body: d.body || '', tag: d.tag || 'ascend', icon: 'icon-192.png', badge: 'icon-192.png', data: { url: d.url || './' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) { c.postMessage({ type: 'notify', url }); return c.focus(); }
    return self.clients.openWindow ? self.clients.openWindow(url) : null;
  }));
});
