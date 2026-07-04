// Update banner untuk PWA iOS: app yang dipasang di home screen nggak punya
// tombol refresh, jadi halaman sendiri yang ngecek versi baru & nawarin reload.
// Alur: reg.update() nemu service-worker.js baru -> install -> skipWaiting di
// service-worker.js bikin dia langsung aktif -> event controllerchange ->
// banner "tap untuk update" muncul -> reload ambil shell terbaru dari network.
(function () {
  if (!('serviceWorker' in navigator)) return;

  // Belum ada controller = install pertama (bukan update) — jangan munculin banner.
  var hadController = !!navigator.serviceWorker.controller;
  var reg = null;
  var shown = false;

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' })
      .then(function (r) { reg = r; })
      .catch(function () {});
  });

  function checkUpdate() { if (reg) reg.update().catch(function () {}); }

  // iOS PWA nggak reload sendiri pas dibuka lagi dari background — cek manual
  // tiap balik ke foreground, plus tiap 15 menit kalau dibiarkan kebuka.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkUpdate();
  });
  setInterval(checkUpdate, 15 * 60 * 1000);

  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController) { hadController = true; return; }
    showBanner();
  });

  function showBanner() {
    if (shown || !document.body) return;
    shown = true;
    var bar = document.createElement('button');
    bar.type = 'button';
    bar.textContent = 'Versi baru tersedia — tap untuk update';
    bar.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);' +
      'bottom:calc(env(safe-area-inset-bottom,0px) + 16px);z-index:9999;' +
      'background:var(--gg-surface,#262522);color:var(--gg-text,#f5f3ec);' +
      'border:1px solid var(--gg-primary,#d97757);border-radius:999px;' +
      'padding:12px 18px;font:600 14px system-ui,-apple-system,sans-serif;' +
      'box-shadow:var(--gg-shadow,0 6px 18px rgba(0,0,0,.35));cursor:pointer;' +
      'max-width:calc(100vw - 32px);white-space:nowrap;';
    bar.addEventListener('click', function () { location.reload(); });
    document.body.appendChild(bar);
  }
})();
