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

// Helper aman untuk ambil radius office (kompat 'radius' & 'radiusMeters').
const OFFICE_RADIUS = (OFFICE_LOCATION && (OFFICE_LOCATION.radius || OFFICE_LOCATION.radiusMeters)) || 150;

let currentUser=null, currentType=null, stream=null, coords=null;
let cameraReady=false;
let sessionCache = []; // semua event sesi shift aktif, ASC by ts
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
  $('liveClock').textContent = d.toLocaleTimeString('id-ID',{hour12:false});
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

function updateWorkCountdown(){
  const wc = $('workCountdown');
  if(!wc) return;
  const clockInEntry = getFirstInSession('clock_in');
  if (!clockInEntry || hasInSession('clock_out')) {
    wc.classList.add('hidden'); return;
  }
  const clockInTime = clockInEntry.ts.toDate();
  const jamKerja = parseFloat(userProfile.jamKerja) || 8;
  const paused = totalPausedMs();
  const endTime = new Date(clockInTime.getTime() + jamKerja * 3600 * 1000 + paused);
  const now = new Date();
  const diff = endTime - now;
  const paused_now = isCurrentlyPaused();
  wc.classList.remove('hidden');
  if (paused_now) wc.classList.add('paused'); else wc.classList.remove('paused');
  const labelEl = wc.querySelector('.wc-label');
  if (labelEl) labelEl.textContent = paused_now ? 'Sisa jam kerja (DIJEDA)' : 'Sisa jam kerja';
  $('wcSub').textContent = 'Jam pulang (estimasi): ' + endTime.toLocaleTimeString('id-ID',{hour:'2-digit', minute:'2-digit', hour12:false});
  if (diff <= 0) {
    $('wcTime').textContent = 'Waktunya pulang!';
    wc.classList.add('done');
    return;
  }
  wc.classList.remove('done');
  const totalSec = Math.floor(diff/1000);
  const h = Math.floor(totalSec/3600);
  const m = Math.floor((totalSec%3600)/60);
  const s = totalSec%60;
  $('wcTime').textContent =
    String(h).padStart(2,'0') + ':' +
    String(m).padStart(2,'0') + ':' +
    String(s).padStart(2,'0');
}
setInterval(updateWorkCountdown, 1000);

// ===== Countdown Istirahat (60 menit dari tap Istirahat) =====
function updateBreakCountdown(){
    let wc = document.getElementById('breakCountdown');
    const bi = getLastInSession('break_in');
    const bo = getLastInSession('break_out');
    const onBreak = bi && (!bo || (bi.ts && bo.ts && bi.ts.toDate().getTime() > bo.ts.toDate().getTime()));
    if (!onBreak){ if (wc) wc.classList.add('hidden'); return; }
    if (!wc){
        const c = document.createElement('div');
        c.id = 'breakCountdown';
        c.className = 'work-countdown break-countdown';
        c.innerHTML = '<div class="wc-label">Sisa waktu Istirahat</div><div class="wc-time" id="bcTime">--:--</div><div class="wc-sub" id="bcSub">Maksimal 1 jam</div>';
        const parent = document.getElementById('workCountdown')?.parentNode;
        if (parent) parent.appendChild(c); else document.querySelector('main')?.appendChild(c);
        wc = c;
    }
    wc.classList.remove('hidden');
    const startTime = bi.ts.toDate();
    const endTime = new Date(startTime.getTime() + 60*60*1000);
    const now = new Date();
    const diff = endTime - now;
    const bcTime = document.getElementById('bcTime');
    const bcSub = document.getElementById('bcSub');
    if (diff <= 0){
        if (bcTime) bcTime.textContent = 'Waktu habis!';
        if (bcSub) bcSub.textContent = 'Silakan tap Selesai Istirahat';
        wc.classList.add('done');
        if (!window.__breakOverPrompted){
            window.__breakOverPrompted = true;
            try{ if (navigator.vibrate) navigator.vibrate([200,100,200]); }catch(e){}
            alert('Waktu istirahat 1 jam sudah habis. Silakan tap "Selesai Istirahat".');
        }
        return;
    }
    wc.classList.remove('done');
    const totalSec = Math.floor(diff/1000);
    const m = Math.floor(totalSec/60);
    const s = totalSec%60;
    if (bcTime) bcTime.textContent = String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    if (bcSub) bcSub.textContent = 'Maksimal 1 jam dari mulai Istirahat';
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
    if (!foto){ showMandatoryAvatarModal(); }
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
        if (all[j].tipe === 'clock_out'){ hasCo = true; break; }
      }
      if (!hasCo){ openCiIdx = i; break; }
    }
  }
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
  const btnPauseIn = $('btnPauseIn');
  const btnPauseOut = $('btnPauseOut');
  if (!btnPauseIn || !btnPauseOut) return;
  const paused = isCurrentlyPaused();
  btnPauseIn.disabled = paused || !hasInSession('clock_in') || hasInSession('clock_out') || isCurrentlyOnBreak();
  btnPauseOut.disabled = !paused;
  btnPauseIn.style.opacity = btnPauseIn.disabled ? '0.45' : '1';
  btnPauseOut.style.opacity = btnPauseOut.disabled ? '0.45' : '1';
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
  return new Promise(resolve => {
    if (!navigator.geolocation){ coords=null; resolve(); return; }
    navigator.geolocation.getCurrentPosition(p => {
      coords = { lat:p.coords.latitude, lng:p.coords.longitude, acc:p.coords.accuracy };
      resolve();
    }, err => { coords=null; resolve(); }, { enableHighAccuracy:true, timeout:8000, maximumAge:0 });
  });
}

async function openSelfie(type){
  currentType = type;
  $('selfieTitle').textContent = 'Ambil Selfie - ' + (TIPE[type]||type);
  $('selfieModal').classList.remove('hidden');
  $('selfieCanvas').classList.add('hidden');
  try{
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode:'user' }, audio:false });
    const v = $('selfieVideo'); v.srcObject = stream; cameraReady = true;
  }catch(e){
    alert('Tidak bisa akses kamera: ' + e.message);
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
  if (!cameraReady) return;
  const v = $('selfieVideo');
  const c = $('selfieCanvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
  closeSelfie();
  if (!coords) try{ await refreshLocStatus(); }catch(e){}
  if (!coords){ alert('Lokasi belum tersedia.'); return; }
  const d = distanceMeters(coords.lat, coords.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);
  const inRad = d <= OFFICE_RADIUS;
  let selfieUrl = '';
  try{
    const path = 'selfie/' + currentUser.uid + '/' + Date.now() + '.jpg';
    const r = ref(storage, path);
    await uploadBytes(r, blob);
    selfieUrl = await getDownloadURL(r);
  }catch(e){
    console.warn('Selfie upload gagal:', e.message);
  }
  const extra = {};
  if (currentType === 'clock_out' && window.__earlyReason){
    extra.earlyReason = window.__earlyReason;
    window.__earlyReason = null;
  }
  await saveAttendance(Object.assign({ tipe: currentType, lokasi:{lat:coords.lat,lng:coords.lng}, jarak:d, inRadius:inRad, fotoSelfie:selfieUrl }, extra));
  await loadActiveSession(currentUser.uid);
};

async function doNoSelfieAction(type, extra={}){
  if (!coords) try{ await refreshLocStatus(); }catch(e){}
  if (!coords){ alert('Lokasi belum tersedia.'); return; }
  const d = distanceMeters(coords.lat, coords.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);
  const inRad = d <= OFFICE_RADIUS;
  await saveAttendance(Object.assign({ tipe:type, lokasi:{lat:coords.lat,lng:coords.lng}, jarak:d, inRadius:inRad }, extra));
  await loadActiveSession(currentUser.uid);
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
  const hasCo = hasInSession('clock_out');
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
  if (!userProfile || !userProfile.foto){
    showMandatoryAvatarModal();
    return;
  }
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
$('btnBreakIn').onclick   = () => handleAction('break_in');
$('btnBreakOut').onclick  = () => handleAction('break_out');
$('btnPauseIn').onclick   = () => handleAction('pause_in');
$('btnPauseOut').onclick  = () => handleAction('pause_out');
$('btnOtIn').onclick      = () => handleAction('overtime_in');
$('btnOtOut').onclick     = () => handleAction('overtime_out');

async function handleClockOut(){
  if (isCurrentlyOnBreak()){
    const bi = getLastInSession('break_in');
    await saveAttendance({
      tipe:'break_out',
      lokasi: (bi && bi.lokasi) || null,
      jarak: (bi && bi.jarak) || 0,
      inRadius: (bi && bi.inRadius) || false,
      autoCap: true
    });
    await loadActiveSession(currentUser.uid);
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
  const clockInEntry = getFirstInSession('clock_in');
  if (clockInEntry && clockInEntry.ts && clockInEntry.ts.toDate){
    const clockInTime = clockInEntry.ts.toDate();
    const jamKerja = parseFloat(userProfile.jamKerja) || 8;
    const paused = totalPausedMs();
    const endTime = new Date(clockInTime.getTime() + jamKerja * 3600 * 1000 + paused);
    const now = new Date();
    if (now < endTime){
      $('earlyModal').classList.remove('hidden');
      return;
    }
  }
  openSelfie('clock_out');
}

$('btnEarlyCancel').onclick = ()=> $('earlyModal').classList.add('hidden');
$('btnEarlyOk').onclick = ()=>{
  const reason = ($('earlyReason').value||'').trim();
  if (!reason){ alert('Mohon isi alasan.'); return; }
  $('earlyModal').classList.add('hidden');
  window.__earlyReason = reason;
  openSelfie('clock_out');
};

$('btnForgotBreakOk').onclick = ()=>{
  $('forgotBreakOutModal').classList.add('hidden');
  proceedClockOut();
};

async function openBreakRangeModal(){
  $('breakStartInput').value = '12:00';
  $('breakEndInput').value   = '13:00';
  $('breakRangeModal').classList.remove('hidden');
}

$('btnBreakRangeOk').onclick = async ()=>{
  const s = $('breakStartInput').value;
  const e = $('breakEndInput').value;
  if (!s || !e){ alert('Mohon isi kedua waktu.'); return; }
  const sd = timeToTodayDate(s);
  let ed = timeToTodayDate(e);
  if (ed <= sd){ alert('Selesai Istirahat harus setelah Mulai Istirahat.'); return; }
  if ((ed - sd) > BREAK_MAX_MS){
    ed = new Date(sd.getTime() + BREAK_MAX_MS);
    alert('Durasi istirahat dipotong maksimal 1 jam. Selesai jadi: ' + fmtTime(ed));
  }
  const d = coords ? distanceMeters(coords.lat, coords.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng) : 0;
  const inRad = coords ? d <= OFFICE_RADIUS : false;
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
