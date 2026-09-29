// ============================================================================
// PR-CL127: lembur wajib ACC Lead / SPV / owner.
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
const jam = iso => new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
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
