import { auth, db, storage, OWNER_EMAILS, OFFICE_LOCATION, kodeClockout, KODE_SLOT_MS, LIBUR_HARI, LIBUR_MAX } from './firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, addDoc, doc, query, where, orderBy, getDocs, getDoc, setDoc, Timestamp, serverTimestamp }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { ref, uploadBytes, uploadString, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const $ = id => document.getElementById(id);
const TIPE = {
  clock_in:'Clock In',
  clock_out:'Clock Out',
  break_in:'Istirahat',
  break_out:'Selesai Istirahat',
  pause_in:'Pause Kerja',
  pause_out:'Lanjut Kerja',
  overtime_in:'Mulai Lembur',
  overtime_out:'Selesai Lembur'
};
const ST_ID = {
  clock_in:'sClockIn',
  clock_out:'sClockOut',
  break_in:'sBreakIn',
  break_out:'sBreakOut',
  pause_in:'sPauseIn',
  pause_out:'sPauseOut',
  overtime_in:'sOtIn',
  overtime_out:'sOtOut'
};
const NO_SELFIE_TYPES = new Set(['break_in','break_out','overtime_in','pause_in','pause_out']);
const BREAK_MAX_MS = 60 * 60 * 1000;
// Window untuk load sesi shift aktif (cover shift lintas hari). 48 jam aman untuk shift sampai ~24-36 jam.
const SESSION_WINDOW_MS = 48 * 60 * 60 * 1000;
// Max durasi 1 shift yang wajar (jam masuk -> clock out). Lebih dari ini dianggap lupa Clock Out.
// 18 jam: cukup untuk lembur panjang yang sah, tapi masih nangkep lupa-clock-out (biasanya 24 jam+).
const MAX_SHIFT_MS = 18 * 60 * 60 * 1000;

// Helper aman untuk ambil radius office (kompat 'radius' & 'radiusMeters').
const OFFICE_RADIUS = (OFFICE_LOCATION && (OFFICE_LOCATION.radius || OFFICE_LOCATION.radiusMeters)) || 150;
const GPS_ACC_MAX_TOLERANCE = 75;
function withinOfficeRadius(d, acc){
    const tol = Math.min(Math.max(Number(acc)||0, 0), GPS_ACC_MAX_TOLERANCE);
    return (d - tol) <= OFFICE_RADIUS;
}

let currentUser=null, currentType=null, stream=null, coords=null;
let cameraReady=false;
let sessionCache = [];
// === Fix C: Track last clock_out untuk cegah double-clockin ===
let lastClockOutMs = 0;
const CLOCKIN_HARD_LOCK_MS = 30 * 1000;       // 30 detik hard-disable setelah clock_out
const CLOCKIN_SOFT_CONFIRM_MS = 5 * 60 * 1000; // 5 menit muncul konfirmasi
let __clockInLockTimer = null;
function updateClockInLock(){
  const btnCi = document.getElementById('btnClockIn');
  if (!btnCi) return;
  const elapsed = Date.now() - lastClockOutMs;
  if (lastClockOutMs > 0 && elapsed < CLOCKIN_HARD_LOCK_MS){
    btnCi.disabled = true;
    btnCi.style.opacity = '0.45';
    btnCi.title = 'Tunggu ' + Math.ceil((CLOCKIN_HARD_LOCK_MS - elapsed)/1000) + ' detik (baru saja Clock Out)';
    if (__clockInLockTimer) clearTimeout(__clockInLockTimer);
    __clockInLockTimer = setTimeout(updateClockInLock, 1000);
  } else {
    btnCi.title = '';
    if (typeof updatePauseTilesUI === 'function') updatePauseTilesUI();
  }
} // semua event sesi shift aktif, ASC by ts
let isSubmitting = false; // global lock untuk mencegah double-submit (race condition)
let userProfile = { nama:'', namaPanggilan:'', jamKerja:9, foto:'', wajibKode:false, kodeAdmin:false, liburHari:null, liburRequest:null };

function distanceMeters(lat1, lng1, lat2, lng2){
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

function greetingByHour(h){
  if (h < 11) return 'Selamat Pagi';
  if (h < 15) return 'Selamat Siang';
  if (h < 18) return 'Selamat Sore';
  return 'Selamat Malam';
}

function updateGreeting(){
  const h = new Date().getHours();
  const g = greetingByHour(h);
  const nama = userProfile.namaPanggilan || userProfile.nama || (currentUser?.email||'').split('@')[0] || '';
  $('greetMsg').textContent = g + (nama ? ', ' + nama : '');
  $('greetSub').textContent = 'selamat beraktivitas';
}

function tickClock(){
  const d = new Date();
  $('liveDate').textContent  = d.toLocaleDateString('id-ID',{weekday:'long', day:'2-digit', month:'long', year:'numeric'});
}
setInterval(tickClock, 1000); tickClock();

// === SESSION HELPERS ===
function hasInSession(type){ return sessionCache.some(r => r.tipe === type); }
function getFirstInSession(type){ return sessionCache.find(r => r.tipe === type) || null; }
function getLastInSession(type){
  for (let i = sessionCache.length - 1; i >= 0; i--){
    if (sessionCache[i].tipe === type) return sessionCache[i];
  }
  return null;
}
// True bila ada pause_in tanpa pasangan pause_out setelahnya.
function isCurrentlyPaused(){
  let paused = false;
  for (const r of sessionCache){
    if (r.tipe === 'pause_in') paused = true;
    else if (r.tipe === 'pause_out') paused = false;
  }
  return paused;
}
function isCurrentlyOnBreak(){
  let onBreak = false;
  for (const r of sessionCache){
    if (r.tipe === 'break_in') onBreak = true;
    else if (r.tipe === 'break_out') onBreak = false;
  }
  return onBreak;
}
// Hitung total paused ms (semua pasangan + pause aktif sampai now).
function totalPausedMs(){
  let total = 0;
  let pauseStart = null;
  for (const r of sessionCache){
    const t = r.ts && r.ts.toDate ? r.ts.toDate().getTime() : null;
    if (t === null) continue;
    if (r.tipe === 'pause_in') pauseStart = t;
    else if (r.tipe === 'pause_out' && pauseStart !== null){
      total += (t - pauseStart);
      pauseStart = null;
    }
  }
  if (pauseStart !== null) total += (Date.now() - pauseStart);
  return total;
}
function totalNonWorkMs(){
  // Total waktu non-kerja: pause + istirahat (break), termasuk yang masih aktif sampai sekarang.
  // Dipakai biar perhitungan jam efektif konsisten dgn payroll & lembur.
  // PENTING: hanya hitung jeda yang benar-benar terjadi DALAM sesi ini [clock-in .. sekarang].
  // Interval dgn timestamp di luar rentang itu (sisa sesi lama yang nyangkut / timestamp rusak)
  // diabaikan, biar tidak "makan" jam kerja efektif (bug: istirahat > waktu sejak clock-in).
  let total = 0;
  let pauseStart = null, breakStart = null;
  const _ciEntry = getFirstInSession('clock_in');
  const _ciMs = (_ciEntry && _ciEntry.ts && _ciEntry.ts.toDate) ? _ciEntry.ts.toDate().getTime() : 0;
  const _now = Date.now();
  function _add(start, end){
    if (start < _ciMs) return;         // jeda mulai sebelum clock-in = sisa lama, abaikan
    if (end > _now + 1000) return;      // jeda berakhir di masa depan = timestamp rusak, abaikan
    if (end > start) total += (end - start);
  }
  for (const r of sessionCache){
    const tm = r.ts && r.ts.toDate ? r.ts.toDate().getTime() : (r.ts && r.ts.toMillis ? r.ts.toMillis() : null);
    if (tm === null) continue;
    if (r.tipe === 'pause_in') pauseStart = tm;
    else if (r.tipe === 'pause_out' && pauseStart !== null){ _add(pauseStart, tm); pauseStart = null; }
    else if (r.tipe === 'break_in') breakStart = tm;
    else if (r.tipe === 'break_out' && breakStart !== null){ _add(breakStart, tm); breakStart = null; }
  }
  if (pauseStart !== null) _add(pauseStart, _now);
  if (breakStart !== null) _add(breakStart, _now);
  return total;
}


// === Istirahat/Pause gabungan (break_in/break_out toggle) ===
// Jam efektif: jamKerja dikurangi 1 jam HANYA jika total Istirahat/Pause hari itu >= 60 menit.
// Kalau skip total / istirahat < 60 menit, jam efektif = jamKerja penuh. Rate gaji TIDAK diubah.
var BREAK_MIN_FOR_CREDIT_MS = 60 * 60 * 1000;
function rawJamKerja(){ return parseFloat(userProfile && userProfile.jamKerja) || 9; }
function effectiveWorkHours(){
  var jk = rawJamKerja();
  // Target NET kerja = kuota jam kerja dikurangi 1 jam hak istirahat (kontrak 10->9, 9->8).
  // Tidak lagi potong flat 1 jam bersyarat; istirahat asli dihitung di totalNonWorkMs().
  return Math.max(0, jk - 1);
}
// Toggle satu tombol: kalau lagi istirahat -> break_out, kalau tidak -> break_in. Repeatable.
function handleBreakToggle(){
  if (isCurrentlyOnBreak() || isCurrentlyPaused()) { handleAction('break_out'); }
  else {
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch(e){}
    handleAction('break_in');
  }
}
// Update label + status tombol gabungan Istirahat/Pause.
function updateBreakToggleUI(){
  var btn = $('btnBreakToggle'); if (!btn) return;
  var lbl = $('lblBreakToggle');
  var active = isCurrentlyOnBreak() || isCurrentlyPaused();
  if (lbl) lbl.textContent = active ? 'Selesai Istirahat / Pause' : 'Istirahat / Pause';
  btn.classList.toggle('tile-afterbreak', active);
  btn.classList.toggle('tile-break', !active);
  btn.disabled = isSubmitting || !hasInSession('clock_in') || hasInSession('clock_out');
  btn.style.opacity = btn.disabled ? '0.45' : '1';
}

function updateWorkCountdown(){
  const wc = $('workCountdown');
  if(!wc) return;
  const clockInEntry = getFirstInSession('clock_in');
  if (!clockInEntry || hasInSession('clock_out')) {
    wc.classList.add('hidden'); return;
  }
  const clockInTime = clockInEntry.ts.toDate();
  const jamKerja = effectiveWorkHours();
  const targetMs = jamKerja * 3600 * 1000;
  const now = new Date();
  let workedMs = (now.getTime() - clockInTime.getTime()) - totalNonWorkMs();
  if (workedMs < 0) workedMs = 0;
  const paused_now = isCurrentlyPaused() || isCurrentlyOnBreak();
  wc.classList.remove('hidden');
  if (paused_now) wc.classList.add('paused'); else wc.classList.remove('paused');
  const labelEl = wc.querySelector('.wc-label');
  if (labelEl) labelEl.textContent = paused_now ? 'Jam kerja efektif (DIBEKUKAN)' : 'Jam kerja efektif berjalan';
  const targetH = Math.floor(targetMs/3600000), targetM = Math.floor((targetMs%3600000)/60000);

  if (workedMs >= targetMs) { wc.classList.add('done'); } else { wc.classList.remove('done'); }
  const totalSec = Math.floor(workedMs/1000);
  const h = Math.floor(totalSec/3600);
  const m = Math.floor((totalSec%3600)/60);
  const sc = totalSec%60;
  $('wcTime').textContent =
    String(h).padStart(2,'0') + ':' +
    String(m).padStart(2,'0') + ':' +
    String(sc).padStart(2,'0');
}
setInterval(updateWorkCountdown, 1000);

// ===== Countdown Istirahat (60 menit dari tap Istirahat) =====
// Timer COUNT-UP Istirahat/Pause: tampilkan sudah berapa lama istirahat berjalan (naik).
// Tidak ada batas mundur 1 jam lagi; waktu kerja otomatis mundur karena freeze.
function updateBreakCountdown(){
    var wc = document.getElementById('breakCountdown');
    var clockedIn = hasInSession('clock_in') && !hasInSession('clock_out');
    var active = isCurrentlyOnBreak() || isCurrentlyPaused();
    var totalMs = clockedIn ? totalNonWorkMs() : 0;
    if (!clockedIn || totalMs <= 0){ if (wc) wc.classList.add('hidden'); window.__breakOverPrompted=false; return; }
    if (!wc){
        var c=document.createElement('div');
        c.id='breakCountdown'; c.className='work-countdown';
        c.innerHTML='<div class="wc-label">Total istirahat / pause</div><div class="wc-time" id="bcTime">00:00</div><div class="wc-sub" id="bcSub">Akumulatif hari ini</div>';
        var pn=document.getElementById('workCountdown'); pn=pn&&pn.parentNode;
        if (pn) pn.appendChild(c); else document.querySelector('main').appendChild(c);
        wc=c;
    }
    wc.classList.remove('hidden');
    var totalSec = Math.floor(totalMs/1000);
    var hh=Math.floor(totalSec/3600), mm=Math.floor((totalSec%3600)/60), ss=totalSec%60;
    var disp=(hh>0?(String(hh).padStart(2,'0')+':'):'')+String(mm).padStart(2,'0')+':'+String(ss).padStart(2,'0');
    var bcTime=document.getElementById('bcTime'); if (bcTime) bcTime.textContent=disp;
    var bcSub=document.getElementById('bcSub');
    if (bcSub) bcSub.textContent = active ? 'Sedang istirahat / pause (berjalan)' : 'Akumulatif hari ini (jeda)';
    wc.classList.toggle('paused', active);
}
setInterval(updateBreakCountdown, 1000);

// ===== Reminder: ingatkan kalau lupa tap Selesai Istirahat/Pause setelah 60 menit =====
var BREAK_REMINDER_MS = 60 * 60 * 1000; // 1 jam
function currentBreakStartMs(){
  // cari break_in / pause_in terakhir yang belum ada pasangan out-nya
  var startMs = 0;
  for (var i = 0; i < sessionCache.length; i++){
    var r = sessionCache[i];
    var tm = (r.ts && r.ts.toDate) ? r.ts.toDate().getTime() : 0;
    if (r.tipe === 'break_in' || r.tipe === 'pause_in') startMs = tm;
    else if (r.tipe === 'break_out' || r.tipe === 'pause_out') startMs = 0;
  }
  return startMs;
}
function showBreakReminderBanner(menit){
  var id = 'breakReminderBanner';
  var el = document.getElementById(id);
  if (!el){
    el = document.createElement('div');
    el.id = id;
    el.style.cssText = 'position:fixed;left:12px;right:12px;top:12px;z-index:9999;background:#b45309;color:#fff;padding:14px 16px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);font-size:14px;line-height:1.4;';
    document.body.appendChild(el);
  }
  el.innerHTML = '<b>Istirahat sudah ' + menit + ' menit</b><br>Jangan lupa tap <b>Selesai Istirahat / Pause</b> kalau sudah balik kerja ya.';
  el.style.display = 'block';
}
function hideBreakReminderBanner(){
  var el = document.getElementById('breakReminderBanner');
  if (el) el.style.display = 'none';
}
function checkBreakReminder(){
  var active = isCurrentlyOnBreak() || isCurrentlyPaused();
  if (!active){ window.__breakOverPrompted = false; hideBreakReminderBanner(); return; }
  var startMs = currentBreakStartMs();
  if (!startMs) return;
  var elapsed = Date.now() - startMs;
  if (elapsed >= BREAK_REMINDER_MS && !window.__breakOverPrompted){
    window.__breakOverPrompted = true;
    var menit = Math.floor(elapsed / 60000);
    showBreakReminderBanner(menit);
    try { if (navigator.vibrate) navigator.vibrate([300,150,300]); } catch(e){}
    try {
      if ('Notification' in window && Notification.permission === 'granted'){
        var n = new Notification('Istirahat sudah lewat 1 jam', {
          body: 'Jangan lupa tap Selesai Istirahat / Pause kalau sudah balik kerja.',
          tag: 'break-reminder',
          requireInteraction: true
        });
        n.onclick = function(){ try { window.focus(); } catch(e){} this.close(); };
      }
    } catch(e){}
  }
}
setInterval(checkBreakReminder, 30000);

function fmtTime(d){ return d.toLocaleTimeString('id-ID',{hour12:false}); }

async function loadUserProfile(uid){
  try{
    let nama='', namaPanggilan='', jamKerja=9, foto='', gpsExempt=false, wajibKode=false, kodeAdmin=false, liburHari=null, liburRequest=null;
    try{
      const snap = await getDoc(doc(db, 'karyawan', uid));
      if (snap.exists()){
        const u = snap.data();
        nama = u.nama || '';
        namaPanggilan = u.namaPanggilan || '';
        jamKerja = (u.jamKerja!=null) ? parseFloat(u.jamKerja) : 9;
        gpsExempt = !!u.gpsExempt;
        wajibKode = (u.wajibKodeClockout === true);   // wajib kode admin saat Clock Out (pilot per orang)
        kodeAdmin = (u.kodeAdmin === true);           // admin bertugas: kodenya tampil di halaman dia
        liburHari = (u.liburHari != null ? Number(u.liburHari) : null);
        liburRequest = Array.isArray(u.liburRequest) ? u.liburRequest.map(Number) : null;
      }
    }catch(e){ console.warn('karyawan profile load err:', e); }
    try{
      const snap2 = await getDoc(doc(db, 'profil', uid));
      if (snap2.exists()){
        const u2 = snap2.data();
        if (u2.foto) foto = u2.foto;
        if (!nama && u2.nama) nama = u2.nama;
      }
    }catch(e){ console.warn('profil load err:', e); }
    userProfile = { nama, namaPanggilan, jamKerja, foto, gpsExempt, wajibKode, kodeAdmin, liburHari, liburRequest };
    initAdminKodeCard();
    // (foto profil opsional) auto-popup wajib upload dihapus
    if (foto){
      $('avatarImg').src = foto;
      $('avatarImg').style.display = 'block';
      $('avatarPlaceholder').style.display = 'none';
    }
    updateGreeting();
  }catch(e){ console.warn('profile load err:', e); }
}

function timeToTodayDate(hhmm){
  const [h,m] = hhmm.split(':').map(Number);
  const d = new Date(); d.setHours(h, m||0, 0, 0);
  return d;
}

// ===== LOAD ACTIVE SESSION =====
async function loadActiveSession(uid){
  sessionCache = [];
  const since = new Date(Date.now() - SESSION_WINDOW_MS);
  const q = query(collection(db,'absensi'),
    where('uid','==', uid),
    where('ts','>=', Timestamp.fromDate(since)),
    orderBy('ts','asc'));
  const snap = await getDocs(q);
  const all = [];
  snap.forEach(d => { const r = d.data(); if (r.ts && r.ts.toDate) all.push(r); });
  let openCiIdx = -1;
  for (let i = all.length - 1; i >= 0; i--){
    if (all[i].tipe === 'clock_in'){
      let hasCo = false;
      for (let j = i + 1; j < all.length; j++){
        if (all[j].tipe === 'clock_out' || all[j].tipe === 'overtime_out'){ hasCo = true; break; }
      }
      if (!hasCo){ openCiIdx = i; break; }
    }
  }
  // Anti-stuck: kalau clock_in yang masih kebuka udah lebih lama dari MAX_SHIFT_MS,
  // anggap karyawan lupa Clock Out. Sesi itu jangan dijadiin aktif biar dia bisa Clock In lagi
  // dan data nggak jadi shift 24 jam+ (datanya kacau).
  if (openCiIdx >= 0) {
    const __ciTs = all[openCiIdx].ts && all[openCiIdx].ts.toMillis ? all[openCiIdx].ts.toMillis() : 0;
    if (__ciTs && (Date.now() - __ciTs) > MAX_SHIFT_MS) {
      openCiIdx = -1;
    }
  }
  // Fix C: cari clock_out terakhir hari ini (untuk cooldown)
  lastClockOutMs = 0;
  for (let i = all.length - 1; i >= 0; i--){
    if (all[i].tipe === 'clock_out' || all[i].tipe === 'overtime_out'){
      const ts = all[i].ts && all[i].ts.toMillis ? all[i].ts.toMillis() : 0;
      if (ts > lastClockOutMs) lastClockOutMs = ts;
    }
  }
  setTimeout(updateClockInLock, 100);
  if (openCiIdx >= 0){
    sessionCache = all.slice(openCiIdx);
  } else {
    sessionCache = [];
  }
  renderStatuses();
  updateWorkCountdown();
  if (!isCurrentlyOnBreak()) window.__breakOverPrompted = false;
  updateBreakCountdown();
  updatePauseTilesUI();
}

function renderStatuses(){
  Object.keys(ST_ID).forEach(k => {
    const el = $(ST_ID[k]); if (!el) return;
    const e = getLastInSession(k);
    if (e && e.ts) el.textContent = fmtTime(e.ts.toDate());
    else el.textContent = '-';
  });
}

function updatePauseTilesUI(){
  updateBreakToggleUI();
}

onAuthStateChanged(auth, async u => {
  if (!u){ location.replace('index.html'); return; }
  if (OWNER_EMAILS.includes((u.email||'').toLowerCase())) {
    location.replace('owner.html'); return;
  }
  currentUser = u;
  await loadUserProfile(u.uid);
  await loadActiveSession(u.uid);
  await checkForgottenClockOut(u.uid);
  refreshLocStatus();
});

$('btnLogout').onclick = () => signOut(auth).then(()=>location.replace('index.html')).catch(()=>location.replace('index.html'));

async function refreshLocStatus(){
  if (!navigator.geolocation){ coords = null; return; }

  const getPos = (opts) => new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      _ => resolve(null),
      opts
    );
  });

  // 1) Coba high-accuracy dulu (cepat 5s)
  let result = await getPos({ enableHighAccuracy: true, timeout: 5000, maximumAge: 0 });

  // 2) Kalau gagal, fallback low-accuracy (10s, boleh cache 30s)
  if (!result) {
    result = await getPos({ enableHighAccuracy: false, timeout: 10000, maximumAge: 30000 });
  }

  coords = result;
}

async function openSelfie(type){
  currentType = type;
  $('selfieTitle').textContent = 'Ambil Selfie - ' + (TIPE[type]||type);
  $('selfieModal').classList.remove('hidden');
  $('selfieCanvas').classList.add('hidden');
  cameraReady = false;

      // 1) Prefetch lokasi di belakang layar (non-blocking) supaya kamera tetap kebuka
        if (!coords) { refreshLocStatus().catch(()=>{}); }

  // 2) Disable tombol shoot sampai kamera siap
  const btnShoot = $('btnSelfieShoot');
  if (btnShoot) { btnShoot.disabled = true; btnShoot.textContent = 'Menyiapkan kamera...'; }

  // Kamera cuma tersedia di koneksi aman (https). Kalau kebuka via http, kasih tau + lempar ke https.
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Kamera diblokir browser karena halaman dibuka lewat koneksi tidak aman (http). Kamu akan dialihkan ke versi aman (https) — silakan coba absen lagi setelah halaman kebuka.');
    closeSelfie();
    if (location.protocol === 'http:') location.replace('https://' + location.host + location.pathname);
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'user' },
        width:  { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    const v = $('selfieVideo');
    v.setAttribute('playsinline', '');
    v.muted = true;
    v.srcObject = stream;

    // Paksa play
    try { await v.play(); } catch(_) {}

    // Tunggu metadata supaya videoWidth/Height valid (max 8s)
    await new Promise((res, rej) => {
      if (v.videoWidth > 0 && v.videoHeight > 0) return res();
          const to = setTimeout(() => res(), 12000);
      const done = () => { clearTimeout(to); v.removeEventListener('loadedmetadata', done); res(); };
      v.addEventListener('loadedmetadata', done);
    });

    cameraReady = true;
    if (btnShoot) { btnShoot.disabled = false; btnShoot.textContent = 'Ambil Foto'; }
  } catch(e) {
    let pesan = 'Tidak bisa akses kamera: ' + (e.message || e.name || 'unknown');
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      pesan = 'Izin kamera ditolak. Buka pengaturan browser, izinkan kamera untuk site ini, lalu refresh.';
    } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
      pesan = 'Kamera tidak ditemukan di device ini.';
    } else if (e.name === 'NotReadableError' || e.name === 'TrackStartError') {
      pesan = 'Kamera sedang dipakai aplikasi lain. Tutup app lain yang pakai kamera, lalu coba lagi.';
    } else if (e.name === 'OverconstrainedError') {
      pesan = 'Kamera tidak mendukung resolusi yang diminta. Hubungi admin.';
    }
    alert(pesan);
    closeSelfie();
  }
}
function closeSelfie(){
  if (stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
  cameraReady = false;
  $('selfieModal').classList.add('hidden');
}
$('btnSelfieCancel').onclick = closeSelfie;
$('btnSelfieShoot').onclick = async ()=>{
    if (!cameraReady) { alert('Kamera lagi disiapkan, tunggu 1-2 detik lalu klik lagi.'); return; }
  if (isSubmitting) return;
  const v = $('selfieVideo');
  const c = $('selfieCanvas');

  if (!v.videoWidth || !v.videoHeight) {
    alert('Kamera belum siap. Tunggu sebentar lalu klik lagi.');
    return;
  }

  const btnShoot = $('btnSelfieShoot');
  btnShoot.disabled = true;
  btnShoot.textContent = 'Memproses...';

  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);

  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
  if (!blob || blob.size < 1000) {
    btnShoot.disabled = false;
    btnShoot.textContent = 'Ambil Foto';
    alert('Gagal capture foto (blank). Coba ulangi.');
    return;
  }

  closeSelfie();

  if (!coords) try{ await refreshLocStatus(); }catch(e){}
  if (!coords){ alert('Lokasi belum tersedia.'); return; }
  const d = distanceMeters(coords.lat, coords.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);
      const inRad = withinOfficeRadius(d, coords && coords.acc);
  let selfieUrl = '';

  showSavingOverlay('Mengunggah foto & menyimpan absen...');

  try{
    const rand = Math.random().toString(36).slice(2,8);
    const path = 'selfie/' + currentUser.uid + '/' + Date.now() + '_' + rand + '.jpg';
    const r = ref(storage, path);
    await uploadBytes(r, blob);
    selfieUrl = await getDownloadURL(r);
  }catch(e){
    console.warn('Selfie upload gagal:', e.message);
    hideSavingOverlay();
    const lanjut = confirm('Upload foto gagal (' + (e.message||'network') + '). Tetap lanjutkan absen tanpa foto?');
    if (!lanjut) return;
    showSavingOverlay('Menyimpan absen...');
  }
  const extra = {};
  if (currentType === 'clock_out' && window.__noBreak){
    extra.noBreak = true;
    window.__noBreak = false;
  }
  if ((currentType === 'clock_out' || currentType === 'overtime_out') && window.__kodeVerif){
    extra.kodeVerif = window.__kodeVerif; // 'ok' = terverifikasi admin, 'darurat' = tanpa kode (merah di owner)
    window.__kodeVerif = null;
  }
  isSubmitting = true;
  try {
    await saveAttendance(Object.assign({ tipe: currentType, lokasi:{lat:coords.lat,lng:coords.lng}, jarak:d, inRadius:inRad, fotoSelfie:selfieUrl }, extra));
    await loadActiveSession(currentUser.uid);
  } catch(e){
    alert('Gagal menyimpan absen: ' + (e.message||'unknown') + '. Coba lagi.');
  } finally {
    isSubmitting = false;
    hideSavingOverlay();
  }
};

// Helper overlay loading untuk camera flow
function showSavingOverlay(text){
  let o = document.getElementById('__savingOverlay');
  if (!o){
    o = document.createElement('div');
    o.id = '__savingOverlay';
    o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;text-align:center;padding:24px;';
    o.innerHTML = '<div><div class="__spin" style="width:48px;height:48px;border:4px solid #fff;border-top-color:transparent;border-radius:50%;margin:0 auto 16px;animation:__spin 1s linear infinite"></div><div id="__savingText"></div></div>';
    const st = document.createElement('style');
    st.textContent = '@keyframes __spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(st);
    document.body.appendChild(o);
  }
  document.getElementById('__savingText').textContent = text || 'Menyimpan...';
  o.style.display = 'flex';
}
function hideSavingOverlay(){
  const o = document.getElementById('__savingOverlay');
  if (o) o.style.display = 'none';
}

async function doNoSelfieAction(type, extra={}){
  if (!coords) try{ await refreshLocStatus(); }catch(e){}
  if (!coords){ alert('Lokasi belum tersedia.'); return; }
  const d = distanceMeters(coords.lat, coords.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);
const inRad = withinOfficeRadius(d, coords && coords.acc);
isSubmitting = true;
    try {
    await saveAttendance(Object.assign({ tipe:type, lokasi:{lat:coords.lat,lng:coords.lng}, jarak:d, inRadius:inRad }, extra));
    await loadActiveSession(currentUser.uid);
  } finally {
    isSubmitting = false;
  }
}

async function saveAttendance(payload){
  const namaForSave = userProfile.nama || (currentUser.email||'').split('@')[0];
  const data = Object.assign({
    uid: currentUser.uid,
    email: currentUser.email,
    nama: namaForSave,
    ts: serverTimestamp()
  }, payload);
  // GPS dikecualikan (HP lokasi bermasalah): jangan tandai "luar radius",
  // tapi tandai transparan gpsExempt biar owner tau lokasinya tidak diverifikasi.
  if (userProfile && userProfile.gpsExempt){
    data.inRadius = true;
    data.gpsExempt = true;
  }
  await addDoc(collection(db,'absensi'), data);
}

function validateSequence(type){
  const hasCi = hasInSession('clock_in');
  const hasCo = hasInSession('clock_out') || hasInSession('overtime_out'); // overtime_out juga menutup shift
  if (type === 'clock_in'){
    if (hasCi && !hasCo) return 'Anda masih punya sesi shift aktif yang belum Clock Out.';
    return null;
  }
  if (type === 'break_in'){
    if (!hasCi) return 'Anda harus Clock In dulu.';
    if (isCurrentlyOnBreak()) return 'Anda sudah tap Istirahat.';
    if (isCurrentlyPaused()) return 'Anda sedang Pause Kerja. Tap Lanjutkan Kerja dulu.';
    if (hasCo) return 'Anda sudah Clock Out.';
    return null;
  }
  if (type === 'break_out'){
    if (!isCurrentlyOnBreak()) return 'Anda belum tap Istirahat.';
    if (hasCo) return 'Anda sudah Clock Out.';
    return null;
  }
  if (type === 'pause_in'){
    if (!hasCi) return 'Anda harus Clock In dulu.';
    if (isCurrentlyPaused()) return 'Anda sudah Pause Kerja.';
    if (isCurrentlyOnBreak()) return 'Anda sedang Istirahat. Pause khusus untuk split jam kerja.';
    if (hasCo) return 'Anda sudah Clock Out.';
    return null;
  }
  if (type === 'pause_out'){
    if (!isCurrentlyPaused()) return 'Anda tidak sedang Pause Kerja.';
    if (hasCo) return 'Anda sudah Clock Out.';
    return null;
  }
  if (type === 'clock_out'){
    if (isCurrentlyOnBreak()) return 'Kamu masih Istirahat. Tap Selesai Istirahat dulu sebelum Clock Out.';
    if (!hasCi) return 'Anda belum Clock In.';
    if (hasCo) return 'Anda sudah Clock Out hari ini.';
    if (isCurrentlyPaused()) return 'Anda sedang Pause. Tap Lanjutkan Kerja dulu sebelum Clock Out.';
    return null;
  }
  if (type === 'overtime_in'){
    if (!hasCo) return 'Lembur hanya setelah Clock Out.';
    if (hasInSession('overtime_in')) return 'Anda sudah Mulai Lembur.';
    return null;
  }
  if (type === 'overtime_out'){
    if (isCurrentlyOnBreak()) return 'Kamu masih Istirahat. Tap Selesai Istirahat dulu sebelum Selesai Lembur.';
    if (!hasInSession('overtime_in')) return 'Anda belum Mulai Lembur.';
    if (hasInSession('overtime_out')) return 'Anda sudah Selesai Lembur.';
    return null;
  }
  return null;
}

function askConfirm(title, message, okLabel){
  return new Promise(resolve => {
    $('confirmTitle').textContent = title;
    $('confirmMsg').textContent = message;
    $('btnConfirmOk').textContent = okLabel || 'Ya, Lanjutkan';
    const modal = $('confirmModal');
    modal.classList.remove('hidden');
    const cleanup = ()=>{
      modal.classList.add('hidden');
      $('btnConfirmOk').onclick = null;
      $('btnConfirmCancel').onclick = null;
    };
    $('btnConfirmOk').onclick = ()=>{ cleanup(); resolve(true); };
    $('btnConfirmCancel').onclick = ()=>{ cleanup(); resolve(false); };
  });
}

/* ===== Kode verifikasi Clock Out (PR-CL55) =====
   Kartu kode untuk admin bertugas: kode 4 angka tampil di halaman mereka,
   ganti otomatis tiap 10 menit (tidak perlu generate manual). */
let __kodeCardTimer = null;
function initAdminKodeCard(){
  const card = $('adminKodeCard');
  if (!card) return;
  if (!userProfile.kodeAdmin){
    card.classList.add('hidden');
    if (__kodeCardTimer){ clearInterval(__kodeCardTimer); __kodeCardTimer = null; }
    return;
  }
  card.classList.remove('hidden');
  const render = ()=>{
    $('adminKodeVal').textContent = kodeClockout(0);
    const sisaMs = KODE_SLOT_MS - (Date.now() % KODE_SLOT_MS);
    const m = Math.floor(sisaMs/60000), s = Math.floor((sisaMs%60000)/1000);
    $('adminKodeTimer').textContent = 'Kode ganti otomatis dalam ' + m + ':' + String(s).padStart(2,'0');
  };
  render();
  if (!__kodeCardTimer) __kodeCardTimer = setInterval(render, 1000);
}

// Modal minta kode saat mau pulang. Resolve: 'ok' (kode benar), 'darurat' (tanpa kode,
// ditandai merah di dashboard owner), atau null (batal).
function askKodeClockout(){
  return new Promise(resolve => {
    const modal = $('kodeModal'), inp = $('kodeInput'), err = $('kodeErr');
    if (!modal || !inp){ resolve('ok'); return; } // fallback aman kalau elemen belum ada
    inp.value = ''; if (err) err.style.display = 'none';
    modal.classList.remove('hidden');
    setTimeout(()=>{ try{ inp.focus(); }catch(e){} }, 60);
    const cleanup = (v)=>{
      modal.classList.add('hidden');
      $('btnKodeOk').onclick = null; $('btnKodeCancel').onclick = null;
      $('btnKodeDarurat').onclick = null; inp.onkeydown = null;
      resolve(v);
    };
    const submit = ()=>{
      const v = (inp.value||'').trim();
      // Terima kode slot SEKARANG atau slot SEBELUMNYA (toleransi pas pergantian 10 menit).
      if (v && (v === kodeClockout(0) || v === kodeClockout(-1))){ cleanup('ok'); }
      else { if (err) err.style.display = 'block'; inp.value=''; try{ inp.focus(); }catch(e){} }
    };
    $('btnKodeOk').onclick = submit;
    inp.onkeydown = (e)=>{ if (e.key === 'Enter'){ e.preventDefault(); submit(); } };
    $('btnKodeCancel').onclick = ()=> cleanup(null);
    $('btnKodeDarurat').onclick = async ()=>{
      modal.classList.add('hidden');
      const ok = await askConfirm('Clock Out Darurat?',
        'Tanpa kode admin, Clock Out ini akan DITANDAI MERAH di dashboard owner dan akan dicek. Lanjutkan hanya kalau admin benar-benar tidak ada.',
        'Ya, Darurat');
      if (ok){ cleanup('darurat'); } else { modal.classList.remove('hidden'); }
    };
  });
}

/* ===== Hari Libur Mingguan — karyawan pilih sendiri 3 prioritas (PR-CL60) ===== */
function _liburOptionsHtml(sel){
  let h = '<option value="">— pilih hari —</option>';
  for (let i=0;i<7;i++) h += '<option value="'+i+'"'+(String(sel)===String(i)?' selected':'')+'>'+LIBUR_HARI[i]+'</option>';
  return h;
}
function openLiburModal(){
  const modal = $('liburModal'); if (!modal) return;
  const cur = userProfile.liburHari;
  const req = Array.isArray(userProfile.liburRequest) ? userProfile.liburRequest : [];
  const cc = $('liburCurrent');
  if (cc){
    let html = (cur!=null && cur>=0)
      ? 'Hari libur kamu: <b style="color:#6ee7b7">'+LIBUR_HARI[cur]+'</b> <span style="color:#9ca3af">(ditentukan owner)</span>'
      : 'Kamu belum punya hari libur tetap. Kirim usulan di bawah ya.';
    if (req.length) html += '<br><span style="color:#fbbf24">📩 Usulan kamu: '+req.map(d=>LIBUR_HARI[d]).join(' › ')+' — nunggu di-approve owner.</span>';
    cc.innerHTML = html;
  }
  $('liburPil1').innerHTML = _liburOptionsHtml(req[0]!=null?req[0]:cur);
  $('liburPil2').innerHTML = _liburOptionsHtml(req[1]);
  $('liburPil3').innerHTML = _liburOptionsHtml(req[2]);
  const err=$('liburErr'); if(err) err.style.display='none';
  modal.classList.remove('hidden');
}
async function saveLiburRequest(){
  const picks=[$('liburPil1').value, $('liburPil2').value, $('liburPil3').value].filter(v=>v!=='').map(Number);
  const err=$('liburErr');
  if (picks.length < 1){ if(err){err.textContent='Minimal pilih 1 hari.';err.style.display='block';} return; }
  if (new Set(picks).size !== picks.length){ if(err){err.textContent='Pilihan harus hari yang berbeda-beda.';err.style.display='block';} return; }
  const btn=$('btnLiburSave'); btn.disabled=true; btn.textContent='Mengirim...';
  try {
    // Cuma KIRIM USULAN — owner yang nentuin hari final. Ga nge-set liburHari.
    await setDoc(doc(db,'karyawan',currentUser.uid), { liburRequest: picks, liburRequestAt: serverTimestamp(), liburRequestPending: true, updatedAt: serverTimestamp() }, { merge:true });
    userProfile.liburRequest = picks;
    $('liburModal').classList.add('hidden');
    alert('✅ Usulan libur kamu udah dikirim ke owner:\n' + picks.map(d=>LIBUR_HARI[d]).join(' › ') + '\n\nOwner yang bakal nentuin hari finalnya. Ditunggu ya.');
  } catch(e){ console.error('saveLiburReq', e); alert('Gagal mengirim: ' + (e && e.message ? e.message : e)); btn.disabled=false; btn.textContent='Kirim Usulan'; }
}
(function wireLibur(){
  const b=$('btnLibur'); if (b) b.onclick=openLiburModal;
  const c=$('btnLiburCancel'); if (c) c.onclick=()=>$('liburModal').classList.add('hidden');
  const s=$('btnLiburSave'); if (s) s.onclick=saveLiburRequest;
})();

async function handleAction(type){
  if (isSubmitting){ return; } // cegah double-tap race condition
  // (foto profil opsional) tidak lagi memblokir aksi kalau belum upload foto
  const err = validateSequence(type);
  if (err){ alert(err); return; }
  if (!coords) try{ await refreshLocStatus(); }catch(e){}

  if (type === 'break_in'){
    const ok = await askConfirm('Mulai Istirahat?', 'Apakah Anda yakin ingin mulai Istirahat sekarang? Tap Selesai Istirahat saat kembali bekerja.', 'Ya, Mulai Istirahat');
    if (!ok) return;
  }
  if (type === 'break_out'){
    const ok = await askConfirm('Selesai Istirahat?', 'Apakah Anda yakin sudah selesai Istirahat dan siap kembali bekerja?', 'Ya, Selesai Istirahat');
    if (!ok) return;
  }
  if (type === 'pause_in'){
    const ok = await askConfirm('Pause Kerja?', 'Sisa jam kerja akan dibekukan sampai Anda tap Lanjutkan Kerja. Pause untuk split jam kerja (bukan istirahat).', 'Ya, Pause');
    if (!ok) return;
  }
  if (type === 'pause_out'){
    const ok = await askConfirm('Lanjutkan Kerja?', 'Timer jam kerja akan kembali berjalan.', 'Ya, Lanjutkan');
    if (!ok) return;
  }
  if (type === 'clock_in' && lastClockOutMs > 0){
    const elapsed = Date.now() - lastClockOutMs;
    if (elapsed < CLOCKIN_HARD_LOCK_MS){
      alert('Anda baru saja Clock Out. Tunggu ' + Math.ceil((CLOCKIN_HARD_LOCK_MS - elapsed)/1000) + ' detik lagi sebelum Clock In ulang.');
      return;
    }
    if (elapsed < CLOCKIN_SOFT_CONFIRM_MS){
      const mins = Math.floor(elapsed/60000);
      const secs = Math.floor((elapsed%60000)/1000);
      const waktuStr = mins > 0 ? (mins + ' menit ' + secs + ' detik') : (secs + ' detik');
      const ok = await askConfirm('Mulai Shift Baru?', 'Anda baru saja Clock Out ' + waktuStr + ' yang lalu. Tap "Ya, Mulai Shift" hanya kalau memang mau mulai shift baru. Kalau salah pencet, tap Batal.', 'Ya, Mulai Shift');
      if (!ok) return;
    }
  }
  if (type === 'clock_out'){
    const ok = await askConfirm('Clock Out Sekarang?', 'Apakah Anda yakin ingin Clock Out? Aksi ini menandakan Anda selesai bekerja untuk sesi shift ini.', 'Ya, Clock Out');
    if (!ok) return;
  }

  // Kode verifikasi admin saat pulang (hanya untuk karyawan yang di-set wajib oleh owner).
  if ((type === 'clock_out' || type === 'overtime_out') && userProfile.wajibKode){
    const k = await askKodeClockout();
    if (!k) return;
    window.__kodeVerif = k; // 'ok' | 'darurat' -> nempel ke event pas disimpan
  }

  if (NO_SELFIE_TYPES.has(type)){
    return doNoSelfieAction(type);
  }
  if (type === 'clock_out'){
    return handleClockOut();
  }
  openSelfie(type);
}

$('btnClockIn').onclick   = () => handleAction('clock_in');
$('btnClockOut').onclick  = () => handleAction('clock_out');
$('btnBreakToggle').onclick = ()=> handleBreakToggle();
// (tombol Mulai Lembur dihapus) overtime_in sekarang otomatis, tidak ada wiring manual
$('btnOtOut').onclick     = () => autoOtThenOut();

async function handleClockOut(){
  if (isCurrentlyOnBreak()){
    const bi = getLastInSession('break_in');
    isSubmitting = true;
    try {
      await saveAttendance({
        tipe:'break_out',
        lokasi: (bi && bi.lokasi) || null,
        jarak: (bi && bi.jarak) || 0,
        inRadius: (bi && bi.inRadius) || false,
        autoCap: true
      });
      await loadActiveSession(currentUser.uid);
    } finally {
      isSubmitting = false;
    }
    $('forgotBreakOutModal').classList.remove('hidden');
    return;
  }
  if (!hasInSession('break_in')){
    openBreakRangeModal();
    return;
  }
  proceedClockOut();
}

function proceedClockOut(){
  // Peringatan pulang lebih awal + input alasan dihapus. Karyawan dibayar per jam efektif.
  openSelfie('clock_out');
}

// earlyModal dihapus (tidak ada lagi peringatan pulang lebih awal).

$('btnForgotBreakOk').onclick = ()=>{
  $('forgotBreakOutModal').classList.add('hidden');
  proceedClockOut();
};

async function openBreakRangeModal(){
  $('breakStartInput').value = '12:00';
  $('breakRangeModal').classList.remove('hidden');
}

$('btnBreakRangeOk').onclick = async ()=>{
  const s = $('breakStartInput').value;
const [h,m]=s.split(':');const eh=String((parseInt(h)+1)%24).padStart(2,'0');const e=eh+':'+m;
  if (!s || !e){ alert('Mohon isi kedua waktu.'); return; }
  const sd = timeToTodayDate(s);
  let ed = timeToTodayDate(e);
  if (ed <= sd){ alert('Selesai Istirahat harus setelah Mulai Istirahat.'); return; }
  if ((ed - sd) > BREAK_MAX_MS){
    ed = new Date(sd.getTime() + BREAK_MAX_MS);
    alert('Durasi istirahat dipotong maksimal 1 jam. Selesai jadi: ' + fmtTime(ed));
  }
  const d = coords ? distanceMeters(coords.lat, coords.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng) : 0;
    const inRad = coords ? withinOfficeRadius(d, coords.acc) : false;
  const namaForSave = userProfile.nama || (currentUser.email||'').split('@')[0];
  const base = {
    uid: currentUser.uid,
    email: currentUser.email,
    nama: namaForSave,
    lokasi: coords ? {lat:coords.lat, lng:coords.lng} : null,
    jarak: d,
    inRadius: inRad,
    flag: 'breakFilledAtCheckout'
  };
  await addDoc(collection(db,'absensi'), Object.assign({}, base, {
    tipe:'break_in',
    ts: Timestamp.fromDate(sd)
  }));
  await addDoc(collection(db,'absensi'), Object.assign({}, base, {
    tipe:'break_out',
    ts: Timestamp.fromDate(ed)
  }));
  $('breakRangeModal').classList.add('hidden');
  await loadActiveSession(currentUser.uid);
  proceedClockOut();
};

var __bnb=$('#btnBreakRangeNoBreak'); if(__bnb) __bnb.onclick = () => {
  $('#breakRangeModal').classList.add('hidden');
  window.__noBreak = true;
  proceedClockOut();
};

// ===== SOFT FORGOTTEN CLOCK OUT =====
async function checkForgottenClockOut(uid){
  try{
    const ciNow = getFirstInSession('clock_in');
    if (ciNow && ciNow.ts && ciNow.ts.toDate){
      const ageMs = Date.now() - ciNow.ts.toDate().getTime();
      if (ageMs < 24 * 60 * 60 * 1000){
        return;
      }
      const ci = ciNow;
      const last = sessionCache[sessionCache.length - 1];
      const lastTime = (last && last.ts && last.ts.toDate) ? last.ts.toDate() : ci.ts.toDate();
      const sessionKey = 'oldSessionShown_' + uid + '_' + ci.ts.toDate().toISOString();
      if (sessionStorage.getItem(sessionKey) === '1') return;

      const ciStr = ci.ts.toDate().toLocaleString('id-ID',{weekday:'long',day:'2-digit',month:'long',hour:'2-digit',minute:'2-digit',hour12:false});
      const lastStr = lastTime.toLocaleString('id-ID',{weekday:'long',day:'2-digit',month:'long',hour:'2-digit',minute:'2-digit',hour12:false});
      $('oldSessionMsg').textContent =
        'Sistem mendeteksi Anda Clock In pada ' + ciStr + ' dan belum Clock Out. ' +
        'Aktivitas terakhir tercatat ' + lastStr + '. ' +
        'Tutup sesi sekarang (Clock Out sekarang) atau tutup nanti?';
      $('oldSessionModal').classList.remove('hidden');
      $('btnOldSessionLater').onclick = ()=>{
        try{ sessionStorage.setItem(sessionKey, '1'); }catch(e){}
        $('oldSessionModal').classList.add('hidden');
      };
      $('btnOldSessionClose').onclick = async ()=>{
        try{ sessionStorage.setItem(sessionKey, '1'); }catch(e){}
        $('oldSessionModal').classList.add('hidden');
        try{ await handleAction('clock_out'); }catch(e){ console.warn('manual close session err', e); }
      };
    }
  }catch(e){ console.warn('checkForgottenClockOut err:', e); }
}

$('avatarWrap').onclick = () => { try { openProfil(); } catch(e) { $('avatarInput').click(); } };
$('avatarInput').onchange = async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  try{
    const dataUrl = await resizeImage(f, 400);
    let url = dataUrl;
    try{
      const path = 'profil/' + currentUser.uid + '/avatar.jpg';
      const r = ref(storage, path);
      await uploadString(r, dataUrl, 'data_url');
      url = await getDownloadURL(r);
      console.log('Avatar uploaded to Storage');
    }catch(storageErr){
      console.warn('Storage upload gagal, pakai base64 inline:', storageErr.message);
    }
    await setDoc(doc(db,'profil', currentUser.uid), { foto: url, nama: userProfile.nama || '' }, { merge:true });
    userProfile.foto = url;
    $('avatarImg').src = url;
    $('avatarImg').style.display = 'block';
    $('avatarPlaceholder').style.display = 'none';
    $('mandatoryAvatarModal').classList.add('hidden');
  }catch(e){
    alert('Gagal simpan foto: ' + e.message);
  }
};

function resizeImage(file, maxSize){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = e=>{
      const img = new Image();
      img.onload = ()=>{
        const c = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (w > h && w > maxSize){ h = h * maxSize / w; w = maxSize; }
        else if (h > maxSize){ w = w * maxSize / h; h = maxSize; }
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// === Auto-refresh absen state agar sinkron dengan owner side ===
async function refreshAbsenState(){
  try{
    if(!currentUser || !currentUser.uid) return;
    await loadActiveSession(currentUser.uid);
  }catch(err){ console.warn('refreshAbsenState error', err); }
}
setInterval(refreshAbsenState, 30000);
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) refreshAbsenState(); });
window.addEventListener('focus', refreshAbsenState);

function showMandatoryAvatarModal(){
  try{
    const m = $('mandatoryAvatarModal');
    if (m) m.classList.remove('hidden');
  }catch(e){}
}
(function(){
  try{
    const b = document.getElementById('btnUploadAvatarNow');
    if (b) b.onclick = ()=>{ try{ $('avatarInput').click(); }catch(e){} };
  }catch(e){}
})();


// ===== Auto-Overtime logic (ditambah lewat PR) =====
// Aturan bisnis:
//  - Lembur HANYA dihitung kalau karyawan menekan "Clock Out Lembur" (tombol ini).
//    Clock out biasa tidak pernah menghitung lembur (karyawan sering lupa clock out).
//  - overtime_in di-set OTOMATIS pada saat kuota jam kerja NET terpenuhi:
//    clock_in + (jamKerja * 1 jam) + total durasi pause/break. Pause TIDAK dihitung jam kerja.

// Total durasi pause + break hari ini dalam milidetik. Pasangkan in->out berurutan.
function totalPauseMillisToday() {
  let total = 0;
  const pairs = [['break_in', 'break_out'], ['pause_in', 'pause_out']];
  for (const [inT, outT] of pairs) {
    const ins = sessionCache.filter(e => e.tipe === inT).sort((a, b) => a.ts.toMillis() - b.ts.toMillis());
    const outs = sessionCache.filter(e => e.tipe === outT).sort((a, b) => a.ts.toMillis() - b.ts.toMillis());
    const n = Math.min(ins.length, outs.length);
    for (let i = 0; i < n; i++) {
      const d = outs[i].ts.toMillis() - ins[i].ts.toMillis();
      if (d > 0) total += d;
    }
  }
  return total;
}

// Tulis dokumen overtime_in langsung ke Firestore dengan timestamp backdate
// (saveAttendance memaksa ts = serverTimestamp(), jadi tidak bisa dipakai untuk backdate).
async function writeOvertimeInAt(ms) {
  const data = {
    tipe: 'overtime_in',
    ts: Timestamp.fromMillis(ms),
    uid: currentUser.uid,
    email: currentUser.email,
    nama: (userProfile && userProfile.nama) ? userProfile.nama : (currentUser.displayName || ''),
    auto: true
  };
  await addDoc(collection(db, 'absensi'), data);
  sessionCache.push({ tipe: 'overtime_in', ts: data.ts });
}

// Handler tombol "Clock Out Lembur": catat overtime_in otomatis (kalau belum ada),
// lalu catat overtime_out lewat alur normal (selfie/validasi seperti biasa).
async function autoOtThenOut() {
  try {
    const clockIn = getFirstInSession('clock_in');
    if (!clockIn) {
      alert('Belum ada Clock In hari ini, lembur tidak bisa dicatat.');
      return;
    }
    // 1) Cek jam kerja efektif (NET) sudah mencapai target (kuota - 1 jam hak istirahat).
    //    totalNonWorkMs() sudah menghitung istirahat/pause yang masih kebuka sampai sekarang,
    //    jadi estimasi akurat walau karyawan belum tap Selesai Istirahat.
    const targetH = effectiveWorkHours();
    const targetMs = targetH * 3600000;
    const workedNetMs = (Date.now() - clockIn.ts.toMillis()) - totalNonWorkMs();
    if (workedNetMs < targetMs) {
      alert('Jam kerja efektif Anda belum mencapai ' + targetH + ' jam, jadi belum ada lembur hari ini. Silakan gunakan tombol Clock Out untuk mengakhiri shift.');
      return;
    }
    // 2) Konfirmasi dulu sebelum lanjut (cegah salah pencet). Tampilkan estimasi durasi lembur.
    const otMs = workedNetMs - targetMs;
    const otH = Math.floor(otMs / 3600000);
    const otM = Math.floor((otMs % 3600000) / 60000);
    const otStr = (otH > 0 ? (otH + ' jam ') : '') + otM + ' menit';
    const okOt = await askConfirm('Selesai Lembur Sekarang?', 'Lembur Anda yang akan tercatat sekitar ' + otStr + '. Aksi ini juga mencatat jam keluar (pulang) Anda. Lanjutkan dan ambil selfie?', 'Ya, Selesai Lembur');
    if (!okOt) return;
    // 3) Setelah dikonfirmasi: tutup otomatis istirahat/pause yang masih kebuka biar durasi akurat
    //    (kasus karyawan lupa tap Selesai Istirahat sebelum tap Selesai Lembur).
    if (isCurrentlyOnBreak()) { await doNoSelfieAction('break_out'); }
    if (isCurrentlyPaused()) { await doNoSelfieAction('pause_out'); }
    // 4) Catat overtime_in otomatis (backdate ke titik kuota terpenuhi).
    if (!hasInSession('overtime_in')) {
      const otInMs = clockIn.ts.toMillis() + targetMs + totalNonWorkMs();
      await writeOvertimeInAt(otInMs);
    }
    // 5) Catat overtime_out (lewat selfie). Ini sekaligus penanda JAM KELUAR;
    //    tidak perlu Clock Out terpisah karena overtime_out sudah menutup shift.
    await handleAction('overtime_out');
  } catch (e) {
    console.error('autoOtThenOut error', e);
    alert('Gagal mencatat lembur: ' + (e && e.message ? e.message : e));
  }
}

// Sembunyikan tombol "Mulai Lembur" karena overtime_in sekarang otomatis.
(function hideManualOtIn() {
  const el = document.getElementById('btnOtIn');
  if (el) el.style.display = 'none';
})();


/* ===== Lengkapi Profil Karyawan (rekening + KTP, 1x lock) ===== */
(function initProfilKaryawan(){
  function el(id){ return document.getElementById(id); }
  let pfSelectedKtpFile = null;
  let pfExistingKtpUrl = '';

  function setLocked(locked){
    const fields = ['pfNamaBank','pfNomorRekening','pfAtasNamaRek'];
    fields.forEach(id => { const e = el(id); if(e) e.disabled = !!locked; });
    const pick = el('pfBtnPickKtp'); if(pick) pick.style.display = locked ? 'none' : '';
    const save = el('pfBtnSave'); if(save) save.style.display = locked ? 'none' : '';
    const note = el('pfLockedNote'); if(note) note.classList.toggle('hidden', !locked);
  }

  async function openProfil(){
  try{ window.openProfil = openProfil; }catch(e){}
    const modal = el('profilModal'); if(!modal) return;
    pfSelectedKtpFile = null;
    if(typeof currentUser === 'undefined' || !currentUser){ alert('Sesi belum siap, coba lagi.'); return; }
    const uid = currentUser.uid;
    try{
      const snap = await getDoc(doc(db,'karyawan',uid));
      const d = snap.exists() ? snap.data() : {};
      if(el('pfNama')) el('pfNama').value = ((typeof userProfile!=='undefined'&&userProfile&&userProfile.nama)?userProfile.nama:'') || d.nama || currentUser.displayName || '';
      if(el('pfIdKaryawan')) el('pfIdKaryawan').value = d.idKaryawan || d.nik || '';
      if(el('pfNamaBank')) el('pfNamaBank').value = d.namaBank || '';
      if(el('pfNomorRekening')) el('pfNomorRekening').value = d.nomorRekening || '';
      if(el('pfAtasNamaRek')) el('pfAtasNamaRek').value = d.atasNamaRek || '';
      pfExistingKtpUrl = d.ktpUrl || '';
      const prev = el('pfKtpPreview');
      if(prev){
        if(d.ktpUrl){ prev.src = d.ktpUrl; prev.classList.remove('hidden'); }
        else { prev.src = ''; prev.classList.add('hidden'); }
      }
      if(el('pfKtpName')) el('pfKtpName').textContent = '';
      setLocked(!!d.profilLocked);
    }catch(e){ console.error('load profil', e); }
    modal.classList.remove('hidden');
  }

  function closeProfil(){ const m = el('profilModal'); if(m) m.classList.add('hidden'); }

  async function saveProfil(){
    if(window.__pfSaving) return; // cegah dobel-simpan (anti dobel-notif)
    if(typeof currentUser === 'undefined' || !currentUser){ alert('Sesi belum siap.'); return; }
    const uid = currentUser.uid;
    const namaBank = (el('pfNamaBank').value||'').trim();
    const nomorRekening = (el('pfNomorRekening').value||'').trim();
    const atasNamaRek = (el('pfAtasNamaRek').value||'').trim();
    if(!namaBank || !nomorRekening || !atasNamaRek){ alert('Lengkapi semua data rekening dulu ya.'); return; }
    // Baca file KTP dari variabel ATAU langsung dari input (event 'change' kadang tidak ke-trigger di HP)
    const ktpInputEl = el('pfKtpInput');
    const ktpFile = pfSelectedKtpFile || (ktpInputEl && ktpInputEl.files && ktpInputEl.files[0]) || null;
    if(!ktpFile && !pfExistingKtpUrl){ alert('Upload foto KTP dulu ya.'); return; }
    const saveBtn = el('pfBtnSave');
    const oldTxt = saveBtn ? saveBtn.textContent : '';
    if(saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Menyimpan...'; }
    window.__pfSaving = true;
    try{
      const path = 'profil/' + uid + '/ktp.jpg';
      const sref = ref(storage, path);
      // --- Kompres foto KTP biar di bawah 2MB (batas Storage) sebelum upload ---
      async function __compressKtp(file, maxBytes){
        try {
          if (!file || !/^image\//.test(file.type||"")) return file;
          if (file.size && file.size <= maxBytes) return file;
          const dataUrl = await new Promise((res,rej)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=rej; fr.readAsDataURL(file); });
          const img = await new Promise((res,rej)=>{ const im=new Image(); im.onload=()=>res(im); im.onerror=rej; im.src=dataUrl; });
          let maxDim = 1600;
          let quality = 0.82;
          let outBlob = null;
          for (let attempt=0; attempt<6; attempt++){
            let w=img.width, h=img.height;
            if (w>maxDim || h>maxDim){ const s=Math.min(maxDim/w, maxDim/h); w=Math.round(w*s); h=Math.round(h*s); }
            const cv=document.createElement("canvas"); cv.width=w; cv.height=h;
            const cx=cv.getContext("2d"); cx.fillStyle="#fff"; cx.fillRect(0,0,w,h); cx.drawImage(img,0,0,w,h);
            outBlob = await new Promise(res=>cv.toBlob(res,"image/jpeg",quality));
            if (outBlob && outBlob.size <= maxBytes) break;
            if (quality > 0.5) quality -= 0.15; else maxDim = Math.round(maxDim*0.8);
          }
          if (!outBlob) return file;
          return new File([outBlob], "ktp.jpg", { type:"image/jpeg" });
        } catch(e){ console.warn("Kompres KTP gagal, pakai file asli:", e&&e.message); return file; }
      }
      let ktpUrl = pfExistingKtpUrl;
      let ktpFailed = false;
      if(ktpFile){
        try {
          const __ktpToUpload = await __compressKtp(ktpFile, 2*1024*1024 - 50*1024);
          await uploadBytes(sref, __ktpToUpload);
          ktpUrl = await getDownloadURL(sref);
        } catch(upErr){ console.error('Upload KTP gagal', upErr); ktpFailed = true; }
      }
      const __payload = {
        namaBank, nomorRekening, atasNamaRek,
        profilUpdatedAt: serverTimestamp()
      };
      if(ktpUrl) __payload.ktpUrl = ktpUrl;
      // Profil dianggap LENGKAP & dikunci kalau rekening + KTP sudah ada.
      if(ktpUrl) __payload.profilLocked = true;
      await setDoc(doc(db,'karyawan',uid), __payload, { merge: true });
      const prev = el('pfKtpPreview');
      if(prev && ktpUrl){ prev.src = ktpUrl; prev.classList.remove('hidden'); }
      if(ktpUrl) setLocked(true);
      alert(ktpFailed
        ? 'Rekening tersimpan, tapi foto KTP gagal terupload. Cek koneksi / coba foto lebih kecil, lalu upload KTP lagi ya.'
        : 'Data profil tersimpan. Terima kasih!');
    }catch(e){
      console.error('save profil', e);
      alert('Gagal menyimpan: ' + (e && e.message ? e.message : e));
    }finally{
      window.__pfSaving = false;
      if(saveBtn){ saveBtn.disabled = false; saveBtn.textContent = oldTxt || 'Simpan'; }
    }
  }

  function wire(){
    try{ window.openProfil = openProfil; }catch(e){} // pasang lebih awal: cegah jalur fallback ikut nembak (anti dobel picker)
    const open = el('btnOpenProfil'); if(open) open.onclick = openProfil;
    const cancel = el('pfBtnCancel'); if(cancel) cancel.onclick = closeProfil;
    const pick = el('pfBtnPickKtp'); const input = el('pfKtpInput');
    if(pick && input) pick.onclick = () => { if(window.__pfPicking) return; window.__pfPicking = true; setTimeout(function(){ window.__pfPicking = false; }, 1000); input.click(); };
    if(input) input.onchange = (ev) => {
      window.__pfPicking = false;
      const f = ev.target.files && ev.target.files[0];
      if(!f) return;
      pfSelectedKtpFile = f;
      if(el('pfKtpName')) el('pfKtpName').textContent = f.name;
      const prev = el('pfKtpPreview');
      if(prev){
        const url = URL.createObjectURL(f);
        prev.src = url; prev.classList.remove('hidden');
      }
    };
    const save = el('pfBtnSave'); if(save) save.onclick = saveProfil;
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();

;window.__pfTriggerAvatar=function(){var i=document.getElementById("avatarInput"); if(i) i.click();};
/* === pf-profil-ui-fix: avatar circle in modal + nama/id readonly === */
(function(){
  function $(id){return document.getElementById(id);}
  function syncPfAvatar(){
    try{
      var src=(typeof userProfile!=='undefined'&&userProfile&&userProfile.foto)?userProfile.foto:'';
      var img=$('pfAvatarImg'), ph=$('pfAvatarPh');
      if(img&&ph){ if(src){ img.src=src; img.classList.add('show'); ph.classList.add('hide'); } else { img.classList.remove('show'); ph.classList.remove('hide'); } }
    }catch(e){}
  }
  function setRO(){ var n=$('pfNama'), i=$('pfIdKaryawan'); if(n){n.readOnly=true;n.removeAttribute('disabled');} if(i){i.readOnly=true;i.removeAttribute('disabled');} }
  function trigger(){ var inp=$('avatarInput'); if(inp){ inp.click(); } }
  function wireUp(){
    var btn=$('pfBtnUploadAvatar'), circle=$('pfAvatarCircle');
    if(btn&&!btn.__pfWired){ btn.__pfWired=true; btn.addEventListener('click',function(e){e.preventDefault();trigger();}); }
    if(circle&&!circle.__pfWired){ circle.__pfWired=true; circle.addEventListener('click',function(e){e.preventDefault();trigger();}); }
    var modal=$('profilModal');
    if(modal&&!modal.__pfObs){ modal.__pfObs=true;
      var obs=new MutationObserver(function(){ if(!modal.classList.contains('hidden')){ setRO(); syncPfAvatar(); } });
      obs.observe(modal,{attributes:true,attributeFilter:['class']});
    }
    var hdr=$('avatarInput');
    if(hdr&&!hdr.__pfMirror){ hdr.__pfMirror=true; hdr.addEventListener('change',function(){ setTimeout(syncPfAvatar,1500); }); }
  }
  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded',wireUp); } else { wireUp(); }
})();


// ===== Fallback wiring tombol profil (tahan banting, anti stale-cache/timing) =====
// Hanya aktif kalau wiring utama (IIFE initProfilKaryawan) TIDAK jalan, dideteksi via window.openProfil.
(function(){
  function gid(id){ return document.getElementById(id); }
  function mainWiringActive(){ return typeof window.openProfil === 'function'; }
  if (typeof window.__pfKtpFile === 'undefined') window.__pfKtpFile = null;
  document.addEventListener('change', function(ev){
    if (mainWiringActive()) return;
    var t = ev.target;
    if (!t || t.id !== 'pfKtpInput') return;
    var f = t.files && t.files[0];
    if (!f) return;
    window.__pfKtpFile = f;
    var nm = gid('pfKtpName'); if (nm) nm.textContent = f.name;
    var prev = gid('pfKtpPreview');
    if (prev) { try { prev.src = URL.createObjectURL(f); prev.classList.remove('hidden'); } catch(e){} }
  }, true);
  async function compressKtpFallback(file, maxBytes){
    try {
      if (!file || !/^image\//.test(file.type)) return file;
      if (file.size && file.size <= maxBytes) return file;
      var dataUrl = await new Promise(function(res,rej){ var r=new FileReader(); r.onload=function(){res(r.result);}; r.onerror=rej; r.readAsDataURL(file); });
      var img = await new Promise(function(res,rej){ var im=new Image(); im.onload=function(){res(im);}; im.onerror=rej; im.src=dataUrl; });
      var maxDim = 1600, quality = 0.82, outBlob = null;
      for (var attempt=0; attempt<6; attempt++){
        var w=img.width, h=img.height;
        if (w>maxDim || h>maxDim){ var s=Math.min(maxDim/w, maxDim/h); w=Math.round(w*s); h=Math.round(h*s); }
        var cv=document.createElement('canvas'); cv.width=w; cv.height=h;
        var cx=cv.getContext('2d'); cx.fillStyle='#fff'; cx.fillRect(0,0,w,h); cx.drawImage(img,0,0,w,h);
        outBlob = await new Promise(function(res){ cv.toBlob(res,'image/jpeg',quality); });
        if (outBlob && outBlob.size <= maxBytes) break;
        if (quality > 0.5) quality -= 0.15; else maxDim = Math.round(maxDim*0.8);
      }
      if (!outBlob) return file;
      return new File([outBlob], 'ktp.jpg', { type:'image/jpeg' });
    } catch(e){ console.warn('compressKtpFallback gagal, pakai file asli', e); return file; }
  }
  async function doSaveFallback(){
    if (window.__pfSaving) return;
    if (typeof currentUser === 'undefined' || !currentUser){ alert('Sesi belum siap, coba lagi'); return; }
    var uid = currentUser.uid;
    var namaBank = ((gid('pfNamaBank')||{}).value||'').trim();
    var nomorRekening = ((gid('pfNomorRekening')||{}).value||'').trim();
    var atasNamaRek = ((gid('pfAtasNamaRek')||{}).value||'').trim();
    if (!namaBank || !nomorRekening || !atasNamaRek){ alert('Lengkapi semua data rekening dulu ya'); return; }
    var ktpFile = window.__pfKtpFile || (gid('pfKtpInput') && gid('pfKtpInput').files && gid('pfKtpInput').files[0]) || null;
    var existingKtp = '';
    try { var __s0 = await getDoc(doc(db,'karyawan',uid)); if (__s0.exists()) existingKtp = (__s0.data().ktpUrl)||''; } catch(e){}
    if (!ktpFile && !existingKtp){ alert('Upload foto KTP dulu ya'); return; }
    window.__pfSaving = true;
    var saveBtn = gid('pfBtnSave');
    var oldTxt = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Menyimpan...'; }
    try {
      var ktpUrl = existingKtp;
      if (ktpFile){
        var sref = ref(storage, 'profil/' + uid + '/ktp.jpg');
        var toUpload = await compressKtpFallback(ktpFile, 2*1024*1024 - 50*1024);
        await uploadBytes(sref, toUpload);
        ktpUrl = await getDownloadURL(sref);
      }
      var __pl = { namaBank: namaBank, nomorRekening: nomorRekening, atasNamaRek: atasNamaRek, profilUpdatedAt: serverTimestamp() }; if (ktpUrl) __pl.profilLocked = true;
      if (ktpUrl) __pl.ktpUrl = ktpUrl;
      await setDoc(doc(db,'karyawan',uid), __pl, { merge: true });
      var prev = gid('pfKtpPreview'); if (prev){ prev.src = ktpUrl; prev.classList.remove('hidden'); }
      alert('Data profil tersimpan. Terima kasih!');
      var modal = gid('profilModal'); if (modal) modal.classList.add('hidden');
    } catch(e){ console.error('doSaveFallback', e); alert('Gagal menyimpan: ' + (e && e.message ? e.message : e)); }
    finally { window.__pfSaving = false; if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = oldTxt || 'Simpan'; } }
  }
  document.addEventListener('click', function(ev){
    if (mainWiringActive()) return;
    var t = ev.target; if (!t || !t.closest) return;
    if (t.closest('#pfBtnPickKtp')){ if(window.__pfPicking) return; window.__pfPicking = true; setTimeout(function(){ window.__pfPicking = false; }, 1000); var inp = gid('pfKtpInput'); if (inp) inp.click(); return; }
    if (t.closest('#pfBtnCancel')){ var m = gid('profilModal'); if (m) m.classList.add('hidden'); return; }
    if (t.closest('#pfBtnSave')){ doSaveFallback(); return; }
  }, true);
})();
