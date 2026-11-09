// ============================================================================
// PR-CL141: Istirahat Bareng — Lead / SPV / owner mulai istirahat 60 menit buat satu divisi.
//
// Dipakai tiga halaman:
//   * karyawan.html — kartu Lead (renderIstirahatBareng) + status/aturan buat HP karyawan
//                     (barengSaya: lagi ikut? kalau istirahat sendiri wajib kode = susulan?).
//   * spv.html      — kartu Lead + rekap Istirahat Bareng & susulan (renderBarengPantau).
//   * owner.html    — sama, owner milih divisi.
//
// Semua aturan (siapa boleh, divisi, siapa bisa ikut, jam server yang sama, tutup otomatis
// tiap menit) dijaga di database: RPC istirahat_bareng_* + pg_cron. Di sini cuma tampilan.
// Gak pakai Realtime (publication dibekukan) — refresh lewat polling + pas tab dibuka lagi.
// ============================================================================
import { sb } from './supabase-config.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const jamBareng = iso => new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }).replace('.', ':');
function pesanError(e){ return (e && (e.message || e.details)) || String(e); }
function baca(fn, args){
  let q = sb.rpc(fn, args || {}, { get: true });
  try{ if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) q = q.abortSignal(AbortSignal.timeout(15000)); }catch(_){}
  return q;
}
function sisaMenit(iso){ return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 60000)); }

// Status buat HP karyawan. Gagal (sinyal jelek) -> null, pemanggil jangan ngeblok absen.
export async function barengSaya(){
  try{
    const { data, error } = await baca('istirahat_bareng_saya');
    if (error) throw error;
    return data || null;
  }catch(e){ console.warn('istirahat_bareng_saya:', e); return null; }
}

// ------------------------------------------------------------- kartu Lead
// State antar-refresh: kartu di-render ulang tiap 30-60 detik, centang yang dilepas Lead
// (mis. yang lagi live) jangan balik kecentang sendiri.
const dilepas = new Set();
let divisiPilihan = null;
try{ divisiPilihan = localStorage.getItem('gg_bareng_divisi') || null; }catch(_){}
let sibuk = false;

export async function renderIstirahatBareng(box, opsi = {}){
  if (!box || sibuk) return;
  let d;
  try{
    const { data, error } = await baca('istirahat_bareng_kandidat', divisiPilihan ? { p_divisi: divisiPilihan } : {});   // GET: null jadi teks 'null', jadi jangan dikirim
    if (error) throw error;
    d = data || {};
    // owner: belum pilih / divisinya udah gak ada -> ambil yang pertama
    if (d.owner && (d.divisi_list || []).length && !(d.divisi_list || []).includes(divisiPilihan)){
      divisiPilihan = d.divisi_list.includes('Fulfillment') ? 'Fulfillment' : d.divisi_list[0];
      const r2 = await baca('istirahat_bareng_kandidat', { p_divisi: divisiPilihan });
      if (r2.error) throw r2.error;
      d = r2.data || {};
    }
  }catch(e){ console.warn('istirahat bareng:', e); box.classList.add('hidden'); return; }

  const muatUlang = async () => { await renderIstirahatBareng(box, opsi); if (opsi.sesudah) try{ await opsi.sesudah(); }catch(_){} };
  const pilihDiv = d.owner
    ? '<select class="bareng-div" style="width:auto;display:inline-block;margin:0 0 8px">'
      + (d.divisi_list || []).map(x => '<option value="' + esc(x) + '"' + (x === d.divisi ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select>'
    : '';
  let isi = '';
  const jalan = d.berjalan;
  if (!d.divisi){
    isi = '<div class="lembur-warn">⚠ Divisi kamu belum diisi di WMS, jadi belum bisa mulai Istirahat Bareng. Minta owner isi dulu.</div>';
  } else if (jalan){
    const peserta = jalan.peserta || [];
    const masih = peserta.filter(p => p.masih).length;
    isi = '<div class="bareng-jalan">\u{1F37D}️ <b>Lagi Istirahat Bareng</b> &middot; ' + esc(jamBareng(jalan.mulai_at)) + '–' + esc(jamBareng(jalan.selesai_rencana_at))
      + ' &middot; sisa <b>' + sisaMenit(jalan.selesai_rencana_at) + ' menit</b><br><span class="muted small">dimulai ' + esc(jalan.oleh || '-')
      + ' &middot; ' + masih + ' dari ' + peserta.length + ' masih istirahat. Selesai otomatis jam ' + esc(jamBareng(jalan.selesai_rencana_at)) + '.</span></div>'
      + '<div class="bareng-peserta">' + peserta.map(p => '<span class="bareng-chip' + (p.masih ? '' : ' off') + '">' + esc(p.nama) + (p.masih ? '' : ' · udah balik') + '</span>').join('') + '</div>'
      + '<button class="btn btn-sm btn-ghost bareng-stop" style="width:auto;display:inline-block;margin-top:8px">Selesaiin sekarang (semua balik kerja)</button>';
  } else {
    const kand = d.kandidat || [];
    const siap = kand.filter(k => !k.alasan);
    isi = kand.length
      ? '<div class="lembur-sub" style="margin-bottom:4px">Centang yang ikut. Lepas centang yang lagi gak bisa ditinggal (mis. lagi live).</div>'
        + '<div class="lembur-pick-list bareng-list">' + kand.map(k => {
            const bisa = !k.alasan;
            const cek = bisa && !dilepas.has(k.karyawan_id);
            return '<label class="lembur-pick' + (bisa ? '' : ' off') + '"><input type="checkbox" value="' + esc(k.karyawan_id) + '"' + (cek ? ' checked' : '') + (bisa ? '' : ' disabled') + '> '
              + esc(k.nama) + (k.saya ? ' (kamu)' : '') + ' <small>masuk ' + esc(jamBareng(k.ci_ts)) + (k.alasan ? ' &middot; ' + esc(k.alasan) : '') + '</small></label>';
          }).join('') + '</div>'
        + '<button class="btn btn-primary bareng-go" style="margin-top:10px"' + (siap.length ? '' : ' disabled') + '>Mulai Istirahat Bareng (60 menit)</button>'
      : '<div class="lembur-sub">Belum ada tim ' + esc(d.divisi) + ' yang lagi masuk.</div>';
  }
  const riw = (d.riwayat || []).filter(r => !jalan || r.id !== jalan.id);
  const riwHtml = riw.length
    ? '<div class="lembur-sub" style="margin-top:10px">Tadi: ' + riw.map(r => esc(jamBareng(r.mulai_at)) + '–' + esc(r.selesai_at ? jamBareng(r.selesai_at) : '?') + ' (' + Number(r.jumlah || 0) + ' orang, ' + esc(r.oleh || '-') + ')').join(' &middot; ')
      + '<br>Yang istirahat sendiri sesudah ini wajib kode admin &rarr; ketandai <b>susulan</b>.</div>'
    : '';
  box.innerHTML = '<div class="lembur-head">\u{1F37D}️ Istirahat Bareng</div>'
    + '<div class="lembur-sub" style="margin-bottom:8px">' + (d.owner ? 'Pilih divisinya' : ('Divisi <b>' + esc(d.divisi || '-') + '</b>')) + ' &middot; semua istirahat di jam yang sama, selesai otomatis 60 menit.</div>'
    + pilihDiv + isi + riwHtml;
  box.classList.remove('hidden');

  const sel = box.querySelector('.bareng-div');
  if (sel) sel.onchange = () => {
    divisiPilihan = sel.value; dilepas.clear();
    try{ localStorage.setItem('gg_bareng_divisi', divisiPilihan); }catch(_){}
    renderIstirahatBareng(box, opsi);
  };
  const list = box.querySelector('.bareng-list');
  const go = box.querySelector('.bareng-go');
  const hitung = () => {
    if (!list || !go) return;
    const n = list.querySelectorAll('input:checked').length;
    go.textContent = 'Mulai Istirahat Bareng (60 menit)' + (n ? ' — ' + n + ' orang' : '');
    go.disabled = !n;
  };
  if (list) list.onchange = (ev) => {
    const t = ev.target;
    if (t && t.value){ if (t.checked) dilepas.delete(t.value); else dilepas.add(t.value); }
    hitung();
  };
  hitung();
  if (go) go.onclick = async () => {
    const ids = Array.from(list.querySelectorAll('input:checked')).map(x => x.value);
    if (!ids.length) return;
    if (!confirm('Mulai Istirahat Bareng ' + d.divisi + ' buat ' + ids.length + ' orang sekarang?\n\nSemua langsung tercatat istirahat di jam yang sama dan selesai otomatis 60 menit lagi.')) return;
    sibuk = true; go.disabled = true;
    try{
      const { data, error } = await sb.rpc('istirahat_bareng_mulai', { p_karyawan: ids, p_menit: 60, p_divisi: d.owner ? d.divisi : null });
      if (error) throw error;
      const lewat = ((data && data.hasil) || []).filter(x => x.hasil !== 'ok');
      dilepas.clear();
      if (!data || !data.id) alert('Gak ada yang bisa diistirahatin:\n' + lewat.map(x => '- ' + (x.nama || '?') + ': ' + x.hasil).join('\n'));
      else if (lewat.length) alert('Istirahat Bareng jalan. Sebagian dilewati:\n' + lewat.map(x => '- ' + (x.nama || '?') + ': ' + x.hasil).join('\n'));
    }catch(e){ alert('Gagal: ' + pesanError(e)); }
    sibuk = false;
    await muatUlang();
  };
  const stop = box.querySelector('.bareng-stop');
  if (stop) stop.onclick = async () => {
    if (!confirm('Selesaiin Istirahat Bareng sekarang? Semua yang masih istirahat langsung tercatat balik kerja.\n\nCatatan: buat gaji, istirahat tetap dihitung minimal 60 menit (aturan biasa).')) return;
    sibuk = true; stop.disabled = true;
    try{ const { error } = await sb.rpc('istirahat_bareng_selesai', { p_id: jalan.id }); if (error) throw error; }
    catch(e){ alert('Gagal: ' + pesanError(e)); }
    sibuk = false;
    await muatUlang();
  };
}

// ------------------------------------------------------------- pantau owner / SPV
export async function renderBarengPantau(box, opsi = {}){
  if (!box) return;
  let d;
  try{
    const { data, error } = await baca('istirahat_bareng_hari_ini', { p_jam: opsi.jam || 20 });
    if (error) throw error;
    d = data || {};
  }catch(e){ console.warn('pantau istirahat bareng:', e); box.classList.add('hidden'); return; }
  const bareng = d.bareng || [], sus = d.susulan || [];
  if (!bareng.length && !sus.length){ box.classList.add('hidden'); box.innerHTML = ''; return; }
  const baris = bareng.map(b => {
    const jalan = !b.selesai_at && new Date(b.selesai_rencana_at).getTime() > Date.now();
    const lewat = (b.dilewati || []).map(x => esc(x.nama || '?') + ' (' + esc(x.hasil) + ')');
    return '<div class="lembur-row"><div class="lembur-info"><b>' + esc(b.divisi) + '</b> &middot; ' + esc(jamBareng(b.mulai_at)) + '–'
      + esc(jamBareng(b.selesai_at || b.selesai_rencana_at)) + ' &middot; oleh ' + esc(b.oleh || '-')
      + (jalan ? ' <span style="color:var(--gg-success-t);font-weight:700">lagi jalan</span>' : (b.selesai_oleh ? ' <span class="muted">(diselesaiin ' + esc(b.selesai_oleh) + ')</span>' : ''))
      + '<br><span class="muted small">Ikut ' + (b.peserta || []).length + ': ' + (b.peserta || []).map(esc).join(', ')
      + (lewat.length ? '<br>Gak ikut: ' + lewat.join(', ') : '') + '</span></div></div>';
  }).join('');
  const susHtml = sus.length
    ? '<div class="lembur-warn bareng-susulan">⚠ <b>Istirahat susulan</b> (sendiri, sesudah divisinya Istirahat Bareng): '
      + sus.map(s => esc(s.nama) + ' ' + esc(jamBareng(s.ts)) + (s.kode_verif === 'darurat' ? ' <b>tanpa kode</b>' : '')).join(' &middot; ') + '</div>'
    : '';
  box.innerHTML = '<div class="lembur-head">\u{1F37D}️ Istirahat Bareng Hari Ini</div>' + susHtml + baris;
  box.classList.remove('hidden');
}
