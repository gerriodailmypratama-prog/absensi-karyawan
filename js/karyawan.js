import { auth, db, storage, OWNER_EMAILS } from './firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, addDoc, query, where, orderBy, getDocs, Timestamp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { ref, uploadString, getDownloadURL }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const $ = id => document.getElementById(id);
const TIPE = { clock_in:'Clock In', clock_out:'Clock Out', overtime_in:'Overtime In', overtime_out:'Overtime Out' };
let currentUser=null, currentType=null, stream=null, coords=null;

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
  currentType=type;
  $('modalTitle').textContent='Selfie - '+TIPE[type];
  $('selfieModal').classList.remove('hidden');
  $('uploadMsg').textContent='';
  $('locInfo').textContent='Mendapatkan lokasi...';
  navigator.geolocation.getCurrentPosition(
    p=>{coords={lat:p.coords.latitude,lng:p.coords.longitude,acc:p.coords.accuracy};
        $('locInfo').textContent='Lokasi: '+coords.lat.toFixed(5)+', '+coords.lng.toFixed(5)+' (akurasi '+Math.round(coords.acc)+'m)';},
    e=>{$('locInfo').textContent='Lokasi tidak tersedia: '+e.message;coords=null;},
    {enableHighAccuracy:true,timeout:10000}
  );
  try{
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'}});
    $('video').srcObject=stream;
  }catch(e){ $('uploadMsg').textContent='Kamera tidak bisa diakses: '+e.message; }
}

$('btnCancel').onclick=closeModal;
function closeModal(){
  $('selfieModal').classList.add('hidden');
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
}

$('btnCapture').onclick=async()=>{
  const v=$('video'),cv=$('canvas');
  cv.width=v.videoWidth;cv.height=v.videoHeight;
  cv.getContext('2d').drawImage(v,0,0);
  const dataUrl=cv.toDataURL('image/jpeg',0.7);
  $('btnCapture').disabled=true;
  $('uploadMsg').textContent='Mengupload...';
  try{
    const filename='absensi/'+currentUser.uid+'/'+Date.now()+'.jpg';
    const sref=ref(storage,filename);
    await uploadString(sref,dataUrl,'data_url');
    const photoUrl=await getDownloadURL(sref);
    await addDoc(collection(db,'absensi'),{
      uid:currentUser.uid,
      email:currentUser.email,
      name:currentUser.displayName||currentUser.email.split('@')[0],
      type:currentType,
      timestamp:Timestamp.now(),
      photoUrl,
      location:coords||null
    });
    $('uploadMsg').textContent='Berhasil!';
    $('uploadMsg').className='msg ok';
    setTimeout(()=>{closeModal();loadTodayStatus();loadHistory();},800);
  }catch(e){
    $('uploadMsg').textContent='Gagal: '+e.message;
  }finally{ $('btnCapture').disabled=false; }
};

async function loadTodayStatus(){
  const start=new Date();start.setHours(0,0,0,0);
  const q=query(collection(db,'absensi'),
    where('uid','==',currentUser.uid),
    where('timestamp','>=',Timestamp.fromDate(start)),
    orderBy('timestamp','asc'));
  const snap=await getDocs(q);
  const map={};snap.forEach(d=>{const x=d.data();if(!map[x.type])map[x.type]=x.timestamp.toDate();});
  const fmt=d=>d?d.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'}):'-';
  $('sClockIn').textContent=fmt(map.clock_in);
  $('sClockOut').textContent=fmt(map.clock_out);
  $('sOtIn').textContent=fmt(map.overtime_in);
  $('sOtOut').textContent=fmt(map.overtime_out);
}

async function loadHistory(){
  const start=new Date();start.setDate(start.getDate()-7);start.setHours(0,0,0,0);
  const q=query(collection(db,'absensi'),
    where('uid','==',currentUser.uid),
    where('timestamp','>=',Timestamp.fromDate(start)),
    orderBy('timestamp','desc'));
  const snap=await getDocs(q);
  const list=$('historyList');list.innerHTML='';
  if(snap.empty){list.innerHTML='<p class="muted center">Belum ada riwayat</p>';return;}
  snap.forEach(d=>{
    const x=d.data();const t=x.timestamp.toDate();
    const div=document.createElement('div');
    div.className='history-item '+x.type;
    div.innerHTML='<b>'+TIPE[x.type]+'</b><br><small class="muted">'+t.toLocaleString('id-ID')+'</small>';
    list.appendChild(div);
  });
}
