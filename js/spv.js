// ============================================================
// PANTAU TIM (SPV)
// Halaman read-only buat supervisor: siapa lagi kerja / istirahat / sudah pulang, realtime.
//
// SENGAJA cuma baca tabel `absensi` (event absen) + view `karyawan_publik` (nama & foto).
// Tabel `karyawan` — tempat gaji, KTP, rekening — TIDAK pernah disentuh, dan aturan RLS
// di database juga menolak SPV membacanya. Jadi batasan ini nyata, bukan sekadar menu
// yang disembunyikan di tampilan.
// ============================================================
import { sb, karyawanSaya, keluar, EMBER_PROFIL, LIBUR_HARI, LIBUR_MAX } from './supabase-config.js';
import { renderLemburHariIni } from './lembur-acc.js';   // PR-CL127 / PR-CL128

const $ = id => document.getElementById(id);
const MAX_SESI_MS = 18 * 60 * 60 * 1000;        // sesi terbuka > 18 jam = lupa clock out, bukan sedang kerja
const ISTIRAHAT_WAJAR_MS = 90 * 60 * 1000;      // di atas ini kemungkinan lupa tap "Selesai Istirahat"
const BARU_PULANG_MS = 6 * 60 * 60 * 1000;      // yang pulang > 6 jam lalu ga usah ditampilkan lagi

const fotoMap = new Map();
const namaProfil = new Map();
// PR-CL124: Personal Assistant (lapor langsung ke owner) dipisah dari tim. SPV tidak melihat PA
// sama sekali; owner melihatnya di kotak sendiri tanpa timer efektif / peringatan istirahat.
const paSet = new Set();
let lihatPA = false;

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
// PR-CL124: status PA hari ini — cuma hadir/pulang + lama hadir, tanpa efektif & istirahat.
function jamWib(ms){ return new Date(ms).toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Jakarta' }); }
function statusPA(uid, nama, arr, now){
  let masuk = 0, keluar = 0;
  for (const e of arr){
    if (e.tipe === 'clock_in' || e.tipe === 'overtime_in') masuk = Math.max(masuk, e.ms);
    if (e.tipe === 'clock_out' || e.tipe === 'overtime_out') keluar = Math.max(keluar, e.ms);
  }
  const mulai = mulaiSesi(arr);
  if (masuk > keluar && mulai){
    if (now - mulai > MAX_SESI_MS) return { uid, nama, jenis: 'lupa', mulai };
    return { uid, nama, jenis: 'hadir', mulai };
  }
  const hariIni = d => new Date(d).toLocaleDateString('sv-SE', { timeZone:'Asia/Jakarta' });
  if (keluar && hariIni(keluar) === hariIni(now)){
    let m = 0;
    for (const e of arr) if ((e.tipe === 'clock_in' || e.tipe === 'overtime_in') && e.ms <= keluar && e.ms > m) m = e.ms;
    return { uid, nama, jenis: 'pulang', mulai: m, keluar };
  }
  return null;
}
function renderPA(pa){
  const kartu = $('paCard'); if (!kartu) return;
  kartu.classList.toggle('hidden', !lihatPA);
  if (!lihatPA) return;
  $('cPA').textContent = pa.length;
  $('listPA').innerHTML = pa.length ? pa.map(x => {
    let ket;
    if (x.jenis === 'hadir') ket = '<span class="p-main" style="color:var(--gg-success-t)">Hadir</span><small class="p-sep">sejak ' + jamWib(x.mulai) + '</small><span class="spv-t p-dim" data-start="' + x.mulai + '">--:--</span>';
    else if (x.jenis === 'pulang') ket = '<span class="p-main">Pulang ' + jamWib(x.keluar) + '</span><small class="p-sep">lama hadir</small><span class="p-dim">' + (x.mulai ? fmtDur(x.keluar - x.mulai) : '-') + '</span>';
    else ket = '<span class="p-main" style="color:var(--gg-warning-t)">Lupa Selesai Kerja</span><small class="p-sep">masuk</small><span class="p-dim">' + new Date(x.mulai).toLocaleString('id-ID', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Jakarta' }) + '</span>';
    return '<div class="p-row">' + avaHtml(x.uid, x.nama) + '<span class="p-name">' + esc(x.nama) + '</span><span class="p-time">' + ket + '</span></div>';
  }).join('') : '<div class="p-empty">PA belum ada yang masuk hari ini</div>';
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

  const { data: rows, error } = await sb
    .from('absensi')
    .select('karyawan_id, tipe, ts')
    .gte('ts', dari.toISOString())
    .order('ts', { ascending: true });
  if (error) throw error;

  const byUid = new Map();
  for (const r of (rows || [])){
    const uid = r.karyawan_id;
    const t = r.ts ? new Date(r.ts) : null;
    if (!uid || !t) continue;
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push({ tipe: r.tipe, ms: t.getTime() });
  }
  for (const arr of byUid.values()) arr.sort((a, b) => a.ms - b.ms);

  // Nama & foto dari view karyawan_publik — jendela terbatas yang boleh dibaca
  // semua yang login. Gaji & KTP tidak ikut keluar dari sana.
  try{
    const { data: profil } = await sb.from('karyawan_publik').select('id, nama, foto_url, is_pa');
    paSet.clear();
    (profil || []).forEach(p => { if (p.is_pa) paSet.add(p.id); });
    // Foto profil disimpan sebagai path di ember tertutup -> dibuatkan link sementara sekaligus.
    const paths = (profil || []).map(p => p.foto_url).filter(Boolean);
    const link = new Map();
    if (paths.length){
      const { data: tt } = await sb.storage.from(EMBER_PROFIL).createSignedUrls(paths, 60 * 60);
      (tt || []).forEach(t => { if (t && t.path && t.signedUrl) link.set(t.path, t.signedUrl); });
    }
    for (const p of (profil || [])){
      if (p.foto_url && link.get(p.foto_url)) fotoMap.set(p.id, link.get(p.foto_url));
      if (p.nama) namaProfil.set(p.id, p.nama);
    }
  }catch(e){ console.warn('karyawan_publik:', e); }

  const now = Date.now();
  const kerja = [], istirahat = [], pulang = [], peringatan = [], pa = [];

  for (const [uid, arr] of byUid){
    const nama = namaProfil.get(uid) || '-';
    if (paSet.has(uid)){
      if (lihatPA){ const s = statusPA(uid, nama, arr, now); if (s) pa.push(s); }
      continue;
    }
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
  renderPA(pa);

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

// ===== PR-CL132: Jadwal Libur =====
// Satu sumber: tukar aktif menang, kalau nggak ada pakai hari libur tetap (sama dengan
// absensi.libur_pada di database — yang juga dibaca briefing WMS). Semua tulis lewat RPC.
const BATAS_MUNDUR = 7, BATAS_MAJU = 60;   // sama dengan validasi atur_tukar_libur
let liburTim = [], liburTukar = [];

const tglWib = d => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
const keDate = s => new Date(s + 'T12:00:00+07:00');
const tambahHari = (s, n) => tglWib(new Date(keDate(s).getTime() + n * 86400000));
const dowDari = s => keDate(s).getUTCDay();
const fmtTgl = s => keDate(s).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Jakarta' });

function liburPada(k, s){
  for (const t of liburTukar){
    if (t.karyawan_id !== k.karyawan_id) continue;
    if (t.tanggal_libur === s) return true;
    if (t.tanggal_asal === s) return false;
  }
  return k.libur_hari != null && Number(k.libur_hari) === dowDari(s);
}
function tukarKe(k, s){ return liburTukar.some(t => t.karyawan_id === k.karyawan_id && t.tanggal_libur === s); }

async function muatLibur(){
  const hariIni = tglWib(new Date());
  const [a, b] = await Promise.all([
    sb.rpc('libur_tim'),
    sb.rpc('libur_tukar_daftar', { p_dari: tambahHari(hariIni, -BATAS_MUNDUR), p_sampai: tambahHari(hariIni, BATAS_MAJU) })
  ]);
  if (a.error) throw a.error;
  if (b.error) throw b.error;
  liburTim = a.data || [];
  liburTukar = b.data || [];
  renderLibur();
}

function renderLibur(){
  const hariIni = tglWib(new Date());
  let html = '';
  for (let i = 0; i < 7; i++){
    const s = tambahHari(hariIni, i);
    const libur = liburTim.filter(k => liburPada(k, s));
    const penuh = libur.length >= LIBUR_MAX;
    html += '<div class="libur-day' + (i === 0 ? ' today' : '') + (penuh ? ' penuh' : '') + '">'
      + '<div class="libur-tgl"><b>' + (i === 0 ? 'Hari ini' : esc(fmtTgl(s))) + '</b><span>' + libur.length + '/' + LIBUR_MAX + '</span></div>'
      + '<div class="libur-nama">' + (libur.length
          ? libur.map(k => tukarKe(k, s) ? '<span class="tukar" title="Hasil tukar libur">&#x1F504; ' + esc(k.nama) + '</span>' : esc(k.nama)).join(', ')
          : '<span class="muted">&mdash;</span>') + '</div></div>';
  }
  $('liburWeek').innerHTML = html;

  const nanti = liburTukar.filter(t => t.tanggal_asal >= hariIni || t.tanggal_libur >= hariIni);
  $('liburTukarList').innerHTML = nanti.length
    ? '<div class="pres-sub muted small">Tukar libur yang akan datang</div>' + nanti.map(t =>
        '<div class="p-row"><span class="p-name">' + esc(t.nama) + '</span>'
        + '<span class="p-time"><span class="p-dim">' + esc(fmtTgl(t.tanggal_asal)) + '</span><small class="p-sep">&rarr;</small>'
        + '<span class="p-main" style="color:var(--gg-info-t)">' + esc(fmtTgl(t.tanggal_libur)) + '</span>'
        + '<button class="btn-link libur-batal" data-id="' + esc(t.id) + '" title="' + esc((t.catatan ? t.catatan + ' · ' : '') + 'oleh ' + (t.dibuat_oleh_nama || 'owner')) + '">Batal</button></span></div>'
      ).join('')
    : '';
  document.querySelectorAll('.libur-batal').forEach(b => {
    b.onclick = async () => {
      const t = liburTukar.find(x => x.id === b.dataset.id); if (!t) return;
      if (!confirm('Batalkan tukar libur ' + t.nama + '? Jadwal balik: libur ' + fmtTgl(t.tanggal_asal) + ', masuk ' + fmtTgl(t.tanggal_libur) + '.')) return;
      const { error } = await sb.rpc('batal_tukar_libur', { p_id: t.id });
      if (error){ alert('Gagal: ' + (error.message || error)); return; }
      muatLibur().catch(e => console.warn('libur:', e));
    };
  });
}

function bukaModal(id){ $(id).classList.remove('hidden'); }
function tutupModal(id){ $(id).classList.add('hidden'); }
document.querySelectorAll('[data-tutup]').forEach(b => { b.onclick = () => tutupModal(b.dataset.tutup); });
function tampilErr(id, pesan){ const el = $(id); el.textContent = pesan || ''; el.classList.toggle('hidden', !pesan); }
function opsiKaryawan(sel){
  sel.innerHTML = '<option value="">&mdash; pilih &mdash;</option>' + liburTim.map(k =>
    '<option value="' + esc(k.karyawan_id) + '">' + esc(k.nama) + (k.libur_hari != null ? ' (libur ' + LIBUR_HARI[k.libur_hari] + ')' : ' (belum ada libur tetap)') + '</option>').join('');
}

// --- Tukar libur
function isiTanggalAsal(){
  const k = liburTim.find(x => x.karyawan_id === $('tkKaryawan').value);
  const sel = $('tkAsal'), hariIni = tglWib(new Date());
  if (!k){ sel.innerHTML = ''; return; }
  const opsi = [];
  for (let i = -BATAS_MUNDUR; i <= BATAS_MAJU && opsi.length < 10; i++){
    const s = tambahHari(hariIni, i);
    if (liburPada(k, s)) opsi.push(s);
  }
  sel.innerHTML = opsi.length
    ? opsi.map(s => '<option value="' + s + '"' + (s === opsi.find(x => x >= hariIni) ? ' selected' : '') + '>' + esc(fmtTgl(s)) + (s < hariIni ? ' (sudah lewat)' : '') + '</option>').join('')
    : '<option value="">Belum ada jadwal libur</option>';
  infoTanggalLibur();
}
function infoTanggalLibur(){
  const s = $('tkLibur').value, k = liburTim.find(x => x.karyawan_id === $('tkKaryawan').value);
  if (!s || !k){ $('tkInfo').textContent = ''; return; }
  const lain = liburTim.filter(x => x.karyawan_id !== k.karyawan_id && liburPada(x, s)).map(x => x.nama);
  $('tkInfo').textContent = liburPada(k, s) ? k.nama + ' memang sudah libur di tanggal itu.'
    : (lain.length ? 'Yang libur ' + fmtTgl(s) + ': ' + lain.join(', ') + (lain.length >= LIBUR_MAX ? ' — sudah ' + lain.length + ' orang!' : '') : 'Belum ada yang libur ' + fmtTgl(s) + '.');
}
$('btnTukarLibur').onclick = () => {
  const hariIni = tglWib(new Date());
  opsiKaryawan($('tkKaryawan'));
  $('tkAsal').innerHTML = ''; $('tkLibur').value = ''; $('tkCatatan').value = ''; $('tkInfo').textContent = '';
  $('tkLibur').min = tambahHari(hariIni, -BATAS_MUNDUR); $('tkLibur').max = tambahHari(hariIni, BATAS_MAJU);
  tampilErr('tkErr', '');
  bukaModal('tukarModal');
};
$('tkKaryawan').onchange = isiTanggalAsal;
$('tkLibur').onchange = infoTanggalLibur;
$('btnTkSimpan').onclick = async () => {
  const p_karyawan = $('tkKaryawan').value, p_tanggal_asal = $('tkAsal').value, p_tanggal_libur = $('tkLibur').value;
  if (!p_karyawan || !p_tanggal_asal || !p_tanggal_libur){ tampilErr('tkErr', 'Pilih karyawan, tanggal libur, dan tanggal penggantinya dulu.'); return; }
  const btn = $('btnTkSimpan'); btn.disabled = true;
  const { error } = await sb.rpc('atur_tukar_libur', { p_karyawan, p_tanggal_asal, p_tanggal_libur, p_catatan: $('tkCatatan').value || null });
  btn.disabled = false;
  if (error){ tampilErr('tkErr', error.message || String(error)); return; }
  tutupModal('tukarModal');
  muatLibur().catch(e => console.warn('libur:', e));
};

// --- Ganti libur tetap
function isiHariTetap(){
  const k = liburTim.find(x => x.karyawan_id === $('ttKaryawan').value);
  const sel = $('ttHari');
  if (!k){ sel.innerHTML = ''; $('ttInfo').textContent = ''; return; }
  sel.innerHTML = LIBUR_HARI.map((h, i) => {
    const n = liburTim.filter(x => x.karyawan_id !== k.karyawan_id && Number(x.libur_hari) === i && x.libur_hari != null).length;
    return '<option value="' + i + '"' + (Number(k.libur_hari) === i && k.libur_hari != null ? ' selected' : '') + '>' + h + ' (' + n + ' orang lain)' + (n >= LIBUR_MAX ? ' — penuh' : '') + '</option>';
  }).join('');
  $('ttInfo').textContent = 'Sekarang: ' + (k.libur_hari != null ? LIBUR_HARI[k.libur_hari] : 'belum ada libur tetap');
}
$('btnLiburTetap').onclick = () => {
  opsiKaryawan($('ttKaryawan'));
  $('ttHari').innerHTML = ''; $('ttInfo').textContent = '';
  tampilErr('ttErr', '');
  bukaModal('tetapModal');
};
$('ttKaryawan').onchange = isiHariTetap;
$('btnTtSimpan').onclick = async () => {
  const p_karyawan = $('ttKaryawan').value, v = $('ttHari').value;
  if (!p_karyawan || v === ''){ tampilErr('ttErr', 'Pilih karyawan dan harinya dulu.'); return; }
  const btn = $('btnTtSimpan'); btn.disabled = true;
  const { data, error } = await sb.rpc('ubah_libur_tetap', { p_karyawan, p_hari: Number(v) });
  btn.disabled = false;
  if (error){ tampilErr('ttErr', error.message || String(error)); return; }
  tutupModal('tetapModal');
  if (data && data.tukar_dibatalkan > 0) alert(data.tukar_dibatalkan + ' tukar libur yang belum lewat ikut dibatalkan karena jadwal tetapnya ganti.');
  muatLibur().catch(e => console.warn('libur:', e));
};

// Penjaga halaman: cuma owner & supervisor yang boleh masuk. Perannya dibaca dari
// kolom `peran` di database, bukan dari daftar email di dalam kode seperti versi
// lama — jadi owner bisa mengangkat/mencopot SPV tanpa perlu ganti kode.
let __sudahMulai = false;
sb.auth.onAuthStateChange(async (event, session) => {
  if (!session){ location.replace('index.html'); return; }
  if (__sudahMulai) return;   // token refresh juga memicu event ini; cukup mulai sekali
  __sudahMulai = true;

  let saya = null;
  try { saya = await karyawanSaya({ paksaSegar: true }); }
  catch (e) { console.error(e); }

  const boleh = saya && (saya.peran === 'owner' || saya.peran === 'spv') && !saya.nonaktif;
  if (!boleh){ alert('Halaman ini khusus supervisor.'); location.replace('karyawan.html'); return; }

  lihatPA = saya.peran === 'owner';
  $('spvNama').textContent = saya.nama || session.user.email || '';
  $('spvDate').textContent = new Date().toLocaleDateString('id-ID', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });

  try{ await muat(); }catch(e){ console.error(e); alert('Gagal memuat data: ' + (e.message || e)); }
  muatLibur().catch(e => { console.warn('libur:', e); $('liburWeek').innerHTML = '<div class="p-empty">Gagal memuat jadwal libur</div>'; })   // PR-CL132
    // PR-CL133: datang dari tombol "Atur Libur" owner -> langsung gulung ke kartu libur setelah isinya kebuka.
    .then(() => { if (location.hash === '#liburBox' && $('liburBox')) $('liburBox').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  // PR-CL127: antrian ACC lembur — selalu tampil (juga saat kosong) supaya tidak ada yang kelupaan.
  const lemburBox = $('lemburAccBox');
  renderLemburHariIni(lemburBox);
  setInterval(() => {
    muat().catch(e => console.warn('refresh:', e));
    renderLemburHariIni(lemburBox);
    if ($('tukarModal').classList.contains('hidden') && $('tetapModal').classList.contains('hidden')) muatLibur().catch(e => console.warn('libur:', e));
  }, 60000);
});

$('btnLogout').onclick = () => keluar();
$('spvTitle').onclick = () => location.reload();
