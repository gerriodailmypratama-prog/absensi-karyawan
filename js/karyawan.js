import { auth, db, storage, OWNER_EMAILS, OFFICE_LOCATION } from './firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, addDoc, query, where, orderBy, getDocs, getDoc, setDoc, doc, Timestamp }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const $ = id => document.getElementById(id);
const TIPE = { clock_in:'Clock In', clock_out:'Clock Out', overtime_in:'Overtime In', overtime_out:'Overtime Out' };
const ST_ID = { clock_in:'sClockIn', clock_out:'sClockOut', overtime_in:'sOtIn', overtime_out:'sOtOut' };
let currentUser=null, currentType=null, stream=null, coords=null, cameraReady=false;

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
    if (h < 11) return { msg:'Selamat Pagi', emoji:'☀️' };
    if (h < 15) return { msg:'Selamat Siang', emoji:'🌞' };
    if (h < 18) return { msg:'Selamat Sore', emoji:'🌤️' };
    return { msg:'Selamat Malam', emoji:'🌙' };
}

function updateGreeting(displayName){
    const h = new Date().getHours();
    const g = greetingByHour(h);
    const nama = displayName || (currentUser && currentUser.email ? currentUser.email.split('@')[0] : '');
    $('greetMsg').textContent = g.msg + ', ' + nama;
    $('greetSub').textContent = 'have a nice day ' + g.emoji;
}

setInterval(()=>{
    const d=new Date();
    $('liveClock').textContent=d.toLocaleTimeString('id-ID');
    $('liveDate').textContent=d.toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
},1000);

onAuthStateChanged(auth, async user=>{
    if (!user) return location.href='index.html';
    if (OWNER_EMAILS.includes(user.email)) return location.href='owner.html';
    currentUser=user;

    // Load karyawan profile doc (photoURL, nama)
    let displayName = user.displayName || user.email.split('@')[0];
    try {
        const snap = await getDoc(doc(db,'karyawan',user.uid));
        if (snap.exists()){
            const d = snap.data();
            if (d.nama) displayName = d.nama;
            if (d.photoURL) {
                $('avatarImg').src = d.photoURL;
                $('avatarImg').style.display = 'block';
                $('avatarPlaceholder').style.display = 'none';
            }
        }
    } catch(e){ console.warn('load profile:', e.message); }

    updateGreeting(displayName);
    setInterval(()=>updateGreeting(displayName), 60000);

    await loadTodayStatus();
    await loadHistory();
});

$('btnLogout').onclick=()=>signOut(auth).then(()=>location.href='index.html');

// Avatar click -> trigger file input
$('avatarWrap').onclick = (ev) => {
    if (ev.target.id === 'avatarInput') return;
    $('avatarInput').click();
};
$('avatarInput').onchange = async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file || !currentUser) return;
    try {
        // Resize to max 256x256, JPEG q0.85
        const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = reject;
            i.src = URL.createObjectURL(file);
        });
        const MAX = 256;
        let w = img.naturalWidth, h = img.naturalHeight;
        const r = Math.min(MAX/w, MAX/h, 1);
        const cw = Math.round(w*r), ch = Math.round(h*r);
        const cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        cv.getContext('2d').drawImage(img, 0, 0, cw, ch);
        const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.85));
        if (!blob) throw new Error('Gagal konversi gambar.');
        const sref = ref(storage, 'profiles/' + currentUser.uid + '.jpg');
        await uploadBytes(sref, blob, { contentType:'image/jpeg' });
        const url = await getDownloadURL(sref);
        // Save to karyawan doc (merge)
        await setDoc(doc(db,'karyawan',currentUser.uid), {
            uid: currentUser.uid,
            email: currentUser.email,
            nama: currentUser.displayName || currentUser.email.split('@')[0],
            photoURL: url,
            updatedAt: Timestamp.now()
        }, { merge: true });
        $('avatarImg').src = url;
        $('avatarImg').style.display = 'block';
        $('avatarPlaceholder').style.display = 'none';
    } catch (e){
        console.error('avatar upload error:', e);
        alert('Gagal upload foto: ' + (e.message || e));
    } finally {
        ev.target.value = '';
    }
};

document.querySelectorAll('button[data-type]').forEach(b=>{
    b.onclick=()=>openSelfie(b.dataset.type);
});

async function openSelfie(type){
    if (!currentUser) { alert('Silakan login dulu.'); return; }
    try {
        const today = new Date(); today.setHours(0,0,0,0);
        const q = query(collection(db,'absensi'),
                        where('uid','==',currentUser.uid),
                        where('tipe','==',type),
                        where('ts','>=', Timestamp.fromDate(today)));
        const snap = await getDocs(q);
        if (!snap.empty) {
            alert('Kamu sudah '+TIPE[type]+' hari ini. Tidak bisa absen ganda.');
            return;
        }
    } catch(e){ console.warn('Validasi skip:', e.message); }

    currentType=type;
    cameraReady=false;
    coords=null;
    $('modalTitle').textContent='Selfie - '+TIPE[type];
    $('selfieModal').classList.remove('hidden');
    $('uploadMsg').textContent='';
    $('uploadMsg').style.color='';
    $('locInfo').textContent='📍 Mendapatkan lokasi...';
    $('locInfo').style.color='';
    $('btnCapture').disabled=true;
    $('btnCapture').textContent='Menyiapkan kamera...';

    navigator.geolocation.getCurrentPosition(p=>{
        const jarak = distanceMeters(p.coords.latitude, p.coords.longitude, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);
        const inRadius = jarak <= OFFICE_LOCATION.radiusMeters;
        coords={ lat:p.coords.latitude, lng:p.coords.longitude, acc:Math.round(p.coords.accuracy), jarak, inRadius };
        if (inRadius) {
            $('locInfo').textContent='🟢 Di area ruko ('+jarak+'m dari titik kantor, akurasi ±'+coords.acc+'m)';
            $('locInfo').style.color='#16a34a';
        } else {
            $('locInfo').textContent='🔴 Di LUAR area ruko ('+jarak+'m dari titik kantor, akurasi ±'+coords.acc+'m). Absen tetap tercatat dengan flag.';
            $('locInfo').style.color='#dc2626';
        }
        checkReady();
    }, err=>{
        $('locInfo').textContent='❌ Gagal mendapatkan lokasi: '+err.message;
        $('locInfo').style.color='#e53935';
    }, { enableHighAccuracy:true, timeout:15000, maximumAge:0 });

    try {
        stream=await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'user' } });
        $('video').srcObject=stream;
        $('video').onloadedmetadata=()=>{
            cameraReady=true;
            $('btnCapture').textContent='Ambil Foto';
            checkReady();
        };
    } catch(e){
        let msg='Kamera tidak bisa diakses: ';
        if (e.name==='NotAllowedError') msg+='Izin kamera ditolak. Klik ikon 📷/kamera di address bar → Allow → reload.';
        else if (e.name==='NotFoundError') msg+='Kamera tidak ditemukan di perangkat ini.';
        else if (e.name==='NotReadableError') msg+='Kamera sedang dipakai aplikasi lain. Tutup app lain dulu.';
        else msg+=e.message;
        $('uploadMsg').textContent=msg;
        $('uploadMsg').style.color='#e53935';
        $('btnCapture').textContent='Kamera bermasalah';
    }
}

function checkReady(){
    if (cameraReady && coords) $('btnCapture').disabled=false;
}

function closeModal(){
    $('selfieModal').classList.add('hidden');
    if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
    cameraReady=false; coords=null; currentType=null;
}
$('btnCancel').onclick=closeModal;

$('btnCapture').onclick=async()=>{
    if (!cameraReady || !coords) { alert('Tunggu kamera & lokasi siap dulu.'); return; }
    const v=$('video'), cv=document.createElement('canvas');
    const MAX_W=640, MAX_H=480;
    let w=v.videoWidth, h=v.videoHeight;
    if (!w || !h) { alert('Kamera belum siap, coba lagi sebentar.'); return; }
    const ratio=Math.min(MAX_W/w, MAX_H/h, 1);
    cv.width=Math.round(w*ratio);
    cv.height=Math.round(h*ratio);
    cv.getContext('2d').drawImage(v,0,0,cv.width,cv.height);

    $('btnCapture').disabled=true;
    $('btnCapture').textContent='⏳ Mengupload...';
    $('uploadMsg').textContent='Menyimpan absensi...';
    $('uploadMsg').style.color='#1976d2';

    try {
        const blob=await new Promise(res=>cv.toBlob(res,'image/jpeg',0.6));
        if (!blob) throw new Error('Gagal konversi foto.');
        const fname='absensi/'+currentUser.uid+'/'+Date.now()+'_'+currentType+'.jpg';
        const sref=ref(storage,fname);
        await uploadBytes(sref,blob,{contentType:'image/jpeg'});
        const url=await getDownloadURL(sref);

        await addDoc(collection(db,'absensi'),{
            uid: currentUser.uid,
            email: currentUser.email,
            nama: currentUser.displayName||currentUser.email.split('@')[0],
            tipe: currentType,
            ts: Timestamp.now(),
            lokasi: { lat:coords.lat, lng:coords.lng, acc:coords.acc },
            jarak: coords.jarak,
            inRadius: coords.inRadius,
            foto: url,
            sizeKB: Math.round(blob.size/1024)
        });

        $('uploadMsg').textContent='✅ Absen tercatat!';
        $('uploadMsg').style.color='#16a34a';
        setTimeout(async()=>{
            closeModal();
            await loadTodayStatus();
            await loadHistory();
        }, 1200);
    } catch(e){
        console.error('upload error:', e);
        $('uploadMsg').textContent='Gagal: '+(e.message||e);
        $('uploadMsg').style.color='#e53935';
        $('btnCapture').disabled=false;
        $('btnCapture').textContent='Ambil Foto';
    }
};

async function loadTodayStatus(){
    const today=new Date(); today.setHours(0,0,0,0);
    const q=query(collection(db,'absensi'),
                    where('uid','==',currentUser.uid),
                    where('ts','>=',Timestamp.fromDate(today)),
                    orderBy('ts','asc')
                    );
    try {
        const snap=await getDocs(q);
        Object.values(ST_ID).forEach(id=>{ const el=$(id); if(el) el.textContent='-'; });
        snap.forEach(d=>{
            const x=d.data();
            const el=$(ST_ID[x.tipe]);
            if (el) el.textContent=fmt(x.ts.toDate());
        });
    } catch(e){ console.error('loadTodayStatus:', e); }
}
function fmt(d){return d.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'});}

async function loadHistory(){
    const since=new Date(); since.setDate(since.getDate()-7); since.setHours(0,0,0,0);
    const q=query(collection(db,'absensi'),
                    where('uid','==',currentUser.uid),
                    where('ts','>=',Timestamp.fromDate(since)),
                    orderBy('ts','desc')
                    );
    try {
        const snap=await getDocs(q);
        const list=$('historyList');
        if (!list) return;
        list.innerHTML='';
        if (snap.empty){ list.innerHTML='<div class="muted center" style="padding:12px">Belum ada riwayat</div>'; return; }
        snap.forEach(d=>{
            const x=d.data();
            const t=x.ts.toDate();
            const tgl=t.toLocaleDateString('id-ID',{day:'2-digit',month:'2-digit'});
            const jam=t.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'});
            const flag = x.inRadius === false ? ' 🔴' : (x.inRadius === true ? ' 🟢' : '');
            const jarakStr = x.jarak != null ? ' · '+x.jarak+'m' : '';
            const div=document.createElement('div');
            div.className='history-item '+x.tipe;
            div.innerHTML='<b>'+(TIPE[x.tipe]||x.tipe)+flag+'</b> · '+tgl+' '+jam+jarakStr;
            list.appendChild(div);
        });
    } catch(e){ console.error('loadHistory:', e); }
}
