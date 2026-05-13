const CACHE = 'absensi-v23';const ASSETS = [
    './','./index.html','./karyawan.html','./owner.html',
    './css/style.css','./manifest.json','./icon.svg'
];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(()=>null)));
    // Do NOT call skipWaiting - let user finish current session before activating new SW
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ));
    // Do NOT call clients.claim - new SW takes over only on next page navigation
});

self.addEventListener('fetch', e => {
    const url = e.request.url;
    if (e.request.method !== 'GET') return;
    if (url.includes('firestore') || url.includes('firebase') || url.includes('googleapis') || url.includes('gstatic')) return;

    // Stale-while-revalidate for HTML/JS/CSS: serve from cache instantly, update in background
    if (e.request.mode === 'navigate' || url.endsWith('.html') || url.endsWith('.js') || url.endsWith('.css')) {
        e.respondWith(
            caches.match(e.request).then(cached => {
                const fetchPromise = fetch(e.request).then(r => {
                    if (r && r.status === 200) {
                        const copy = r.clone();
                        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
                    }
                    return r;
                }).catch(() => cached || caches.match('./index.html'));
                return cached || fetchPromise;
            })
        );
        return;
    }

    // Cache-first for other assets
    e.respondWith(
        caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match('./index.html')))
    );
});
