const CACHE = 'absensi-v62';
const ASSETS = [
  './', './index.html', './karyawan.html', './owner.html',
  './css/style.css', './manifest.json', './icon.svg'
];

// Batas tunggu network sebelum fallback ke salinan cache (biar ga "stuck" pas sinyal lemot).
const NET_TIMEOUT_MS = 3000;

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => null)));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // Hapus cache versi lama.
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    // Ambil alih semua tab yang lagi kebuka biar SW baru langsung dipakai (ga nunggu semua tab ditutup).
    if (self.clients && self.clients.claim) await self.clients.claim();
  })());
});

// Network-first (dengan timeout) untuk app shell: HTML/JS/CSS + navigasi.
// Ambil versi TERBARU dari server kalau online; fallback ke cache kalau lambat/offline.
// Tiap respons 200 disimpan ke cache supaya tetap bisa jalan offline.
function networkFirst(request) {
  return new Promise(resolve => {
    let settled = false;
    const done = resp => { if (!settled && resp) { settled = true; resolve(resp); } };

    // Kalau network kelamaan, pakai salinan cache dulu (kalau ada).
    const timer = setTimeout(() => {
      caches.match(request).then(cached => done(cached));
    }, NET_TIMEOUT_MS);

    fetch(request).then(r => {
      clearTimeout(timer);
      if (r && r.status === 200) {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
      }
      // Kalau timer udah keburu kasih cache, network tetap kepakai buat update cache di atas.
      done(r);
    }).catch(() => {
      clearTimeout(timer);
      caches.match(request).then(cached => {
        if (cached) { done(cached); return; }
        caches.match('./index.html').then(fallback => { settled = true; resolve(fallback); });
      });
    });
  });
}

self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (e.request.method !== 'GET') return;
  // Jangan ganggu Firestore/Firebase/Google (data realtime, biar selalu langsung ke server).
  if (url.includes('firestore') || url.includes('firebase') || url.includes('googleapis') || url.includes('gstatic')) return;

  // App shell -> network-first biar update langsung kelihatan sekali refresh.
  if (e.request.mode === 'navigate' || url.endsWith('.html') || url.endsWith('.js') || url.endsWith('.css')) {
    e.respondWith(networkFirst(e.request));
    return;
  }

  // Aset statis lain (ikon/gambar) -> cache-first (jarang berubah, biar hemat & cepat).
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match('./index.html')))
  );
});
