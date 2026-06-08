import { auth, db, storage, OWNER_EMAILS, OFFICE_LOCATION } from './firebase-config.js';
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
const MAX_SHIFT_MS = 14 * 60 * 60 * 1000;

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
let userProfile = { nama:'', jamKerja:8, foto:'' };

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
  const nama = userProfile.nama || (currentUser?.email||'').split('@')[0] || '';
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
  let total = 0;
  let pauseStart = null, breakStart = null;
  for (const r of sessionCache){
    const tm = r.ts && r.ts.toDate ? r.ts.toDate().getTime() : (r.ts && r.ts.toMillis ? r.ts.toMillis() : null);
    if (tm === null) continue;
    if (r.tipe === 'pause_in') pauseStart = tm;
    else if (r.tipe === 'pause_out' && pauseStart !== null){ total += (tm - pauseStart); pauseStart = null; }
    else if (r.tipe === 'break_in') breakStart = tm;
    else if (r.tipe === 'break_out' && breakStart !== null){ total += (tm - breakStart); breakStart = null; }
  }
  if (pauseStart !== null) total += (Date.now() - pauseStart);
  if (breakStart !== null) total += (Date.now() - breakStart);
  return total;
}


// === Istirahat/Pause gabungan (break_in/break_out toggle) ===
// Jam efektif: jamKerja dikurangi 1 jam HANYA jika total Istirahat/Pause hari itu >= 60 menit.
// Kalau skip total / istirahat < 60 menit, jam efektif = jamKerja penuh. Rate gaji TIDAK diubah.
var BREAK_MIN_FOR_CREDIT_MS = 60 * 60 * 1000;
function rawJamKerja(){ return parseFloat(userProfile && userProfile.jamKerja) || 8; }
function effectiveWorkHours(){
  var jk = rawJamKerja();
  // Target NET kerja = kuota jam kerja dikurangi 1 jam hak istirahat (kontrak 10->9, 9->8).
  // Tidak lagi potong flat 1 jam bersyarat; istirahat asli dihitung di totalNonWorkMs().
  return Math.max(0, jk - 1);
}
// Toggle satu tombol: kalau lagi istirahat -> break_out, kalau tidak -> break_in. Repeatable.
function handleBreakToggle(){
  if (isCurrentlyOnBreak() || isCurrentlyPaused()) handleAction('break_out');
  else handleAction('break_in');
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

function fmtTime(d){ return d.toLocaleTimeString('id-ID',{hour12:false}); }

async function loadUserProfile(uid){
  try{
    let nama='', jamKerja=8, foto='';
    try{
      const snap = await getDoc(doc(db, 'karyawan', uid));
      if (snap.exists()){
        const u = snap.data();
        nama = u.nama || '';
        jamKerja = (u.jamKerja!=null) ? parseFloat(u.jamKerja) : 8;
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
    userProfile = { nama, jamKerja, foto };
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

$('avatarWrap').onclick = () => $('avatarInput').click();
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
    // 1) Tutup otomatis istirahat/pause yang masih kebuka biar durasi akurat
    //    (kasus karyawan lupa tap Selesai Istirahat sebelum tap Selesai Lembur).
    if (isCurrentlyOnBreak()) { await doNoSelfieAction('break_out'); }
    if (isCurrentlyPaused()) { await doNoSelfieAction('pause_out'); }
    // 2) Cek jam kerja efektif (NET) sudah mencapai target (kuota - 1 jam hak istirahat).
    //    Kalau belum, belum ada lembur -> arahkan pakai Clock Out.
    const targetH = effectiveWorkHours();
    const targetMs = targetH * 3600000;
    const workedNetMs = (Date.now() - clockIn.ts.toMillis()) - totalNonWorkMs();
    if (workedNetMs < targetMs) {
      alert('Jam kerja efektif Anda belum mencapai ' + targetH + ' jam, jadi belum ada lembur hari ini. Silakan gunakan tombol Clock Out untuk mengakhiri shift.');
      return;
    }
    // 3) Catat overtime_in otomatis (backdate ke titik kuota terpenuhi).
    if (!hasInSession('overtime_in')) {
      const otInMs = clockIn.ts.toMillis() + targetMs + totalNonWorkMs();
      await writeOvertimeInAt(otInMs);
    }
    // 4) Catat overtime_out (lewat selfie). Ini sekaligus penanda JAM KELUAR;
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
    if(typeof currentUser === 'undefined' || !currentUser){ alert('Sesi belum siap.'); return; }
    const uid = currentUser.uid;
    const namaBank = (el('pfNamaBank').value||'').trim();
    const nomorRekening = (el('pfNomorRekening').value||'').trim();
    const atasNamaRek = (el('pfAtasNamaRek').value||'').trim();
    if(!namaBank || !nomorRekening || !atasNamaRek){ alert('Lengkapi semua data rekening dulu ya.'); return; }
    if(!pfSelectedKtpFile){ alert('Upload foto KTP dulu ya.'); return; }
    const saveBtn = el('pfBtnSave');
    const oldTxt = saveBtn ? saveBtn.textContent : '';
    if(saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Menyimpan...'; }
    try{
      const path = 'profil/' + uid + '/ktp.jpg';
      const sref = ref(storage, path);
      await uploadBytes(sref, pfSelectedKtpFile);
      const ktpUrl = await getDownloadURL(sref);
      await setDoc(doc(db,'karyawan',uid), {
        namaBank, nomorRekening, atasNamaRek, ktpUrl,
        profilLocked: true,
        profilUpdatedAt: serverTimestamp()
      }, { merge: true });
      const prev = el('pfKtpPreview');
      if(prev){ prev.src = ktpUrl; prev.classList.remove('hidden'); }
      setLocked(true);
      alert('Data profil tersimpan. Terima kasih!');
    }catch(e){
      console.error('save profil', e);
      alert('Gagal menyimpan: ' + (e && e.message ? e.message : e));
    }finally{
      if(saveBtn){ saveBtn.disabled = false; saveBtn.textContent = oldTxt || 'Simpan'; }
    }
  }

  function wire(){
    const open = el('btnOpenProfil'); if(open) open.onclick = openProfil;
    const cancel = el('pfBtnCancel'); if(cancel) cancel.onclick = closeProfil;
    const pick = el('pfBtnPickKtp'); const input = el('pfKtpInput');
    if(pick && input) pick.onclick = () => input.click();
    if(input) input.onchange = (ev) => {
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
