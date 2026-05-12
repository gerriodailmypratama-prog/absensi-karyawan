import { auth, db, storage, OWNER_EMAILS } from './firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, addDoc, query, where, orderBy, getDocs, Timestamp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const $ = id => document.getElementById(id);
const TIPE = { clock_in:'Clock In', clock_out:'Clock Out', overtime_in:'Overtime In', overtime_out:'Overtime Out' };
let currentUser=null, currentType=null, stream=null, coords=null, cameraReady=false;

setInterval(()=>{
  const d=new Date();
  $('liveClock').textContent=d.toLocaleTimeString('id-ID');
  $('liveDate').textContent=d.toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
},1000);

onAuthStateChanged(auth, async user=>{
  if (!user) return location.href='index.html';
  if (OWNER_EMAILS.includes(user.email)) return location.href='owner.html';
  currentUser=user;
  $('userName').textContent=user.displayName||user.email.split('@')[0];
  $('userEmail').textContent=user.email;
  await loadTodayStatus();
  await loadHistory();
});

$('btnLogout').onclick=()=>signOut(auth).then(()=>location.href='index.html');

document.querySelectorAll('button[data-type]').forEach(b=>{
  b.onclick=()=>openSelfie(b.dataset.type);
});

async function openSelfie(type){
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const q = query(collection(db,'absensi'),
      where('uid','==',currentUser.uid),
      where('tipe','==',type),
      where('ts','>=', Timestamp.fromDate(today))
    );
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
  $('locStatus').textContent='📍 Mendapatkan lokasi...';
  $('locStatus').style.color='';
  $('btnCapture').disabled=true;
  $('btnCapture').textContent='Menyiapkan kamera...';

  navigator.geolocation.getCurrentPosition(
    p=>{ coords={lat:p.coords.latitude,lng:p.coords.longitude,acc:Math.round(p.coords.accuracy)};
      $('locStatus').textContent='📍 Lokasi OK (akurasi ±'+coords.acc+'m)';
      $('locStatus').style.color='#43a047';
      checkReady(); },
    e=>{ let msg='📍 GPS gagal: ';
      if (e.code===1) msg+='Izin lokasi ditolak. Aktifkan di pengaturan browser.';
      else if (e.code===2) msg+='Lokasi tidak tersedia. Cek GPS HP.';
      else if (e.code===3) msg+='Timeout. Coba lagi di area sinyal kuat.';
      else msg+=e.message;
      $('locStatus').textContent=msg;
      $('locStatus').style.color='#e53935'; },
    {enableHighAccuracy:true,timeout:15000,maximumAge:60000}
  );

  try {
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:640},height:{ideal:480}}});
    $('video').srcObject=stream;
    $('video').onloadedmetadata=()=>{
      cameraReady=true;
      $('btnCapture').textContent='Ambil Foto';
      checkReady();
    };
  } catch(e){
    let msg='Kamera tidak bisa diakses: ';
    if (e.name==='NotAllowedError') msg+='Izin kamera ditolak. Klik ikon 🔒/kamera di address bar → Allow → reload halaman.';
    else if (e.name==='NotFoundError') msg+='Kamera tidak ditemukan di perangkat ini.';
    else if (e.name==='NotReadableError') msg+='Kamera sedang dipakai aplikasi lain. Tutup app lain dulu.';
    else msg+=e.message;
    $('uploadMsg').textContent=msg;
    $('uploadMsg').style.color='#e53935';
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
    const fname='absensi/'+currentUser.uid+'/'+Date.now()+'_'+currentType+'.jpg';
    const sref=ref(storage,fname);
    await uploadBytes(sref,blob,{contentType:'image/jpeg'});
    const url=await getDownloadURL(sref);

    await addDoc(collection(db,'absensi'),{
      uid:currentUser.uid,
      email:currentUser.email,
      nama:currentUser.displayName||currentUser.email.split('@')[0],
      tipe:currentType,
      ts:Timestamp.now(),
      lokasi:coords,
      foto:url,
      sizeKB:Math.round(blob.size/1024)
    });

    $('uploadMsg').textContent='✅ '+TIPE[currentType]+' berhasil!';
    $('uploadMsg').style.color='#43a047';
    setTimeout(()=>{ closeModal(); loadTodayStatus(); loadHistory(); },1200);
  } catch(e){
    $('uploadMsg').textContent='❌ Gagal: '+e.message;
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
  const snap=await getDocs(q);
  ['clock_in','clock_out','overtime_in','overtime_out'].forEach(t=>$('st_'+t).textContent='-');
  snap.forEach(d=>{
    const x=d.data();
    $('st_'+x.tipe).textContent=fmt(x.ts.toDate());
  });
}
function fmt(d){return d.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'});}

async function loadHistory(){
  const since=new Date(); since.setDate(since.getDate()-7); since.setHours(0,0,0,0);
  const q=query(collection(db,'absensi'),
    where('uid','==',currentUser.uid),
    where('ts','>=',Timestamp.fromDate(since)),
    orderBy('ts','desc')
  );
  const snap=await getDocs(q);
  const tbody=$('historyBody'); tbody.innerHTML='';
  if(snap.empty){tbody.innerHTML='<tr><td colspan="3" style="text-align:center;padding:12px;color:#888">Belum ada riwayat</td></tr>';return;}
  snap.forEach(d=>{
    const x=d.data(), dt=x.ts.toDate();
    const tr=document.createElement('tr');
    tr.innerHTML='<td>'+dt.toLocaleDateString('id-ID')+'</td><td>'+TIPE[x.tipe]+'</td><td>'+fmt(dt)+'</td>';
    tbody.appendChild(tr);
  });
}
