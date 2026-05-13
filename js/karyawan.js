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
  overtime_in:'Mulai Lembur',
  overtime_out:'Selesai Lembur'
};
const ST_ID = {
  clock_in:'sClockIn',
  clock_out:'sClockOut',
  break_in:'sBreakIn',
  break_out:'sBreakOut',
  overtime_in:'sOtIn',
  overtime_out:'sOtOut'
};
const NO_SELFIE_TYPES = new Set(['break_in','break_out','overtime_in']);
const BREAK_MAX_MS = 60 * 60 * 1000;

let currentUser=null, currentType=null, stream=null, coords=null;
let cameraReady=false;
let todayCache = [];
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

function updateWorkCountdown(){
  const wc = $('workCountdown');
  if(!wc) return;
  const clockInEntry = getTodayEntry('clock_in');
  if (!clockInEntry || hasToday('clock_out')) {
    wc.classList.add('hidden'); return;
  }
  const clockInTime = clockInEntry.ts.toDate();
  const jamKerja = parseFloat(userProfile.jamKerja) || 8;
  const endTime = new Date(clockInTime.getTime() + jamKerja * 3600 * 1000);
  const now = new Date();
  const diff = endTime - now;
  wc.classList.remove('hidden');
  $('wcSub').textContent = 'Jam pulang: ' + endTime.toLocaleTimeString('id-ID',{hour:'2-digit', minute:'2-digit', hour12:false}) + ' (' + jamKerja + ' jam dari Clock In)';
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
    const bi = getTodayEntry('break_in');
    const bo = getTodayEntry('break_out');
    if (!bi || bo){ if (wc) wc.classList.add('hidden'); return; }
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
    if (foto){
      $('avatarImg').src = foto;
      $('avatarImg').style.display = 'block';
      $('avatarPlaceholder').style.display = 'none';
    }
    updateGreeting();
  }catch(e){ console.warn('profile load err:', e); }
}

function startOfDay(d0){ const d=new Date(d0||Date.now()); d.setHours(0,0,0,0); return d; }
function endOfDay(d0){ const d=new Date(d0||Date.now()); d.setHours(23,59,59,999); return d; }
function timeToTodayDate(hhmm){
  const [h,m] = hhmm.split(':').map(Number);
  const d = new Date(); d.setHours(h, m||0, 0, 0);
  return d;
}

async function loadToday(uid){
  todayCache = [];
  const q = query(collection(db,'absensi'),
    where('uid','==', uid),
    where('ts','>=', Timestamp.fromDate(startOfDay())),
    where('ts','<=', Timestamp.fromDate(endOfDay())),
    orderBy('ts','asc'));
  const snap = await getDocs(q);
  const _pad = n => String(n).padStart(2,'0');
  const _today = new Date();
  const todayStr = _today.getFullYear() + '-' + _pad(_today.getMonth()+1) + '-' + _pad(_today.getDate());
  snap.forEach(d => {
    const r = d.data();
    if (r.tanggal && r.tanggal !== todayStr) return;
    todayCache.push(r);
  });
  renderStatuses();
  updateWorkCountdown();
  if (hasToday('break_out')) window.__breakOverPrompted = false;
  updateBreakCountdown();
}

function hasToday(type){ return todayCache.some(r => r.tipe === type); }
function getTodayEntry(type){ return todayCache.find(r => r.tipe === type) || null; }

function renderStatuses(){
  Object.keys(ST_ID).forEach(k => {
    const el = $(ST_ID[k]); if (!el) return;
    const e = getTodayEntry(k);
    if (e && e.ts) el.textContent = fmtTime(e.ts.toDate());
    else el.textContent = '-';
  });
}

onAuthStateChanged(auth, async u => {
  if (!u){ location.replace('index.html'); return; }
  if (OWNER_EMAILS.includes((u.email||'').toLowerCase())) {
    location.replace('owner.html'); return;
  }
  currentUser = u;
  await loadUserProfile(u.uid);
  await loadToday(u.uid);
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
  const inRad = d <= OFFICE_LOCATION.radius;
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
  await loadToday(currentUser.uid);
};

async function doNoSelfieAction(type, extra={}){
  if (!coords) try{ await refreshLocStatus(); }catch(e){}
  if (!coords){ alert('Lokasi belum tersedia.'); return; }
  const d = distanceMeters(coords.lat, coords.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);
  const inRad = d <= OFFICE_LOCATION.radius;
  await saveAttendance(Object.assign({ tipe:type, lokasi:{lat:coords.lat,lng:coords.lng}, jarak:d, inRadius:inRad }, extra));
  await loadToday(currentUser.uid);
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
  if (type === 'clock_in'){
    if (hasToday('clock_in')) return 'Anda sudah Clock In hari ini.';
    return null;
  }
  if (type === 'break_in'){
    if (!hasToday('clock_in')) return 'Anda harus Clock In dulu.';
    if (hasToday('break_in')) return 'Anda sudah tap Istirahat.';
    if (hasToday('clock_out')) return 'Anda sudah Clock Out.';
    return null;
  }
  if (type === 'break_out'){
    if (!hasToday('break_in')) return 'Anda belum tap Istirahat.';
    if (hasToday('break_out')) return 'Anda sudah tap Selesai Istirahat.';
    if (hasToday('clock_out')) return 'Anda sudah Clock Out.';
    return null;
  }
  if (type === 'clock_out'){
    if (hasToday('clock_out')) return 'Anda sudah Clock Out hari ini.';
    return null;
  }
  if (type === 'overtime_in'){
    if (!hasToday('clock_out')) return 'Lembur hanya setelah Clock Out.';
    if (hasToday('overtime_in')) return 'Anda sudah Mulai Lembur.';
    return null;
  }
  if (type === 'overtime_out'){
    if (!hasToday('overtime_in')) return 'Anda belum Mulai Lembur.';
    if (hasToday('overtime_out')) return 'Anda sudah Selesai Lembur.';
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
  if (type === 'clock_out'){
    const ok = await askConfirm('Clock Out Sekarang?', 'Apakah Anda yakin ingin Clock Out? Aksi ini menandakan Anda selesai bekerja hari ini.', 'Ya, Clock Out');
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

$('btnClockIn').onclick  = () => handleAction('clock_in');
$('btnClockOut').onclick = () => handleAction('clock_out');
$('btnBreakIn').onclick  = () => handleAction('break_in');
$('btnBreakOut').onclick = () => handleAction('break_out');
$('btnOtIn').onclick     = () => handleAction('overtime_in');
$('btnOtOut').onclick    = () => handleAction('overtime_out');

async function handleClockOut(){
  if (hasToday('break_in') && !hasToday('break_out')){
    const bi = getTodayEntry('break_in');
    await saveAttendance({
      tipe:'break_out',
      lokasi: bi.lokasi || null,
      jarak: bi.jarak || 0,
      inRadius: bi.inRadius || false,
      autoCap: true
    });
    await loadToday(currentUser.uid);
    $('forgotBreakOutModal').classList.remove('hidden');
    return;
  }
  if (!hasToday('break_in')){
    openBreakRangeModal();
    return;
  }
  proceedClockOut();
}

function proceedClockOut(){
  const clockInEntry = getTodayEntry('clock_in');
  if (clockInEntry && clockInEntry.ts && clockInEntry.ts.toDate){
    const clockInTime = clockInEntry.ts.toDate();
    const jamKerja = parseFloat(userProfile.jamKerja) || 8;
    const endTime = new Date(clockInTime.getTime() + jamKerja * 3600 * 1000);
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
  const inRad = coords ? d <= OFFICE_LOCATION.radius : false;
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
  await loadToday(currentUser.uid);
  proceedClockOut();
};

async function checkForgottenClockOut(uid){
  try{
    const since = new Date(); since.setDate(since.getDate()-7); since.setHours(0,0,0,0);
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const yesterdayEnd = new Date(todayStart.getTime() - 1);

    const q = query(collection(db,'absensi'),
      where('uid','==', uid),
      where('ts','>=', Timestamp.fromDate(since)),
      where('ts','<=', Timestamp.fromDate(yesterdayEnd)),
      orderBy('ts','asc'));
    const snap = await getDocs(q);
    const byDay = new Map();
    snap.forEach(d=>{
      const r = d.data();
      if (!r.ts || !r.ts.toDate) return;
      const tgl = r.tanggal || (function(){
        const dd = r.ts.toDate();
        const _pad = n => String(n).padStart(2,'0');
        return dd.getFullYear()+'-'+_pad(dd.getMonth()+1)+'-'+_pad(dd.getDate());
      })();
      if (!byDay.has(tgl)) byDay.set(tgl, []);
      byDay.get(tgl).push(r);
    });

    let target = null;
    for (const [day, rows] of byDay){
      const ci = rows.find(r=>r.tipe==='clock_in');
      const co = rows.find(r=>r.tipe==='clock_out');
      if (!ci) continue;
      if (!co){
        target = { day, ci, co: null, mode: 'CREATE' };
        break;
      }
      if (co && co.autoClockOut === true){
        target = { day, ci, co, mode: 'INFO' };
        break;
      }
    }
    if (!target) return;

    const clockInTime = target.ci.ts.toDate();
    const jamKerja = parseFloat(userProfile && userProfile.jamKerja) || 8;
    const autoCutTime = target.co ? target.co.ts.toDate() : new Date(clockInTime.getTime() + jamKerja * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2,'0');
    const tanggalKemarin = target.day || (autoCutTime.getFullYear()+'-'+pad(autoCutTime.getMonth()+1)+'-'+pad(autoCutTime.getDate()));

    const sessionKey = 'lupaShown_'+uid+'_'+tanggalKemarin;
    if (sessionStorage.getItem(sessionKey) === '1') return;

    if (target.mode === 'CREATE'){
      $('forgotTitle').textContent = 'Lupa Clock Out';
      $('forgotMsg').textContent =
        'Anda lupa Clock Out pada ' + clockInTime.toLocaleDateString('id-ID',{weekday:'long',day:'2-digit',month:'long',year:'numeric'}) +
        '. Sistem otomatis mencatat Clock Out pada ' + autoCutTime.toLocaleDateString('id-ID',{day:'2-digit',month:'long'}) +
        ' jam ' + autoCutTime.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',hour12:false}) +
        ' (sesuai jam kerja ' + jamKerja + ' jam). Hubungi atasan jika perlu koreksi.';
    } else {
      $('forgotTitle').textContent = 'Pemberitahuan: Lupa Clock Out';
      $('forgotMsg').textContent =
        'Anda lupa Clock Out pada ' + clockInTime.toLocaleDateString('id-ID',{weekday:'long',day:'2-digit',month:'long',year:'numeric'}) +
        '. Sistem sudah otomatis mencatat Clock Out pada jam ' + autoCutTime.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',hour12:false}) +
        ' (sesuai jam kerja ' + jamKerja + ' jam). Hubungi atasan jika perlu koreksi.';
    }
    $('forgotClockOutModal').classList.remove('hidden');

    $('btnForgotClockOutOk').onclick = async () => {
      if ($('btnForgotClockOutOk').dataset.processing === '1') return;
      $('btnForgotClockOutOk').dataset.processing = '1';
      try{ sessionStorage.setItem(sessionKey, '1'); }catch(e){}
      try{
        if (target.mode === 'CREATE'){
          const namaForSave = userProfile.nama || (currentUser.email||'').split('@')[0];
          await addDoc(collection(db,'absensi'), {
            uid: currentUser.uid,
            email: currentUser.email,
            nama: namaForSave,
            tipe: 'clock_out',
            lokasi: target.ci.lokasi || null,
            jarak: target.ci.jarak || 0,
            inRadius: target.ci.inRadius || false,
            autoCutByForgot: true,
            lupaClockOut: true,
            autoClockOut: true,
            editNote: 'Auto Clock Out (lupa) dihitung ' + jamKerja + ' jam setelah Clock In ' + clockInTime.toLocaleString('id-ID'),
            tanggal: tanggalKemarin,
            ts: Timestamp.fromDate(autoCutTime)
          });
        }
      }catch(err){
        console.warn('addDoc auto-clockOut error', err);
        try{ sessionStorage.removeItem(sessionKey); }catch(e){}
        alert('Gagal mencatat auto Clock Out: ' + (err && err.message ? err.message : err));
      }
      $('btnForgotClockOutOk').dataset.processing = '';
      $('forgotClockOutModal').classList.add('hidden');
    };
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
    await loadToday(currentUser.uid);
    renderStatuses();
    updateWorkCountdown();
    if(typeof updateBreakCountdown==='function') updateBreakCountdown();
  }catch(err){ console.warn('refreshAbsenState error', err); }
}
setInterval(refreshAbsenState, 30000);
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) refreshAbsenState(); });
window.addEventListener('focus', refreshAbsenState);
