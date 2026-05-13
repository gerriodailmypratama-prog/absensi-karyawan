import { auth, db, storage, OWNER_EMAILS, OFFICE_LOCATION } from './firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, addDoc, query, where, orderBy, getDocs, getDoc, setDoc, doc, Timestamp, serverTimestamp }
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
const BREAK_MAX_MS = 60 * 60 * 1000; // 1 jam

let currentUser=null, currentType=null, stream=null, coords=null, cameraReady=false;
let todayCache = [];
let workEndTime = '17:00'; // default jam pulang

function distanceMeters(lat1, lng1, lat2, lng2){
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

function greetingByHour(h){
  if (h < 11) return { msg:'Selamat Pagi', emoji:'' };
  if (h < 15) return { msg:'Selamat Siang', emoji:'' };
  if (h < 18) return { msg:'Selamat Sore', emoji:'' };
  return { msg:'Selamat Malam', emoji:'' };
}

function updateGreeting(displayName){
  const h = new Date().getHours();
  const g = greetingByHour(h);
  const nama = displayName || (currentUser && currentUser.email && currentUser.email.split('@')[0]) || '';
  $('greetMsg').textContent = g.msg + (nama ? ', ' + nama : '');
  $('greetSub').textContent = 'selamat beraktivitas';
}

function tickClock(){
  const d = new Date();
  $('liveClock').textContent = d.toLocaleTimeString('id-ID',{hour12:false});
  $('liveDate').textContent = d.toLocaleDateString('id-ID',{weekday:'long', day:'2-digit', month:'long', year:'numeric'});
}
setInterval(tickClock, 1000); tickClock();

// ===== Countdown jam kerja =====
function parseHM(s){
  const m = /^(\d{1,2}):(\d{2})$/.exec((s||'').trim());
  if(!m) return null;
  return { h: parseInt(m[1],10), m: parseInt(m[2],10) };
}

function updateWorkCountdown(){
  const wc = $('workCountdown');
  if(!wc) return;
  // Hanya tampilkan jika sudah Clock In dan belum Clock Out
  if (!hasToday('clock_in') || hasToday('clock_out')) {
    wc.classList.add('hidden');
    return;
  }
  const hm = parseHM(workEndTime) || {h:17, m:0};
  const now = new Date();
  const end = new Date(); end.setHours(hm.h, hm.m, 0, 0);
  const diff = end - now;
  wc.classList.remove('hidden');
  $('wcSub').textContent = 'Jam pulang: ' + String(hm.h).padStart(2,'0') + ':' + String(hm.m).padStart(2,'0');
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

function fmtTime(d){ return d.toLocaleTimeString('id-ID',{hour12:false}); }

async function loadProfileAvatar(uid){
  try{
    const snap = await getDoc(doc(db, 'profil', uid));
    if (snap.exists()){
      const u = snap.data();
      if (u.foto){
        $('avatarImg').src = u.foto;
        $('avatarImg').style.display = 'block';
        $('avatarPlaceholder').style.display = 'none';
      }
      if (u.jamPulang) workEndTime = u.jamPulang;
      updateGreeting(u.nama || '');
    }
  }catch(e){ console.warn('profile load err', e); }
}

function startOfDay(){ const d=new Date(); d.setHours(0,0,0,0); return d; }
function endOfDay(){ const d=new Date(); d.setHours(23,59,59,999); return d; }
function timeToTodayDate(hhmm){
  const [h,m] = hhmm.split(':').map(Number);
  const d = new Date(); d.setHours(h, m||0, 0, 0); return d;
}

async function loadToday(uid){
  todayCache = [];
  const q = query(collection(db,'absensi'),
    where('uid','==', uid),
    where('ts','>=', Timestamp.fromDate(startOfDay())),
    where('ts','<=', Timestamp.fromDate(endOfDay())),
    orderBy('ts','asc'));
  const snap = await getDocs(q);
  const list = $('todayList'); list.innerHTML = '';
  // Reset status indicators
  Object.values(ST_ID).forEach(id => { const el=$(id); if(el) el.textContent='-'; });
  snap.forEach(s=>{
    const a = s.data(); todayCache.push(a);
    const t = a.ts && a.ts.toDate ? a.ts.toDate() : new Date();
    const dist = (a.jarak!=null)? a.jarak + ' m' : '-';
    const inRad = !!a.inRadius;
    const label = TIPE[a.tipe] || a.tipe;
    // Update status
    const sid = ST_ID[a.tipe];
    if (sid) $(sid).textContent = fmtTime(t);
    // Riwayat row
    const row = document.createElement('div');
    row.className = 'list-row';
    const note = a.flag === 'breakFilledAtCheckout' ? ' <span class="muted small">(diisi saat Clock Out)</span>' : '';
    const auto = a.autoCap ? ' <span class="muted small">(auto 1 jam)</span>' : '';
    row.innerHTML = '<div><strong>' + label + '</strong>' + note + auto +
      '<div class="muted small">' + fmtTime(t) + ' &middot; ' + dist + ' &middot; ' + (inRad?'<span class="ok">dalam radius</span>':'<span class="warn">luar radius</span>') + '</div></div>';
    list.appendChild(row);
  });
  updateWorkCountdown();
}

function hasToday(type){ return todayCache.some(a => a.tipe === type); }
function getTodayEntry(type){ return todayCache.find(a => a.tipe === type); }

async function getLocation(){
  return new Promise((resolve, reject)=>{
    if (!navigator.geolocation) return reject(new Error('Geolocation tidak didukung'));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }),
      err => reject(err),
      { enableHighAccuracy:true, timeout:15000, maximumAge:30000 }
    );
  });
}

let __lastLocKey = '';
async function refreshLocStatus(){
  try{
    const c = await getLocation();
    coords = c;
    const d = distanceMeters(c.lat, c.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);
    const inRad = d <= OFFICE_LOCATION.radius;
    const key = (inRad?'in':'out') + ':' + d;
    if (key === __lastLocKey) return;
    __lastLocKey = key;
    $('locStatus').innerHTML = inRad
      ? '<span class="ok">Dalam radius kantor</span> &middot; jarak ' + d + ' m'
      : '<span class="warn">Di luar radius kantor</span> &middot; jarak ' + d + ' m';
  }catch(e){
    if (__lastLocKey === 'err') return;
    __lastLocKey = 'err';
    $('locStatus').innerHTML = '<span class="warn">Lokasi belum tersedia</span>';
  }
}
setInterval(refreshLocStatus, 30000);

// ===== Selfie flow =====
async function openSelfie(type){
  currentType = type;
  $('selfieTitle').textContent = 'Ambil Selfie - ' + (TIPE[type]||type);
  $('selfieModal').classList.remove('hidden');
  try{
    stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'user' }, audio:false });
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
  // Upload selfie
  const path = 'selfie/' + currentUser.uid + '/' + Date.now() + '.jpg';
  const r = ref(storage, path);
  await uploadBytes(r, blob);
  const url = await getDownloadURL(r);
  const extra = {};
  if (currentType === 'clock_out' && window.__earlyReason){
    extra.earlyReason = window.__earlyReason;
    window.__earlyReason = null;
  }
  await saveAttendance(Object.assign({ tipe: currentType, lokasi:{lat:coords.lat,lng:coords.lng}, jarak:d, inRadius:inRad, fotoSelfie:url }, extra));
  await loadToday(currentUser.uid);
};

// ===== No-selfie flow (Istirahat / Selesai Istirahat / Mulai Lembur) =====
async function doNoSelfieAction(type, extra={}){
  if (!coords) try{ await refreshLocStatus(); }catch(e){}
  if (!coords){ alert('Lokasi belum tersedia.'); return; }
  const d = distanceMeters(coords.lat, coords.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);
  const inRad = d <= OFFICE_LOCATION.radius;

  // Geofence: Selesai Istirahat WAJIB di radius (karyawan kembali ke kantor)
  if (type === 'break_out' && !inRad){
    alert('Anda harus di kantor untuk tap Selesai Istirahat. Jarak: ' + d + ' m');
    return;
  }

  await saveAttendance(Object.assign({ tipe:type, lokasi:{lat:coords.lat,lng:coords.lng}, jarak:d, inRadius:inRad }, extra));
  await loadToday(currentUser.uid);
}

async function saveAttendance(payload){
  const data = Object.assign({
    uid: currentUser.uid,
    email: currentUser.email,
    nama: $('greetMsg').textContent.replace(/^[^,]*,\s*/, '') || currentUser.email,
    ts: serverTimestamp()
  }, payload);
  await addDoc(collection(db,'absensi'), data);
}

// ===== Validasi urutan =====
function validateSequence(type){
  if (type === 'clock_in'){
    if (hasToday('clock_in')) return 'Anda sudah Clock In hari ini.';
    return null;
  }
  if (!hasToday('clock_in')) return 'Anda harus Clock In dulu.';

  if (type === 'break_in'){
    if (hasToday('break_in')) return 'Anda sudah mulai Istirahat.';
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

// ===== Handlers =====
async function handleAction(type){
  const err = validateSequence(type);
  if (err){ alert(err); return; }
  if (!coords) try{ await refreshLocStatus(); }catch(e){}

  if (NO_SELFIE_TYPES.has(type)){
    return doNoSelfieAction(type);
  }
  // Clock In / Clock Out / Selesai Lembur -> pakai selfie
  if (type === 'clock_out'){
    return handleClockOut();
  }
  openSelfie(type);
}

$('btnClockIn').onclick = ()=> handleAction('clock_in');
$('btnClockOut').onclick = ()=> handleAction('clock_out');
$('btnBreakIn').onclick = ()=> handleAction('break_in');
$('btnBreakOut').onclick = ()=> handleAction('break_out');
$('btnOtIn').onclick = ()=> handleAction('overtime_in');
$('btnOtOut').onclick = ()=> handleAction('overtime_out');

// ===== Clock Out flow dengan auto-handle istirahat =====
async function handleClockOut(){
  // Case A: sudah ada break_in tapi belum break_out -> auto-cap 1 jam
  if (hasToday('break_in') && !hasToday('break_out')){
    const bi = getTodayEntry('break_in');
    const biTime = bi.ts && bi.ts.toDate ? bi.ts.toDate() : new Date();
    const autoEnd = new Date(biTime.getTime() + BREAK_MAX_MS);
    // Simpan auto break_out
    await saveAttendance({
      tipe:'break_out',
      lokasi: bi.lokasi || null,
      jarak: bi.jarak || 0,
      inRadius: bi.inRadius || false,
      autoCap: true
    });
    await loadToday(currentUser.uid);
    $('forgotBreakOutModal').classList.remove('hidden');
    return; // user click OK -> proceed
  }
  // Case B: belum break_in sama sekali -> WAJIB isi range
  if (!hasToday('break_in')){
    openBreakRangeModal();
    return; // user fill -> save -> proceed
  }
  // Case C: break sudah selesai -> langsung selfie
  proceedClockOut();
}

function proceedClockOut(){
  // Cek apakah sudah waktunya pulang
  const hm = parseHM(workEndTime) || {h:17, m:0};
  const now = new Date();
  const endShift = new Date(); endShift.setHours(hm.h, hm.m, 0, 0);
  if (now < endShift){
    $('earlyModal').classList.remove('hidden');
    return;
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
  $('breakEndInput').value = '13:00';
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
  const base = {
    uid: currentUser.uid,
    email: currentUser.email,
    nama: $('greetMsg').textContent.replace(/^[^,]*,\s*/, '') || currentUser.email,
    lokasi: coords ? {lat:coords.lat, lng:coords.lng} : null,
    jarak: d,
    inRadius: inRad,
    flag: 'breakFilledAtCheckout'
  };
  // Simpan break_in dengan ts custom
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

// ===== Avatar upload (dengan fallback base64) =====
$('avatarWrap').onclick = ()=> $('avatarInput').click();
$('avatarInput').onchange = async (ev)=>{
  const f = ev.target.files[0]; if (!f) return;
  try{
    // Resize ke max 400px untuk hemat storage
    const dataUrl = await resizeImage(f, 400);
    // Coba upload ke Firebase Storage
    let url = dataUrl; // fallback default ke base64
    try{
      const path = 'profil/' + currentUser.uid + '/avatar.jpg';
      const r = ref(storage, path);
      // uploadString dengan data_url base64
      await uploadString(r, dataUrl, 'data_url');
      url = await getDownloadURL(r);
      console.log('Avatar uploaded to Storage:', url);
    }catch(storageErr){
      console.warn('Storage upload gagal, pakai base64 inline:', storageErr.message);
      // url tetap dataUrl (base64)
    }
    await setDoc(doc(db, 'profil', currentUser.uid), { foto: url }, { merge:true });
    $('avatarImg').src = url;
    $('avatarImg').style.display = 'block';
    $('avatarPlaceholder').style.display = 'none';
    alert('Foto profil berhasil disimpan.');
  }catch(e){
    console.error('Avatar save error:', e);
    alert('Gagal simpan foto: ' + e.message);
  }
};

function resizeImage(file, maxSize){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ev =>{
      const img = new Image();
      img.onload = ()=>{
        let w = img.width, h = img.height;
        if (w > h && w > maxSize){ h = h * (maxSize/w); w = maxSize; }
        else if (h > maxSize){ w = w * (maxSize/h); h = maxSize; }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject;
      img.src = ev.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ===== Logout =====
$('btnLogout').onclick = ()=> signOut(auth).then(()=> location.href='index.html');

// ===== Auth gate =====
onAuthStateChanged(auth, async (user)=>{
  if (!user){ location.href='index.html'; return; }
  if (OWNER_EMAILS.includes((user.email||'').toLowerCase())){
    location.href='owner.html'; return;
  }
  currentUser = user;
  await loadProfileAvatar(user.uid);
  await loadToday(user.uid);
  refreshLocStatus();
});
