// ============================================================
// PANTAU TIM (SPV) — PR-CL98
// Halaman read-only buat supervisor: siapa lagi kerja / istirahat / sudah pulang, realtime.
// SENGAJA cuma baca koleksi `absensi` (event absen) + `profil` (nama & foto). Koleksi
// `karyawan` — tempat gaji, KTP, rekening — TIDAK pernah disentuh, dan firestore.rules juga
// menolak SPV membacanya. Jadi batasan ini nyata, bukan sekadar menu yang disembunyikan.
// ============================================================
import { auth, db, OWNER_EMAILS } from './firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, doc, getDoc, getDocs, query, where, Timestamp }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const $ = id => document.getElementById(id);
const MAX_SESI_MS = 18 * 60 * 60 * 1000;        // sesi terbuka > 18 jam = lupa clock out, bukan sedang kerja
const ISTIRAHAT_WAJAR_MS = 90 * 60 * 1000;      // di atas ini kemungkinan lupa tap "Selesai Istirahat"
const BARU_PULANG_MS = 6 * 60 * 60 * 1000;      // yang pulang > 6 jam lalu ga usah ditampilkan lagi

const fotoMap = new Map();
const namaProfil = new Map();

function fmtDur(ms){
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h > 0 ? (h + ':' + String(m).padStart(2, '0')) : String(m)) + ':' + String(ss).padStart(2, '0');
}
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// Foto ditumpuk di atas inisial. Kalau gambarnya gagal dimuat (mis. Storage bermasalah),
// img-nya menghilang sendiri dan inisial di bawahnya yang kelihatan.
function avaHtml(uid, nama){
  const nm = esc(nama || '?');
  const ini = esc((nama || '?').charAt(0).toUpperCase());
  const f = fotoMap.get(uid) || '';
  if (!f) return '<span class="p-ava p-ava-ph" title="' + nm + '">' + ini + '</span>';
  return '<span class="p-ava p-ava-ph" title="' + nm + '" style="position:relative;overflow:hidden">' + ini
       + '<img src="' + esc(f) + '" alt="" onerror="this.remove()"'
       + ' style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></span>';
}

// Mulai sesi kerja yang SEDANG berjalan: clock_in/overtime_in paling awal setelah keluar terakhir.
function mulaiSesi(arr){
  let keluar = 0;
  for (const e of arr) if ((e.tipe === 'clock_out' || e.tipe === 'overtime_out') && e.ms > keluar) keluar = e.ms;
  let mulai = 0;
  for (const e of arr) if ((e.tipe === 'clock_in' || e.tipe === 'overtime_in') && e.ms >= keluar){ if (!mulai || e.ms < mulai) mulai = e.ms; }
  return mulai;
}
// Total istirahat + pause yang SUDAH ditutup dalam rentang tertentu.
function istirahatSelesai(arr, dari, sampai){
  let tot = 0, ob = 0, op = 0;
  for (const e of arr){
    if (e.ms < dari || e.ms > sampai) continue;
    if (e.tipe === 'break_in') ob = e.ms;
    else if (e.tipe === 'break_out'){ if (ob && e.ms >= ob){ tot += e.ms - ob; ob = 0; } }
    else if (e.tipe === 'pause_in') op = e.ms;
    else if (e.tipe === 'pause_out'){ if (op && e.ms >= op){ tot += e.ms - op; op = 0; } }
  }
  return tot;
}

async function muat(){
  // Ambil dari KEMARIN 00:00 supaya shift yang nembus tengah malam tetap kebaca utuh.
  const dari = new Date(); dari.setDate(dari.getDate() - 1); dari.setHours(0, 0, 0, 0);
  const snap = await getDocs(query(collection(db, 'absensi'), where('ts', '>=', Timestamp.fromDate(dari))));

  const byUid = new Map();
  snap.forEach(d => {
    const r = d.data() || {};
    const t = r.ts && r.ts.toDate ? r.ts.toDate() : null;
    const uid = r.uid;
    if (!uid || !t) return;
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push({ tipe: r.tipe, ms: t.getTime(), nama: r.nama || '' });
  });
  for (const arr of byUid.values()) arr.sort((a, b) => a.ms - b.ms);

  // Nama & foto dari koleksi profil (boleh dibaca semua yang login).
  try{
    const ps = await getDocs(collection(db, 'profil'));
    ps.forEach(d => {
      const p = d.data() || {};
      if (p.foto) fotoMap.set(d.id, p.foto);
      const n = p.ultahNama || p.nama;
      if (n) namaProfil.set(d.id, n);
    });
  }catch(e){ console.warn('profil:', e); }

  const now = Date.now();
  const kerja = [], istirahat = [], pulang = [], peringatan = [];

  for (const [uid, arr] of byUid){
    const nama = namaProfil.get(uid) || (arr.find(e => e.nama) || {}).nama || '-';
    let masukTerakhir = 0, keluarTerakhir = 0, bIn = 0, bOut = 0;
    for (const e of arr){
      if (e.tipe === 'clock_in' || e.tipe === 'overtime_in') masukTerakhir = Math.max(masukTerakhir, e.ms);
      if (e.tipe === 'clock_out' || e.tipe === 'overtime_out') keluarTerakhir = Math.max(keluarTerakhir, e.ms);
      if (e.tipe === 'break_in' || e.tipe === 'pause_in') bIn = Math.max(bIn, e.ms);
      if (e.tipe === 'break_out' || e.tipe === 'pause_out') bOut = Math.max(bOut, e.ms);
    }
    const mulai = mulaiSesi(arr);
    const sesiJalan = masukTerakhir > keluarTerakhir && mulai > 0 && (now - mulai) <= MAX_SESI_MS;

    if (keluarTerakhir > 0 && keluarTerakhir >= masukTerakhir){
      if (now - keluarTerakhir <= BARU_PULANG_MS && mulai){
        const kotor = keluarTerakhir - mulai;
        pulang.push({ uid, nama, kotor, efektif: Math.max(0, kotor - istirahatSelesai(arr, mulai, keluarTerakhir)) });
      }
    } else if (sesiJalan && bIn > bOut){
      istirahat.push({ uid, nama, mulaiBreak: bIn, sudah: istirahatSelesai(arr, mulai, now) });
      if ((now - bIn) > ISTIRAHAT_WAJAR_MS) peringatan.push({ nama, jalan: now - bIn });
    } else if (sesiJalan){
      kerja.push({ uid, nama, mulai, rest: istirahatSelesai(arr, mulai, now) });
    }
  }

  kerja.sort((a, b) => a.mulai - b.mulai);
  istirahat.sort((a, b) => a.mulaiBreak - b.mulaiBreak);

  $('cWork').textContent = kerja.length;
  $('cBreak').textContent = istirahat.length;
  $('cDone').textContent = pulang.length;

  $('listWork').innerHTML = kerja.length ? kerja.map(x =>
    '<div class="p-row">' + avaHtml(x.uid, x.nama) + '<span class="p-name">' + esc(x.nama) + '</span>'
    + '<span class="p-time"><span class="spv-t p-main" data-start="' + x.mulai + '">--:--</span>'
    + '<small class="p-sep">efektif</small>'
    + '<span class="spv-net p-dim" data-start="' + x.mulai + '" data-base="' + x.rest + '">--:--</span></span></div>'
  ).join('') : '<div class="p-empty">Belum ada yang kerja</div>';

  $('listBreak').innerHTML = istirahat.length ? istirahat.map(x =>
    '<div class="p-row">' + avaHtml(x.uid, x.nama) + '<span class="p-name">' + esc(x.nama) + '</span>'
    + '<span class="p-time"><span class="spv-t p-main" data-start="' + x.mulaiBreak + '">--:--</span>'
    + '<small class="p-sep">total</small>'
    + '<span class="spv-tot p-dim" data-start="' + x.mulaiBreak + '" data-base="' + x.sudah + '">--:--</span></span></div>'
  ).join('') : '<div class="p-empty">Tidak ada yang istirahat</div>';

  $('listDone').innerHTML = pulang.length ? pulang.map(x =>
    '<div class="p-row">' + avaHtml(x.uid, x.nama) + '<span class="p-name">' + esc(x.nama) + '</span>'
    + '<span class="p-time"><span class="p-main">' + fmtDur(x.kotor) + '</span>'
    + '<small class="p-sep">efektif</small><span class="p-dim">' + fmtDur(x.efektif) + '</span></span></div>'
  ).join('') : '<div class="p-empty">Belum ada yang pulang</div>';

  // Peringatan istirahat kepanjangan — ini inti gunanya SPV: negur sebelum jadi koreksi payroll.
  const al = $('spvAlert');
  if (peringatan.length){
    al.innerHTML = '<div class="ultah-today"><span class="ultah-cake">⚠️</span><span>Istirahat kelamaan &mdash; kemungkinan lupa tap "Selesai Istirahat":</span></div>'
      + '<div class="ultah-next">' + peringatan.map(p => '<span><b>' + esc(p.nama) + '</b> sudah ' + fmtDur(p.jalan) + '</span>').join('') + '</div>';
    al.classList.remove('hidden');
  } else {
    al.classList.add('hidden');
    al.innerHTML = '';
  }
}

// Timer jalan tiap detik (murni tampilan, ga nulis apa pun ke database).
setInterval(() => {
  const now = Date.now();
  document.querySelectorAll('.spv-t').forEach(el => {
    const s = parseInt(el.dataset.start, 10) || 0;
    if (s) el.textContent = fmtDur(now - s);
  });
  document.querySelectorAll('.spv-net').forEach(el => {
    const s = parseInt(el.dataset.start, 10) || 0, b = parseInt(el.dataset.base, 10) || 0;
    if (s) el.textContent = fmtDur((now - s) - b);
  });
  document.querySelectorAll('.spv-tot').forEach(el => {
    const s = parseInt(el.dataset.start, 10) || 0, b = parseInt(el.dataset.base, 10) || 0;
    if (s) el.textContent = fmtDur(b + (now - s));
  });
}, 1000);

onAuthStateChanged(auth, async u => {
  if (!u){ location.replace('index.html'); return; }
  const owner = OWNER_EMAILS.includes((u.email || '').toLowerCase());
  let boleh = owner;
  if (!owner){
    try{
      const s = await getDoc(doc(db, 'karyawan', u.uid));
      boleh = s.exists() && s.data().spvAkses === true;
    }catch(e){ boleh = false; }
  }
  if (!boleh){ alert('Halaman ini khusus supervisor.'); location.replace('karyawan.html'); return; }
  $('spvNama').textContent = u.email || '';
  $('spvDate').textContent = new Date().toLocaleDateString('id-ID', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
  try{ await muat(); }catch(e){ console.error(e); alert('Gagal memuat data: ' + (e.message || e)); }
  setInterval(() => { muat().catch(e => console.warn('refresh:', e)); }, 60000);
});

$('btnLogout').onclick = () => signOut(auth).then(() => location.replace('index.html')).catch(() => location.replace('index.html'));
$('spvTitle').onclick = () => location.reload();
