import { auth, db, storage, OWNER_EMAILS, OFFICE_LOCATION } from './firebase-config.js';

import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, addDoc, query, where, orderBy, getDocs, getDoc, setDoc, doc, Timestamp, serverTimestamp }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const $ = id => document.getElementById(id);
const TIPE = {
  clock_in:'Clock In',
  clock_out:'Clock Out',
  break_in:'Break',
  break_out:'After Break',
  overtime_in:'Overtime In',
  overtime_out:'Overtime Out'
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
const BREAK_MAX_MS = 60 * 60 * 1000; // 1 hour cap

let currentUser=null, currentType=null, stream=null, coords=null, cameraReady=false;
let todayCache = []; // cache of today's records for the current user

// Haversine distance (meters) between two lat/lng points
function distanceMeters(lat1, lng1, lat2, lng2){
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

function greetingByHour(h){
    if (h < 11) return { msg:'Good Morning', emoji:'' };
    if (h < 15) return { msg:'Good Afternoon', emoji:'' };
    if (h < 18) return { msg:'Good Evening', emoji:'' };
    return { msg:'Good Night', emoji:'' };
}

function updateGreeting(displayName){
    const h = new Date().getHours();
    const g = greetingByHour(h);
    const nama = displayName || (currentUser && currentUser.email && currentUser.email.split('@')[0]) || '';
    $('greetMsg').textContent = g.msg + (nama ? ', ' + nama : '');
    $('greetSub').textContent = 'have a nice day';
}

function tickClock(){
    const d = new Date();
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    const ss = String(d.getSeconds()).padStart(2,'0');
    $('liveClock').textContent = hh + ':' + mm + ':' + ss;
    const opt = { weekday:'long', day:'2-digit', month:'long', year:'numeric' };
    $('liveDate').textContent = d.toLocaleDateString('en-US', opt);
}
setInterval(tickClock, 1000); tickClock();

function startOfDay(d=new Date()){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d=new Date()){ const x=new Date(d); x.setHours(23,59,59,999); return x; }
function fmtTime(d){ return d.toLocaleTimeString('en-US',{hour12:false}); }

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
            updateGreeting(u.nama || '');
        }
    }catch(e){ console.warn('profile load err', e); }
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
    Object.values(ST_ID).forEach(id => { const el=$(id); if(el) el.textContent='-'; });

    snap.forEach(docSnap=>{
        const a = docSnap.data();
        todayCache.push(a);
        const t = a.ts && a.ts.toDate ? a.ts.toDate() : new Date(a.ts);
        if (ST_ID[a.tipe]) $(ST_ID[a.tipe]).textContent = fmtTime(t);

        const row = document.createElement('div');
        row.className = 'list-item';
        const inRad = (a.inRadius === true);
        const dist = (typeof a.jarak === 'number') ? (a.jarak + ' m') : '-';
        const note = a.breakFilledAtCheckout ? ' <span class="tag warn">filled at checkout</span>' : '';
        const auto = a.autoCutByCheckout ? ' <span class="tag warn">auto-cut 1h</span>' : '';
        row.innerHTML = '<div><strong>' + (TIPE[a.tipe]||a.tipe) + '</strong>' + note + auto +
            '<div class="muted small">' + fmtTime(t) + ' &middot; ' + dist + ' &middot; ' + (inRad?'<span class="ok">In radius</span>':'<span class="warn">Out of radius</span>') + '</div></div>';
        list.appendChild(row);
    });
}

function hasToday(type){
    return todayCache.some(a => a.tipe === type);
}

function getTodayEntry(type){
    return todayCache.find(a => a.tipe === type);
}

async function getLocation(){
    return new Promise((resolve, reject)=>{
        if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
        navigator.geolocation.getCurrentPosition(
            pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }),
            err => reject(err),
            { enableHighAccuracy:true, timeout:10000, maximumAge:0 }
        );
    });
}

async function refreshLocStatus(){
    try{
        const c = await getLocation();
        coords = c;
        const d = distanceMeters(c.lat, c.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);
        const inRad = d <= OFFICE_LOCATION.radius;
        $('locStatus').innerHTML = inRad
            ? '<span class="ok">In radius</span> &middot; distance ' + d + ' m'
            : '<span class="warn">Out of radius</span> &middot; distance ' + d + ' m';
    }catch(e){
        $('locStatus').innerHTML = '<span class="warn">Location unavailable</span>';
    }
}
refreshLocStatus(); setInterval(refreshLocStatus, 15000);

// ===== Selfie flow =====
async function openSelfie(type){
    currentType = type;
    $('selfieTitle').textContent = 'Selfie - ' + TIPE[type];
    $('selfieModal').classList.remove('hidden');
    $('btnSend').classList.add('hidden');
    $('btnRetake').classList.add('hidden');
    $('btnCapture').classList.remove('hidden');
    $('selfieCanvas').hidden = true;
    $('selfieVideo').style.display = 'block';
    cameraReady = false;
    try{
        stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'user' }, audio:false });
        $('selfieVideo').srcObject = stream;
        cameraReady = true;
        $('selfieInfo').textContent = 'Camera ready';
    }catch(e){
        $('selfieInfo').textContent = 'Camera error: ' + e.message;
    }
}

function closeSelfie(){
    $('selfieModal').classList.add('hidden');
    if (stream){ stream.getTracks().forEach(t=>t.stop()); stream = null; }
}

$('btnCancelSelfie').onclick = closeSelfie;

$('btnCapture').onclick = ()=>{
    if (!cameraReady) return;
    const v = $('selfieVideo'); const c = $('selfieCanvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(v,0,0,c.width,c.height);
    c.hidden = false; v.style.display='none';
    $('btnCapture').classList.add('hidden');
    $('btnRetake').classList.remove('hidden');
    $('btnSend').classList.remove('hidden');
};

$('btnRetake').onclick = ()=>{
    $('selfieCanvas').hidden = true;
    $('selfieVideo').style.display = 'block';
    $('btnSend').classList.add('hidden');
    $('btnRetake').classList.add('hidden');
    $('btnCapture').classList.remove('hidden');
};

$('btnSend').onclick = async ()=>{
    if (!coords){ try{ await refreshLocStatus(); }catch(e){} }
    if (!coords){ alert('Location not available yet.'); return; }
    const d = distanceMeters(coords.lat, coords.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);
    const inRad = d <= OFFICE_LOCATION.radius;
    const canvas = $('selfieCanvas');
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.7));
    const sizeKB = Math.round(blob.size / 1024);
    const path = 'absensi/' + currentUser.uid + '/' + currentType + '_' + Date.now() + '.jpg';
    const r = ref(storage, path);
    await uploadBytes(r, blob);
    const url = await getDownloadURL(r);
    await saveAttendance({ tipe: currentType, lokasi:{lat:coords.lat,lng:coords.lng}, jarak:d, inRadius:inRad, foto:url, sizeKB });
    closeSelfie();
    await loadToday(currentUser.uid);
};

// ===== No-selfie flow (Break / After Break / Overtime In) =====
async function doNoSelfieAction(type, extra={}){
    if (!coords){ try{ await refreshLocStatus(); }catch(e){} }
    if (!coords){ alert('Location not available yet.'); return; }
    const d = distanceMeters(coords.lat, coords.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);
    const inRad = d <= OFFICE_LOCATION.radius;

    // Geofence rule: After Break MUST be in radius (employee back at office)
    if (type === 'break_out' && !inRad){
        alert('You must be at the office to tap After Break. Distance: ' + d + ' m');
        return;
    }

    await saveAttendance(Object.assign({ tipe:type, lokasi:{lat:coords.lat,lng:coords.lng}, jarak:d, inRadius:inRad, foto:null, sizeKB:0 }, extra));
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

// ===== Sequence validation =====
function validateSequence(type){
    // Clock In first, only once
    if (type === 'clock_in'){
        if (hasToday('clock_in')) return 'You have already Clocked In today.';
        return null;
    }
    if (!hasToday('clock_in')) return 'You must Clock In first.';

    if (type === 'break_in'){
        if (hasToday('break_in')) return 'You have already started Break.';
        if (hasToday('clock_out')) return 'You have already Clocked Out.';
        return null;
    }
    if (type === 'break_out'){
        if (!hasToday('break_in')) return 'You have not started Break yet.';
        if (hasToday('break_out')) return 'You have already tapped After Break.';
        if (hasToday('clock_out')) return 'You have already Clocked Out.';
        return null;
    }
    if (type === 'clock_out'){
        if (hasToday('clock_out')) return 'You have already Clocked Out today.';
        return null;
    }
    if (type === 'overtime_in'){
        if (!hasToday('clock_out')) return 'Overtime can only start after Clock Out.';
        if (hasToday('overtime_in')) return 'Overtime In already recorded.';
        return null;
    }
    if (type === 'overtime_out'){
        if (!hasToday('overtime_in')) return 'You have not started Overtime yet.';
        if (hasToday('overtime_out')) return 'Overtime Out already recorded.';
        return null;
    }
    return null;
}

// ===== Clock Out interceptor: enforce break, handle forgot Break Out =====
function timeToTodayDate(hhmm){
    const [h,m] = hhmm.split(':').map(Number);
    const d = new Date(); d.setHours(h, m, 0, 0);
    return d;
}

async function handleClockOutFlow(){
    // Case A: user never tapped Break -> mandatory modal to input range
    if (!hasToday('break_in')){
        await openBreakRangeModal();
        return; // The modal will resume the clock-out flow after saving
    }
    // Case B: tapped Break but not After Break -> auto-cut + warning
    if (hasToday('break_in') && !hasToday('break_out')){
        const brIn = getTodayEntry('break_in');
        const inTs = brIn.ts && brIn.ts.toDate ? brIn.ts.toDate() : new Date();
        const autoEnd = new Date(inTs.getTime() + BREAK_MAX_MS);
        $('autoBreakEndTime').textContent = fmtTime(autoEnd);
        $('forgotBreakOutModal').classList.remove('hidden');
        // Save auto-cut break_out record
        const d = coords ? distanceMeters(coords.lat, coords.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng) : 0;
        const inRad = coords ? d <= OFFICE_LOCATION.radius : false;
        await addDoc(collection(db,'absensi'), {
            uid: currentUser.uid,
            email: currentUser.email,
            nama: $('greetMsg').textContent.replace(/^[^,]*,\s*/, '') || currentUser.email,
            ts: Timestamp.fromDate(autoEnd),
            tipe: 'break_out',
            lokasi: coords ? {lat:coords.lat,lng:coords.lng} : null,
            jarak: d,
            inRadius: inRad,
            foto: null,
            sizeKB: 0,
            autoCutByCheckout: true
        });
        await loadToday(currentUser.uid);
        return; // resume after user clicks OK
    }
    // Case C: break properly recorded -> proceed straight to selfie
    proceedClockOutSelfie();
}

function proceedClockOutSelfie(){
    // Early clock out check (before scheduled end-of-shift, e.g. 17:00)
    const now = new Date();
    const endShift = new Date(); endShift.setHours(17,0,0,0);
    if (now < endShift){
        $('earlyModal').classList.remove('hidden');
        return;
    }
    openSelfie('clock_out');
}

$('btnEarlyCancel').onclick = ()=> $('earlyModal').classList.add('hidden');
$('btnEarlyOk').onclick = ()=>{
    const reason = ($('earlyReason').value||'').trim();
    if (!reason){ alert('Please provide a reason.'); return; }
    $('earlyModal').classList.add('hidden');
    window.__earlyReason = reason;
    openSelfie('clock_out');
};

$('btnForgotBreakOk').onclick = ()=>{
    $('forgotBreakOutModal').classList.add('hidden');
    proceedClockOutSelfie();
};

async function openBreakRangeModal(){
    $('breakStartInput').value = '12:00';
    $('breakEndInput').value = '13:00';
    $('breakRangeModal').classList.remove('hidden');
}

$('btnBreakRangeOk').onclick = async ()=>{
    const s = $('breakStartInput').value;
    const e = $('breakEndInput').value;
    if (!s || !e){ alert('Please fill in both times.'); return; }
    const sd = timeToTodayDate(s);
    let ed = timeToTodayDate(e);
    if (ed <= sd){ alert('Break End must be after Break Start.'); return; }
    // Cap at 1 hour
    if ((ed - sd) > BREAK_MAX_MS){
        ed = new Date(sd.getTime() + BREAK_MAX_MS);
        alert('Break duration capped to 1 hour. Adjusted end time: ' + fmtTime(ed));
    }
    const d = coords ? distanceMeters(coords.lat, coords.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng) : 0;
    const inRad = coords ? d <= OFFICE_LOCATION.radius : false;
    const base = {
        uid: currentUser.uid,
        email: currentUser.email,
        nama: $('greetMsg').textContent.replace(/^[^,]*,\s*/, '') || currentUser.email,
        lokasi: coords ? {lat:coords.lat,lng:coords.lng} : null,
        jarak: d,
        inRadius: inRad,
        foto: null,
        sizeKB: 0,
        breakFilledAtCheckout: true
    };
    await addDoc(collection(db,'absensi'), Object.assign({}, base, { tipe:'break_in', ts: Timestamp.fromDate(sd) }));
    await addDoc(collection(db,'absensi'), Object.assign({}, base, { tipe:'break_out', ts: Timestamp.fromDate(ed) }));
    $('breakRangeModal').classList.add('hidden');
    await loadToday(currentUser.uid);
    proceedClockOutSelfie();
};

// ===== Action dispatcher =====
async function handleAction(type){
    const err = validateSequence(type);
    if (err){ alert(err); return; }

    if (type === 'clock_out'){
        await handleClockOutFlow();
        return;
    }

    if (NO_SELFIE_TYPES.has(type)){
        await doNoSelfieAction(type);
        return;
    }

    // Clock In or Overtime Out -> selfie
    openSelfie(type);
}

$('btnClockIn').onclick = ()=> handleAction('clock_in');
$('btnClockOut').onclick = ()=> handleAction('clock_out');
$('btnBreakIn').onclick = ()=> handleAction('break_in');
$('btnBreakOut').onclick = ()=> handleAction('break_out');
$('btnOtIn').onclick = ()=> handleAction('overtime_in');
$('btnOtOut').onclick = ()=> handleAction('overtime_out');

// ===== Avatar upload =====
$('avatarWrap').onclick = ()=> $('avatarInput').click();
$('avatarInput').onchange = async (ev)=>{
    const f = ev.target.files[0]; if (!f) return;
    const path = 'profil/' + currentUser.uid + '/avatar.jpg';
    const r = ref(storage, path);
    await uploadBytes(r, f);
    const url = await getDownloadURL(r);
    await setDoc(doc(db,'profil', currentUser.uid), { foto:url }, { merge:true });
    $('avatarImg').src = url;
    $('avatarImg').style.display = 'block';
    $('avatarPlaceholder').style.display = 'none';
};

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
});
