// ============================================================================
// PR-CL127: lembur wajib ACC Lead / SPV / owner.
// PR-CL128: diganti alur izin dulu (minta / disuruh) -> Mulai Lembur -> Selesai Lembur. Fungsi
// PR-CL127 di bawah tetap dipakai buat sisa sesi aturan lama (29 Sep) & kartu Mila.
//
// Dipakai tiga halaman:
//   * karyawan.html — kartu "Lembur Kamu" (status nunggu / di-ACC / ditolak) + antrian ACC
//                     kalau orangnya Lead (lembur_akses.bisa_acc) atau SPV.
//   * spv.html      — antrian ACC buat SPV & owner.
//   * owner.html    — antrian ACC di Beranda.
//
// Semua keputusan (siapa boleh ACC, batas H+1, larangan ACC punya sendiri) dijaga di
// database lewat RPC lembur_acc_putus(); tampilan di sini cuma cerminannya.
// ============================================================================
import { sb } from './supabase-config.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const jam = iso => new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }).replace('.', ':');
const tgl = d => new Date(String(d).slice(0, 10) + 'T12:00:00+07:00').toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Jakarta' });
function durasi(menit){
  const m = Math.max(0, Math.round(Number(menit) || 0));
  if (!m) return '';
  const h = Math.floor(m / 60), s = m % 60;
  return h ? (h + ' jam' + (s ? ' ' + s + ' mnt' : '')) : (s + ' mnt');
}
function batasLabel(iso){
  // batas_acc = 00:00 WIB hari berikutnya -> tampilkan sebagai "s/d <hari> 23:59"
  const d = new Date(new Date(iso).getTime() - 60000);
  return d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Jakarta' }) + ' 23:59';
}
function pesanError(e){ return (e && (e.message || e.details)) || String(e); }
// Baca pakai GET + batas waktu: di PC owner, POST rpc pernah macet tanpa kabar (lihat PR WMS
// "anti-beku"). Fungsi bacanya STABLE, jadi aman lewat GET.
function baca(fn, args){
  let q = sb.rpc(fn, args || {}, { get: true });
  try{ if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) q = q.abortSignal(AbortSignal.timeout(15000)); }catch(_){}
  return q;
}

export async function infoLemburSaya(){
  const { data, error } = await baca('lembur_info_saya');
  if (error) throw error;
  return data || {};
}

// ------------------------------------------------------------- kartu karyawan
export const LABEL_STATUS = {
  menunggu:    { ikon: '⏳', teks: 'Lembur nunggu ACC', warna: 'var(--gg-warning-t)' },
  disetujui:   { ikon: '✅', teks: 'Lembur di-ACC',     warna: 'var(--gg-success-t)' },
  ditolak:     { ikon: '❌', teks: 'Lembur ditolak — dibayar jam normal', warna: 'var(--gg-danger-t)' },
  kedaluwarsa: { ikon: '⌛', teks: 'Lembur tidak di-ACC sampai batas — dibayar jam normal', warna: 'var(--gg-danger-t)' },
  bebas:       { ikon: '✅', teks: 'Lembur tercatat (bebas ACC)', warna: 'var(--gg-success-t)' }
};

export async function renderLemburSaya(box, opsi = {}){
  if (!box) return;
  let rows = [];
  try{
    const { data, error } = await baca('lembur_acc_saya', { p_hari: 4 });
    if (error) throw error;
    rows = data || [];
  }catch(e){ console.warn('lembur saya:', e); box.classList.add('hidden'); return; }
  if (!rows.length){ box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.innerHTML = '<div class="lembur-head">\u{1F319} Lembur Kamu</div>' + rows.map(r => {
    const st = LABEL_STATUS[r.status_efektif] || LABEL_STATUS.menunggu;
    let ket = '';
    if (r.status_efektif === 'disetujui') ket = 'oleh <b>' + esc(r.penyetuju || '-') + '</b>';
    else if (r.status_efektif === 'ditolak') ket = 'oleh <b>' + esc(r.penyetuju || '-') + '</b>';
    else if (r.status_efektif === 'menunggu') ket = 'Lead / SPV bisa ACC s/d ' + esc(batasLabel(r.batas_acc)) + '. Kalau gak di-ACC, dibayar jam normal.';
    const dur = durasi(r.menit_perkiraan);
    const alasanBtn = (r.status_efektif === 'menunggu' && !r.alasan)
      ? ' <button class="btn btn-sm btn-ghost lembur-alasan-btn" data-id="' + esc(r.id) + '">Isi alasan</button>' : '';
    return '<div class="lembur-row">'
      + '<div class="lembur-st" style="color:' + st.warna + '">' + st.ikon + ' ' + esc(st.teks) + '</div>'
      + '<div class="lembur-sub">' + esc(tgl(r.tanggal)) + ' &middot; selesai ' + esc(jam(r.ts_selesai)) + (dur ? ' &middot; ±' + esc(dur) : '')
      + (ket ? '<br>' + ket : '')
      + (r.alasan ? '<br><i>&ldquo;' + esc(r.alasan) + '&rdquo;</i>' : (r.status_efektif === 'menunggu' ? '<br><span style="color:var(--gg-warning-t)">Alasan belum diisi</span>' : ''))
      + (r.catatan_putus ? '<br>Catatan: ' + esc(r.catatan_putus) : '')
      + alasanBtn + '</div></div>';
  }).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('.lembur-alasan-btn').forEach(b => {
    b.onclick = async () => {
      const a = opsi.mintaAlasan ? await opsi.mintaAlasan() : prompt('Alasan lembur (wajib):', '');
      if (!a) return;
      try{
        const { error } = await sb.rpc('lembur_isi_alasan', { p_id: b.dataset.id, p_alasan: a });
        if (error) throw error;
      }catch(e){ alert('Gagal menyimpan alasan: ' + pesanError(e)); }
      renderLemburSaya(box, opsi);
    };
  });
}

// ------------------------------------------------------------- antrian penyetuju
export async function renderAntrianLembur(box, opsi = {}){
  if (!box) return;
  let rows = [];
  try{
    const { data, error } = await baca('lembur_acc_antrian');
    if (error) throw error;
    rows = data || [];
  }catch(e){ console.warn('antrian lembur:', e); box.classList.add('hidden'); return; }
  const nunggu = rows.filter(r => r.status === 'menunggu');
  if (!rows.length){
    if (opsi.tampilKosong){
      box.innerHTML = '<div class="lembur-head">\u{1F319} ACC Lembur</div><div class="lembur-sub">Tidak ada lembur yang nunggu ACC.</div>';
      box.classList.remove('hidden');
    } else { box.classList.add('hidden'); box.innerHTML = ''; }
    return;
  }
  box.innerHTML = '<div class="lembur-head">\u{1F319} ACC Lembur: <b>' + nunggu.length + '</b> nunggu keputusan</div>'
    + '<div class="lembur-sub" style="margin-bottom:6px">Yang gak di-ACC sampai akhir hari besoknya otomatis <b>tidak dibayar lemburnya</b> (jam normal tetap dibayar).</div>'
    + rows.map(r => {
      const dur = durasi(r.menit_perkiraan);
      const status = r.status === 'menunggu'
        ? '<span style="color:var(--gg-warning-t)">⏳ nunggu &middot; batas ' + esc(batasLabel(r.batas_acc)) + '</span>'
        : (r.status === 'disetujui'
          ? '<span style="color:var(--gg-success-t)">✅ di-ACC ' + esc(r.penyetuju || '') + '</span>'
          : '<span style="color:var(--gg-danger-t)">❌ ditolak ' + esc(r.penyetuju || '') + '</span>');
      return '<div class="lembur-row lembur-antri">'
        + '<div class="lembur-info"><b>' + esc(r.nama) + '</b> &middot; ' + esc(tgl(r.tanggal))
        + ' &middot; ' + (r.ts_mulai ? esc(jam(r.ts_mulai)) + '–' : 'selesai ') + esc(jam(r.ts_selesai))
        + (dur ? ' <b>(±' + esc(dur) + ')</b>' : '')
        + '<br>' + (r.alasan ? '<i>&ldquo;' + esc(r.alasan) + '&rdquo;</i>' : '<span class="muted">(alasan belum diisi)</span>')
        + '<br>' + status + '</div>'
        + '<div class="lembur-aksi">'
        + (r.status !== 'disetujui' ? '<button class="btn btn-sm btn-success lembur-ok" data-id="' + esc(r.id) + '" data-nama="' + esc(r.nama) + '">ACC</button>' : '')
        + (r.status !== 'ditolak' ? '<button class="btn btn-sm btn-ghost lembur-no" data-id="' + esc(r.id) + '" data-nama="' + esc(r.nama) + '">Tolak</button>' : '')
        + '</div></div>';
    }).join('');
  box.classList.remove('hidden');
  const putus = async (b, setuju) => {
    let catatan = null;
    if (setuju){
      if (!confirm('ACC lembur ' + b.dataset.nama + '? Lemburnya akan dibayar.')) return;
    } else {
      catatan = prompt('Tolak lembur ' + b.dataset.nama + ' (dibayar jam normal saja).\nCatatan buat dia (opsional):', '');
      if (catatan === null) return;
    }
    b.disabled = true;
    try{
      const { error } = await sb.rpc('lembur_acc_putus', { p_id: b.dataset.id, p_setuju: setuju, p_catatan: catatan });
      if (error) throw error;
    }catch(e){ alert('Gagal: ' + pesanError(e)); }
    await renderAntrianLembur(box, opsi);
    if (opsi.sesudahPutus) try{ opsi.sesudahPutus(); }catch(_){}
  };
  box.querySelectorAll('.lembur-ok').forEach(b => { b.onclick = () => putus(b, true); });
  box.querySelectorAll('.lembur-no').forEach(b => { b.onclick = () => putus(b, false); });
}

// ============================================================================
// PR-CL128: izin dulu -> Mulai Lembur -> Selesai Lembur.
// Lembur harus DISURUH Lead / SPV / owner, atau karyawan MINTA izin lalu di-ACC. Database
// (trigger lembur_izin_jaga) menolak Mulai Lembur tanpa izin atau sebelum jam normal kelar.
// ============================================================================
export const RATE_LEMBUR_BARU = 18750;   // Rp 12.500 x 1,5 (keputusan owner 29 Sep 2026)
export const rupiah = n => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
export { durasi as durasiMenit, jam as jamWib };

export async function lemburIzinSaya(){
  const { data, error } = await baca('lembur_izin_saya');
  if (error) throw error;
  return data || {};
}
export async function mintaLembur(alasan){
  const { data, error } = await sb.rpc('lembur_minta', { p_alasan: alasan });
  if (error) throw error;
  return data;
}

// Menit lembur bersih satu riwayat (jendela Mulai..Selesai dikurangi istirahat/pause di dalamnya).
function menitBersih(r){
  if (!r || !r.mulai_at) return 0;
  const akhir = r.selesai_at ? new Date(r.selesai_at).getTime() : Date.now();
  return Math.max(0, (akhir - new Date(r.mulai_at).getTime()) / 60000 - (Number(r.jeda_menit) || 0));
}

// Kartu "Lembur Kamu" versi izin: status izin shift ini + hasil lembur 4 hari terakhir.
export function renderLemburKamu(box, st){
  if (!box) return;
  const baris = [];
  const iz = st && st.izin;
  if (iz && iz.status === 'menunggu'){
    baris.push('<div class="lembur-row"><div class="lembur-st" style="color:var(--gg-warning-t)">⏳ Minta lembur, nunggu ACC</div>'
      + '<div class="lembur-sub">dikirim ' + esc(jam(iz.created_at)) + (iz.alasan ? ' &middot; <i>&ldquo;' + esc(iz.alasan) + '&rdquo;</i>' : '') + '</div></div>');
  } else if (iz && iz.status === 'ditolak'){
    baris.push('<div class="lembur-row"><div class="lembur-st" style="color:var(--gg-danger-t)">❌ Lembur ditolak — dibayar jam normal</div>'
      + '<div class="lembur-sub">oleh <b>' + esc(iz.penyetuju || '-') + '</b>' + (iz.catatan_putus ? ' &middot; &ldquo;' + esc(iz.catatan_putus) + '&rdquo;' : '') + '</div></div>');
  } else if (iz && iz.status === 'dibatalkan'){
    baris.push('<div class="lembur-row"><div class="lembur-st" style="color:var(--gg-danger-t)">Izin lembur dibatalin</div>'
      + '<div class="lembur-sub">oleh <b>' + esc(iz.penyetuju || '-') + '</b>' + (iz.catatan_putus ? ' &middot; &ldquo;' + esc(iz.catatan_putus) + '&rdquo;' : '') + '</div></div>');
  } else if (iz && iz.status === 'disetujui' && !iz.mulai_at){
    baris.push('<div class="lembur-row"><div class="lembur-st" style="color:var(--gg-success-t)">'
      + (iz.jenis === 'suruh' ? '\u{1F4E3} Kamu disuruh lembur' : '✅ Izin lembur di-ACC') + '</div>'
      + '<div class="lembur-sub">oleh <b>' + esc(iz.jenis === 'suruh' ? (iz.dibuat_oleh || iz.penyetuju || '-') : (iz.penyetuju || '-')) + '</b>'
      + ' &middot; tap <b>Mulai Lembur</b> setelah jam normal kelar. Dibayar 1,5× (' + rupiah(RATE_LEMBUR_BARU) + '/jam).'
      + (iz.catatan_putus ? '<br>Catatan: ' + esc(iz.catatan_putus) : (iz.jenis === 'suruh' && iz.alasan ? '<br>Catatan: ' + esc(iz.alasan) : '')) + '</div></div>');
  }
  for (const r of ((st && st.riwayat) || [])){
    const m = menitBersih(r);
    const oleh = r.jenis === 'suruh' ? ('\u{1F4E3} disuruh <b>' + esc(r.penyetuju || '-') + '</b>') : ('di-ACC <b>' + esc(r.penyetuju || '-') + '</b>');
    if (!r.selesai_at){
      baris.push('<div class="lembur-row"><div class="lembur-st" style="color:var(--gg-primary)">\u{1F319} Lembur berjalan sejak ' + esc(jam(r.mulai_at)) + '</div>'
        + '<div class="lembur-sub">' + oleh + (r.alasan ? ' &middot; <i>&ldquo;' + esc(r.alasan) + '&rdquo;</i>' : '') + '</div></div>');
    } else {
      baris.push('<div class="lembur-row"><div class="lembur-st" style="color:var(--gg-success-t)">✅ Lembur ' + esc(durasi(m) || '0 mnt')
        + ' (' + esc(jam(r.mulai_at)) + '–' + esc(jam(r.selesai_at)) + ') &middot; ' + rupiah(m / 60 * RATE_LEMBUR_BARU) + '</div>'
        + '<div class="lembur-sub">' + esc(tgl(r.tanggal)) + ' &middot; ' + oleh + (r.alasan ? ' &middot; <i>&ldquo;' + esc(r.alasan) + '&rdquo;</i>' : '') + '</div></div>');
    }
  }
  if (!baris.length){ box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.innerHTML = '<div class="lembur-head">\u{1F319} Lembur Kamu</div>' + baris.join('');
  box.classList.remove('hidden');
}

// ------------------------------------------------------------- Lembur Hari Ini (Lead / SPV / owner)
let __modalSuruh = null;
function modalSuruh(){
  if (__modalSuruh) return __modalSuruh;
  const m = document.createElement('div');
  m.className = 'modal hidden';
  m.id = 'lemburSuruhModal';
  m.innerHTML = '<div class="modal-box">'
    + '<h3>\u{1F4E3} Suruh Lembur</h3>'
    + '<p class="muted small">Pilih siapa yang lembur hari ini. Mereka langsung bisa tap Mulai Lembur setelah jam kerja normalnya kelar.</p>'
    + '<div class="lembur-pick-list"></div>'
    + '<textarea rows="2" maxlength="200" class="lembur-suruh-cat" style="margin-top:10px" placeholder="Catatan (opsional)"></textarea>'
    + '<div class="row"><button class="btn btn-ghost lembur-suruh-batal">Batal</button><button class="btn btn-primary lembur-suruh-ok">Suruh Lembur</button></div>'
    + '</div>';
  document.body.appendChild(m);
  __modalSuruh = m;
  return m;
}
async function bukaSuruh(sesudah, div){   // PR-CL129: div = { owner, peta: Map(id -> divisi) }
  const m = modalSuruh();
  const list = m.querySelector('.lembur-pick-list');
  const ok = m.querySelector('.lembur-suruh-ok');
  const cat = m.querySelector('.lembur-suruh-cat');
  cat.value = '';
  list.innerHTML = '<div class="lembur-sub">Memuat yang lagi masuk...</div>';
  m.classList.remove('hidden');
  const hitung = () => {
    const n = list.querySelectorAll('input:checked').length;
    ok.textContent = 'Suruh Lembur' + (n ? ' (' + n + ')' : '');
    ok.disabled = !n;
  };
  try{
    const { data, error } = await baca('lembur_kandidat_suruh');
    if (error) throw error;
    const rows = data || [];
    const ket = { menunggu: 'minta, nunggu ACC', disetujui: 'udah ada izin', lembur: 'lagi lembur', ditolak: 'tadi ditolak', dibatalkan: 'izin dibatalin' };
    // PR-CL129: server cuma kirim divisi yang boleh kamu suruh; owner dikelompokin per divisi.
    const divOf = r => (div && div.peta && div.peta.get(r.karyawan_id)) || 'Divisi belum diisi';
    if (div && div.owner) rows.sort((a, b) => divOf(a).localeCompare(divOf(b)) || String(a.ci_ts).localeCompare(String(b.ci_ts)));
    let grp = null;
    list.innerHTML = rows.length ? rows.map(r => {
      const sudah = r.status_izin === 'disetujui' || r.status_izin === 'lembur';
      let head = '';
      if (div && div.owner && divOf(r) !== grp){ grp = divOf(r); head = '<div class="lembur-grup">' + esc(grp) + '</div>'; }
      return head + '<label class="lembur-pick' + (sudah ? ' off' : '') + '"><input type="checkbox" value="' + esc(r.karyawan_id) + '"' + (sudah ? ' disabled' : '') + '> '
        + esc(r.nama) + ' <small>masuk ' + esc(jam(r.ci_ts)) + (r.status_izin ? ' &middot; ' + esc(ket[r.status_izin] || r.status_izin) : '') + '</small></label>';
    }).join('') : '<div class="lembur-sub">Belum ada karyawan ' + (div && !div.owner && div.divisi ? 'divisi ' + esc(div.divisi) + ' ' : '') + 'yang lagi masuk.</div>';
  }catch(e){ list.innerHTML = '<div class="lembur-sub" style="color:var(--gg-danger-t)">Gagal memuat: ' + esc(pesanError(e)) + '</div>'; }
  list.onchange = hitung;
  hitung();
  m.querySelector('.lembur-suruh-batal').onclick = () => m.classList.add('hidden');
  ok.onclick = async () => {
    const ids = Array.from(list.querySelectorAll('input:checked')).map(x => x.value);
    if (!ids.length) return;
    ok.disabled = true;
    try{
      const { data, error } = await sb.rpc('lembur_suruh', { p_karyawan: ids, p_catatan: cat.value.trim() || null });
      if (error) throw error;
      const gagal = (data || []).filter(x => x.hasil !== 'disuruh');
      m.classList.add('hidden');
      if (gagal.length) alert('Sebagian dilewati:\n' + gagal.map(x => '- ' + (x.nama || '?') + ': ' + x.hasil).join('\n'));
    }catch(e){ alert('Gagal: ' + pesanError(e)); ok.disabled = false; return; }
    if (sesudah) sesudah();
  };
}

export async function renderLemburHariIni(box, opsi = {}){
  if (!box) return;
  let rows = [], lama = [], dinfo = {};
  try{
    const [a, b, c] = await Promise.all([baca('lembur_hari_ini'), baca('lembur_acc_antrian'), baca('lembur_divisi_info')]);
    if (a.error) throw a.error;
    rows = a.data || [];
    lama = (b && !b.error && b.data) || [];
    dinfo = (c && !c.error && c.data) || {};
  }catch(e){ console.warn('lembur hari ini:', e); box.classList.add('hidden'); return; }
  // PR-CL129: ACC per divisi. Server sudah menyaring; di sini cuma label & pengelompokan.
  const div = { owner: !!dinfo.owner, divisi: dinfo.divisi || null, peta: new Map((dinfo.tim || []).map(t => [t.id, t.divisi || 'Divisi belum diisi'])) };
  const divOf = r => div.peta.get(r.karyawan_id) || 'Divisi belum diisi';
  if (div.owner) rows.sort((a, b) => divOf(a).localeCompare(divOf(b)));
  const muatUlang = async () => { await renderLemburHariIni(box, opsi); if (opsi.sesudahPutus) try{ opsi.sesudahPutus(); }catch(_){} };
  const nunggu = rows.filter(r => r.status === 'menunggu' && r.sesi_terbuka);
  const now = Date.now();
  let __grp = null;
  const html = rows.map(r => {
    let __head = '';
    if (div.owner && divOf(r) !== __grp){ __grp = divOf(r); __head = '<div class="lembur-grup">' + esc(__grp) + '</div>'; }
    const oleh = r.jenis === 'suruh' ? ('\u{1F4E3} disuruh ' + esc(r.dibuat_oleh || r.penyetuju || '-')) : null;
    let info = '<b>' + esc(r.nama) + '</b> &middot; ', aksi = '';
    if (r.status === 'menunggu'){
      info += 'minta ' + esc(jam(r.created_at)) + (r.alasan ? '<br><i>&ldquo;' + esc(r.alasan) + '&rdquo;</i>' : '')
        + '<br>' + (r.sesi_terbuka ? '<span style="color:var(--gg-warning-t)">⏳ nunggu keputusan</span>' : '<span class="muted">sudah pulang</span>');
      if (r.sesi_terbuka) aksi = '<button class="btn btn-sm btn-success lh-ok" data-id="' + esc(r.id) + '" data-nama="' + esc(r.nama) + '">ACC</button>'
        + '<button class="btn btn-sm btn-ghost lh-no" data-id="' + esc(r.id) + '" data-nama="' + esc(r.nama) + '">Tolak</button>';
    } else if (r.status === 'disetujui' && r.mulai_at && !r.selesai_at){
      const menit = Math.max(0, (now - new Date(r.mulai_at).getTime()) / 60000 - (Number(r.jeda_menit) || 0));
      info += (oleh || ('✅ di-ACC ' + esc(r.penyetuju || '-'))) + '<br><span class="lembur-live">\u{1F534} lagi lembur sejak ' + esc(jam(r.mulai_at)) + ' (' + esc(durasi(menit) || '0 mnt') + ')</span>';
    } else if (r.status === 'disetujui' && r.selesai_at){
      const menit = Math.max(0, (new Date(r.selesai_at) - new Date(r.mulai_at)) / 60000 - (Number(r.jeda_menit) || 0));
      info += (oleh || ('✅ di-ACC ' + esc(r.penyetuju || '-'))) + '<br><span style="color:var(--gg-success-t)">selesai lembur ' + esc(jam(r.mulai_at)) + '–' + esc(jam(r.selesai_at)) + ' (' + esc(durasi(menit) || '0 mnt') + ')</span>';
    } else if (r.status === 'disetujui'){
      info += (oleh || ('✅ di-ACC ' + esc(r.penyetuju || '-') + ' ' + esc(jam(r.diputus_at))))
        + '<br><span class="muted">' + (r.sesi_terbuka ? 'belum mulai lembur' : 'pulang tanpa lembur') + '</span>';
      if (r.sesi_terbuka) aksi = '<button class="btn btn-sm btn-ghost lh-batal" data-id="' + esc(r.id) + '" data-nama="' + esc(r.nama) + '">Batalin izin</button>';
    } else if (r.status === 'ditolak'){
      info += '<span style="color:var(--gg-danger-t)">❌ ditolak ' + esc(r.penyetuju || '') + '</span>' + (r.catatan_putus ? ' &middot; &ldquo;' + esc(r.catatan_putus) + '&rdquo;' : '');
    } else {
      info += '<span class="muted">izin dibatalin ' + esc(r.penyetuju || '') + '</span>';
    }
    return __head + '<div class="lembur-row lembur-antri"><div class="lembur-info">' + info + '</div>' + (aksi ? '<div class="lembur-aksi">' + aksi + '</div>' : '') + '</div>';
  }).join('');
  const kosong = dinfo.kosong || [];
  const catatanDiv = div.owner
    ? (kosong.length ? '<div class="lembur-warn">⚠ Divisi belum diisi di WMS: <b>' + kosong.map(esc).join(', ') + '</b>. Lembur mereka cuma bisa di-ACC owner.</div>' : '')
    : (div.divisi ? '' : '<div class="lembur-warn">⚠ Divisi kamu belum diisi di WMS, jadi kamu belum bisa ACC / nyuruh siapa-siapa. Minta owner isi dulu.</div>');
  box.innerHTML = '<div class="lembur-head">\u{1F319} Lembur Hari Ini</div>'
    + '<div class="lembur-sub" style="margin-bottom:8px">' + (div.owner ? 'Semua divisi' : ('Divisi <b>' + esc(div.divisi || '-') + '</b>')) + ' &middot; permintaan yang nunggu: <b>' + nunggu.length + '</b>. Tanpa izin, gak ada yang bisa mulai lembur.</div>'
    + catatanDiv
    + '<button class="btn btn-sm btn-primary lh-suruh" style="margin:0 0 6px;width:auto;display:inline-block">\u{1F4E3} Suruh Lembur</button>'
    + (html || '<div class="lembur-sub">Belum ada yang minta / disuruh lembur hari ini.</div>')
    + (lama.length ? '<div class="lembur-sub" style="margin-top:12px"><b>Aturan lama (ACC setelah lembur)</b> &mdash; sisa sesi sebelum alur izin, batas s/d akhir hari besoknya:</div><div class="lh-lama"></div>' : '');
  box.classList.remove('hidden');
  if (lama.length){
    const sub = box.querySelector('.lh-lama');
    sub.className = 'lh-lama';
    await renderAntrianLembur(sub, { sesudahPutus: muatUlang });
    // renderAntrianLembur menulis judulnya sendiri; buang judul & keterangan ganda.
    const h = sub.querySelector('.lembur-head'); if (h) h.remove();
    const s = sub.querySelector('.lembur-sub'); if (s) s.remove();
  }
  box.querySelector('.lh-suruh').onclick = () => bukaSuruh(muatUlang, div);
  const aksi = async (b, fn, args, konfirmasi) => {
    if (konfirmasi === null) return;
    b.disabled = true;
    try{ const { error } = await sb.rpc(fn, args); if (error) throw error; }
    catch(e){ alert('Gagal: ' + pesanError(e)); }
    await muatUlang();
  };
  box.querySelectorAll('.lh-ok').forEach(b => { b.onclick = () => {
    if (!confirm('ACC lembur ' + b.dataset.nama + '? Dia bisa Mulai Lembur setelah jam normalnya kelar.')) return;
    aksi(b, 'lembur_izin_putus', { p_id: b.dataset.id, p_setuju: true, p_catatan: null });
  }; });
  box.querySelectorAll('.lh-no').forEach(b => { b.onclick = () => {
    const c = prompt('Tolak lembur ' + b.dataset.nama + '. Catatan buat dia (opsional):', '');
    if (c === null) return;
    aksi(b, 'lembur_izin_putus', { p_id: b.dataset.id, p_setuju: false, p_catatan: c });
  }; });
  box.querySelectorAll('.lh-batal').forEach(b => { b.onclick = () => {
    const c = prompt('Batalin izin lembur ' + b.dataset.nama + '? Catatan buat dia (opsional):', '');
    if (c === null) return;
    aksi(b, 'lembur_izin_batal', { p_id: b.dataset.id, p_catatan: c });
  }; });
}
