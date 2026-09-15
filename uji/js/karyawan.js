// ============================================================================
// Halaman karyawan — versi Supabase.
//
// Ini PINDAHAN, bukan perancangan ulang. Alur, urutan konfirmasi, bunyi tombol,
// dan semua kasus aneh yang sudah ketemu di lapangan (sesi nyangkut, lupa clock
// out, anti double clock-in, istirahat diisi belakangan pas mau pulang, lembur
// backdate, GPS ngaco) sengaja dipertahankan apa adanya. Yang diganti cuma
// mesin di belakangnya: Firestore -> Postgres, Firebase Storage -> Supabase
// Storage, Firebase Auth -> Supabase Auth.
//
// Tiga hal yang WAJIB diingat kalau nanti mengubah file ini:
//   1. absensi.karyawan_id menunjuk ke karyawan.id, BUKAN ke id akun login.
//      Ini sumber bug paling gampang. `saya.id` yang betul, bukan user.id.
//   2. Kolom `ts` sengaja TIDAK pernah dikirim dari HP — biar pakai now() dari
//      database. Jam HP bisa diubah orang. Dua tempat yang memang harus
//      backdate (istirahat diisi saat checkout & overtime_in otomatis) diberi
//      catatan tersendiri di bawah.
//   3. Kalau query balik kosong padahal datanya ada, curigai RLS dulu sebelum
//      curiga querynya salah.
// ============================================================================

import {
  sb, karyawanSaya, keluar, jarakMeter, dalamRadius,
  kodeClockout, KODE_SLOT_MS, LIBUR_HARI, LIBUR_MAX,
  periodeBerjalan, KASBON_PLAFON_DEFAULT, pesanRamah, MODE_UJI,
  EMBER_SELFIE, EMBER_PROFIL, EMBER_KTP
} from './supabase-config.js';

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
// Shift lebih pendek dari ini dianggap ga wajib istirahat (PR-CL105).
const SHIFT_WAJIB_ISTIRAHAT_MS = 5 * 60 * 60 * 1000;
const MAX_SHIFT_MS = 18 * 60 * 60 * 1000;
// Selfie dikompres dulu sebelum naik. ~150KB itu titik tengah: mukanya masih
// jelas kelihatan buat dicek owner, tapi ga bikin staf yang sinyalnya tipis
// gagal absen gara-gara upload kelamaan.
const SELFIE_MAX_BYTES = 150 * 1024;

// Jembatan kecil: kode di bawah ini aslinya bicara dengan Timestamp Firestore
// (punya .toDate() & .toMillis()). Daripada mengubah puluhan tempat perhitungan
// yang sudah teruji, waktu dari Postgres (teks ISO) dibungkus ulang biar
// bentuknya sama. Logika jam kerja/istirahat/lembur jadi TIDAK tersentuh.
function stempel(iso){
  const ms = iso ? new Date(iso).getTime() : NaN;
  if (!isFinite(ms)) return null;
  return { toDate(){ return new Date(ms); }, toMillis(){ return ms; } };
}
function bungkusEvent(r){
  return Object.assign({}, r, { ts: stempel(r.ts) });
}

// Kolom event absen yang dipakai halaman ini. Ditulis eksplisit biar ga
// kebawa kolom baru yang belum tentu perlu.
const KOLOM_ABSEN = 'id, tipe, ts, lat, lng, akurasi_m, jarak_m, in_radius, gps_exempt, foto_selfie, kode_verif, no_break, auto_cap, otomatis, flag';

let currentUser=null;          // akun login (auth) — dipakai buat email & token
let saya=null;                 // BARIS TABEL KARYAWAN — ini yang punya .id
let currentType=null, stream=null, coords=null;
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
let userProfile = { nama:'', namaPanggilan:'', jamKerja:9, foto:'', wajibKode:false, kodeAdmin:false, noShiftBarrier:false, liburHari:null, liburRequest:null };
// Daftar yang belum diisi (rekening/KTP). Default dianggap kurang semua sampai baris kebaca,
// biar akun baru yang datanya belum lengkap juga tetap dapat notif lengkapi profil.
let profilKurang = ['Rekening bank &mdash; tujuan transfer gaji', 'Foto KTP'];
// Umur akun (ms sejak join/dibuat) — dipakai buat eskalasi pengingat foto profil:
// >= 2 hari belum upload -> warning "foto absen bakal dipakai"; >= 3 hari -> beneran dipakai.
let sayaJoinMs = 0;
// ===== PR-CL95: ucapan ulang tahun =====
// Karyawan cuma boleh baca baris karyawan MILIKNYA SENDIRI (biar data gaji orang
// lain aman), jadi tanggal lahir teman ga bisa dibaca dari sana. Penggantinya
// view `karyawan_publik`: isinya cuma nama, foto, dan TANGGAL-BULAN lahir tanpa
// tahun. Jadi teman tau siapa yang ultah, tapi umurnya tetap ga kelihatan.
// (Di versi Firebase ini dikerjakan dengan menyalin sendiri ke koleksi `profil`;
// sekarang penyalinan itu ga perlu lagi — view-nya yang mengurus.)
let tanggalLahirSaya = '';
let sayaNonaktif = false;
let sayaSpv = false; // PR-CL98: akses halaman Pantau Tim
function __mmdd(d){ return String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }

async function cekUltah(){
  const hari = __mmdd(new Date());
  // 1) Ulang tahun SAYA -> popup ucapan (sekali sehari, biar ga muncul tiap refresh).
  if (String(tanggalLahirSaya || '').slice(5) === hari){
    const key = 'ggUltah_' + new Date().getFullYear() + '-' + hari;
    let sudah = false;
    try{ sudah = localStorage.getItem(key) === '1'; }catch(e){}
    if (!sudah){
      const el = $('ultahPopNama');
      if (el) el.textContent = userProfile.namaPanggilan || userProfile.nama || '';
      const pop = $('ultahPopup');
      if (pop){
        pop.classList.remove('hidden');
        try{ localStorage.setItem(key, '1'); }catch(e){}
      }
    }
  }
  // 2) Ulang tahun TEMAN -> kartu pengingat di beranda (tampil sepanjang hari itu).
  try{
    const { data, error } = await sb.from('karyawan_publik').select('id, nama, ultah_mmdd');
    if (error) throw error;
    const teman = [];
    (data || []).forEach(p => {
      if (saya && p.id === saya.id) return;
      if (p.ultah_mmdd === hari && p.nama) teman.push(p.nama);
    });
    if (teman.length){
      const t = $('ultahTemanTxt');
      if (t) t.innerHTML = 'Hari ini <span style="color:#fb923c">' + teman.join(', ') + '</span> ulang tahun!';
      const c = $('ultahTemanCard'); if (c) c.classList.remove('hidden');
    }
  }catch(e){ console.warn('cek ultah teman:', e); }
}

// ===== PR-CL93: KASBON — pengajuan pinjaman gaji dari sisi karyawan =====
// Tombolnya cuma kebuka kalau owner ngasih akses (kasbonAktif), plafonnya persen dari
// gaji yang SUDAH terkumpul di periode berjalan. Kalau disetujui owner, jumlahnya masuk
// kolom Potongan bulan itu -> kepotong otomatis pas gajian.
//
// Semua penjaganya (akses dibuka owner, status wajib 'menunggu', jatah 1x per
// periode, plafon) sekarang ada DI DATABASE lewat fungsi ajukan_kasbon().
// Dulu penjaga itu setengah di JavaScript, setengah di firestore.rules — yang
// di JavaScript gampang dilewati orang yang paham teknis.
let kasbonAktif = false, kasbonPlafon = KASBON_PLAFON_DEFAULT, kasbonRequest = null, baseHarian = 0;
function __kbRp(n){ return 'Rp ' + Math.round(n || 0).toLocaleString('id-ID'); }

// Perkiraan gaji terkumpul periode ini: jumlah hari yang ada Clock In x base harian.
// Sengaja KONSERVATIF (lembur/tunjangan ga dihitung) supaya plafon yang ditawarkan
// ga pernah lebih besar dari hak mereka. Angka final tetap dihitung owner saat approve.
async function hitungGajiBerjalan(periode){
  // Periodenya dihitung database sendiri (absensi.periode_berjalan), sama aturan
  // dengan periodeBerjalan() di browser.
  const { data, error } = await sb.rpc('gaji_berjalan_saya');
  if (error) throw error;
  const b = Array.isArray(data) ? data[0] : data;
  return { hari: (b && b.hari) || 0, gaji: Number((b && b.gaji) || 0) };
}

// Jatah kasbon: 1x per periode gaji. Yang ngunci cuma pengajuan yang masih MENUNGGU
// atau yang SUDAH DISETUJUI di periode berjalan — kalau ditolak, masih boleh coba lagi.
function kasbonTerpakaiBulanIni(yyyymm){
  const r = kasbonRequest;
  if (!r || r.periode !== yyyymm) return false;
  return r.status === 'menunggu' || r.status === 'disetujui';
}
function tampilStatusKasbon(yyyymm){
  const box = $('kbStatusBox'), form = $('kbFormBox'), btn = $('btnKasbonSubmit');
  const r = kasbonRequest;
  if (!box) return;
  const terkunci = kasbonTerpakaiBulanIni(yyyymm);
  if (!r){ box.classList.add('hidden'); if (form) form.classList.remove('hidden'); if (btn) btn.classList.remove('hidden'); return; }
  const txt = $('kbStatusTxt'), sub = $('kbStatusSub');
  if (r.status === 'menunggu'){
    if (txt){ txt.textContent = '⏳ Menunggu persetujuan'; txt.style.color = '#fcd34d'; }
    if (sub) sub.textContent = 'Kamu mengajukan ' + __kbRp(r.jumlah) + '. Tunggu dikonfirmasi ya.';
  } else if (r.status === 'disetujui'){
    if (txt){ txt.textContent = '✅ Disetujui ' + __kbRp(r.disetujui_jumlah != null ? r.disetujui_jumlah : r.jumlah); txt.style.color = '#86efac'; }
    if (sub) sub.textContent = 'Otomatis dipotong dari gaji periode ' + (r.periode_label || r.periode || '') + '.'
      + (terkunci ? ' Jatah kasbon periode ini sudah terpakai — bisa ajukan lagi periode berikutnya.' : '');
  } else {
    if (txt){ txt.textContent = '❌ Ditolak'; txt.style.color = '#fca5a5'; }
    if (sub) sub.textContent = r.catatan_owner ? ('Catatan: ' + r.catatan_owner) : 'Silakan ajukan lagi kalau memang perlu.';
  }
  box.classList.remove('hidden');
  if (form) form.classList.toggle('hidden', terkunci);
  if (btn) btn.classList.toggle('hidden', terkunci);
}

async function openKasbonModal(){
  if (!saya) return;
  const m = $('kasbonModal'); if (!m) return;
  const err = $('kbErr'); if (err) err.classList.add('hidden');
  const periode = periodeBerjalan(new Date());
  if ($('kbPeriode')) $('kbPeriode').textContent = periode.label;
  if ($('kbGaji')) $('kbGaji').textContent = 'menghitung...';
  if ($('kbMax')) $('kbMax').textContent = '-';
  tampilStatusKasbon(periode.yyyymm);
  m.classList.remove('hidden');
  if (kasbonTerpakaiBulanIni(periode.yyyymm)) return; // ga usah hitung, formnya lagi dikunci
  try{
    const h = await hitungGajiBerjalan(periode);
    // Kasbon yang SUDAH disetujui di periode yang sama ikut mengurangi sisa plafon.
    const sudah = (kasbonRequest && kasbonRequest.status === 'disetujui' && kasbonRequest.periode === periode.yyyymm)
      ? (kasbonRequest.disetujui_jumlah != null ? kasbonRequest.disetujui_jumlah : kasbonRequest.jumlah) : 0;
    const maks = Math.max(0, Math.floor(h.gaji * (kasbonPlafon / 100)) - sudah);
    window.__kbMaks = maks;
    if ($('kbGaji')) $('kbGaji').textContent = __kbRp(h.gaji) + ' (' + h.hari + ' hari masuk)';
    if ($('kbMax')) $('kbMax').textContent = __kbRp(maks) + ' (maks ' + kasbonPlafon + '%' + (sudah ? ', sudah ambil ' + __kbRp(sudah) : '') + ')';
  }catch(e){
    console.warn('hitung gaji berjalan:', e);
    if ($('kbGaji')) $('kbGaji').textContent = 'gagal menghitung';
  }
}

async function submitKasbon(){
  if (!saya) return;
  const err = $('kbErr'), btn = $('btnKasbonSubmit');
  const jumlah = parseInt(($('kbJumlah') || {}).value, 10) || 0;
  const maks = window.__kbMaks || 0;
  const show = msg => { if (err){ err.textContent = msg; err.classList.remove('hidden'); } };
  if (jumlah <= 0){ show('Isi jumlah yang mau diajukan dulu ya.'); return; }
  if (jumlah > maks){ show('Melebihi batas. Maksimal ' + __kbRp(maks) + '.'); return; }
  const periode = periodeBerjalan(new Date());
  if (kasbonTerpakaiBulanIni(periode.yyyymm)){ show('Jatah kasbon periode ini sudah terpakai. Coba lagi periode berikutnya ya.'); return; }
  if (btn){ btn.disabled = true; btn.textContent = 'Mengirim...'; }
  try{
    const { data, error } = await sb.rpc('ajukan_kasbon', {
      p_jumlah: jumlah,
      p_alasan: (($('kbAlasan') || {}).value || '').trim()
    });
    if (error) throw error;
    kasbonRequest = Array.isArray(data) ? data[0] : data;
    if ($('kbJumlah')) $('kbJumlah').value = '';
    if ($('kbAlasan')) $('kbAlasan').value = '';
    tampilStatusKasbon(periode.yyyymm);
  }catch(e){
    console.error('submit kasbon', e);
    show('Gagal mengirim: ' + pesanRamah(e));
  }finally{
    if (btn){ btn.disabled = false; btn.textContent = 'Ajukan'; }
  }
}

// PR-CL91: slip gaji dari owner (ditulis saat gaji ditandai LUNAS). Tayang cuma 24 jam sejak dibayar.
let slipData = null;
const SLIP_TAYANG_MS = 24 * 60 * 60 * 1000;
function __slipRp(n){ return 'Rp ' + Math.round(n || 0).toLocaleString('id-ID'); }
function showSlipCard(){
  const c = $('slipCard'); if (!c || !slipData) return;
  const paidMs = slipData.paidAt && slipData.paidAt.toMillis ? slipData.paidAt.toMillis() : 0;
  if (!paidMs || (Date.now() - paidMs) > SLIP_TAYANG_MS) return; // lewat 24 jam -> ga ditampilkan
  const until = new Date(paidMs + SLIP_TAYANG_MS);
  const sub = $('slipCardSub');
  if (sub) sub.textContent = 'Slip ' + (slipData.label || '') + ' · bisa dilihat s/d ' + until.toLocaleString('id-ID', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
  c.classList.remove('hidden');
}
function openSlipModal(){
  if (!slipData) return;
  const b = $('slipBody'); if (!b) return;
  const jamL = (function(h){ const m = Math.round((h || 0) * 60); return m <= 0 ? '-' : Math.floor(m/60) + ' jam ' + (m%60) + ' mnt'; })(slipData.totalJamLembur);
  // PR-CL92: "parsial" bikin salah paham (dikira ga dihitung hari kerja) — jembrengin
  // jadi dua baris bahasa manusia: hari penuh vs hari singkat (tetap dihitung masuk, dibayar per jam).
  const rows = [
    ['Hari Kerja Penuh', (slipData.hariHadir || 0) + ' hari']
  ];
  if (slipData.hariParsial) rows.push(['Hari Kerja Singkat', (slipData.hariParsial || 0) + ' hari<br><small class="muted">tetap dihitung masuk kerja &mdash; dibayar sesuai jam</small>']);
  rows.push(
    ['Total Jam Kerja', (slipData.totalJamKerja || 0) + ' jam'],
    ['Jam Lembur', jamL],
    ['Upah Pokok', __slipRp(slipData.upahPokok)],
    ['Upah Lembur', __slipRp(slipData.upahLembur)]
  );
  if (slipData.tunjangan > 0) rows.push(['Tunjangan Jabatan', __slipRp(slipData.tunjangan)]);
  if (slipData.bonus > 0) rows.push(['Bonus', '+ ' + __slipRp(slipData.bonus)]);
  if (slipData.potongan > 0) rows.push(['Potongan / Kasbon', '- ' + __slipRp(slipData.potongan)]);
  rows.push(['TOTAL DITERIMA', __slipRp(slipData.totalBayar)]);
  b.innerHTML = rows.map(function(r, i){
    const last = i === rows.length - 1;
    return '<tr' + (last ? ' style="border-top:1px solid #3a3a3a"' : '') + '><td' + (last ? ' style="font-weight:700"' : '') + '>' + r[0] + '</td><td style="text-align:right;' + (last ? 'font-weight:800;color:#34d399;font-size:16px' : '') + '">' + r[1] + '</td></tr>';
  }).join('');
  const sub = $('slipModalSub'); if (sub) sub.textContent = 'Periode ' + (slipData.label || '-');
  const paidMs = slipData.paidAt && slipData.paidAt.toMillis ? slipData.paidAt.toMillis() : 0;
  const exp = $('slipModalExp');
  if (exp && paidMs) exp.textContent = 'Slip ini otomatis hilang ' + new Date(paidMs + SLIP_TAYANG_MS).toLocaleString('id-ID', { weekday:'long', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) + '. Screenshot kalau mau disimpan ya.';
  $('slipModal').classList.remove('hidden');
}
// Popup pengingat tiap kali buka aplikasi (sebelum sempat Clock In) sampai profil lengkap.
function showLengkapiProfilNotice(){
  if (!profilKurang.length) return;
  const m = $('lengkapiProfilModal'); if (!m) return;
  const ul = $('lpList'); if (ul) ul.innerHTML = profilKurang.map(x => '<li>' + x + '</li>').join('');
  m.classList.remove('hidden');
}

// ===== LOKASI SAAT MENCET TOMBOL =====
// Aturan cabang (sementara, sesuai keputusan owner): kalau karyawan sudah
// ditempatkan di cabang, radiusnya dicek ke cabang ITU. Kalau belum (kondisi
// sekarang: data cabang belum ada dari klien), lat/lng TETAP disimpan tapi
// in_radius dibiarkan NULL = "tidak diketahui". Absen TIDAK PERNAH diblokir —
// memblokir orang gara-gara GPS ngaco cuma bikin drama, sementara owner tetap
// butuh tahu. Yang berubah cuma penandanya.
function lokasiAbsen(){
  if (!coords) return null;
  const c = saya && saya.cabang;
  const dasar = { lat: coords.lat, lng: coords.lng, akurasi_m: (coords.acc != null ? coords.acc : null) };
  if (!c || c.lat == null || c.lng == null){
    return Object.assign(dasar, { jarak_m: null, in_radius: null });
  }
  const j = jarakMeter(coords.lat, coords.lng, c.lat, c.lng);
  return Object.assign(dasar, { jarak_m: j, in_radius: dalamRadius(j, coords.acc, c.radius_m) });
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

// Ember foto sengaja TERTUTUP (selfie & KTP bukan barang yang boleh ketebak
// URL-nya orang luar), jadi yang disimpan di database itu PATH, bukan URL.
// Link tayangnya dibikin sebentar-sebentar di sini.
async function urlTayang(ember, path){
  const p = String(path || '').trim();
  if (!p) return '';
  if (/^(https?:|data:|blob:)/i.test(p)) return p;   // nilai lama / base64 inline
  try{
    const { data, error } = await sb.storage.from(ember).createSignedUrl(p, 60 * 60);
    if (error) throw error;
    return (data && data.signedUrl) || '';
  }catch(e){ console.warn('signed url ' + ember + ':', e); return ''; }
}

async function loadUserProfile(){
  try{
    let nama='', namaPanggilan='', jamKerja=9, foto='', gpsExempt=false, wajibKode=false, kodeAdmin=false, noShiftBarrier=false, liburHari=null, liburRequest=null;
    try{
      const u = saya;
      if (u){
        // Di skema baru `nama` = nama panggilan (satu kata, yang tampil di layar)
        // dan `nama_lengkap` = nama di KTP. Di Firestore dulu dua field terpisah
        // di dokumen yang sama.
        namaPanggilan = u.nama || '';
        nama = u.nama_lengkap || u.nama || '';
        jamKerja = (u.jam_kerja!=null) ? parseFloat(u.jam_kerja) : 9;
        gpsExempt = !!u.gps_exempt;
        wajibKode = (u.wajib_kode_clockout === true);  // wajib kode admin saat Clock Out (pilot per orang)
        kodeAdmin = (u.kode_admin === true);           // admin bertugas: kodenya tampil di halaman dia
        noShiftBarrier = (u.no_shift_barrier === true);// exempt barrier shift 18 jam (khusus admin nginap, mis. Mila)
        liburHari = (u.libur_hari != null ? Number(u.libur_hari) : null);
        // PR-CL93: akses kasbon — dibuka owner per orang (patokan masa kerja 1 tahun+).
        kasbonAktif = (u.kasbon_aktif === true);
        kasbonPlafon = (u.kasbon_plafon_persen != null ? Number(u.kasbon_plafon_persen) : KASBON_PLAFON_DEFAULT);
        baseHarian = Number(u.base_harian) || 0;
        tanggalLahirSaya = (typeof u.tanggal_lahir === 'string' ? u.tanggal_lahir.trim() : ''); // PR-CL95
        sayaNonaktif = (u.nonaktif === true);          // PR-CL97: sudah resign -> semua tombol absen dikunci
        // PR-CL98: dulu ini saklar lepas `spvAkses`. Sekarang perannya sudah ada
        // di kolom `peran`, jadi tidak perlu saklar kedua yang bisa beda sendiri.
        sayaSpv = (u.peran === 'spv' || u.peran === 'owner');
        foto = await urlTayang(EMBER_PROFIL, u.foto_url);
        // Cek kelengkapan profil (rekening + KTP) buat notif "Lengkapi Profil" pas login.
        profilKurang = [];
        if (!String(u.nama_bank||'').trim() || !String(u.nomor_rekening||'').trim() || !String(u.atas_nama_rek||'').trim()) profilKurang.push('Rekening bank &mdash; tujuan transfer gaji');
        if (!String(u.ktp_url||'').trim()) profilKurang.push('Foto KTP &mdash; arsip kepegawaian');
        // Umur akun buat eskalasi pengingat foto profil (pakai created_at, fallback tanggal_masuk).
        try{
          const _tj = u.created_at || u.tanggal_masuk;
          sayaJoinMs = _tj ? (new Date(_tj).getTime() || 0) : 0;
        }catch(e){ sayaJoinMs = 0; }
      }
    }catch(e){ console.warn('karyawan profile load err:', e); }

    // Usulan libur & pengajuan kasbon: di Firestore dulu nempel sebagai field di
    // dokumen karyawan; di sini jadi barisnya sendiri. Yang dipakai tetap yang
    // PALING BARU, jadi perilakunya sama dengan versi lama yang cuma simpan satu.
    try{
      const { data } = await sb.from('libur_request')
        .select('pilihan, status, created_at')
        .order('created_at', { ascending: false }).limit(1);
      const r = data && data[0];
      if (r && Array.isArray(r.pilihan)) liburRequest = r.pilihan.map(Number);
    }catch(e){ console.warn('libur request load err:', e); }

    try{
      const { data } = await sb.from('kasbon_request')
        .select('jumlah, alasan, status, periode, periode_label, disetujui_jumlah, catatan_owner, created_at')
        .order('created_at', { ascending: false }).limit(1);
      kasbonRequest = (data && data[0]) || null;
    }catch(e){ console.warn('kasbon request load err:', e); }

    // PR-CL91: slip gaji — potretnya ditulis owner ke baris payroll periode itu.
    try{
      const { data } = await sb.from('payroll_status')
        .select('slip, dibayar_at, periode')
        .eq('status', 'dibayar').not('slip', 'is', null)
        .order('dibayar_at', { ascending: false, nullsFirst: false }).limit(1);
      const r = data && data[0];
      slipData = r && r.slip ? Object.assign({}, r.slip, { paidAt: stempel(r.dibayar_at) }) : null;
    }catch(e){ console.warn('slip load err:', e); }

    userProfile = { nama, namaPanggilan, jamKerja, foto, gpsExempt, wajibKode, kodeAdmin, noShiftBarrier, liburHari, liburRequest };
    initAdminKodeCard();

    // Foto profil ikut daftar "Profil Belum Lengkap" (PR-CL108).
    //
    // Sengaja MENGINGATKAN, bukan memblokir. Versi lama (dicabut Juni 2026,
    // commit 3dd43cc) menghadang Clock In dengan modal tanpa tombol tutup —
    // siapa pun yang uploadnya gagal jadi tidak bisa absen sama sekali.
    // Kehadiran jangan pernah disandera urusan kelengkapan data.
    //
    // Ditaruh di sini, bukan di blok profilKurang bersama rekening & KTP,
    // karena nilai foto baru selesai dibaca dari koleksi 'profil' beberapa baris
    // di atas — di blok itu nilainya masih kosong.
    // Patokannya kolom foto_url (bukan link tayang): kalau link sementara gagal dibuat karena
    // sinyal, foto yang sebenarnya ada jangan dianggap kosong lalu ditimpa selfie.
    if (!String((saya && saya.foto_url) || foto || '').trim()) {
      // Eskalasi: lewat 2 hari belum upload -> warning tegas: selfie absen bakal dipakai.
      const _umurHari = sayaJoinMs ? (Date.now() - sayaJoinMs) / 86400000 : 0;
      if (_umurHari >= 2) {
        profilKurang.push('Foto profil &mdash; &#9888;&#65039; udah ' + Math.floor(_umurHari) + ' hari belum upload nih! Kalau dibiarin, <b>foto absen kamu otomatis dipakai jadi foto profil</b> &#128248;');
      } else {
        profilKurang.push('Foto profil &mdash; biar wajahmu kelihatan di papan kehadiran');
      }
    }

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
async function loadActiveSession(){
  sessionCache = [];
  const since = new Date(Date.now() - SESSION_WINDOW_MS).toISOString();
  const { data, error } = await sb
    .from('absensi')
    .select(KOLOM_ABSEN)
    .eq('karyawan_id', saya.id)
    .gte('ts', since)
    .order('ts', { ascending: true });
  if (error) throw error;
  const all = (data || []).map(bungkusEvent).filter(r => r.ts);
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
    // Barrier "lupa clock out" — TAPI karyawan yang di-exempt (noShiftBarrier, mis. admin nginap Mila) ga kena,
    // biar sesi lembur panjang >18 jam tetap bisa ditutup sendiri (Selesai Lembur), ga ke-reset.
    const __maxShift = userProfile.noShiftBarrier ? (72 * 60 * 60 * 1000) : MAX_SHIFT_MS;
    if (__ciTs && (Date.now() - __ciTs) > __maxShift) {
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

// Pengganti onAuthStateChanged. Dijaga sekali jalan: onAuthStateChange bisa
// menyala beberapa kali (INITIAL_SESSION, TOKEN_REFRESHED) dan kita ga mau
// halaman disiapkan berkali-kali.
let __sudahMulai = false;
sb.auth.onAuthStateChange(async (event, session) => {
  if (!session){ location.replace('index.html'); return; }
  if (__sudahMulai) return;
  __sudahMulai = true;
  try{ await mulaiHalaman(session); }
  catch(e){ console.error('mulai halaman', e); alert(pesanRamah(e)); }
});

async function mulaiHalaman(session){
  currentUser = session.user;
  saya = await karyawanSaya({ paksaSegar: true });
  if (!saya){
    // Akunnya ada tapi belum didaftarkan sebagai karyawan — jangan kasih layar
    // kosong, balikin ke halaman depan yang memang menjelaskan langkahnya.
    location.replace('index.html');
    return;
  }
  if (saya.peran === 'owner'){ location.replace('owner.html'); return; }

  await loadUserProfile();
  await loadActiveSession();
  await checkForgottenClockOut();
  refreshLocStatus();
  try{ showLengkapiProfilNotice(); }catch(e){}
  try{ showSlipCard(); }catch(e){}
  // Tombol Kasbon cuma nongol kalau owner udah buka aksesnya buat orang ini.
  try{ if (kasbonAktif && $('btnKasbon')) $('btnKasbon').classList.remove('hidden'); }catch(e){}
  try{ if (sayaSpv && $('btnPantauTim')) $('btnPantauTim').classList.remove('hidden'); }catch(e){}
  try{ await cekUltah(); }catch(e){ console.warn('ultah:', e); }
}

if ($('btnUltahClose')) $('btnUltahClose').onclick = () => $('ultahPopup').classList.add('hidden');
if ($('btnKasbon')) $('btnKasbon').onclick = () => { try{ openKasbonModal(); }catch(e){} };
if ($('btnKasbonClose')) $('btnKasbonClose').onclick = () => $('kasbonModal').classList.add('hidden');
if ($('btnKasbonSubmit')) $('btnKasbonSubmit').onclick = () => { try{ submitKasbon(); }catch(e){} };
if ($('btnLihatSlip')) $('btnLihatSlip').onclick = () => { try{ openSlipModal(); }catch(e){} };
if ($('btnSlipClose')) $('btnSlipClose').onclick = () => $('slipModal').classList.add('hidden');

$('btnLogout').onclick = () => keluar().catch(()=>location.replace('index.html'));
// Tombol popup "Lengkapi Profil": isi sekarang -> buka modal Profil; nanti -> tutup (muncul lagi di buka berikutnya).
if ($('btnLpNanti')) $('btnLpNanti').onclick = () => $('lengkapiProfilModal').classList.add('hidden');
if ($('btnLpIsi')) $('btnLpIsi').onclick = () => {
  $('lengkapiProfilModal').classList.add('hidden');
  try{ if (window.openProfil) window.openProfil(); else $('btnOpenProfil').click(); }catch(e){}
};

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

// Kompres gambar sampai di bawah batas. Ini kode yang sama persis yang dipakai
// buat foto KTP di bawah — dipisah biar selfie ikut kebagian.
async function kompresGambar(sumber, maxBytes){
  try {
    const tipe = sumber && sumber.type ? sumber.type : 'image/jpeg';
    if (!sumber || !/^image\//.test(tipe)) return sumber;
    if (sumber.size && sumber.size <= maxBytes) return sumber;
    const dataUrl = await new Promise((res,rej)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=rej; fr.readAsDataURL(sumber); });
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
    return outBlob || sumber;
  } catch(e){ console.warn("Kompres gambar gagal, pakai file asli:", e&&e.message); return sumber; }
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
  const lok = lokasiAbsen();
  let selfieUrl = '';

  showSavingOverlay('Mengunggah foto & menyimpan absen...');

  try{
    const kecil = await kompresGambar(blob, SELFIE_MAX_BYTES);
    const rand = Math.random().toString(36).slice(2,8);
    // Map paling depan WAJIB id karyawan — itu yang dipakai aturan Storage
    // buat mastiin orang cuma bisa naruh & buka foto miliknya sendiri.
    const path = saya.id + '/' + Date.now() + '_' + rand + '.jpg';
    const { error } = await sb.storage.from(EMBER_SELFIE)
      .upload(path, kecil, { contentType: 'image/jpeg', upsert: false });
    if (error) throw error;
    selfieUrl = path;   // yang disimpan PATH, bukan URL (embernya tertutup)
  }catch(e){
    console.warn('Selfie upload gagal:', e.message);
    hideSavingOverlay();
    const lanjut = confirm('Upload foto gagal (' + (e.message||'network') + '). Tetap lanjutkan absen tanpa foto?');
    if (!lanjut) return;
    showSavingOverlay('Menyimpan absen...');
  }
  const extra = {};
  if (currentType === 'clock_out' && window.__noBreak){
    extra.no_break = true;
    window.__noBreak = false;
  }
  if ((currentType === 'clock_out' || currentType === 'overtime_out') && window.__kodeVerif){
    extra.kode_verif = window.__kodeVerif; // 'ok' = terverifikasi admin, 'darurat' = tanpa kode (merah di owner)
    window.__kodeVerif = null;
  }
  isSubmitting = true;
  try {
    await saveAttendance(Object.assign({ tipe: currentType, foto_selfie: selfieUrl || null }, lok, extra));
    await loadActiveSession();
    // Sanksi foto profil (PR-CL111): sudah diwarning sejak hari ke-2, masuk hari ke-3 masih belum upload
    // -> selfie absen barusan otomatis jadi foto profil. Bisa diganti kapan aja lewat menu Profil.
    // Selfie & foto profil beda ember, jadi filenya disalin ke ember profil dulu.
    try{
      const _umurHari = sayaJoinMs ? (Date.now() - sayaJoinMs) / 86400000 : 0;
      if (selfieUrl && !String((saya && saya.foto_url) || userProfile.foto || '').trim() && _umurHari >= 3){
        const { data: _blob, error: _e1 } = await sb.storage.from(EMBER_SELFIE).download(selfieUrl);
        if (_e1) throw _e1;
        const _path = saya.id + '/avatar.jpg';
        const { error: _e2 } = await sb.storage.from(EMBER_PROFIL).upload(_path, _blob, { contentType: 'image/jpeg', upsert: true });
        if (_e2) throw _e2;
        const { error: _e3 } = await sb.rpc('simpan_foto_saya', { p_foto_url: _path });
        if (_e3) throw _e3;
        if (saya) saya.foto_url = _path;
        const _tayang = await urlTayang(EMBER_PROFIL, _path);
        userProfile.foto = _tayang;
        const _ai = $('avatarImg'); if (_ai){ _ai.src = _tayang; _ai.style.display = 'block'; }
        const _ap = $('avatarPlaceholder'); if (_ap) _ap.style.display = 'none';
        setTimeout(function(){ alert('\u{1F4F8} Karena belum upload foto profil, foto absen barusan otomatis jadi foto profil kamu ya!\n\nKurang kece? Upload foto pilihanmu sendiri di menu Profil \u{1F60E}'); }, 400);
      }
    }catch(e){ console.warn('auto foto profil dari absen gagal:', e); }
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
  const lok = lokasiAbsen();
isSubmitting = true;
    try {
    await saveAttendance(Object.assign({ tipe:type }, lok, extra));
    await loadActiveSession();
  } finally {
    isSubmitting = false;
  }
}

async function saveAttendance(payload){
  // Kolom `ts` sengaja TIDAK diisi -> database yang menuliskan now(). Jam HP
  // bisa diubah orang, jam server tidak.
  const data = Object.assign({
    karyawan_id: saya.id,
    cabang_id: saya.cabang_id || null
  }, payload);
  // GPS dikecualikan (HP lokasi bermasalah): jangan tandai "luar radius",
  // tapi tandai transparan gps_exempt biar owner tau lokasinya tidak diverifikasi.
  if (saya && saya.gps_exempt){
    data.in_radius = true;
    data.gps_exempt = true;
  }
  const { error } = await sb.from('absensi').insert(data);
  if (error) throw error;
  pingTelegramAbsen(data);
}

// PR-CL99: pergerakan absen realtime ke grup Telegram.
// Fire-and-forget SESUDAH absennya tersimpan — ping gagal (sinyal jelek,
// server ngambek) GAK BOLEH ganggu absen. Auth pakai token sesi Supabase yang
// emang udah dipegang app — zero secret baru di client. Aturan pesan/dedup-nya
// di sisi server. Dua jalur pembukuan mundur (break isi-pas-checkout,
// overtime_in backdate) SENGAJA gak lewat sini — itu bukan pergerakan orang
// detik itu.
//
// CATATAN: absensi-ping di project WMS masih memverifikasi token FIREBASE.
// Sampai fungsinya diport ke token Supabase, panggilan ini ditolak diam-diam
// dan absennya tetap aman.
const ABSEN_PING_URL = 'https://ryuwnsxwtwfmndnbysxw.supabase.co/functions/v1/absensi-ping';
// PR-CL101: total buat feed Telegram — dihitung dari sessionCache (event sesi
// yang kebuka) + momen sekarang, karena event yang BARUSAN dipencet belum ada
// di cache (loadActiveSession jalan sesudahnya). Display-only buat owner;
// gaji tetap dari payroll, jadi meleset semenit dua menit bukan masalah.
function totalMenitAbsen(tipe){
  try {
    var evs = (sessionCache || []).map(function(e){
      var ms = e && e.ts && (e.ts.toMillis ? e.ts.toMillis() : (e.ts.toDate ? e.ts.toDate().getTime() : NaN));
      return { tipe: e && e.tipe, ms: ms };
    }).filter(function(e){ return e.tipe && isFinite(e.ms); }).sort(function(a,b){ return a.ms - b.ms; });
    var nowMs = Date.now();
    var ciEv = null;
    for (var i0=0;i0<evs.length;i0++){ if (evs[i0].tipe==='clock_in'){ ciEv=evs[i0]; break; } }
    if (!ciEv){ for (var i1=0;i1<evs.length;i1++){ if (evs[i1].tipe==='overtime_in'){ ciEv=evs[i1]; break; } } }
    if (!ciEv) return null;
    var ciMs = ciEv.ms;
    function pasangan(inT, outT, endMs){
      var tot = 0, open = null;
      for (var i=0;i<evs.length;i++){
        var e = evs[i];
        if (e.tipe===inT) open = e.ms;
        else if (e.tipe===outT && open!=null){
          var s = Math.max(open, ciMs), en = Math.min(e.ms, endMs);
          if (en>s) tot += en-s;
          open = null;
        }
      }
      // pasangan yang masih kebuka (mis. break_in tanpa break_out di cache,
      // karena break_out-nya yang barusan dipencet) ditutup pakai endMs.
      if (open!=null){ var s2=Math.max(open,ciMs); if (endMs>s2) tot += endMs-s2; }
      return tot;
    }
    if (tipe==='break_out'){
      return Math.round(pasangan('break_in','break_out', nowMs)/60000) || null;
    }
    if (tipe==='clock_out' || tipe==='overtime_out'){
      var ef = (nowMs - ciMs) - pasangan('break_in','break_out', nowMs) - pasangan('pause_in','pause_out', nowMs);
      return ef>0 ? Math.round(ef/60000) : null;
    }
    return null;
  } catch(e){ return null; }
}

function pingTelegramAbsen(data){
  if (MODE_UJI) return;   // uji coba: jangan ramaikan grup Telegram asli
  try {
    sb.auth.getSession().then(function(res){
      var tok = res && res.data && res.data.session && res.data.session.access_token;
      if (!tok) return;
      return fetch(ABSEN_PING_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
        body: JSON.stringify({
          tipe: data.tipe,
          nama: (userProfile && (userProfile.namaPanggilan || userProfile.nama)) || '',
          in_radius: data.in_radius !== false,
          gps_exempt: data.gps_exempt === true,
          total_menit: totalMenitAbsen(data.tipe)
        })
      });
    }).catch(function(){});
  } catch (e) { /* absen udah aman tersimpan; ping cuma bonus */ }
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
let _liburFull = []; // hari yang slot-nya udah penuh (>= LIBUR_MAX) — di-exclude dari pilihan
function _liburOptionsHtml(sel){
  let h = '<option value="">— pilih hari —</option>';
  for (let i=0;i<7;i++){
    const full = _liburFull.includes(i);
    h += '<option value="'+i+'"'+(String(sel)===String(i)?' selected':'')+(full?' disabled':'')+'>'+LIBUR_HARI[i]+(full?' — PENUH':'')+'</option>';
  }
  return h;
}
async function openLiburModal(){
  const modal = $('liburModal'); if (!modal) return;
  const cur = userProfile.liburHari;
  const req = Array.isArray(userProfile.liburRequest) ? userProfile.liburRequest : [];
  // PR-CL94: hari libur yang SUDAH ditetapkan owner sifatnya PERMANEN — ga bisa diusulin
  // ganti tiap minggu. Yang boleh ngajuin cuma yang belum punya hari libur sama sekali.
  const terkunci = (cur != null && cur >= 0 && cur <= 6);
  const form = $('liburForm'), intro = $('liburIntro'), save = $('btnLiburSave'), cancel = $('btnLiburCancel');
  if (form) form.classList.toggle('hidden', terkunci);
  if (save) save.classList.toggle('hidden', terkunci);
  if (cancel) cancel.textContent = terkunci ? 'Tutup' : 'Batal';
  if (intro) intro.innerHTML = terkunci
    ? 'Hari libur mingguan kamu sudah ditetapkan dan sifatnya <b>tetap</b>. Kalau ada keperluan khusus, ngomong langsung ke owner ya.'
    : 'Usul 3 hari sesuai prioritas kamu. Ini <b>usulan</b> &mdash; <b>owner yang nentuin</b> hari libur finalnya, jadi ga langsung jadi ya. Nanti kekabarin.';
  if (terkunci){
    const cc0 = $('liburCurrent');
    if (cc0) cc0.innerHTML = '<div style="background:rgba(255,255,255,.05);border-radius:10px;padding:12px;text-align:center">'
      + '<div style="font-size:13px;color:#9ca3af">Hari libur mingguan kamu</div>'
      + '<div style="font-size:24px;font-weight:800;color:#6ee7b7;margin-top:2px">' + LIBUR_HARI[cur] + '</div>'
      + '<div style="font-size:12px;color:#9ca3af;margin-top:4px">\u{1F512} Sudah tetap &mdash; ditentukan owner</div></div>';
    modal.classList.remove('hidden');
    return;
  }
  // Hitung hari yang slot-nya udah penuh (>= LIBUR_MAX), biar di-exclude dari pilihan.
  // Dihitung DI DATABASE: karyawan ga boleh baca baris karyawan lain (di sana ada
  // gaji), jadi yang balik cuma angka harinya — bukan siapa-siapanya.
  _liburFull = [];
  try {
    const { data, error } = await sb.rpc('libur_penuh', { p_maks: LIBUR_MAX });
    if (error) throw error;
    _liburFull = (data || []).map(Number);
  } catch(e){ console.warn('libur full-count err', e); }
  const cc = $('liburCurrent');
  if (cc){
    let html = (cur!=null && cur>=0)
      ? 'Hari libur kamu: <b style="color:#6ee7b7">'+LIBUR_HARI[cur]+'</b> <span style="color:#9ca3af">(ditentukan owner)</span>'
      : 'Kamu belum punya hari libur tetap. Kirim usulan di bawah ya.';
    if (req.length) html += '<br><span style="color:#fbbf24">📩 Usulan kamu: '+req.map(d=>LIBUR_HARI[d]).join(' › ')+' — nunggu di-approve owner.</span>';
    if (_liburFull.length>=7) html += '<br><span style="color:#f87171">Semua hari sudah penuh. Hubungi admin ya.</span>';
    cc.innerHTML = html;
  }
  $('liburPil1').innerHTML = _liburOptionsHtml(req[0]!=null?req[0]:cur);
  $('liburPil2').innerHTML = _liburOptionsHtml(req[1]);
  $('liburPil3').innerHTML = _liburOptionsHtml(req[2]);
  ['liburPil1','liburPil2','liburPil3'].forEach(id=>{ const s=$(id); if (s) s.onchange = _liburSyncDropdowns; });
  _liburSyncDropdowns();
  const err=$('liburErr'); if(err) err.style.display='none';
  modal.classList.remove('hidden');
}
// Cegah pilih hari yang sama di >1 dropdown (prioritas 1>2>3) + exclude hari yang udah PENUH.
function _liburSyncDropdowns(){
  const s1=$('liburPil1'), s2=$('liburPil2'), s3=$('liburPil3');
  if (!s1||!s2||!s3) return;
  const isFull = v => _liburFull.includes(Number(v));
  [s1,s2,s3].forEach(s=>{ if (s.value && isFull(s.value)) s.value=''; });
  const v1=s1.value;
  if (s2.value && s2.value===v1) s2.value='';
  const v2=s2.value;
  if (s3.value && (s3.value===v1 || s3.value===v2)) s3.value='';
  Array.from(s1.options).forEach(o=>{ o.disabled = !!(o.value && isFull(o.value)); });
  Array.from(s2.options).forEach(o=>{ o.disabled = !!(o.value && (isFull(o.value) || o.value===v1)); });
  Array.from(s3.options).forEach(o=>{ o.disabled = !!(o.value && (isFull(o.value) || o.value===v1 || o.value===v2)); });
}
async function saveLiburRequest(){
  const _cur = userProfile.liburHari;
  // Pengaman kedua: kalau hari libur sudah ditetapkan, usulan ditolak di sini juga.
  // (Pengaman ketiga ada di dalam fungsi ajukan_libur() di database.)
  if (_cur != null && _cur >= 0 && _cur <= 6){
    const e0 = $('liburErr');
    if (e0){ e0.textContent = 'Hari libur kamu sudah ditetapkan (' + LIBUR_HARI[_cur] + ') dan sifatnya tetap.'; e0.style.display = 'block'; }
    return;
  }
  const picks=[$('liburPil1').value, $('liburPil2').value, $('liburPil3').value].filter(v=>v!=='').map(Number);
  const err=$('liburErr');
  if (picks.length < 1){ if(err){err.textContent='Minimal pilih 1 hari.';err.style.display='block';} return; }
  if (new Set(picks).size !== picks.length){ if(err){err.textContent='Pilihan harus hari yang berbeda-beda.';err.style.display='block';} return; }
  const btn=$('btnLiburSave'); btn.disabled=true; btn.textContent='Mengirim...';
  try {
    // Cuma KIRIM USULAN — owner yang nentuin hari final. Ga nge-set liburHari.
    const { error } = await sb.rpc('ajukan_libur', { p_pilihan: picks });
    if (error) throw error;
    userProfile.liburRequest = picks;
    $('liburModal').classList.add('hidden');
    alert('✅ Usulan libur kamu udah dikirim ke owner:\n' + picks.map(d=>LIBUR_HARI[d]).join(' › ') + '\n\nOwner yang bakal nentuin hari finalnya. Ditunggu ya.');
  } catch(e){ console.error('saveLiburReq', e); alert('Gagal mengirim: ' + pesanRamah(e)); btn.disabled=false; btn.textContent='Kirim Usulan'; }
}
(function wireLibur(){
  const b=$('btnLibur'); if (b) b.onclick=openLiburModal;
  const c=$('btnLiburCancel'); if (c) c.onclick=()=>$('liburModal').classList.add('hidden');
  const s=$('btnLiburSave'); if (s) s.onclick=saveLiburRequest;
})();

async function handleAction(type){
  if (isSubmitting){ return; } // cegah double-tap race condition
  // PR-CL97: akun yang sudah di-nonaktifkan owner (resign) ga boleh absen lagi. Tanpa ini,
  // sesi mereka bisa kebuka dan nongol di papan kehadiran owner seolah-olah masih kerja.
  if (sayaNonaktif){
    alert('Akun kamu sudah dinonaktifkan, jadi tidak bisa absen lagi. Kalau ini keliru, hubungi owner ya.');
    return;
  }
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
        lat: bi ? bi.lat : null,
        lng: bi ? bi.lng : null,
        akurasi_m: bi ? bi.akurasi_m : null,
        jarak_m: bi ? bi.jarak_m : null,
        in_radius: bi ? bi.in_radius : null,
        auto_cap: true
      });
      await loadActiveSession();
    } finally {
      isSubmitting = false;
    }
    $('forgotBreakOutModal').classList.remove('hidden');
    return;
  }
  if (!hasInSession('break_in')){
    // PR-CL105: shift pendek ga wajib istirahat. Sebelum ini shift 1 jam pun dipaksa isi
    // istirahat 1 jam -- kasus itang 21 Agu: kerja 1j07m malah kepotong jadi 0.34 jam.
    const _ciS = getFirstInSession('clock_in');
    const _ciMs = (_ciS && _ciS.ts && _ciS.ts.toDate) ? _ciS.ts.toDate().getTime() : 0;
    const _spanMs = _ciMs ? (Date.now() - _ciMs) : 0;
    if (_spanMs > 0 && _spanMs < SHIFT_WAJIB_ISTIRAHAT_MS){ proceedClockOut(); return; }
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
  // PR-CL105: istirahat harus DI DALAM sesi kerja. Tanpa ini, "+1 jam" otomatis bisa melewati
  // jam Clock Out (kasus itang: clock out 09:46 tapi break_out tercatat 10:00).
  const _nowD = new Date();
  if (sd >= _nowD){ alert("Jam mulai istirahat tidak boleh melewati jam sekarang."); return; }
  if (ed > _nowD) ed = _nowD;
  const lok = lokasiAbsen() || { lat:null, lng:null, akurasi_m:null, jarak_m:null, in_radius:null };
  const base = Object.assign({
    karyawan_id: saya.id,
    cabang_id: saya.cabang_id || null,
    flag: 'breakFilledAtCheckout'
  }, lok);
  // SATU-SATUNYA jalur (selain overtime_in otomatis) yang boleh menuliskan `ts`
  // dari HP: ini memang pembukuan MUNDUR — orangnya mengaku tadi istirahat jam
  // sekian. Jamnya diketik sendiri, jadi memang tidak bisa pakai now().
  const { error } = await sb.from('absensi').insert([
    Object.assign({}, base, { tipe:'break_in',  ts: sd.toISOString() }),
    Object.assign({}, base, { tipe:'break_out', ts: ed.toISOString() })
  ]);
  if (error){ alert('Gagal menyimpan istirahat: ' + pesanRamah(error)); return; }
  $('breakRangeModal').classList.add('hidden');
  await loadActiveSession();
  proceedClockOut();
};

var __bnb=$('btnBreakRangeNoBreak'); if(__bnb) __bnb.onclick = () => {
  $('breakRangeModal').classList.add('hidden');
  window.__noBreak = true;
  proceedClockOut();
};

// ===== SOFT FORGOTTEN CLOCK OUT =====
async function checkForgottenClockOut(){
  try{
    const uid = saya.id;
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
    // Tanpa cadangan base64: database cuma menerima path file di map milik sendiri,
    // jadi kalau upload gagal lebih baik bilang gagal daripada nyimpen setengah.
    const path = saya.id + '/avatar.jpg';
    const blob = await (await fetch(dataUrl)).blob();
    const { error: upErr } = await sb.storage.from(EMBER_PROFIL)
      .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
    if (upErr) throw upErr;
    const simpan = path;
    const tampil = await urlTayang(EMBER_PROFIL, path) || dataUrl;
    const { error } = await sb.rpc('simpan_foto_saya', { p_foto_url: simpan });
    if (error) throw error;
    if (saya) saya.foto_url = simpan;
    userProfile.foto = tampil;
    $('avatarImg').src = tampil;
    $('avatarImg').style.display = 'block';
    $('avatarPlaceholder').style.display = 'none';
    // (modal wajib lama sudah dihapus — lihat catatan PR-CL105)
  }catch(e){
    alert('Gagal simpan foto: ' + (e && e.message ? e.message : e));
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
    if(!saya || !saya.id) return;
    await loadActiveSession();
  }catch(err){ console.warn('refreshAbsenState error', err); }
}
setInterval(refreshAbsenState, 30000);
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) refreshAbsenState(); });
window.addEventListener('focus', refreshAbsenState);

// CATATAN: showMandatoryAvatarModal() DIHAPUS di PR-CL108. Itu sisa versi
// lama yang menghadang Clock In dengan modal tanpa jalan keluar. Sudah tidak
// dipanggil sejak commit 3dd43cc, dan sekarang digantikan daftar "Profil Belum
// Lengkap" yang mengingatkan tanpa menyandera absen.


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

// Tulis baris overtime_in langsung ke database dengan timestamp backdate.
// saveAttendance() sengaja tidak pernah mengirim `ts` (biar pakai now() server),
// jadi jalur backdate ini memang harus lewat sini. Ditandai `otomatis` supaya
// owner tahu ini dicatat sistem, bukan dipencet orang.
async function writeOvertimeInAt(ms) {
  const data = {
    karyawan_id: saya.id,
    cabang_id: saya.cabang_id || null,
    tipe: 'overtime_in',
    ts: new Date(ms).toISOString(),
    otomatis: true
  };
  const { error } = await sb.from('absensi').insert(data);
  if (error) throw error;
  sessionCache.push({ tipe: 'overtime_in', ts: stempel(data.ts) });
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

  // Rekening & KTP dikunci TERPISAH. Rekening: kekunci sampai owner buka. KTP: sekali upload, permanen (ga bisa diubah).
  function applyProfilLocks(rekLocked, hasKtp){
    ['pfNamaBank','pfNomorRekening','pfAtasNamaRek'].forEach(id => { const e = el(id); if(e) e.disabled = !!rekLocked; });
    const pick = el('pfBtnPickKtp'); if(pick) pick.style.display = hasKtp ? 'none' : '';        // KTP udah ada -> tombol upload disembunyiin
    const save = el('pfBtnSave'); if(save) save.style.display = (rekLocked && hasKtp) ? 'none' : ''; // ga ada yang bisa diubah -> sembunyiin
    const note = el('pfLockedNote');
    if(note){
      if(rekLocked && hasKtp){ note.textContent = 'Rekening terkunci — minta admin buka kunci kalau mau ganti. Foto KTP tidak bisa diubah.'; note.classList.remove('hidden'); }
      else if(hasKtp){ note.textContent = 'Foto KTP sudah terkunci (tidak bisa diubah). Rekening bisa kamu perbarui di atas, lalu Simpan.'; note.classList.remove('hidden'); }
      else { note.classList.add('hidden'); }
    }
  }

  async function openProfil(){
  try{ window.openProfil = openProfil; }catch(e){}
    const modal = el('profilModal'); if(!modal) return;
    pfSelectedKtpFile = null;
    if(!saya){ alert('Sesi belum siap, coba lagi.'); return; }
    try{
      // Baris karyawan diambil ulang biar isinya segar (mis. owner baru saja
      // membuka kunci rekening sementara halaman ini belum di-refresh).
      const d = await karyawanSaya({ paksaSegar: true }) || saya || {};
      if (d && d.id) saya = d;
      if(el('pfNama')) el('pfNama').value = ((typeof userProfile!=='undefined'&&userProfile&&userProfile.nama)?userProfile.nama:'') || d.nama_lengkap || d.nama || '';
      // ID Karyawan (read-only). Kalau belum ada, auto-generate sekali biar user langsung lihat ID-nya.
      // Skema GG-XXXX (acak). Owner tetap bisa ganti dari panel.
      let _idKar = d.id_karyawan || '';
      if(!_idKar){
        try {
          const { data, error } = await sb.rpc('pastikan_id_karyawan');
          if (error) throw error;
          _idKar = data || '';
        } catch(e){ console.warn('auto-set idKaryawan gagal:', e); }
      }
      if(el('pfIdKaryawan')) el('pfIdKaryawan').value = _idKar;
      if(el('pfNamaBank')) el('pfNamaBank').value = d.nama_bank || '';
      if(el('pfNomorRekening')) el('pfNomorRekening').value = d.nomor_rekening || '';
      if(el('pfAtasNamaRek')) el('pfAtasNamaRek').value = d.atas_nama_rek || '';
      pfExistingKtpUrl = d.ktp_url || '';
      const prev = el('pfKtpPreview');
      if(prev){
        const tayang = await urlTayang(EMBER_KTP, d.ktp_url);
        if(tayang){ prev.src = tayang; prev.classList.remove('hidden'); }
        else { prev.src = ''; prev.classList.add('hidden'); }
      }
      if(el('pfKtpName')) el('pfKtpName').textContent = '';
      applyProfilLocks(!!d.rekening_locked, !!d.ktp_url);
    }catch(e){ console.error('load profil', e); }
    modal.classList.remove('hidden');
  }

  function closeProfil(){ const m = el('profilModal'); if(m) m.classList.add('hidden'); }

  async function saveProfil(){
    if(window.__pfSaving) return; // cegah dobel-simpan (anti dobel-notif)
    if(!saya){ alert('Sesi belum siap.'); return; }
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
      let ktpUrl = pfExistingKtpUrl;
      let ktpFailed = false;
      if(ktpFile){
        try {
          // Kompres foto KTP biar di bawah 2MB (batas ember) sebelum upload.
          const __ktpToUpload = await kompresGambar(ktpFile, 2*1024*1024 - 50*1024);
          // Nama file unik + tanpa upsert: ember KTP sengaja tidak mengizinkan menimpa file.
          const path = saya.id + '/ktp_' + Date.now() + '.jpg';
          const { error } = await sb.storage.from(EMBER_KTP)
            .upload(path, __ktpToUpload, { contentType: (__ktpToUpload && __ktpToUpload.type) || 'image/jpeg', upsert: false });
          if (error) throw error;
          ktpUrl = path;
        } catch(upErr){ console.error('Upload KTP gagal', upErr); ktpFailed = true; }
      }
      // Rekening dikunci lagi tiap habis disimpan (owner buka lagi kalau perlu),
      // dan KTP cuma nempel kalau sebelumnya masih kosong — dua-duanya dijaga
      // di dalam fungsi database, bukan di sini.
      const { error } = await sb.rpc('simpan_rekening_saya', {
        p_nama_bank: namaBank,
        p_nomor_rekening: nomorRekening,
        p_atas_nama_rek: atasNamaRek,
        p_ktp_url: ktpUrl || null
      });
      if (error) throw error;
      pfExistingKtpUrl = ktpUrl || pfExistingKtpUrl;
      const prev = el('pfKtpPreview');
      if(prev && ktpUrl){
        const tayang = await urlTayang(EMBER_KTP, ktpUrl);
        if (tayang){ prev.src = tayang; prev.classList.remove('hidden'); }
      }
      applyProfilLocks(true, !!ktpUrl);
      // Refresh daftar-kurang: rekening baru tersimpan, sisa KTP kalau belum keupload.
      profilKurang = ktpUrl ? [] : ['Foto KTP'];
      alert(ktpFailed
        ? 'Rekening tersimpan, tapi foto KTP gagal terupload. Cek koneksi / coba foto lebih kecil, lalu upload KTP lagi ya.'
        : 'Data profil tersimpan. Terima kasih!');
    }catch(e){
      console.error('save profil', e);
      alert('Gagal menyimpan: ' + pesanRamah(e));
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
// Jauh lebih pendek dari versi Firebase: semua penjaga (kunci rekening, KTP
// sekali isi) sekarang ada di dalam fungsi database, jadi jalur cadangan ini
// tidak bisa lagi kelewatan aturan kayak dulu.
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
  async function doSaveFallback(){
    if (window.__pfSaving) return;
    if (!saya){ alert('Sesi belum siap, coba lagi'); return; }
    var namaBank = ((gid('pfNamaBank')||{}).value||'').trim();
    var nomorRekening = ((gid('pfNomorRekening')||{}).value||'').trim();
    var atasNamaRek = ((gid('pfAtasNamaRek')||{}).value||'').trim();
    if (!namaBank || !nomorRekening || !atasNamaRek){ alert('Lengkapi semua data rekening dulu ya'); return; }
    var ktpFile = window.__pfKtpFile || (gid('pfKtpInput') && gid('pfKtpInput').files && gid('pfKtpInput').files[0]) || null;
    var existingKtp = (saya && saya.ktp_url) || '';
    if (!ktpFile && !existingKtp){ alert('Upload foto KTP dulu ya'); return; }
    window.__pfSaving = true;
    var saveBtn = gid('pfBtnSave');
    var oldTxt = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Menyimpan...'; }
    try {
      var ktpUrl = existingKtp;
      if (ktpFile){
        var toUpload = await kompresGambar(ktpFile, 2*1024*1024 - 50*1024);
        var path = saya.id + '/ktp_' + Date.now() + '.jpg';
        var up = await sb.storage.from(EMBER_KTP).upload(path, toUpload, { contentType: (toUpload && toUpload.type) || 'image/jpeg', upsert:false });
        if (up.error) throw up.error;
        ktpUrl = path;
      }
      var res = await sb.rpc('simpan_rekening_saya', {
        p_nama_bank: namaBank, p_nomor_rekening: nomorRekening,
        p_atas_nama_rek: atasNamaRek, p_ktp_url: ktpUrl || null
      });
      if (res.error) throw res.error;
      var prev = gid('pfKtpPreview');
      if (prev && ktpUrl){ var tayang = await urlTayang(EMBER_KTP, ktpUrl); if (tayang) { prev.src = tayang; prev.classList.remove('hidden'); } }
      alert('Data profil tersimpan. Terima kasih!');
      var modal = gid('profilModal'); if (modal) modal.classList.add('hidden');
    } catch(e){ console.error('doSaveFallback', e); alert('Gagal menyimpan: ' + pesanRamah(e)); }
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
