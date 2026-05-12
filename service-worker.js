const CACHE = 'absensi-v2';
const ASSETS = [
    './','./index.html','./karyawan.html','./owner.html',
    './css/style.css','./manifest.json','./icon.svg'
  ];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(()=>null)));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys =>
          Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
                                     ));
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    const url = e.request.url;
    if (url.includes('firestore') || url.includes('firebase') || url.includes('googleapis') || url.includes('gstatic')) return;
    // Network-first for HTML/JS so updates propagate fast; cache fallback for offline.
                        if (e.request.mode === 'navigate' || url.endsWith('.html') || url.endsWith('.js')) {
                              e.respondWith(
                                      fetch(e.request).then(r => {
                                                const copy = r.clone();
                                                caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
                                                return r;
                                      }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
                                    );
                              return;
                        }
    e.respondWith(
          caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match('./index.html')))
        );
});
