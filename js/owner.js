// ============================================================================
// Dashboard Owner — versi Supabase.
//
// Tampilan, urutan menu, nama kolom, dan format angka SENGAJA sama persis
// dengan versi Firebase. Yang diganti cuma mesinnya:
//
//   Firestore                    ->  Postgres
//   koleksi absensi              ->  tabel absensi
//   koleksi karyawan + profil    ->  tabel karyawan
//   bonusBulan / potonganBulan   ->  tabel penyesuaian_gaji
//   koleksi payroll_status       ->  tabel payroll_status
//   daftar email owner di kode   ->  kolom karyawan.peran = 'owner'
//
// PERUBAHAN TERBESAR: dulu halaman rekap menarik RIBUAN dokumen absensi mentah
// ke browser lalu menjumlahkannya pakai JavaScript. Di 150 karyawan itu ±27.000
// dokumen sekali buka halaman — lambat, bisa nge-hang di HP. Sekarang semua
// perangkaian sesi & penjumlahan dikerjakan di database lewat fungsi di
// sql/0002_pr_cl02_rekap_absensi.sql (f_sesi_kerja, f_rekap_harian,
// f_status_harian). Browser tinggal terima hasil yang sudah matang.
//
// SEMUA akses data lewat blok "LAPISAN DATA" di bawah — jangan sebar query
// mentah ke seluruh file. Kalau nanti ada view rekap baru, cukup tukar isi
// satu fungsi di situ.
// ============================================================================

// === 24h time-text helper (manual entry, no AM/PM) ===
(function(){
  if (window.__time24Installed) return; window.__time24Installed = true;
  function autoFormat(v){
    v = (v||'').replace(/[^0-9]/g,'').slice(0,4);
    if (v.length === 4) return v.slice(0,2) + ':' + v.slice(2);
    return v;
  }
  function validHM(v){ return /^([01]\d|2[0-3]):[0-5]\d$/.test(v); }
  document.addEventListener('input', function(e){
    const el = e.target;
    if (!el.matches || !el.matches('input.kh-time, input.kh-edit-jam, input.rd-edit-jam')) return;
    const before = el.value;
    const after = autoFormat(before);
    if (after !== before){
      el.value = after;
      try { el.setSelectionRange(after.length, after.length); } catch(_){}
    }
  });
  document.addEventListener('blur', function(e){
    const el = e.target;
    if (!el.matches || !el.matches('input.kh-time, input.kh-edit-jam, input.rd-edit-jam')) return;
    let v = (el.value||'').trim();
    if (v === '') return;
    let m = v.match(/^(\d):(\d{1,2})$/);
    if (m) v = '0' + m[1] + ':' + (m[2].length === 1 ? '0' + m[2] : m[2]);
    let m2 = v.match(/^(\d{2}):(\d)$/);
    if (m2) v = m2[1] + ':0' + m2[2];
    if (/^\d+$/.test(v)){
      if (v.length === 1) v = '0' + v + ':00';
      else if (v.length === 2) v = v + ':00';
      else if (v.length === 3) v = '0' + v[0] + ':' + v.slice(1);
      else if (v.length === 4) v = v.slice(0,2) + ':' + v.slice(2);
    }
    if (validHM(v)){
      if (el.value !== v){
        el.value = v;
        el.dispatchEvent(new Event('change', {bubbles: true}));
      }
      return;
    }
    const orig = el.dataset.orig || el._origVal || '';
    el.value = orig;
    el.classList.add('kh-save-err');
    setTimeout(()=>el.classList.remove('kh-save-err'), 1500);
  }, true);
})();

import {
  sb, karyawanSaya, keluar, kodeClockout, KODE_SLOT_MS,
  LIBUR_HARI, LIBUR_MAX, periodePayroll, pesanRamah
} from './supabase-config.js';

const $ = id => document.getElementById(id);
const TIPE = { clock_in:'Clock In', clock_out:'Clock Out', break_in:'Istirahat', break_out:'Selesai Istirahat', pause_in:'Pause Kerja', pause_out:'Lanjut Kerja', overtime_in:'Mulai Lembur', overtime_out:'Selesai Lembur' };
let cachedRows = [];
let chartHadir = null, chartLokasi = null;
let unsubToday = null;      // langganan realtime tabel absensi
let tickerBeranda = null;   // jaring pengaman kalau realtime tidak aktif

// Karyawan yang lagi login. Dipakai buat isi kolom dibuat_oleh waktu owner
// mengoreksi absen orang lain, dan buat cek peran.
let SAYA = null;

function localDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
}

// ============================================================================
// LAPISAN DATA — satu-satunya tempat yang ngomong ke database.
// ============================================================================

// Postgres mengirim kolom numeric sebagai TEKS ("8.00"). Semua yang menghitung
// wajib lewat sini, biar tidak ada penjumlahan teks yang diam-diam jadi
// "8.008.00" dan bikin gaji salah.
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Bungkus timestamp jadi bentuk yang dikenal kode tampilan lama
// (r.ts.toDate() / r.ts.toMillis()). Ini disengaja: dengan begini ratusan baris
// render, format jam, dan hitung durasi TIDAK perlu diubah sama sekali — jadi
// yang muncul di layar dijamin sama persis dengan versi Firebase.
function capWaktu(iso){
  if (!iso) return null;
  const d = new Date(iso);
  return { toDate: () => d, toMillis: () => d.getTime() };
}

// Satu baris absensi -> bentuk yang dipakai kode tampilan (nama field lama).
function bentukEvent(r){
  const k = r.karyawan || {};
  return {
    _id: r.id,
    uid: r.karyawan_id,
    nama: k.nama || '',
    email: k.email || '',
    tipe: r.tipe,
    ts: capWaktu(r.ts),
    inRadius: r.in_radius,
    jarak: (r.jarak_m == null ? null : Math.round(num(r.jarak_m))),
    gpsExempt: r.gps_exempt === true,
    lokasi: (r.lat == null && r.lng == null) ? null
          : { lat: r.lat, lng: r.lng, acc: r.akurasi_m },
    fotoSelfie: r.foto_selfie || '',
    catatan: r.catatan || ''
  };
}

// Satu baris karyawan -> bentuk yang dipakai kode tampilan (nama field lama).
// Kolom baru di Postgres dipetakan balik ke nama lama supaya tampilan, urutan
// kolom, dan label di layar tidak ada yang berubah.
function bentukKaryawan(k){
  return {
    id: k.id,
    uid: k.id,
    user_id: k.user_id,
    cabang_id: k.cabang_id,             // masih NULL semua — cabang belum dimodelkan
    nama: k.nama || '',                 // panggilan (1 kata, huruf kecil)
    namaPanggilan: k.nama || '',
    full_name: k.nama_lengkap || '',
    email: k.email || '',
    phone: k.phone || '',
    idKaryawan: k.id_karyawan || '',
    jabatan: k.jabatan || '',
    peran: k.peran || 'staff',
    spvAkses: k.peran === 'spv',
    photoURL: k.foto_url || '',
    tanggalLahir: k.tanggal_lahir || '',
    tanggalJoin: k.tanggal_masuk || '',
    baseHarian: num(k.base_harian),
    jamKerja: num(k.jam_kerja) || 9,
    multiplierLembur: num(k.multiplier_lembur) || 1,
    tunjanganBulanan: num(k.tunjangan_bulanan),
    liburHari: (k.libur_hari == null ? null : Number(k.libur_hari)),
    nonaktif: k.nonaktif === true,
    gpsExempt: k.gps_exempt === true,
    kasbonAktif: k.kasbon_aktif === true,
    kasbonPlafonPersen: num(k.kasbon_plafon_persen),
    namaBank: k.nama_bank || '',
    nomorRekening: k.nomor_rekening || '',
    atasNamaRek: k.atas_nama_rek || '',
    ktpUrl: k.ktp_url || '',
    rekeningLocked: k.rekening_locked === true,
    updatedAt: k.updated_at || null
  };
}

// Rentang satu hari kalender (jam di HP owner) -> ISO buat filter kolom ts.
function rentangHari(d){
  const a = new Date(d); a.setHours(0,0,0,0);
  const b = new Date(d); b.setHours(23,59,59,999);
  return { dari: a.toISOString(), sampai: b.toISOString() };
}

const KOLOM_EVENT = '*, karyawan:karyawan_id (nama, nama_lengkap, email, foto_url)';

const DB = {
  // ---------------------------------------------------------------- karyawan
  async karyawanSemua(){
    const { data, error } = await sb.from('karyawan').select('*').order('nama');
    if (error) throw error;
    return (data || []).map(bentukKaryawan);
  },

  async karyawanSatu(uid){
    const { data, error } = await sb.from('karyawan').select('*').eq('id', uid).maybeSingle();
    if (error) throw error;
    return data ? bentukKaryawan(data) : null;
  },

  // Jumlah karyawan aktif — dihitung di database, barisnya tidak ikut dikirim.
  async jumlahKaryawanAktif(){
    const { count, error } = await sb.from('karyawan')
      .select('id', { count: 'exact', head: true })
      .eq('nonaktif', false);
    if (error) throw error;
    return count || 0;
  },

  // Panggilan sudah dipakai orang lain? Dicek di database — dulu ini menarik
  // SEMUA dokumen karyawan cuma buat membandingkan satu nama.
  async panggilanDipakai(pg, kecualiUid){
    let q = sb.from('karyawan').select('id', { count: 'exact', head: true }).ilike('nama', pg);
    if (kecualiUid) q = q.neq('id', kecualiUid);
    const { count, error } = await q;
    if (error) throw error;
    return (count || 0) > 0;
  },

  async simpanKaryawan(uid, patch){
    const { error } = await sb.from('karyawan').update(patch).eq('id', uid);
    if (error) throw error;
  },

  async hapusKaryawan(uid){
    const { error } = await sb.from('karyawan').delete().eq('id', uid);
    if (error) throw error;
  },

  // ----------------------------------------------------- rekap (dihitung SQL)
  // Papan kehadiran satu hari: tiap karyawan aktif + statusnya. Pengganti
  // langsung dari "tarik semua event lalu rangkai sesi di browser".
  async statusHarian(tglStr){
    const { data, error } = await sb.rpc('f_status_harian', { p_tanggal: tglStr || null });
    if (error) throw error;
    return data || [];
  },

  // Satu baris per karyawan per hari kerja: jam masuk/keluar, istirahat, jeda,
  // jam efektif, lembur, kategori hari. Semua penjumlahannya di database.
  async rekapHarian(dariStr, sampaiStr){
    const { data, error } = await sb.rpc('f_rekap_harian', { p_dari: dariStr, p_sampai: sampaiStr });
    if (error) throw error;
    return data || [];
  },

  // Satu baris per SESI kerja. Dipakai halaman Rekap (butuh jam efektif MENTAH
  // yang belum dipagari kontrak) dan buat tahu batas sesi di Kehadiran Harian.
  async sesiKerja(dariStr, sampaiStr){
    const { data, error } = await sb.rpc('f_sesi_kerja', { p_dari: dariStr, p_sampai: sampaiStr });
    if (error) throw error;
    return data || [];
  },

  // ------------------------------------------------------------ event mentah
  // Cuma dipakai di tempat yang memang butuh event satu per satu: panel Data
  // Absensi, kolom jam yang bisa diedit di Kehadiran Harian, dan drill-down.
  async events({ dari, sampai, karyawanId, tipe, lokasi, urut = 'desc', batas = 3000 }){
    let q = sb.from('absensi').select(KOLOM_EVENT).gte('ts', dari).lte('ts', sampai);
    if (karyawanId) q = q.eq('karyawan_id', karyawanId);
    if (tipe) q = q.eq('tipe', tipe);
    if (lokasi === 'in')  q = q.eq('in_radius', true);
    if (lokasi === 'out') q = q.eq('in_radius', false);
    q = q.order('ts', { ascending: urut === 'asc' }).limit(batas);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map(bentukEvent);
  },

  // Berapa event bertipe tertentu di satu rentang — dihitung di database
  // (head:true, jadi tidak ada satu baris pun yang dikirim ke browser).
  async hitungEvent({ dari, sampai, tipe, inRadius }){
    let q = sb.from('absensi').select('id', { count: 'exact', head: true })
      .gte('ts', dari).lte('ts', sampai);
    if (tipe) q = q.eq('tipe', tipe);
    if (inRadius === true)  q = q.eq('in_radius', true);
    if (inRadius === false) q = q.eq('in_radius', false);
    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
  },

  async tambahEvent(baris){
    const { error } = await sb.from('absensi').insert(baris);
    if (error) throw error;
  },
  async ubahEvent(id, patch){
    const { error } = await sb.from('absensi').update(patch).eq('id', id);
    if (error) throw error;
  },
  async hapusEvent(id){
    const { error } = await sb.from('absensi').delete().eq('id', id);
    if (error) throw error;
  },

  // -------------------------------------------------------------------- uang
  async penyesuaianPeriode(periode){
    const { data, error } = await sb.from('penyesuaian_gaji')
      .select('karyawan_id, jenis, jumlah').eq('periode', periode);
    if (error) throw error;
    return data || [];
  },

  // Ganti nilai bonus/potongan satu orang di satu periode. Di Firestore ini
  // menimpa bonusBulan[yyyymm]; di sini barisnya dihapus lalu ditulis ulang,
  // supaya perilakunya sama (isi = angka terakhir, bukan akumulasi).
  // Catatan: kasbon yang sudah disetujui disimpan dengan jenis 'kasbon' dan
  // ikut kehapus kalau owner mengubah potongan — persis seperti dulu waktu
  // kasbon numpang di potonganBulan yang sama.
  async setPenyesuaian(uid, periode, jenis, jumlah){
    const jenisnya = (jenis === 'potongan') ? ['potongan', 'kasbon'] : [jenis];
    const { error: e1 } = await sb.from('penyesuaian_gaji').delete()
      .eq('karyawan_id', uid).eq('periode', periode).in('jenis', jenisnya);
    if (e1) throw e1;
    if (jumlah > 0){
      const { error: e2 } = await sb.from('penyesuaian_gaji').insert({
        karyawan_id: uid, periode, jenis, jumlah,
        dibuat_oleh: SAYA ? SAYA.id : null
      });
      if (e2) throw e2;
    }
  },

  async payrollStatusPeriode(periode){
    const { data, error } = await sb.from('payroll_status')
      .select('karyawan_id, status, jumlah').eq('periode', periode);
    if (error) throw error;
    return data || [];
  },

  async setPayrollStatus(uid, periode, dibayar, jumlah, slip){
    const { error } = await sb.from('payroll_status').upsert({
      karyawan_id: uid,
      periode,
      status: dibayar ? 'dibayar' : 'belum',
      jumlah: (jumlah == null ? null : Math.round(jumlah)),
      slip: dibayar ? (slip || null) : null,
      dibayar_at: dibayar ? new Date().toISOString() : null,
      dibayar_oleh: (dibayar && SAYA) ? SAYA.id : null
    }, { onConflict: 'karyawan_id,periode' });
    if (error) throw error;
  }
};

// ============================================================================
// MASUK HALAMAN
// ============================================================================
// Owner dikenali dari kolom karyawan.peran = 'owner', BUKAN dari daftar email
// yang ditulis di kode seperti versi lama. Jadi owner bisa mengangkat/mencabut
// akses tanpa perlu ganti kode dan deploy ulang.
(async function mulai(){
  let saya = null;
  try { saya = await karyawanSaya(); }
  catch (e) { console.error('gagal baca karyawan:', e); }

  const { data: { user } } = await sb.auth.getUser();
  if (!user) { location.href = 'index.html'; return; }
  if (!saya || saya.peran !== 'owner') { alert('Access denied'); location.href = 'karyawan.html'; return; }

  SAYA = saya;
  $('ownerEmail').textContent = user.email || saya.email || '';

  const today = new Date();
  const weekAgo = new Date(); weekAgo.setDate(today.getDate() - 6);
  $('dateFrom').value = localDateStr(weekAgo);
  $('dateTo').value = localDateStr(today);

  initSidebar();
  initBeranda();
  initKehadiranMatrix();
  try{ initRekap(); }catch(e){ console.error('initRekap failed', e); }
  try{ loadData(); }catch(e){ console.warn('init loadData err', e); }
  try{ renderKodeSidebar(); }catch(e){}
})();

$('btnLogout').onclick = () => keluar();
$('btnFilter').onclick = loadData;
// Klik Beranda untuk refresh data dashboard
const _btnBeranda = $('berandaTitle');
if (_btnBeranda){
  _btnBeranda.addEventListener('click', ()=>{
    const ic = $('berandaRefreshIcon');
    if (ic){ ic.style.transition='transform .6s'; ic.style.transform='rotate(360deg)'; setTimeout(()=>{ic.style.transform='rotate(0deg)';}, 650); }
    try { muatBeranda(); } catch(e){}
  });
}
$('btnExport').onclick = exportCSV;

function initSidebar(){
    const links = document.querySelectorAll('.nav-link');
    function activate(page){
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const target = document.getElementById('page-' + page);
        if (target) target.classList.add('active');
        links.forEach(l => l.classList.toggle('active', l.dataset.page === page));
        if (page === 'kehadiran') loadKehadiranMatrix();
        if (page === 'rekap') { try{ loadRekap(); }catch(e){ console.error(e); } }
        if (page === 'payroll') { try{ loadPayroll(); }catch(e){ console.error(e); } }
        if (page === 'karyawan') loadKaryawanList();
        if (window.innerWidth <= 768) document.body.classList.remove('sidebar-open');
    }
    links.forEach(l => l.onclick = (e) => { e.preventDefault(); activate(l.dataset.page); });
    const initial = (location.hash || '#beranda').replace('#', '');
    activate(['beranda','kehadiran','rekap','karyawan','payroll'].includes(initial) ? initial : 'beranda');
    $('btnSidebar').onclick = () => document.body.classList.toggle('sidebar-open');
}

// ============================================================================
// BERANDA
// ============================================================================
// Dulu: satu langganan realtime yang menarik SEMUA event 48 jam terakhir, lalu
// dihitung ulang di browser tiap ada perubahan.
// Sekarang: papan kehadiran datang matang dari f_status_harian, angka statistik
// dihitung pakai COUNT di database, dan tabel bawah cuma 20 baris terakhir.
function initBeranda(){
    const today = new Date();
    $('berandaDate').textContent = today.toLocaleDateString('en-US', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

    muatBeranda();

    // Realtime: begitu ada absen masuk, papan langsung ikut berubah.
    if (unsubToday) { try { sb.removeChannel(unsubToday); } catch(e){} unsubToday = null; }
    try {
      unsubToday = sb.channel('beranda-absensi')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'absensi' }, () => { muatBeranda(); })
        .subscribe();
    } catch(e){ console.warn('realtime absensi tidak aktif:', e); }

    // Jaring pengaman: kalau tabel absensi belum dimasukkan ke publication
    // realtime, langganan di atas tidak pernah bunyi. Refresh berkala ini
    // bikin papan tetap hidup (isinya cuma beberapa COUNT, ringan).
    if (tickerBeranda) clearInterval(tickerBeranda);
    tickerBeranda = setInterval(() => {
      const hal = document.getElementById('page-beranda');
      if (hal && hal.classList.contains('active')) muatBeranda();
    }, 30000);
}

const TOTAL_KARYAWAN_DEFAULT = 0;
async function getTotalKaryawan(){
    try { return await DB.jumlahKaryawanAktif(); }   // karyawan nonaktif (resign) tidak dihitung
    catch (e) { return TOTAL_KARYAWAN_DEFAULT; }
}

// ===== PR-CL83: notice ulang tahun karyawan =====
// tanggal_lahir disimpan sebagai DATE ('YYYY-MM-DD'). Yang dipakai cuma tanggal
// & bulan, jadi perbandingannya aman dari zona waktu (ga ada konversi jam).
function _ultahInfo(tglLahir, today){
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(tglLahir||'').trim());
    if (!m) return null;
    const thn = +m[1], bln = +m[2], tgl = +m[3];
    if (bln < 1 || bln > 12 || tgl < 1 || tgl > 31) return null;
    // Ulang tahun berikutnya (29 Feb di tahun biasa otomatis jatuh ke 1 Mar oleh Date).
    let next = new Date(today.getFullYear(), bln-1, tgl);
    next.setHours(0,0,0,0);
    if (next < today) next = new Date(today.getFullYear()+1, bln-1, tgl);
    const selisihHari = Math.round((next - today) / 86400000);
    return { selisihHari, umurNanti: next.getFullYear() - thn, tgl, bln };
}

// CATATAN PINDAHAN: versi Firebase juga menyalin tanggal-bulan ultah ke koleksi
// 'profil' (syncUltahKeProfil) supaya kartu "hari ini X ulang tahun" muncul di
// aplikasi SEMUA karyawan. Koleksi 'profil' sudah dilebur ke tabel karyawan,
// dan RLS bikin staf cuma bisa baca barisnya sendiri — jadi belum ada tempat
// yang boleh dibaca semua orang. Banner di Beranda owner tetap jalan; kartu
// ultah di aplikasi karyawan butuh keputusan owner (lihat laporan).
async function renderUlangTahun(daftarKaryawan){
    const box = $('ultahBox');
    if (!box) return;
    const today = new Date(); today.setHours(0,0,0,0);
    const hariIni = [], segera = [];
    (daftarKaryawan || []).forEach(k => {
        if (k.nonaktif === true) return;                 // yang sudah resign ga usah
        const info = _ultahInfo(k.tanggalLahir, today);
        if (!info) return;
        const nama = k.namaPanggilan || k.nama || '-';
        if (info.selisihHari === 0) hariIni.push({nama, umur: info.umurNanti});
        else if (info.selisihHari <= 2) segera.push({nama, hari: info.selisihHari, tgl: info.tgl, bln: info.bln}); // H-2 aja biar ga kelamaan diumumin
    });
    if (!hariIni.length && !segera.length){ box.classList.add('hidden'); box.innerHTML = ''; return; }
    const BLN = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
    let h = '';
    if (hariIni.length){
        h += '<div class="ultah-today"><span class="ultah-cake">\u{1F382}</span><span>Hari ini ulang tahun: '
           + hariIni.map(x => '<span class="ultah-name">' + x.nama + '</span> <span class="ultah-age">(' + x.umur + ' th)</span>').join(', ')
           + '</span></div>';
    }
    if (segera.length){
        segera.sort((a,b) => a.hari - b.hari);
        h += '<div class="ultah-next">' + (hariIni.length ? '' : '<span>\u{1F382} Ulang tahun terdekat:</span>')
           + segera.slice(0,4).map(x => '<span><b>' + x.nama + '</b> ' + x.tgl + ' ' + BLN[x.bln-1]
           + ' · ' + (x.hari === 1 ? 'besok' : x.hari + ' hari lagi') + '</span>').join('')
           + '</div>';
    }
    box.innerHTML = h;
    box.classList.remove('hidden');
}

// ===== PR-CL93: pengajuan kasbon dari karyawan =====
// BELUM ADA TEMPATNYA di skema baru: pengajuan kasbon dulu disimpan sebagai
// objek kasbonRequest di dalam dokumen karyawan. Tabel karyawan yang baru tidak
// punya kolom itu, dan tabel penyesuaian_gaji cuma menyimpan kasbon yang SUDAH
// disetujui (jenis = 'kasbon'). Jadi kotaknya selalu tersembunyi — sama seperti
// keadaan "tidak ada pengajuan". Fungsinya sengaja ditinggal utuh biar gampang
// dihidupkan lagi begitu kolomnya ada. Lihat laporan.
function __kbRpO(n){ return 'Rp ' + Math.round(n || 0).toLocaleString('id-ID'); }
async function renderKasbonRequests(){
    const box = $('kasbonBox');
    if (!box) return;
    box.classList.add('hidden');
    box.innerHTML = '';
}

// Ambil semua bahan Beranda. Perhatikan: yang ditarik ke browser cuma papan
// kehadiran (1 baris per karyawan) + 20 event terakhir. Angka statistiknya
// dihitung pakai COUNT di database, jadi tidak ada event yang ikut terkirim.
async function muatBeranda(){
    try {
        const kini = new Date();
        const hariIni = rentangHari(kini);
        const kemarinDate = new Date(kini); kemarinDate.setDate(kemarinDate.getDate() - 1);
        const dua_hari = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

        const [total, status, karyawan, cIn, cOut, otIn, otOut, inRuko, outRuko, terakhir, rekapKemarin] =
        await Promise.all([
            getTotalKaryawan(),
            DB.statusHarian(null),                       // null = hari kerja yang lagi berjalan
            DB.karyawanSemua(),
            DB.hitungEvent({ ...hariIni, tipe: 'clock_in' }),
            DB.hitungEvent({ ...hariIni, tipe: 'clock_out' }),
            DB.hitungEvent({ ...hariIni, tipe: 'overtime_in' }),
            DB.hitungEvent({ ...hariIni, tipe: 'overtime_out' }),
            DB.hitungEvent({ ...hariIni, tipe: 'clock_in', inRadius: true }),
            DB.hitungEvent({ ...hariIni, tipe: 'clock_in', inRadius: false }),
            DB.events({ dari: dua_hari, sampai: hariIni.sampai, urut: 'desc', batas: 20 }),
            DB.rekapHarian(localDateStr(kemarinDate), localDateStr(kemarinDate))
        ]);

        // Siapa yang lagi istirahat butuh jam MULAI istirahatnya buat timer.
        const lagiIstirahat = status.filter(s => s.status === 'istirahat').map(s => s.karyawan_id);
        let mulaiIstirahat = new Map();
        if (lagiIstirahat.length){
            const ev = await DB.events({ ...hariIni, tipe: 'break_in', urut: 'desc', batas: 500 });
            ev.forEach(e => { if (!mulaiIstirahat.has(e.uid)) mulaiIstirahat.set(e.uid, e.ts.toMillis()); });
        }

        await renderBeranda({
            total, status, karyawan, terakhir, rekapKemarin, mulaiIstirahat,
            stat: { clock_in: cIn, clock_out: cOut, overtime_in: otIn, overtime_out: otOut },
            inRuko, outRuko
        });
    } catch (err) {
        console.error('Beranda error:', err);
    }
}

async function renderBeranda(p){
    try{ await renderHadirFloating(p); }catch(e){ console.warn('hadir floating err', e); }
    try{ await renderUlangTahun(p.karyawan); }catch(e){ console.warn('ultah err', e); }
    try{ await renderKasbonRequests(); }catch(e){ console.warn('kasbon err', e); }

    const total = p.total;
    // "Clocked In" = berapa ORANG yang hari ini sudah punya jam masuk.
    const hadir = p.status.filter(s => s.jam_masuk).length;
    const belum = Math.max(total - hadir, 0);
    const stat = p.stat;
    const inRuko = p.inRuko, outRuko = p.outRuko;

    $('berandaStats').innerHTML =
        '<div class="stat"><b>' + hadir + '/' + total + '</b><small>Clocked In</small></div>' +
        '<div class="stat"><b>' + stat.clock_in + '</b><small>Total Clock In</small></div>' +
        '<div class="stat"><b>' + stat.clock_out + '</b><small>Clock Out</small></div>' +
        '<div class="stat"><b>' + stat.overtime_in + '</b><small>OT In</small></div>' +
        '<div class="stat"><b>' + stat.overtime_out + '</b><small>OT Out</small></div>' +
        '<div class="stat" style="background:#3b1d1d"><b style="color:#dc2626">' + outRuko + '</b><small>Out of Radius</small></div>';

    const ctx1 = document.getElementById('chartHadir');
    if (ctx1 && window.Chart) {
        if (chartHadir) chartHadir.destroy();
        chartHadir = new Chart(ctx1, {
            type: 'doughnut',
            data: {
                labels: ['Clocked In', 'Pending'],
                datasets: [{ data: [hadir, belum], backgroundColor: ['#10b981', '#33312d'], borderWidth: 0 }]
            },
            options: { plugins:{ legend:{ position:'bottom' } }, cutout:'65%' }
        });
        $('capHadir').textContent = hadir + ' dari ' + total + ' karyawan sudah Clock In hari ini';
    }

    const ctx2 = document.getElementById('chartLokasi');
    if (ctx2 && window.Chart) {
        if (chartLokasi) chartLokasi.destroy();
        chartLokasi = new Chart(ctx2, {
            type: 'doughnut',
            data: {
                labels: ['In Office', 'Out of Radius'],
                datasets: [{ data: [inRuko, outRuko], backgroundColor: ['#10b981', '#ef4444'], borderWidth: 0 }]
            },
            options: { plugins:{ legend:{ position:'bottom' } }, cutout:'65%' }
        });
        $('capLokasi').textContent = inRuko + ' di ruko · ' + outRuko + ' luar lokasi';
    }

    const tb = document.querySelector('#tblToday tbody');
    tb.innerHTML = '';
    const rows = p.terakhir || [];
    if (!rows.length) {
        $('emptyToday').textContent = 'No attendance activity today';
        return;
    }
    $('emptyToday').textContent = '';
    rows.slice(0, 20).forEach(r => {
        const t = r.ts && r.ts.toDate ? r.ts.toDate() : new Date();
        const jam = t.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
        const nama = r.nama || (r.email ? r.email.split('@')[0] : '-');
        let badge = '';
        if (r.inRadius === true) badge = '<span class="badge-loc badge-in">In Office'+(r.jarak!=null?' '+r.jarak+'m':'')+'</span>';
        else if (r.inRadius === false) badge = '<span class="badge-loc badge-out">Out '+(r.jarak!=null?r.jarak+'m':'')+'</span>';
        else badge = '<span class="muted">-</span>';
        const tr = document.createElement('tr');
        if (r.inRadius === false) tr.style.background = '#3b1d1d';
        tr.innerHTML = '<td>'+jam+'</td><td>'+nama+'</td><td>'+(TIPE[r.tipe]||r.tipe)+'</td><td>'+badge+'</td>';
        tb.appendChild(tr);
    });
    renderWorkingNowWithFetch(rows, p.karyawan);
}

// ============================================================================
// DATA ABSENSI (panel bawah Beranda)
// ============================================================================
async function loadData() {
    try {
        const from = new Date($('dateFrom').value + 'T00:00:00');
        const to = new Date($('dateTo').value + 'T23:59:59.999');

        // Pilihan karyawan diisi dari tabel karyawan, bukan dari event yang
        // kebetulan ada di rentang ini. Bedanya: daftarnya lengkap dan filter
        // orangnya bisa dikerjakan DI DATABASE (dulu semua event ditarik dulu
        // baru disaring di browser).
        const sel = $('selKaryawan'); const prev = sel.value;
        const semua = await DB.karyawanSemua();
        sel.innerHTML = '<option value="">All</option>';
        semua.filter(k => k.email).sort((a,b)=>a.email.localeCompare(b.email)).forEach(k => {
            const o = document.createElement('option'); o.value = k.id; o.textContent = k.email; sel.appendChild(o);
        });
        sel.value = prev;

        const fUid = sel.value, fType = $('selType').value;
        const fLoc = $('selLocation') ? $('selLocation').value : '';
        const BATAS = 3000;
        const rows = await DB.events({
            dari: from.toISOString(), sampai: to.toISOString(),
            karyawanId: fUid || null, tipe: fType || null, lokasi: fLoc || null,
            urut: 'desc', batas: BATAS
        });

        cachedRows = rows;
        renderStats(rows);
        renderTable(rows);
        if (rows.length >= BATAS){
            $('emptyMsg').textContent = 'Menampilkan ' + BATAS.toLocaleString('id-ID')
                + ' catatan terbaru. Persempit rentang tanggalnya kalau mau lihat yang lebih lama.';
        }
    } catch (err) {
        console.error('loadData error:', err);
        alert('Failed to load data: ' + pesanRamah(err));
    }
}

function renderStats(rows) {
    const stat = { clock_in:0, clock_out:0, break_in:0, break_out:0, overtime_in:0, overtime_out:0 };
    let outCount = 0;
    rows.forEach(r => {
        if (stat[r.tipe] !== undefined) stat[r.tipe]++;
        if (r.inRadius === false) outCount++;
    });
    $('stats').innerHTML =
        '<div class="stat"><b>'+stat.clock_in+'</b><small>Clock In</small></div>'+
        '<div class="stat"><b>'+stat.clock_out+'</b><small>Clock Out</small></div>'+
        '<div class="stat"><b>'+stat.overtime_in+'</b><small>Overtime In</small></div>'+
        '<div class="stat"><b>'+stat.overtime_out+'</b><small>Overtime Out</small></div>'+
        '<div class="stat"><b>'+rows.length+'</b><small>Total Records</small></div>'+
        '<div class="stat" style="background:#3b1d1d"><b style="color:#dc2626">'+outCount+'</b><small>Out of Radius</small></div>';
}

function renderTable(rows) {
    const tb = document.querySelector('#tblAbsen tbody');
    tb.innerHTML = '';
    if (!rows.length) { $('emptyMsg').textContent = 'No data in this range'; return; }
    $('emptyMsg').textContent = '';
    rows.forEach(r => {
        if (r.tipe === 'break_in' || r.tipe === 'break_out') return; // PR-CL04 sembunyikan event Istirahat/Selesai Istirahat dari tabel
        const t = r.ts && r.ts.toDate ? r.ts.toDate() : new Date();
        const loc = r.lokasi
            ? '<a href="https://www.google.com/maps?q='+r.lokasi.lat+','+r.lokasi.lng+'" target="_blank" rel="noopener">Map</a>'
            : '<span class="muted">-</span>';
        const img = r.fotoSelfie
            ? '<img src="'+r.fotoSelfie+'" alt="foto" style="width:48px;height:48px;object-fit:cover;border-radius:6px;cursor:pointer" onclick="document.getElementById(\'modalImg\').src=this.src;document.getElementById(\'photoModal\').classList.add(\'show\')">'
            : '<span class="muted">-</span>';
        const nama = r.nama || (r.email ? r.email.split('@')[0] : '-');
        let badge = '';
        if (r.inRadius === true) {
            badge = '<span class="badge-loc badge-in">🟢 In Office ('+(r.jarak!=null?r.jarak+'m':'')+')</span>';
        } else if (r.inRadius === false) {
            badge = '<span class="badge-loc badge-out">🔴 Out of Radius ('+(r.jarak!=null?r.jarak+'m':'')+')</span>';
        } else {
            badge = '<span class="muted" style="font-size:11px">-</span>';
        }
        const tr = document.createElement('tr');
        if (r.inRadius === false) tr.style.background = '#3b1d1d';
        const isoTs = t.toISOString();
        const jamHHMMSS = String(t.getHours()).padStart(2,'0')+':'+String(t.getMinutes()).padStart(2,'0')+':'+String(t.getSeconds()).padStart(2,'0');
        const tanggalYMD = localDateStr(t);
        const tipeOpts = ['clock_in','clock_out','break_in','break_out','overtime_in','overtime_out']
            .map(v=>'<option value="'+v+'"'+(v===(r.tipe||'')?' selected':'')+'>'+(TIPE[v]||v)+'</option>').join('');
        tr.innerHTML = '<td><input type="date" class="kh-edit-tgl" data-id="'+(r._id||'')+'" value="'+tanggalYMD+'"></td>'+
            '<td><input type="text" inputmode="numeric" maxlength="5" placeholder="--:--" class="kh-edit-jam" data-id="'+(r._id||'')+'" value="'+(jamHHMMSS||'').slice(0,5)+'"></td>'+
            '<td>'+nama+'</td>'+
            '<td><select class="kh-edit-tipe" data-id="'+(r._id||'')+'">'+tipeOpts+'</select></td>'+
            '<td>'+badge+'</td><td>'+loc+'</td><td>'+img+'</td>'+
            '<td class="col-aksi-kh">'+
                '<button class="btn-link btn-hapus-absen" data-id="'+(r._id||'')+'" data-nama="'+nama+'" data-tipe="'+(r.tipe||'')+'" data-ts="'+isoTs+'" style="color:#dc2626">🗑️ Hapus</button>'+
            '</td>';
        tb.appendChild(tr);
    });
    // Inline edit: jam (waktu)
    document.querySelectorAll('.kh-edit-jam').forEach(inp=>{
        inp._origVal = inp.value;
        inp.onchange = async ()=>{
            const id = inp.dataset.id;
            const tglInput = document.querySelector('.kh-edit-tgl[data-id="'+id+'"]');
            const tglVal = tglInput ? tglInput.value : '';
            const jamVal = inp.value;
            if(!id || !tglVal || !jamVal){ alert('Tanggal/Jam tidak valid'); inp.value = inp._origVal; return; }
            try{
                const newDate = new Date(tglVal + 'T' + jamVal);
                if(isNaN(newDate.getTime())){ alert('Format jam tidak valid'); inp.value = inp._origVal; return; }
                inp.classList.add('kh-saving');
                await DB.ubahEvent(id, { ts: newDate.toISOString(), dibuat_oleh: SAYA ? SAYA.id : null });
                inp.classList.remove('kh-saving'); inp.classList.add('kh-saved');
                setTimeout(()=>inp.classList.remove('kh-saved'), 1200);
                inp._origVal = inp.value;
                try{ const cidx = cachedRows.findIndex(r=>r._id===id); if(cidx>=0) cachedRows[cidx].ts = capWaktu(newDate.toISOString()); }catch(e){}
            }catch(err){
                console.error('inline edit jam err', err);
                inp.classList.remove('kh-saving');
                alert('Gagal simpan jam: '+pesanRamah(err));
                inp.value = inp._origVal;
            }
        };
    });
    document.querySelectorAll('.kh-edit-tgl').forEach(inp=>{
        inp._origVal = inp.value;
        inp.onchange = ()=>{
            const id = inp.dataset.id;
            const jamInput = document.querySelector('.kh-edit-jam[data-id="'+id+'"]');
            if(jamInput) jamInput.dispatchEvent(new Event('change'));
        };
    });
    document.querySelectorAll('.kh-edit-tipe').forEach(sel=>{
        sel._origVal = sel.value;
        sel.onchange = async ()=>{
            const id = sel.dataset.id;
            const newTipe = sel.value;
            if(!id || !newTipe){ sel.value = sel._origVal; return; }
            try{
                sel.classList.add('kh-saving');
                await DB.ubahEvent(id, { tipe: newTipe, dibuat_oleh: SAYA ? SAYA.id : null });
                sel.classList.remove('kh-saving'); sel.classList.add('kh-saved');
                setTimeout(()=>sel.classList.remove('kh-saved'), 1200);
                sel._origVal = sel.value;
                try{ const cidx = cachedRows.findIndex(r=>r._id===id); if(cidx>=0) cachedRows[cidx].tipe = newTipe; }catch(e){}
            }catch(err){
                console.error('inline edit tipe err', err);
                sel.classList.remove('kh-saving');
                alert('Gagal simpan tipe: '+pesanRamah(err));
                sel.value = sel._origVal;
            }
        };
    });
    document.querySelectorAll('.btn-hapus-absen').forEach(b=>{
        b.onclick = ()=> openDeleteAbsen(b.dataset.id, b.dataset.nama, b.dataset.tipe, b.dataset.ts);
    });
}

function exportCSV() {
    if (!cachedRows.length) { alert('No data to export'); return; }
    // Judul kolom sengaja TIDAK diubah supaya file lama & baru bisa ditumpuk.
    // 4 kolom terakhir + SizeKB isinya kosong: field itu tidak punya kolom di
    // skema Postgres yang baru (lihat laporan).
    const header = ['Date','Time','Name','Email','Type','Location Status','Distance(m)','Latitude','Longitude','Accuracy(m)','SizeKB','PhotoURL','BreakFilledAtCheckout','AutoCut1h','EarlyReason'];
    const lines = [header.join(',')];
    cachedRows.forEach(r => {
        const t = r.ts && r.ts.toDate ? r.ts.toDate() : new Date();
        const tanggal = t.toLocaleDateString('en-US');
        const jam = t.toLocaleTimeString('en-US');
        const lat = r.lokasi ? r.lokasi.lat : '';
        const lng = r.lokasi ? r.lokasi.lng : '';
        const acc = r.lokasi ? r.lokasi.acc : '';
        const statusLok = r.inRadius === true ? 'In Office' : (r.inRadius === false ? 'Out of Radius' : '');
        const jarak = r.jarak != null ? r.jarak : '';
        const cells = [tanggal, jam, r.nama || '', r.email || '', TIPE[r.tipe] || r.tipe || '', statusLok, jarak, lat, lng, acc, '', r.fotoSelfie || '', '', '', ''];
        lines.push(cells.map(c => '"'+String(c == null ? '' : c).replace(/"/g, '""')+'"').join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'absensi_'+$('dateFrom').value+'_to_'+$('dateTo').value+'.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ============================================================================
// Floating Bar Kehadiran di Beranda (papan "siapa lagi ngapain")
// ============================================================================
// Dulu: 48 jam event mentah ditarik ke browser, lalu sesi kerja, istirahat, dan
// "lupa clock out" dirangkai pakai belasan fungsi JavaScript.
// Sekarang: f_status_harian sudah mengembalikan status matang per orang
// (berjalan / istirahat / jeda / selesai / lupa_clock_out / libur / belum_absen)
// beserta jam masuk, jam keluar, menit istirahat, dan menit jeda.
// Yang masih dikerjakan browser cuma timer yang jalan tiap detik.
async function renderHadirFloating(p){
    const total = p.total;
    const statusRows = p.status || [];
    const fotoMap = new Map();
    const namaMap = new Map();
    (p.karyawan || []).forEach(k => { fotoMap.set(k.id, k.photoURL || ''); namaMap.set(k.id, k.namaPanggilan || k.nama || ''); });

    const LEWAT_PULANG_MS = 6 * 60 * 60 * 1000;   // "baru pulang" masih tampil 6 jam
    const skrg = Date.now();
    const ms = iso => iso ? new Date(iso).getTime() : 0;

    const hadirUids = [], workingUids = [], breakUids = [], finishUids = [];
    const infoByUid = new Map();

    statusRows.forEach(s => {
        if (!s.jam_masuk) return;                 // libur / belum absen — bukan "hadir"
        const uid = s.karyawan_id;
        infoByUid.set(uid, {
            masuk: ms(s.jam_masuk),
            keluar: ms(s.jam_keluar),
            istirahatMs: num(s.istirahat_menit) * 60000,
            jedaMs: num(s.jeda_menit) * 60000
        });
        hadirUids.push(uid);
        if (s.status === 'berjalan' || s.status === 'jeda') workingUids.push(uid);
        else if (s.status === 'istirahat') breakUids.push(uid);
        else if (s.status === 'selesai') finishUids.push(uid);
        // 'lupa_clock_out' sengaja tidak masuk mana-mana: dia tetap dihitung
        // hadir, tapi bukan "sedang bekerja" (selaras Kehadiran Harian).
    });

    // Sesi yang MULAI kemarin dan baru ditutup dini hari ini (mis. lembur nembus
    // tengah malam) diikat ke hari kerja kemarin oleh database, jadi tidak ikut
    // di papan hari ini. Kita tarik lagi supaya tetap muncul di "Finish Working"
    // selama 6 jam — persis kelakuan versi lama.
    (p.rekapKemarin || []).forEach(r => {
        const uid = r.karyawan_id;
        if (infoByUid.has(uid)) return;
        const keluar = ms(r.jam_keluar);
        if (!keluar || (skrg - keluar) > LEWAT_PULANG_MS) return;
        infoByUid.set(uid, {
            masuk: ms(r.jam_masuk), keluar,
            istirahatMs: num(r.istirahat_menit) * 60000,
            jedaMs: num(r.jeda_menit) * 60000
        });
        hadirUids.push(uid);
        finishUids.push(uid);
    });

    function namaOf(uid){ return namaMap.get(uid) || ''; }
    function avaHtml(u){
        const foto = fotoMap.get(u) || '';
        const nm = namaOf(u) || '?';
        if (foto) return '<img class="p-ava" src="'+foto+'" alt="" title="'+nm+'">';
        return '<span class="p-ava p-ava-ph" title="'+nm+'">'+nm.charAt(0).toUpperCase()+'</span>';
    }
    function setCount(id, n){ const el = $(id); if (el) el.textContent = n + '/' + total; }
    function fmtDurMs(msVal){
        const _sec = Math.max(0, Math.floor(msVal/1000));
        const _h = Math.floor(_sec/3600), _m = Math.floor((_sec%3600)/60), _ss = _sec%60;
        return (_h>0 ? (_h + ':' + String(_m).padStart(2,'0')) : String(_m)) + ':' + String(_ss).padStart(2,'0');
    }

    // Bar atas: avatar wall semua yang hadir hari ini.
    setCount('hadirCount', hadirUids.length);
    (function(){
        const wrap = $('hadirAvatars');
        if (!wrap) return;
        wrap.innerHTML = '';
        if (!hadirUids.length){ wrap.insertAdjacentHTML('beforeend', '<span class="hadir-empty muted small">—</span>'); return; }
        hadirUids.forEach(u => {
            const foto = fotoMap.get(u) || '';
            const initial = (namaOf(u) || '?').charAt(0).toUpperCase();
            if (!foto) wrap.insertAdjacentHTML('beforeend', '<span class="hadir-avatar hadir-avatar-ph" title="'+namaOf(u)+'">'+initial+'</span>');
            else wrap.insertAdjacentHTML('beforeend', '<img class="hadir-avatar" src="'+foto+'" alt="" title="'+namaOf(u)+'" />');
        });
    })();

    setCount('workingCount', workingUids.length);
    setCount('breakCount', breakUids.length);
    setCount('finishCount', finishUids.length);

    // On Working: chip per orang (foto+nama+timer LIVE; class work-timer/work-net
    // dipakai ticker global di bawah).
    const _workBox = $('workTimers');
    if (_workBox){
        _workBox.innerHTML = workingUids.length ? workingUids.map(function(u){
            const inf = infoByUid.get(u); if (!inf || !inf.masuk) return '';
            const _rest = inf.istirahatMs + inf.jedaMs;   // istirahat+jeda yang SUDAH selesai
            return '<div class="p-row">' + avaHtml(u)
                 + '<span class="p-name">' + (namaOf(u)||'-') + '</span>'
                 + '<span class="p-time"><span class="work-timer p-main" data-start="' + inf.masuk + '">--:--</span>'
                 + '<small class="p-sep">efektif</small>'
                 + '<span class="work-net p-dim" data-start="' + inf.masuk + '" data-base="' + _rest + '">--:--</span></span>'
                 + '</div>';
        }).join('') : '<div class="p-empty">Belum ada yang bekerja</div>';
    }

    // On Break: chip per orang (timer LIVE; class brk-timer/brk-total).
    const _brkBox = $('breakTimers');
    if (_brkBox){
        _brkBox.innerHTML = breakUids.length ? breakUids.map(function(u){
            const inf = infoByUid.get(u) || {};
            const _s = (p.mulaiIstirahat && p.mulaiIstirahat.get(u)) || 0;
            const _b = inf.istirahatMs || 0;
            return '<div class="p-row">' + avaHtml(u)
                 + '<span class="p-name">' + (namaOf(u)||'-') + '</span>'
                 + '<span class="p-time"><span class="brk-timer p-main" data-start="' + _s + '">--:--</span>'
                 + '<small class="p-sep">total</small>'
                 + '<span class="brk-total p-dim" data-start="' + _s + '" data-base="' + _b + '">--:--</span></span>'
                 + '</div>';
        }).join('') : '<div class="p-empty">Tidak ada yang istirahat</div>';
    }

    // Finish: chip per orang, angka FINAL statis (tidak ticking).
    const _finBox = $('finishTimers');
    if (_finBox){
        _finBox.innerHTML = finishUids.length ? finishUids.map(function(u){
            const inf = infoByUid.get(u);
            if (!inf || !inf.masuk || !inf.keluar) return '';
            const _gross = inf.keluar - inf.masuk;
            if (_gross <= 0) return '';
            const _eff = Math.max(0, _gross - inf.istirahatMs - inf.jedaMs);
            return '<div class="p-row">' + avaHtml(u)
                 + '<span class="p-name">' + (namaOf(u)||'-') + '</span>'
                 + '<span class="p-time"><span class="p-main">' + fmtDurMs(_gross) + '</span>'
                 + '<small class="p-sep">efektif</small>'
                 + '<span class="p-dim">' + fmtDurMs(_eff) + '</span></span>'
                 + '</div>';
        }).join('') : '<div class="p-empty">Belum ada yang pulang</div>';
    }

    if (!window.__ggBreakTick){
        window.__ggBreakTick = setInterval(function(){
            const _now = Date.now();
            function _fmtBrk(_sec){
                const _h = Math.floor(_sec/3600), _m = Math.floor((_sec%3600)/60), _ss = _sec%60;
                return (_h>0 ? (_h + ':' + String(_m).padStart(2,'0')) : String(_m)) + ':' + String(_ss).padStart(2,'0');
            }
            document.querySelectorAll('.brk-timer, .work-timer').forEach(function(t){
                const _s = parseInt(t.getAttribute('data-start'),10) || 0;
                if (!_s){ t.textContent = '--:--'; return; }
                t.textContent = _fmtBrk(Math.max(0, Math.floor((_now - _s)/1000)));
            });
            document.querySelectorAll('.brk-total').forEach(function(t){
                const _s = parseInt(t.getAttribute('data-start'),10) || 0;
                const _b = parseInt(t.getAttribute('data-base'),10) || 0;
                if (!_s){ t.textContent = '--:--'; return; }
                t.textContent = _fmtBrk(Math.max(0, Math.floor((_b + (_now - _s))/1000)));
            });
            document.querySelectorAll('.work-net').forEach(function(t){
                const _s = parseInt(t.getAttribute('data-start'),10) || 0;
                const _b = parseInt(t.getAttribute('data-base'),10) || 0;
                if (!_s){ t.textContent = '--:--'; return; }
                t.textContent = _fmtBrk(Math.max(0, Math.floor(((_now - _s) - _b)/1000)));
            });
        }, 1000);
    }
}

// ============================================================================
// KARYAWAN
// ============================================================================
async function loadKaryawanList(){
    try {
        const rows = await DB.karyawanSemua();
        const tb = document.querySelector('#tblKaryawan tbody');
        tb.innerHTML = '';
        if (!rows.length) {
            $('emptyKaryawan').textContent = 'Belum ada karyawan terdaftar. Minta karyawan daftar via halaman login (pakai kode pendaftaran).';
            return;
        }
        $('emptyKaryawan').textContent = '';
        rows.sort((a,b)=>(a.nama||'').localeCompare(b.nama||''));
        // === Jadwal Libur Mingguan (ringkasan + kuota) ===
        (function(){
          const _tbl = document.getElementById('tblKaryawan');
          const _wrap = _tbl ? _tbl.closest('.card') : null;
          let _box = document.getElementById('liburSchedule');
          if (!_box && _wrap && _wrap.parentElement){ _box=document.createElement('div'); _box.id='liburSchedule'; _box.className='card'; _wrap.parentElement.insertBefore(_box, _wrap); }
          if (!_box) return;
          const byDay=[[],[],[],[],[],[],[]];
          rows.forEach(r => { if (r.nonaktif===true) return; if (r.liburHari!=null){ const h=Number(r.liburHari); if(h>=0&&h<=6) byDay[h].push(r.namaPanggilan||r.nama||'?'); } });
          window.__liburByDay = byDay;
          let html='<h3 style="margin:0 0 8px">🌴 Jadwal Libur Mingguan <small class="muted" style="font-weight:400;font-size:12px">— maks '+LIBUR_MAX+'/hari, ga dianggap mangkir</small></h3><div style="display:flex;flex-wrap:wrap;gap:8px">';
          for (let h=0;h<7;h++){ const full=byDay[h].length>=LIBUR_MAX; const col=byDay[h].length===0?'#6b7280':full?'#f97316':'#9ca3af'; html+='<div style="flex:1 1 120px;min-width:110px;padding:8px 10px;border:1px solid #2a2a2a;border-radius:10px;background:#141414"><div style="font-size:12px;font-weight:700;color:'+col+'">'+LIBUR_HARI[h]+' ('+byDay[h].length+'/'+LIBUR_MAX+')</div><div style="font-size:12px;color:#d1d5db;margin-top:2px">'+(byDay[h].length?byDay[h].join(', '):'<span class="muted">—</span>')+'</div></div>'; }
          html+='</div>';
          // CATATAN PINDAHAN: banner "usulan libur nunggu di-assign" belum bisa
          // tampil — usulan karyawan (liburRequest/liburRequestPending) tidak
          // punya kolom di tabel karyawan yang baru. Lihat laporan.
          _box.innerHTML=html;
        })();
        // === Auto-isi default buat yang belum punya: ID (GG-####), jam kerja 9, base 100rb, tanggal join ===
        // PERSIS versi lama. Hati-hati waktu impor 150 karyawan: yang base
        // harian-nya masih kosong bakal otomatis diisi 100.000 begitu halaman
        // ini dibuka. Lihat laporan.
        let _maxKid = 0;
        rows.forEach(r => { const m = /^GG-(\d+)$/i.exec(r.idKaryawan || ''); if (m){ const n = parseInt(m[1],10); if (n > _maxKid) _maxKid = n; } });
        for (const r of rows){
            const patch = {};
            let _idBumped = false;
            if (!r.idKaryawan){ _maxKid++; patch.id_karyawan = 'GG-' + String(_maxKid).padStart(4,'0'); _idBumped = true; }
            if (!r.jamKerja)    patch.jam_kerja = 9;           // default 9 jam/hari (kecuali owner sudah set)
            if (!r.baseHarian)  patch.base_harian = 100000;    // default base 100rb, nempel sampai owner edit
            if (!r.tanggalJoin) patch.tanggal_masuk = localDateStr(new Date());  // tanggal join otomatis
            // CATATAN PINDAHAN: versi lama juga menambal email kosong dengan
            // membaca event absensi. Tabel absensi yang baru tidak menyimpan
            // email (identitasnya lewat karyawan_id), jadi langkah itu dilepas.
            if (Object.keys(patch).length){
                try {
                    await DB.simpanKaryawan(r.id, patch);
                    // Cerminkan ke baris yang sudah di tangan, biar tabelnya langsung
                    // nampilin nilai baru tanpa perlu query ulang.
                    if (patch.id_karyawan)   r.idKaryawan  = patch.id_karyawan;
                    if (patch.jam_kerja)     r.jamKerja    = patch.jam_kerja;
                    if (patch.base_harian)   r.baseHarian  = patch.base_harian;
                    if (patch.tanggal_masuk) r.tanggalJoin = patch.tanggal_masuk;
                }
                catch(e){ console.warn('Auto-isi default gagal untuk', r.id, e); if (_idBumped) _maxKid--; }
            }
        }
        // Foto profil: sekarang satu kolom karyawan.foto_url. Versi lama harus
        // menembak koleksi 'profil' satu per satu (150 request sekali buka).
        // Aktif dulu (urut nama), lalu Nonaktif/resign dikelompokin di bawah
        // (redup + bisa di-collapse, default keumpet biar rapi).
        rows.sort((a,b)=> ((a.nonaktif===true)?1:0) - ((b.nonaktif===true)?1:0));
        const _nonaktifCount = rows.filter(r=>r.nonaktif===true).length;
        let _no = 0, _sepInserted = false;
        rows.forEach((x) => {
            const isNon = (x.nonaktif===true);
            if (isNon && !_sepInserted){
                _sepInserted = true;
                const sep = document.createElement('tr');
                sep.className = 'kry-nonaktif-sep';
                sep.style.cursor = 'pointer';
                sep.innerHTML = '<td colspan="11" style="padding:9px 12px;background:#161616;border-top:2px solid #2a2a2a;color:#9ca3af;font-size:12.5px;font-weight:600">'
                  + '<span class="kry-non-caret">▸</span> Nonaktif / Resign (' + _nonaktifCount + ') — klik buat lihat/sembunyikan</td>';
                sep.onclick = () => {
                    const rowsN = tb.querySelectorAll('.kry-nonaktif-row');
                    const show = rowsN.length && rowsN[0].style.display === 'none';
                    rowsN.forEach(r => r.style.display = show ? '' : 'none');
                    const c = sep.querySelector('.kry-non-caret'); if (c) c.textContent = show ? '▾' : '▸';
                };
                tb.appendChild(sep);
            }
            const idDisplay = x.idKaryawan || '-';
            const jamKerja = x.jamKerja || 9;
            const tr = document.createElement('tr');
            if (isNon){ tr.className = 'kry-nonaktif-row'; tr.style.opacity = '.55'; tr.style.display = 'none'; }
            _no++;
            const tj = x.tanggalJoin ? new Date(x.tanggalJoin + 'T00:00:00') : null;
            const tjStr = tj && !isNaN(tj.getTime()) ? tj.toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'}) : '-';
            // Nama tampilan dgn fallback berlapis: baris kosong tetap kebaca (pakai email) + jelas perlu dilengkapi.
            const dispNama = x.full_name || x.nama || (x.email ? x.email.split('@')[0] : '') || '(belum ada data)';
            const dispPgl = x.namaPanggilan || x.nama || '-';
            const _foto = x.photoURL || '';
            const _ini = (dispNama.trim().charAt(0) || '?').toUpperCase();
            const avatar = _foto
                ? '<img src="'+_foto+'" alt="" loading="lazy" style="width:36px;height:36px;border-radius:50%;object-fit:cover;display:block;border:1px solid var(--gg-border,#403d37)">'
                : '<span style="width:36px;height:36px;border-radius:50%;background:var(--gg-surface-2,#33312d);color:var(--gg-muted,#a8a399);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;border:1px solid var(--gg-border,#403d37)">'+_ini+'</span>';
            const liburCell = (x.liburHari!=null)
                ? '<span class="tag" style="background:#12291f;color:#6ee7b7;white-space:nowrap" title="Hari libur mingguan">🌴 '+LIBUR_HARI[Number(x.liburHari)]+'</span>'
                : '<span class="muted">—</span>';
            tr.innerHTML = '<td>'+_no+'</td>'+
              '<td style="width:44px;padding-right:0">'+avatar+'</td>'+
              '<td><span class="kry-nama-link" data-uid="'+x.id+'" style="cursor:pointer;color:#f97316;text-decoration:underline;">'+dispNama+'</span>'+((!x.updatedAt)?' <span class="tag warn" title="Karyawan baru / belum direview owner. Klik Edit untuk cek gaji & jam kerja.">baru</span>':'')+(x.nonaktif===true?' <span class="tag" title="Sudah resign / dinonaktifkan. Tidak muncul di absensi harian & laporan Telegram.">Nonaktif</span>':'')+'</td>'+
              '<td><span style="color:var(--gg-text-2)">'+dispPgl+'</span></td>'+
              '<td>'+liburCell+'</td>'+
              '<td>'+(x.email||'-')+'</td>'+
              '<td>'+(x.phone||'-')+'</td>'+
              '<td>'+idDisplay+'</td>'+
              '<td>'+jamKerja+' jam</td>'+
              '<td>'+tjStr+'</td>'+
              '<td><button class="btn-link btn-edit-kar" data-uid="'+x.id+'">Edit</button> <button class="btn-link btn-del-kar" data-uid="'+x.id+'" data-nama="'+(x.nama||'')+'" style="color:#dc2626">Hapus</button></td>';
            tb.appendChild(tr);
        });
        document.querySelectorAll('.btn-edit-kar').forEach(b => {
            b.onclick = () => openEditKaryawan(b.dataset.uid);
        });
        document.querySelectorAll('.kry-nama-link').forEach(s => {
            s.onclick = () => showProfilKaryawan(s.dataset.uid);
        });
        document.querySelectorAll('.btn-del-kar').forEach(b => {
            b.onclick = () => deleteKaryawan(b.dataset.uid, b.dataset.nama);
        });
    } catch(e){ console.error('loadKaryawanList:', e); }
}

// Cek apakah panggilan (huruf kecil) sudah dipakai karyawan lain.
async function panggilanTaken(pgValue, excludeUid){
    return await DB.panggilanDipakai(pgValue, excludeUid);
}

// Nama panggilan: satu kata huruf kecil. Dulu diimpor dari firebase-config
// (normalizePanggilan); supabase-config menyediakan rapikanPanggilan dengan
// bentuk balikan berbeda, jadi dibungkus di sini biar kode di bawah tidak ganti.
function normalizePanggilan(mentah){
  const trim = String(mentah || '').trim();
  if (!trim) return { ok:false, value:'', error:'Nama panggilan wajib diisi.' };
  const kecil = trim.toLowerCase();
  if (/\s/.test(kecil)) return { ok:false, value:'', error:'Nama panggilan harus SATU kata (tanpa spasi).' };
  if (!/^[a-z0-9]+$/.test(kecil)) return { ok:false, value:'', error:'Nama panggilan cuma boleh huruf dan angka.' };
  return { ok:true, value:kecil, error:'' };
}
function suggestPanggilan(namaLengkap){
  return String(namaLengkap || '').trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g,'');
}

// CATATAN PINDAHAN: form "tambah karyawan manual" sudah dipensiunkan dari UI
// sejak lama (elemennya tidak ada di owner.html). Di versi Firebase sisa
// handler-nya masih bisa membuat akun login lewat secondary app. Di Supabase,
// bikin akun untuk orang lain butuh service role key — dan itu HARAM ditaruh di
// browser. Jalur resminya: karyawan daftar sendiri lewat halaman login pakai
// kode pendaftaran (fungsi daftar_karyawan di database).

// ============== EDIT KARYAWAN ==============
// Beberapa kotak isian di form ini BELUM punya kolom di skema Postgres:
// Status Karyawan, "wajib kode clock-out", dan "admin kode". Daripada
// kelihatan bisa disimpan padahal hilang diam-diam, kotaknya dimatikan dan
// dikasih keterangan. Lihat laporan.
const FIELD_BELUM_ADA_KOLOM = [
  ['editStatusKaryawan', 'Belum ada kolomnya di database — tunggu migrasi berikutnya.'],
  ['editWajibKode',      'Belum ada kolomnya di database — tunggu migrasi berikutnya.'],
  ['editKodeAdmin',      'Belum ada kolomnya di database — tunggu migrasi berikutnya.']
];
function matikanFieldTanpaKolom(){
  FIELD_BELUM_ADA_KOLOM.forEach(([id, ket]) => {
    const el = $(id);
    if (!el) return;
    el.disabled = true;
    el.title = ket;
    if (el.parentElement) el.parentElement.style.opacity = '.55';
  });
}

async function openEditKaryawan(uid){
    try {
        const d = await DB.karyawanSatu(uid);
        if (!d) { alert('Employee data not found.'); return; }
        $('editUid').value = uid;
        // editNama = nama lengkap (nama_lengkap), editNamaPanggilan = panggilan (kolom `nama`).
        $('editNama').value = d.full_name || d.nama || '';
        if ($('editNamaPanggilan')) $('editNamaPanggilan').value = d.namaPanggilan || d.nama || '';
        $('editPhone').value = d.phone || '';
        $('editIdKaryawan').value = d.idKaryawan || '';
        $('editJamKerja').value = d.jamKerja || 9;
        if ($('editTanggalJoin')) $('editTanggalJoin').value = d.tanggalJoin || '';
        // Tanggal lahir disimpan sebagai DATE (tanggal kalender, bukan momen
        // waktu) supaya ulang tahun tidak pernah geser gara-gara zona waktu.
        if ($('editTanggalLahir')) $('editTanggalLahir').value = d.tanggalLahir || '';
        if ($('editJabatan')) $('editJabatan').value = d.jabatan || '';
        if ($('editNonaktif')) $('editNonaktif').checked = (d.nonaktif === true);
        if ($('editKasbonAktif')) $('editKasbonAktif').checked = (d.kasbonAktif === true);
        if ($('editSpvAkses')) {
          // PR-CL98 versi baru: akses SPV = kolom peran, bukan flag terpisah.
          $('editSpvAkses').checked = (d.peran === 'spv');
          $('editSpvAkses').disabled = (d.peran === 'owner');
          if (d.peran === 'owner') $('editSpvAkses').title = 'Ini akun owner — perannya tidak diubah dari sini.';
        }
        if ($('editKasbonPlafon')) $('editKasbonPlafon').value = (d.kasbonPlafonPersen != null ? d.kasbonPlafonPersen : '');
        matikanFieldTanpaKolom();
        if ($('editLiburHari')) {
          $('editLiburHari').value = (d.liburHari != null ? String(d.liburHari) : '');
          try {
            const _all = await DB.karyawanSemua();
            const _cnt=[0,0,0,0,0,0,0], _nm=[[],[],[],[],[],[],[]];
            _all.forEach(k2 => { if (k2.id===uid) return; if (k2.nonaktif===true) return; if (k2.liburHari!=null){ const h=Number(k2.liburHari); if(h>=0&&h<=6){ _cnt[h]++; _nm[h].push(k2.namaPanggilan||k2.nama||'?'); } } });
            Array.from($('editLiburHari').options).forEach(opt => {
              if (opt.value==='') return; const h=Number(opt.value);
              opt.textContent = LIBUR_HARI[h] + (_cnt[h]>=LIBUR_MAX ? ' — PENUH ('+_nm[h].join(', ')+')' : _cnt[h]>0 ? ' — '+_cnt[h]+'/'+LIBUR_MAX+' ('+_nm[h].join(', ')+')' : ' — kosong');
            });
          } catch(e){ console.warn('libur quota label err', e); }
          const _reqEl = $('editLiburReq');
          if (_reqEl) _reqEl.style.display = 'none';   // usulan libur belum ada kolomnya
        }
        if ($('editBaseHarian')) $('editBaseHarian').value = d.baseHarian || '';
        if ($('editTunjangan')) $('editTunjangan').value = __fmtRpPlain(d.tunjanganBulanan); // PR-CL78/87
        if ($('editMultiplierLembur')) $('editMultiplierLembur').value = d.multiplierLembur || 1;
        if ($('editGpsExempt')) $('editGpsExempt').checked = !!d.gpsExempt;
        if ($('editNamaBank')) $('editNamaBank').value = d.namaBank || '';
        if ($('editAtasNamaRek')) $('editAtasNamaRek').value = d.atasNamaRek || '';
        if ($('editNomorRekening')) $('editNomorRekening').value = d.nomorRekening || '';
        // Status upload dokumen
        const setStat = (id, url) => { const el = $(id); if (el) el.textContent = url ? '✓ sudah diupload' : '(belum)'; };
        setStat('ktpStatus', d.ktpUrl);
        // ===== KTP preview + lock status profil =====
        (function(){
          var wrap = $('editKtpPreviewWrap');
          var img = $('editKtpPreview');
          var link = $('editKtpLink');
          if(wrap && img){
            if(d.ktpUrl){ img.src = d.ktpUrl; if(link) link.href = d.ktpUrl; wrap.style.display = 'block'; }
            else { img.src = ''; if(link) link.removeAttribute('href'); wrap.style.display = 'none'; }
          }
          var lockSpan = $('profilLockStatus');
          var resetBtn = $('btnResetLockProfil');
          var rekLocked = !!d.rekeningLocked;
          if(lockSpan) lockSpan.textContent = rekLocked ? 'Rekening: TERKUNCI' : 'Rekening: bisa diedit karyawan';
          if(resetBtn){
            resetBtn.style.display = rekLocked ? 'inline-block' : 'none';
            resetBtn.onclick = async function(){
              if(!confirm('Buka kunci REKENING karyawan ini? Dia bisa input ulang rekening 1x lalu kekunci lagi. Foto KTP TIDAK kena (tetap terkunci).')) return;
              resetBtn.disabled = true;
              try{
                await DB.simpanKaryawan(uid, { rekening_locked: false });
                if(lockSpan) lockSpan.textContent = 'Rekening: dibuka — karyawan bisa input ulang sekarang';
                resetBtn.style.display = 'none';
                alert('Kunci rekening dibuka. Karyawan bisa update rekeningnya (KTP tetap terkunci).');
              }catch(e){ alert('Gagal reset: ' + pesanRamah(e)); }
              finally{ resetBtn.disabled = false; }
            };
          }
        })();
        $('editKaryawanModal').classList.remove('hidden');
    } catch(e){ alert('Failed to load data: ' + pesanRamah(e)); }
}
$('btnEditCancel').onclick = () => $('editKaryawanModal').classList.add('hidden');

$('formEditKaryawan').onsubmit = async (e) => {
    e.preventDefault();
    const uid = $('editUid').value;
    const fullName = $('editNama').value.trim();      // nama lengkap -> nama_lengkap
    const pg = normalizePanggilan($('editNamaPanggilan') ? $('editNamaPanggilan').value : '');
    const phone = $('editPhone').value.trim();
    const idKaryawan = $('editIdKaryawan').value.trim();
    const jamKerja = parseInt($('editJamKerja').value, 10) || 9;
    const jabatan = $('editJabatan') ? $('editJabatan').value.trim() : '';
    const nonaktif = $('editNonaktif') ? $('editNonaktif').checked : false;
    const kasbonAktif = $('editKasbonAktif') ? $('editKasbonAktif').checked : false;
    const spvAkses = $('editSpvAkses') ? $('editSpvAkses').checked : false; // PR-CL98
    const _kbPl = $('editKasbonPlafon') ? parseInt($('editKasbonPlafon').value, 10) : NaN;
    const kasbonPlafonPersen = (isNaN(_kbPl) ? 50 : Math.max(0, Math.min(100, _kbPl)));
    const liburHari = ($('editLiburHari') && $('editLiburHari').value !== '') ? parseInt($('editLiburHari').value, 10) : null;
    const baseHarian = $('editBaseHarian') ? (parseInt($('editBaseHarian').value, 10) || 0) : 0;
    const tunjanganBulanan = $('editTunjangan') ? __parseRp($('editTunjangan').value) : 0; // PR-CL78/87
    const multiplierLembur = $('editMultiplierLembur') ? (parseFloat($('editMultiplierLembur').value) || 1) : 1;
    const gpsExempt = $('editGpsExempt') ? $('editGpsExempt').checked : false;
    const namaBank = $('editNamaBank') ? $('editNamaBank').value.trim() : '';
    const atasNamaRek = $('editAtasNamaRek') ? $('editAtasNamaRek').value.trim() : '';
    const nomorRekening = $('editNomorRekening') ? $('editNomorRekening').value.trim() : '';
    if (!fullName) { alert('Nama lengkap wajib diisi.'); return; }
    if (!pg.ok) { alert(pg.error); return; }
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Menyimpan...'; }
    try {
        if (await panggilanTaken(pg.value, uid)) { alert('Nama panggilan "' + pg.value + '" sudah dipakai karyawan lain. Pilih panggilan lain.'); if (submitBtn){ submitBtn.disabled=false; submitBtn.textContent='Simpan'; } return; }
        if (liburHari != null) {
          const _allL = await DB.karyawanSemua();
          let _c=0; const _nm=[];
          _allL.forEach(k2 => { if (k2.id===uid) return; if (k2.nonaktif===true) return; if (Number(k2.liburHari)===liburHari){ _c++; _nm.push(k2.namaPanggilan||k2.nama||'?'); } });
          if (_c >= LIBUR_MAX && !confirm('Hari ' + LIBUR_HARI[liburHari] + ' sudah penuh (' + _c + ' orang: ' + _nm.join(', ') + '). Yakin tetap tambah jadi ' + (_c+1) + '?')) { if (submitBtn){ submitBtn.disabled=false; submitBtn.textContent='Simpan'; } return; }
        }
        const tanggalJoinVal = $('editTanggalJoin') ? $('editTanggalJoin').value : '';
        const tanggalLahir = $('editTanggalLahir') ? ($('editTanggalLahir').value || '') : '';
        // Peran: owner TIDAK pernah diturunkan dari form ini (kotaknya juga
        // dimatikan waktu dibuka), supaya tidak ada owner yang tanpa sengaja
        // mengunci dirinya sendiri di luar dashboard.
        const lama = await DB.karyawanSatu(uid);
        const peran = (lama && lama.peran === 'owner') ? 'owner' : (spvAkses ? 'spv' : 'staff');
        const payload = {
            nama: pg.value, nama_lengkap: fullName, phone, id_karyawan: idKaryawan,
            jam_kerja: jamKerja,
            tanggal_masuk: tanggalJoinVal || null,
            tanggal_lahir: tanggalLahir || null,
            jabatan, base_harian: baseHarian, tunjangan_bulanan: tunjanganBulanan,
            multiplier_lembur: multiplierLembur, gps_exempt: gpsExempt,
            nama_bank: namaBank, nomor_rekening: nomorRekening, atas_nama_rek: atasNamaRek,
            nonaktif, kasbon_aktif: kasbonAktif, kasbon_plafon_persen: kasbonPlafonPersen,
            peran,
            libur_hari: liburHari
        };
        await DB.simpanKaryawan(uid, payload);
        $('editKaryawanModal').classList.add('hidden');
        loadKaryawanList();
    } catch(err){ alert('Gagal simpan: ' + pesanRamah(err)); }
    finally { if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Simpan'; } }
};

// ============== KARYAWAN SEDANG BEKERJA ==============
// CATATAN: elemen #workingNowList / #emptyWorking sudah tidak ada di
// owner.html (digantikan papan chip di Beranda), jadi fungsi ini praktis mati.
// Sengaja ditinggal — cuma sekarang dia berhenti SEBELUM query, biar tidak ada
// permintaan ke database buat sesuatu yang tidak pernah tampil.
function renderWorkingNow(rows, karyawanMap){
    const list = $('workingNowList');
    const empty = $('emptyWorking');
    if (!list || !empty) return;
    const latestByUid = {};
    rows.forEach(r => {
        const ms = r.ts && r.ts.toMillis ? r.ts.toMillis() : 0;
        if (!latestByUid[r.uid] || ms > (latestByUid[r.uid].ts.toMillis())) latestByUid[r.uid] = r;
    });
    const working = Object.values(latestByUid).filter(r => r.tipe === 'clock_in' || r.tipe === 'overtime_in' || r.tipe === 'break_in' || r.tipe === 'break_out');
    if (working.length === 0) {
        list.innerHTML = '';
        empty.textContent = 'No employees currently working.';
        return;
    }
    empty.textContent = '';
    list.innerHTML = working.map(r => {
        const k = karyawanMap[r.uid] || {};
        // Foto profil: path di ember absensi-profil, sudah diubah jadi link tayang di k.__foto.
        const photo = k.__foto || k.photoURL || '';
        const nama = k.nama || r.nama || String(r.uid).slice(0,6);
        let tipeLabel = TIPE[r.tipe] || r.tipe;
        let tipeColor = 'badge-green';
        if (r.tipe === 'overtime_in') tipeColor = 'badge-orange';
        else if (r.tipe === 'break_in') { tipeLabel = 'On Break'; tipeColor = 'badge-yellow'; }
        else if (r.tipe === 'break_out') { tipeLabel = 'Working'; tipeColor = 'badge-green'; }
        const avatar = photo
            ? '<img src="'+photo+'" alt="'+nama+'">'
            : '<div class="avatar-init">'+(nama[0]||'?').toUpperCase()+'</div>';
        const jam = r.ts.toDate().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
        return '<div class="working-item">' + avatar + '<div class="working-info"><b>'+nama+'</b><small>'+tipeLabel+' · '+jam+'</small></div><span class="badge '+tipeColor+'">'+tipeLabel+'</span></div>';
    }).join('');
}
function renderWorkingNowWithFetch(rows, daftarKaryawan){
    if (!$('workingNowList') || !$('emptyWorking')) return;   // elemennya tidak ada -> jangan buang query
    const map = {};
    (daftarKaryawan || []).forEach(k => map[k.id] = k);
    renderWorkingNow(rows, map);
}

// ===== Hapus Karyawan =====
async function deleteKaryawan(uid, nama){
    if (!uid){ alert('UID karyawan tidak valid.'); return; }
    const ok = confirm('Hapus karyawan "' + (nama||uid) + '"?\n\nIni akan menghapus baris karyawan BESERTA seluruh riwayat absensinya (relasi cascade di database).\n\nCATATAN: Akun login HARUS dihapus manual lewat Supabase Dashboard > Authentication > Users.');
    if (!ok) return;
    try{
        await DB.hapusKaryawan(uid);
        alert('Karyawan "' + (nama||uid) + '" berhasil dihapus.\n\nJangan lupa hapus akun login lewat Supabase Dashboard > Authentication.');
        loadKaryawanList();
    }catch(e){
        alert('Gagal hapus: ' + pesanRamah(e));
    }
}

// ===== Edit Absensi (Owner Only) =====
function openEditAbsen(docId, nama, tipe, tsIso){
    if (!docId){ alert('ID absen tidak ditemukan.'); return; }
    $('editAbsenId').value = docId;
    $('editAbsenNama').value = nama || '';
    $('editAbsenTipe').value = tipe || 'clock_in';
    if (tsIso){
        try{
            const d = new Date(tsIso);
            const hh = String(d.getHours()).padStart(2,'0');
            const mi = String(d.getMinutes()).padStart(2,'0');
            const ss = String(d.getSeconds()).padStart(2,'0');
            $('editAbsenDate').value = localDateStr(d);
            $('editAbsenTime').value = hh + ':' + mi + ':' + ss;
        }catch(e){}
    }
    $('editAbsenNote').value = '';
    $('editAbsenModal').classList.remove('hidden');
}
if ($('btnEditAbsenCancel')) $('btnEditAbsenCancel').onclick = ()=> $('editAbsenModal').classList.add('hidden');
if ($('formEditAbsen')) $('formEditAbsen').onsubmit = async (e)=>{
    e.preventDefault();
    const id = $('editAbsenId').value;
    const tipe = $('editAbsenTipe').value;
    const dateStr = $('editAbsenDate').value;
    const timeStr = $('editAbsenTime').value;
    const note = ($('editAbsenNote').value||'').trim();
    if (!id || !dateStr || !timeStr){ alert('Tanggal & Jam wajib diisi.'); return; }
    const newDate = new Date(dateStr + 'T' + timeStr);
    if (isNaN(newDate.getTime())){ alert('Format tanggal/jam tidak valid.'); return; }
    try{
        await DB.ubahEvent(id, {
            tipe: tipe,
            ts: newDate.toISOString(),
            catatan: note || null,
            dibuat_oleh: SAYA ? SAYA.id : null
        });
        $('editAbsenModal').classList.add('hidden');
        alert('Absensi berhasil di-update.');
        if (typeof loadData === 'function') loadData();
    }catch(err){
        alert('Gagal update: ' + pesanRamah(err));
    }
};

// ===== Hapus Absen (Owner Only) =====
let _pendingDeleteAbsenId = null;
function openDeleteAbsen(id, nama, tipe, tsIso){
    if (!id) return;
    const tipeLabel = TIPE[tipe] || tipe || '-';
    let tglStr = '-';
    try {
        if (tsIso){
            const d = new Date(tsIso);
            tglStr = d.toLocaleDateString('id-ID',{weekday:'long', day:'2-digit', month:'long', year:'numeric'}) +
                     ' jam ' + d.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',hour12:false});
        }
    }catch(e){}
    _pendingDeleteAbsenId = id;
    $('deleteAbsenId').value = id;
    $('deleteAbsenMsg').innerHTML = 'Yakin hapus event <strong>' + tipeLabel + '</strong> milik <strong>' + (nama||'-') + '</strong> pada ' + tglStr + '?<br><small style="color:#6b7280">Hanya event ini yang dihapus. Event lain (clock_in/out/break/lembur) milik karyawan ini tidak terpengaruh.</small>';
    $('deleteAbsenModal').classList.remove('hidden');
}

// Setup modal handlers (jalan sekali saat file load)
(function setupDeleteAbsenModal(){
    const cancelBtn = $('btnDeleteAbsenCancel');
    const confirmBtn = $('btnDeleteAbsenConfirm');
    const modal = $('deleteAbsenModal');
    if (cancelBtn){
        cancelBtn.onclick = ()=>{ _pendingDeleteAbsenId = null; if (modal) modal.classList.add('hidden'); };
    }
    if (confirmBtn){
        confirmBtn.onclick = async ()=>{
            const id = _pendingDeleteAbsenId || ($('deleteAbsenId') && $('deleteAbsenId').value);
            if (!id){ if (modal) modal.classList.add('hidden'); return; }
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Menghapus...';
            try {
                await DB.hapusEvent(id);
                console.log('[AUDIT] Absen dihapus oleh', SAYA && SAYA.nama, 'id=', id, 'pada', new Date().toISOString());
                _pendingDeleteAbsenId = null;
                if (modal) modal.classList.add('hidden');
                try { loadData(); } catch(e){}
            } catch(err){
                alert('Gagal hapus absen: ' + pesanRamah(err));
            } finally {
                confirmBtn.disabled = false;
                confirmBtn.textContent = 'Hapus';
            }
        };
    }
})();

// ============================================================================
// KEHADIRAN MATRIX (Hadirr-style)
// ============================================================================
// Dulu: tarik event kemarin + hari ini + besok pagi, lalu ~180 baris JavaScript
// buat menebak sesi mana milik hari mana (look-behind, look-ahead, buang ekor,
// normalisasi byTipe, tebak jam pulang yang lupa clock out).
// Sekarang: SEMUA itu dikerjakan f_sesi_kerja / f_rekap_harian / f_status_harian
// di database. Event mentah masih ditarik untuk SATU hari saja — bukan buat
// menghitung, tapi karena kolom Jam Masuk & Jam Keluar bisa diedit dan butuh
// id barisnya.
const MATRIX_COLS = [
  { tipe:'clock_in',     label:'Jam Masuk' },
  { tipe:'clock_out',    label:'Jam Keluar' },
  { tipe:'break_in',     label:'Istirahat' },
  { tipe:'break_out',    label:'Selesai Istirahat' },
  { tipe:'pause_in',     label:'Pause' },
  { tipe:'pause_out',    label:'Lanjut' },
  { tipe:'overtime_in',  label:'Lembur Masuk' },
  { tipe:'overtime_out', label:'Lembur Keluar' }
];

let currentKhDate = new Date();
let khRowsCache = {};

function fmtHM(d){
  if (!d) return '';
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}
// Durasi ms -> "2j 30mn" / "45mn" / "3j" (format lama, jangan diubah).
function fmtMsDur(ms){
  if (ms == null) return '0';
  if (ms < 0) ms = 0;
  const _m = Math.round(ms/60000);
  const _h = Math.floor(_m/60);
  const _mm = _m % 60;
  return _h === 0 ? _mm + 'mn' : (_mm === 0 ? _h + 'j' : _h + 'j ' + _mm + 'mn');
}
function pad2(n){ return String(n).padStart(2,'0'); }
function dateToInputStr(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }

function buildWeekNav(refDate){
  const wrap = $('khWeekNav'); if (!wrap) return;
  wrap.innerHTML = '';
  // Strip berpusat pada tanggal yang dipilih (center index 3 dari 7); geser kiri-kanan ikut. Ring biru = HARI INI.
  const today = new Date(); today.setHours(0,0,0,0);
  const ctr = new Date(refDate); ctr.setHours(0,0,0,0);
  const refStr = dateToInputStr(new Date(refDate));
  const todayStr = dateToInputStr(today);
  const wdNames = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
  for (let i=-3; i<=3; i++){
    const dd = new Date(ctr); dd.setDate(ctr.getDate() + i);
    const ddStr = dateToInputStr(dd);
    const btn = document.createElement('button');
    btn.type = 'button';
    let cls = 'kh-day-btn';
    if (ddStr === refStr) cls += ' active';
    if (ddStr === todayStr) cls += ' kh-day-today';
    btn.className = cls;
    btn.innerHTML = '<span class="kh-day-wd">'+wdNames[dd.getDay()]+'</span><span class="kh-day-num">'+dd.getDate()+'/'+(dd.getMonth()+1)+'</span>';
    btn.onclick = ()=>{ currentKhDate = dd; $('khDate').value = dateToInputStr(dd); loadKehadiranMatrix(); buildWeekNav(dd); };
    wrap.appendChild(btn);
  }
}

function initKehadiranMatrix(){
  const inp = $('khDate'); if (!inp) return;
  inp.value = dateToInputStr(currentKhDate);
  inp.onchange = ()=>{
    const v = inp.value;
    if (!v) return;
    const [y,m,dd] = v.split('-').map(Number);
    currentKhDate = new Date(y, m-1, dd);
    loadKehadiranMatrix();
  };
  const prev = $('khPrevDay'); if (prev) prev.onclick = ()=>{ const d=new Date(currentKhDate); d.setDate(d.getDate()-1); currentKhDate=d; inp.value=dateToInputStr(d); loadKehadiranMatrix(); };
  const next = $('khNextDay'); if (next) next.onclick = ()=>{ const d=new Date(currentKhDate); d.setDate(d.getDate()+1); currentKhDate=d; inp.value=dateToInputStr(d); loadKehadiranMatrix(); };
  const tdy  = $('khToday');   if (tdy)  tdy.onclick = ()=>{ currentKhDate=new Date(); inp.value=dateToInputStr(currentKhDate); loadKehadiranMatrix(); };
}

async function loadKehadiranMatrix(){
  try {
    const d = new Date(currentKhDate);
    buildWeekNav(d);
    const titleEl = $('khTitle');
    if (titleEl){
      titleEl.textContent = 'Kehadiran Harian | ' + d.toLocaleDateString('id-ID',{weekday:'long', day:'2-digit', month:'long', year:'numeric'});
    }
    const dStr = dateToInputStr(d);
    // Event mentah dijaring lebar 1 hari ke belakang & 2 hari ke depan supaya
    // sesi yang nembus tengah malam tetap kebawa. Yang menentukan event mana
    // milik hari ini adalah BATAS SESI dari database, bukan tebakan di browser.
    const lookBehind = new Date(d); lookBehind.setDate(lookBehind.getDate()-1); lookBehind.setHours(0,0,0,0);
    const lookAhead  = new Date(d); lookAhead.setDate(lookAhead.getDate()+2);  lookAhead.setHours(0,0,0,0);

    const [karyawan, rekap, status, sesi, events] = await Promise.all([
      DB.karyawanSemua(),
      DB.rekapHarian(dStr, dStr),
      DB.statusHarian(dStr),
      DB.sesiKerja(dStr, dStr),
      DB.events({ dari: lookBehind.toISOString(), sampai: lookAhead.toISOString(), urut: 'asc', batas: 6000 })
    ]);

    const byUid = {};
    karyawan.forEach(k => {
      byUid[k.id] = {
        uid: k.id,
        nama: k.nama || (k.email||'').split('@')[0] || '-',
        email: k.email || '',
        jamKerja: k.jamKerja,
        nonaktif: k.nonaktif,
        liburHari: k.liburHari,
        libur: (k.liburHari != null && Number(k.liburHari) === d.getDay()),
        events: [], byTipe: {}, rekap: null, status: 'belum_absen'
      };
    });

    const msOf = iso => iso ? new Date(iso).getTime() : 0;

    // Batas sesi hari ini per orang, langsung dari database.
    const batas = {};
    sesi.forEach(s => {
      const uid = s.karyawan_id;
      const mulai = msOf(s.ts_masuk);
      const akhir = msOf(s.ts_keluar) || msOf(s.ts_keluar_dugaan) || Date.now();
      if (!batas[uid]) batas[uid] = { mulai, akhir };
      else { batas[uid].mulai = Math.min(batas[uid].mulai, mulai); batas[uid].akhir = Math.max(batas[uid].akhir, akhir); }
    });

    rekap.forEach(r => { if (byUid[r.karyawan_id]) byUid[r.karyawan_id].rekap = r; });
    status.forEach(s => { if (byUid[s.karyawan_id]) byUid[s.karyawan_id].status = s.status; });

    // Event mentah -> masukkan ke pemiliknya, tapi HANYA yang jatuh di dalam
    // rentang sesi hari itu. Ini pengganti look-behind/look-ahead manual.
    events.forEach(ev => {
      const row = byUid[ev.uid];
      if (!row) return;
      const b = batas[ev.uid];
      if (!b) return;                                   // hari ini dia tidak punya sesi
      const t = ev.ts.toMillis();
      if (t < b.mulai || t > b.akhir) return;
      row.events.push(ev);
      if (!row.byTipe[ev.tipe]) row.byTipe[ev.tipe] = ev;
    });

    // Karyawan nonaktif (resign): sembunyikan dari matrix kecuali dia memang ada absen di hari ini.
    Object.keys(byUid).forEach(u=>{ const r = byUid[u]; if (r.nonaktif && !r.rekap) delete byUid[u]; });
    khRowsCache = byUid;
    renderKehadiranMatrix();
    renderKhSummary();
  } catch(err){
    console.error('loadKehadiranMatrix error:', err);
    alert('Gagal load kehadiran: ' + pesanRamah(err));
  }
}

function renderKhSummary(){
  const sum = $('khSummary'); if (!sum) return;
  const uids = Object.keys(khRowsCache);
  let working=0, onBreak=0, paused=0, finish=0, belum=0, hadir=0, libur=0;
  uids.forEach(u=>{
    const st = khRowsCache[u].status;
    if (st === 'libur'){ libur++; return; }
    if (st === 'belum_absen'){ belum++; return; }
    hadir++;
    if (st === 'selesai') finish++;
    else if (st === 'istirahat') onBreak++;
    else if (st === 'jeda') paused++;
    else working++;                    // 'berjalan' & 'lupa_clock_out'
  });
  sum.innerHTML =
    '<div class="kh-stat"><b>'+hadir+'</b><small>Hadir</small></div>'+
    '<div class="kh-stat"><b>'+working+'</b><small>On Working</small></div>'+
    '<div class="kh-stat"><b>'+onBreak+'</b><small>On Break</small></div>'+
    '<div class="kh-stat"><b>'+paused+'</b><small>Paused</small></div>'+
    '<div class="kh-stat"><b>'+finish+'</b><small>Finish</small></div>'+
    '<div class="kh-stat"><b>'+belum+'</b><small>Belum Hadir</small></div>'+
    '<div class="kh-stat"><b>'+libur+'</b><small>🌴 Libur</small></div>';
}

function gpsDotFor(row){
  const ci = row.byTipe['clock_in'];
  if (!ci || ci.inRadius === undefined || ci.inRadius === null) return '<span class="gps-dot gps-na" title="GPS tidak terdeteksi"></span>';
  if (ci.gpsExempt) return '<span class="gps-dot" title="GPS dilewati (HP lokasi bermasalah) — lokasi tidak diverifikasi" style="background:#60a5fa"></span>';
  return ci.inRadius
    ? '<span class="gps-dot gps-in" title="GPS dalam jangkauan ('+ (ci.jarak||0) +'m)"></span>'
    : '<span class="gps-dot gps-out" title="GPS di luar jangkauan ('+ (ci.jarak||0) +'m)"></span>';
}

function statusBadgeFor(row){
  switch (row.status){
    case 'selesai':        return '<span class="kh-badge kh-finish">Finished</span>';
    case 'istirahat':      return '<span class="kh-badge kh-break">Break</span>';
    case 'jeda':           return '<span class="kh-badge kh-pause">Paused</span>';
    case 'lupa_clock_out': return '<span class="kh-badge kh-lupa" title="Clock In lebih dari 18 jam tanpa Clock Out. Kemungkinan lupa Clock Out. Isi jam pulang di kolom Clock Out untuk koreksi.">⚠ Lupa Clock Out</span>';
    case 'berjalan':       return '<span class="kh-badge kh-working">Working</span>';
    case 'libur':          return '<span class="kh-badge kh-belum">Belum Hadir</span>';
    default:               return '<span class="kh-badge kh-belum">Belum Hadir</span>';
  }
}

function renderKehadiranMatrix(){
  const tb = document.querySelector('#tblKehadiranMatrix tbody');
  if (!tb) return;
  tb.innerHTML = '';
  const uids = Object.keys(khRowsCache).sort((a,b)=>{
    const na = (khRowsCache[a].nama||'').toLowerCase();
    const nb = (khRowsCache[b].nama||'').toLowerCase();
    return na.localeCompare(nb);
  });
  if (!uids.length){
    $('khEmpty').textContent = 'Belum ada record absensi pada tanggal ini.';
    return;
  }
  $('khEmpty').textContent = '';
  uids.forEach(uid=>{
    const row = khRowsCache[uid];
    const tr = document.createElement('tr');
    tr.dataset.uid = uid;

    // ===== Semua angka durasi datang dari database (f_rekap_harian) =====
    const R = row.rekap;
    const msOf = iso => iso ? new Date(iso).getTime() : 0;
    const _masukMs  = R ? msOf(R.jam_masuk) : 0;
    const _keluarMs = R ? msOf(R.jam_keluar) : 0;              // sudah termasuk jam pulang DUGAAN buat yang lupa clock out
    const _lupa     = !!(R && R.ada_lupa_clock_out);
    const _istMs    = R ? num(R.istirahat_menit) * 60000 : 0;
    const _jedaMs   = R ? num(R.jeda_menit) * 60000 : 0;
    const _spanMs   = (_masukMs && _keluarMs) ? Math.max(0, _keluarMs - _masukMs) : 0;
    const _efektifMs= (_masukMs && _keluarMs) ? (_spanMs - _istMs - _jedaMs) : 0;
    const _lemburMin= R ? Math.round(num(R.jam_lembur) * 60) : 0;
    // "Data perlu review": tap istirahat/pause yang kelihatan tidak wajar.
    const _durAnom  = (_istMs > 2*3600000) || (_jedaMs > 2*3600000) || (_efektifMs < 0);

    let cells = '<td class="col-nama">'+ gpsDotFor(row) +' '+ (row.nama||'-') + (row.nonaktif ? ' <span class="kh-badge" title="Sudah resign / dinonaktifkan">Nonaktif</span>' : '') + (row.libur ? ' <span class="kh-badge" style="background:#12291f;color:#6ee7b7" title="Dijadwalkan libur hari ini">🌴 Libur</span>' : '') +'</td>';
    cells += '<td>'+ statusBadgeFor(row) +'</td>';

    // --- Jam Masuk (bisa diedit) ---
    // Sengaja HANYA clock_in, sama seperti versi lama: kalau sesinya dibuka
    // pakai "Mulai Lembur" saja, kotak ini memang kosong.
    const evIn = row.byTipe['clock_in'];
    const valIn = evIn ? fmtHM(evIn.ts.toDate()) : '';
    cells += '<td><input type="text" inputmode="numeric" maxlength="5" placeholder="--:--" class="kh-time" data-tipe="clock_in" value="'+valIn+'" data-orig="'+valIn+'"></td>';

    // --- Jam Keluar (bisa diedit; kalau lupa clock out isinya jam DUGAAN) ---
    const evOut = row.byTipe['clock_out'] || row.byTipe['overtime_out'];
    const valOut = evOut ? fmtHM(evOut.ts.toDate()) : (_keluarMs ? fmtHM(new Date(_keluarMs)) : '');
    const autoTitle = (!evOut && _lupa) ? ' title="Jam keluar OTOMATIS (lupa Clock Out >18 jam). Dihitung dari durasi kontrak + istirahat. Edit untuk koreksi."' : '';
    const editedFlag = (!evOut && _lupa) ? ' kh-edited' : '';
    cells += '<td><input type="text" inputmode="numeric" maxlength="5" placeholder="--:--" class="kh-time'+editedFlag+'" data-tipe="clock_out" value="'+valOut+'" data-orig="'+valOut+'"'+autoTitle+'></td>';

    // --- Total Kerja / Kerja Efektif / Dur. Istirahat / Dur. Pause / Dur. Lembur ---
    cells += '<td class="kh-dur" title="Total Kerja">'+ (_spanMs ? fmtMsDur(_spanMs) : '0') +'</td>';
    cells += '<td class="kh-dur" title="Kerja Efektif (Total Kerja - istirahat - pause)">'+ (_masukMs && _keluarMs ? fmtMsDur(_efektifMs) : '0') +'</td>';
    cells += '<td class="kh-dur kh-istirahat-cell" title="Dur. Istirahat">'+ fmtMsDur(_istMs) +'</td>';
    cells += '<td class="kh-dur" title="Dur. Pause">'+ fmtMsDur(_jedaMs) +'</td>';
    const _lemHHMM = (min)=>{ if(min==null) return '0:00'; if(min<0) min=0; return Math.floor(min/60)+':'+String(Math.round(min%60)).padStart(2,'0'); };
    const _anomMark = _durAnom ? ' kh-anom' : '';
    const _anomTitle = _durAnom ? ' (DATA PERLU REVIEW: tap istirahat/pause tidak lengkap)' : '';
    cells += '<td class="kh-dur kh-lembur-cell'+_anomMark+'" title="Dur. Lembur'+_anomTitle+'">'+(_anomMark?'⚠ ':'')+_lemHHMM(_lemburMin)+'</td>';

    cells += '<td class="col-aksi">'+
             '<button class="btn btn-sm btn-primary kh-save-row">Simpan</button>'+
             '<button class="btn btn-sm btn-ghost kh-delete-row" title="Hapus semua record karyawan ini di tanggal ini">Hapus</button>'+
             '</td>';
    tr.innerHTML = cells;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.kh-save-row').forEach(btn=>{
    btn.onclick = (e)=>{ const tr = e.target.closest('tr'); saveKehadiranRow(tr.dataset.uid, tr); };
  });
  tb.querySelectorAll('.kh-delete-row').forEach(btn=>{
    btn.onclick = (e)=>{ const tr = e.target.closest('tr'); deleteKehadiranRow(tr.dataset.uid); };
  });
  // === Auto-save per cell on change ===
  tb.querySelectorAll('input.kh-time').forEach(inp=>{
    inp.addEventListener('change', async ()=>{
      const tr = inp.closest('tr');
      if(!tr) return;
      await saveSingleKehadiranCell(tr.dataset.uid, inp);
    });
  });
}

// Normalisasi ketikan jam jadi HH:MM. Balikan null kalau tidak masuk akal.
function rapikanJam(mentah){
  let v = String(mentah || '').trim();
  let m1 = v.match(/^(\d):(\d{1,2})$/);
  if (m1) v = '0' + m1[1] + ':' + (m1[2].length===1 ? '0'+m1[2] : m1[2]);
  let m2 = v.match(/^(\d{2}):(\d)$/);
  if (m2) v = m2[1] + ':0' + m2[2];
  if (/^\d+$/.test(v)){
    if (v.length === 1) v = '0' + v + ':00';
    else if (v.length === 2) v = v + ':00';
    else if (v.length === 3) v = '0' + v[0] + ':' + v.slice(1);
    else if (v.length === 4) v = v.slice(0,2) + ':' + v.slice(2);
  }
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null;
}

// Jam yang diketik owner -> timestamp. Shift lintas tengah malam: kalau jam
// KELUAR lebih awal dari jam MASUK-nya, otomatis digeser ke besok.
function waktuDariKetikan(row, tipe, hhmm){
  const [hh,mm] = hhmm.split(':').map(Number);
  const ts = new Date(currentKhDate);
  ts.setHours(hh||0, mm||0, 0, 0);
  const OUT_PAIRS = { clock_out:'clock_in', break_out:'break_in', pause_out:'pause_in', overtime_out:'overtime_in' };
  const inTipe = OUT_PAIRS[tipe];
  if (inTipe){
    const inEv = row.byTipe && row.byTipe[inTipe];
    if (inEv && ts.getTime() < inEv.ts.toMillis()) ts.setDate(ts.getDate() + 1);
  }
  return ts;
}

// === Auto-save satu cell di matrix Kehadiran Harian (tanpa tombol Simpan) ===
async function saveSingleKehadiranCell(uid, inp){
    const row = khRowsCache[uid];
    if(!row){ console.warn('saveSingleKehadiranCell: row tidak ditemukan', uid); return; }
    const tipe = inp.dataset.tipe;
    const newVal = (inp.value||'').trim();
    const origVal = inp.dataset.orig || '';
    if(newVal === origVal) return;
    inp.classList.remove('kh-saved','kh-save-err');
    inp.classList.add('kh-saving');
    try{
        // Jam Keluar boleh berisi clock_out ATAU overtime_out (Selesai Lembur);
        // Jam Masuk selalu clock_in.
        const existing = (tipe === 'clock_out')
          ? (row.byTipe['clock_out'] || row.byTipe['overtime_out'])
          : row.byTipe[tipe];
        if(newVal === ''){
            if(existing) await DB.hapusEvent(existing._id);
        } else {
            const jam = rapikanJam(newVal);
            if (!jam){
              inp.classList.remove('kh-saving');
              inp.classList.add('kh-save-err');
              setTimeout(()=>inp.classList.remove('kh-save-err'), 1500);
              inp.value = origVal;
              return;
            }
            inp.value = jam;
            const newTs = waktuDariKetikan(row, tipe, jam);
            if(existing){
                await DB.ubahEvent(existing._id, { ts: newTs.toISOString(), dibuat_oleh: SAYA ? SAYA.id : null });
            } else {
                await DB.tambahEvent({
                    karyawan_id: row.uid,
                    tipe: tipe,
                    ts: newTs.toISOString(),
                    catatan: 'diinput manual oleh owner',
                    dibuat_oleh: SAYA ? SAYA.id : null
                });
            }
        }
        inp.classList.remove('kh-saving');
        inp.classList.add('kh-saved');
        inp.dataset.orig = newVal;
        setTimeout(()=>inp.classList.remove('kh-saved'), 1500);
        try{ await loadKehadiranMatrix(); }catch(e){ console.warn('reload matrix after save err', e); }
    }catch(err){
        console.error('saveSingleKehadiranCell err', err);
        inp.classList.remove('kh-saving');
        inp.classList.add('kh-save-err');
        alert('Gagal simpan: '+pesanRamah(err));
        inp.value = origVal;
        setTimeout(()=>inp.classList.remove('kh-save-err'), 2500);
    }
}

async function saveKehadiranRow(uid, tr){
  const row = khRowsCache[uid];
  if (!row){ alert('Data karyawan tidak ditemukan.'); return; }
  const inputs = tr.querySelectorAll('input.kh-time');
  const changes = [];
  inputs.forEach(inp=>{
    const newVal = (inp.value||'').trim();
    const origVal = inp.dataset.orig || '';
    if (newVal === origVal) return;
    changes.push({ inp, tipe: inp.dataset.tipe, newVal, origVal });
  });
  if (!changes.length){ alert('Tidak ada perubahan.'); return; }
  if (!confirm('Simpan '+changes.length+' perubahan untuk '+(row.nama||uid)+'?')) return;
  let okCount = 0, errCount = 0;
  for (const ch of changes){
    try{
      const existing = (ch.tipe === 'clock_out')
        ? (row.byTipe['clock_out'] || row.byTipe['overtime_out'])
        : row.byTipe[ch.tipe];
      if (ch.newVal === '' && existing){
        await DB.hapusEvent(existing._id);
        okCount++;
      } else if (ch.newVal !== ''){
        const jam = rapikanJam(ch.newVal);
        if (!jam){ errCount++; continue; }
        const newTs = waktuDariKetikan(row, ch.tipe, jam);
        if (existing){
          await DB.ubahEvent(existing._id, { ts: newTs.toISOString(), dibuat_oleh: SAYA ? SAYA.id : null });
        } else {
          await DB.tambahEvent({
            karyawan_id: row.uid, tipe: ch.tipe, ts: newTs.toISOString(),
            catatan: 'diinput manual oleh owner', dibuat_oleh: SAYA ? SAYA.id : null
          });
        }
        okCount++;
      }
    }catch(e){
      console.error('save change err', ch, e);
      errCount++;
    }
  }
  alert('Selesai. Berhasil: '+okCount+', Gagal: '+errCount);
  await loadKehadiranMatrix();
}

async function deleteKehadiranRow(uid){
  const row = khRowsCache[uid];
  if (!row){ return; }
  if (!confirm('Hapus SEMUA record absensi milik '+(row.nama||uid)+' pada tanggal ini? Aksi ini tidak bisa di-undo.')) return;
  let ok=0,err=0;
  for (const ev of row.events){
    try{ await DB.hapusEvent(ev._id); ok++; }catch(e){err++;}
  }
  alert('Selesai. Dihapus: '+ok+', Gagal: '+err);
  await loadKehadiranMatrix();
}

/* ===========================================================
   REKAP KEHADIRAN (Hadirr-style) — date range summary per user
   ===========================================================
   INI yang dulu paling berat: 30 hari x 150 karyawan = ±27.000 dokumen absensi
   ditarik ke browser, lalu dipasang-pasangkan sendiri pakai JavaScript.
   Sekarang yang datang adalah SESI KERJA yang sudah jadi dari f_sesi_kerja —
   satu baris per sesi (±1 per orang per hari), lengkap dengan jam efektif,
   lembur, istirahat, dan jeda yang sudah dihitung Postgres. Browser tinggal
   menjumlahkan per orang.
   =========================================================== */
let rekapRangeFrom = null;
let rekapRangeTo = null;
let rekapDataCache = [];

function initRekap(){
  const elFrom = document.getElementById('rekapFrom');
  const elTo   = document.getElementById('rekapTo');
  const elSearch = document.getElementById('rekapSearch');
  const elLoad = document.getElementById('btnRekapLoad');
  const elExport = document.getElementById('btnRekapExport');
  const elQuickMonth = document.getElementById('btnRekapMonth');
  const elQuickWeek  = document.getElementById('btnRekapWeek');
  const elQuickToday = document.getElementById('btnRekapToday');
  if (!elFrom || !elTo) return;
  const today = new Date();
  const from30 = new Date(today); from30.setDate(from30.getDate()-29);
  if (!elFrom.value) elFrom.value = ymdR(from30);
  if (!elTo.value)   elTo.value   = ymdR(today);
  if (elLoad)   elLoad.onclick   = ()=>loadRekap();
  if (elExport) elExport.onclick = ()=>exportRekapCSV();
  if (elSearch) elSearch.oninput = ()=>renderRekap();
  if (elQuickMonth) elQuickMonth.onclick = ()=>{
    const t = new Date(); const a = new Date(t.getFullYear(),t.getMonth(),1);
    elFrom.value = ymdR(a); elTo.value = ymdR(t); loadRekap();
  };
  if (elQuickWeek) elQuickWeek.onclick = ()=>{
    const t = new Date(); const a = new Date(t); a.setDate(a.getDate()-6);
    elFrom.value = ymdR(a); elTo.value = ymdR(t); loadRekap();
  };
  if (elQuickToday) elQuickToday.onclick = ()=>{
    const t = new Date(); elFrom.value = ymdR(t); elTo.value = ymdR(t); loadRekap();
  };
}

function ymdR(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const dd= String(d.getDate()).padStart(2,'0');
  return y+'-'+m+'-'+dd;
}

function fmtHMr(totalMs){
  if (!totalMs || totalMs < 0) return '0';
  const totalMin = Math.floor(totalMs/60000);
  const h = Math.floor(totalMin/60);
  const m = totalMin % 60;
  return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
}

async function loadRekap(){
  const elFrom = document.getElementById('rekapFrom');
  const elTo   = document.getElementById('rekapTo');
  const elTitle= document.getElementById('rekapTitle');
  const tbody  = document.querySelector('#tblRekap tbody');
  if (!elFrom || !elTo || !tbody) return;
  const fromStr = elFrom.value;
  const toStr   = elTo.value;
  if (!fromStr || !toStr){ alert('Pilih rentang tanggal'); return; }
  if (fromStr > toStr){ alert('Tanggal "Dari" harus sebelum "Sampai"'); return; }
  rekapRangeFrom = fromStr; rekapRangeTo = toStr;
  if (elTitle) elTitle.textContent = 'Ringkasan Kehadiran: ' + fromStr + ' s/d ' + toStr;
  tbody.innerHTML = '<tr><td colspan="10" class="muted center">Memuat data...</td></tr>';
  try {
    const [sesi, karyawan] = await Promise.all([
      DB.sesiKerja(fromStr, toStr),
      DB.karyawanSemua()
    ]);
    const namaMap = new Map();
    karyawan.forEach(k => namaMap.set(k.id, k.namaPanggilan || k.nama || '-'));

    const per = new Map();
    for (const s of sesi){
      const uid = s.karyawan_id;
      if (!per.has(uid)) per.set(uid, {
        uid, nama: namaMap.get(uid) || '-', hari: new Set(),
        jamKerjaMs: 0, jamIstirahatMs: 0, jamLemburMs: 0,
        terlambat: 0, belumLengkap: 0, totalEvents: 0
      });
      const r = per.get(uid);
      r.hari.add(s.tanggal_kerja);
      r.totalEvents += num(s.jml_event);
      r.jamLemburMs += num(s.jam_lembur) * 3600000;
      const belumTutup = !s.ts_keluar || s.lupa_clock_out === true;
      if (belumTutup){
        r.belumLengkap++;                       // masuk tapi tidak ada Clock Out
      } else {
        // jam_efektif_mentah = (jam keluar - jam masuk) - istirahat - jeda,
        // BELUM dipagari jam kontrak — sama seperti hitungan halaman ini dulu.
        r.jamKerjaMs      += num(s.jam_efektif_mentah) * 3600000;
        r.jamIstirahatMs  += (num(s.istirahat_menit) + num(s.jeda_menit)) * 60000;
      }
    }
    const rows = Array.from(per.values()).map(r => ({
      uid: r.uid, nama: r.nama, hariHadir: r.hari.size,
      jamKerjaMs: r.jamKerjaMs, jamIstirahatMs: r.jamIstirahatMs, jamLemburMs: r.jamLemburMs,
      terlambat: r.terlambat, belumLengkap: r.belumLengkap, totalEvents: r.totalEvents
    }));
    rows.sort((a,b)=>a.nama.localeCompare(b.nama));
    rekapDataCache = rows;
    renderRekap();
    renderRekapSummary();
  } catch(e){
    console.error('loadRekap error', e);
    tbody.innerHTML = '<tr><td colspan="10" class="muted center" style="color:#dc2626">Gagal memuat data: '+pesanRamah(e)+'</td></tr>';
  }
}

function renderRekapSummary(){
  const el = document.getElementById('rekapSummary');
  if (!el) return;
  const rows = rekapDataCache;
  const totalKaryawan = rows.length;
  let totalHari = 0, totalKerja = 0, totalIstirahat = 0, totalLembur = 0, totalTelat = 0;
  for (const r of rows){
    totalHari += r.hariHadir;
    totalKerja += r.jamKerjaMs;
    totalIstirahat += r.jamIstirahatMs;
    totalLembur += r.jamLemburMs;
    totalTelat += r.terlambat;
  }
  el.innerHTML =
    '<div class="kh-stat"><div class="muted small">Karyawan</div><div class="stat-num">'+totalKaryawan+'</div></div>'+
    '<div class="kh-stat"><div class="muted small">Total Hari Hadir</div><div class="stat-num">'+totalHari+'</div></div>'+
    '<div class="kh-stat"><div class="muted small">Total Jam Kerja</div><div class="stat-num">'+fmtHMr(totalKerja)+'</div></div>'+
    '<div class="kh-stat"><div class="muted small">Total Istirahat</div><div class="stat-num">'+fmtHMr(totalIstirahat)+'</div></div>'+
    '<div class="kh-stat"><div class="muted small">Total Lembur</div><div class="stat-num">'+fmtHMr(totalLembur)+'</div></div>'+
    '<div class="kh-stat"><div class="muted small">Telat (hari)</div><div class="stat-num">'+totalTelat+'</div></div>';
}

function renderRekap(){
  const tbody = document.querySelector('#tblRekap tbody');
  const empty = document.getElementById('rekapEmpty');
  const search = (document.getElementById('rekapSearch')?.value || '').toLowerCase().trim();
  if (!tbody) return;
  const rows = rekapDataCache.filter(r => !search || r.nama.toLowerCase().includes(search));
  if (rows.length === 0){
    tbody.innerHTML = '';
    if (empty) empty.textContent = 'Tidak ada data pada rentang ini.';
    return;
  }
  if (empty) empty.textContent = '';
  tbody.innerHTML = rows.map((r,i)=>
      '<tr data-uid="'+(r.uid||'')+'" data-nama="'+((r.nama||'').replace(/"/g,'&quot;'))+'" class="rekap-row-clickable">'+
        '<td>'+(i+1)+'</td>'+
        '<td>'+r.nama+'</td>'+
        '<td class="num">'+r.hariHadir+'</td>'+
        '<td class="num">'+fmtHMr(r.jamKerjaMs)+'</td>'+
        '<td class="num">'+fmtHMr(r.jamIstirahatMs)+'</td>'+
        '<td class="num">'+fmtHMr(r.jamLemburMs)+'</td>'+
        '<td class="num">'+r.terlambat+'</td>'+
        '<td class="num">'+r.belumLengkap+'</td>'+
        '<td class="num">'+r.totalEvents+'</td>'+
        '<td><button class="btn btn-sm btn-primary btn-rekap-detail" data-uid="'+(r.uid||'')+'" data-nama="'+((r.nama||'').replace(/"/g,'&quot;'))+'">Detail</button></td>'+
      '</tr>'
    ).join('');
    tbody.querySelectorAll('.btn-rekap-detail').forEach(b=>{
      b.onclick = (e)=>{ e.stopPropagation(); openRekapDetail(b.dataset.uid, b.dataset.nama); };
    });
    tbody.querySelectorAll('tr.rekap-row-clickable').forEach(tr=>{
      tr.style.cursor='pointer';
      tr.onclick = ()=> openRekapDetail(tr.dataset.uid, tr.dataset.nama);
    });
}

function exportRekapCSV(){
  if (!rekapDataCache.length){ alert('Belum ada data untuk diekspor. Klik Tampilkan terlebih dahulu.'); return; }
  const elFrom = document.getElementById('rekapFrom');
  const elTo   = document.getElementById('rekapTo');
  const headers = ['No','Nama','Hari Hadir','Jam Kerja','Jam Istirahat','Jam Lembur','Terlambat (Hari)','Belum Lengkap','Total Event'];
  const lines = [headers.join(',')];
  rekapDataCache.forEach((r,i)=>{
    const cells = [
      i+1,
      '"'+r.nama.replace(/"/g,'""')+'"',
      r.hariHadir,
      fmtHMr(r.jamKerjaMs),
      fmtHMr(r.jamIstirahatMs),
      fmtHMr(r.jamLemburMs),
      r.terlambat,
      r.belumLengkap,
      r.totalEvents
    ];
    lines.push(cells.join(','));
  });
  const csv = '﻿' + lines.join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'rekap-kehadiran_'+(elFrom?.value||'')+'_'+(elTo?.value||'')+'.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

// ===== Rekap Detail Modal (drill-down per karyawan) =====
// Bedanya dari versi lama: event mentah SATU ORANG baru ditarik pas modalnya
// dibuka. Dulu semua event semua orang dicache di browser cuma buat jaga-jaga
// kalau owner mengklik salah satu baris.
let rekapDetailEvents = [];
async function openRekapDetail(uid, nama){
    const modal = document.getElementById('rekapDetailModal');
    const title = document.getElementById('rekapDetailTitle');
    const tbody = document.querySelector('#tblRekapDetail tbody');
    const empty = document.getElementById('rekapDetailEmpty');
    if(!modal || !tbody) return;
    const from = rekapRangeFrom || document.getElementById('rekapFrom')?.value || '';
    const to   = rekapRangeTo   || document.getElementById('rekapTo')?.value || '';
    if(title) title.textContent = 'Detail Kehadiran: ' + (nama||'-') + ' (' + from + ' s/d ' + to + ')';
    tbody.innerHTML = '<tr><td colspan="5" class="muted center">Memuat...</td></tr>';
    modal.classList.remove('hidden');

    let events = [];
    try {
      events = await DB.events({
        dari: new Date(from + 'T00:00:00').toISOString(),
        sampai: new Date(to + 'T23:59:59.999').toISOString(),
        karyawanId: uid, urut: 'asc', batas: 2000
      });
    } catch(e){
      tbody.innerHTML = '<tr><td colspan="5" class="muted center" style="color:#dc2626">Gagal memuat: '+pesanRamah(e)+'</td></tr>';
      return;
    }
    rekapDetailEvents = events;

    if(events.length===0){
        tbody.innerHTML = '';
        if(empty) empty.textContent = 'Tidak ada event untuk karyawan ini pada rentang tanggal.';
        return;
    }
    if(empty) empty.textContent = '';
    const TIPE_LOCAL = { clock_in:'Clock In', clock_out:'Clock Out', break_in:'Istirahat', break_out:'Selesai Istirahat', overtime_in:'Mulai Lembur', overtime_out:'Selesai Lembur' };
    tbody.innerHTML = events.map(ev=>{
        const d = ev.ts.toDate();
        const tgl = localDateStr(d);
        const jam = String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0');
        const opts = ['clock_in','clock_out','break_in','break_out','overtime_in','overtime_out']
            .map(v=>'<option value="'+v+'"'+(v===(ev.tipe||'')?' selected':'')+'>'+(TIPE_LOCAL[v]||v)+'</option>').join('');
        const status = ev.inRadius===true ? '<span class="badge-loc badge-in">In Office</span>' : (ev.inRadius===false ? '<span class="badge-loc badge-out">Out of Radius</span>' : '<span class="muted small">-</span>');
        return '<tr data-id="'+ev._id+'">'+
            '<td><input type="date" class="rd-edit-tgl" data-id="'+ev._id+'" value="'+tgl+'"></td>'+
            '<td><input type="text" inputmode="numeric" maxlength="5" placeholder="--:--" class="rd-edit-jam" data-id="'+ev._id+'" value="'+(jam||'').slice(0,5)+'"></td>'+
            '<td><select class="rd-edit-tipe" data-id="'+ev._id+'">'+opts+'</select></td>'+
            '<td>'+status+'</td>'+
            '<td><button class="btn-link rd-hapus" data-id="'+ev._id+'" data-nama="'+(nama||'').replace(/"/g,'&quot;')+'" data-tipe="'+(ev.tipe||'')+'" style="color:#dc2626">🗑️ Hapus</button></td>'+
        '</tr>';
    }).join('');
    tbody.querySelectorAll('.rd-edit-jam').forEach(inp=>{
        inp._origVal = inp.value;
        inp.onchange = async ()=>{
            const id = inp.dataset.id;
            const tglInput = tbody.querySelector('.rd-edit-tgl[data-id="'+id+'"]');
            const tglVal = tglInput ? tglInput.value : '';
            const jamVal = inp.value;
            if(!id || !tglVal || !jamVal){ alert('Tanggal/Jam tidak valid'); inp.value = inp._origVal; return; }
            try{
                const newDate = new Date(tglVal + 'T' + jamVal);
                if(isNaN(newDate.getTime())){ alert('Format jam tidak valid'); inp.value = inp._origVal; return; }
                inp.classList.add('kh-saving');
                await DB.ubahEvent(id, { ts: newDate.toISOString(), dibuat_oleh: SAYA ? SAYA.id : null });
                inp.classList.remove('kh-saving'); inp.classList.add('kh-saved');
                setTimeout(()=>inp.classList.remove('kh-saved'), 1200);
                inp._origVal = inp.value;
            }catch(err){
                console.error('rd edit jam err', err);
                inp.classList.remove('kh-saving');
                alert('Gagal simpan jam: '+pesanRamah(err));
                inp.value = inp._origVal;
            }
        };
    });
    tbody.querySelectorAll('.rd-edit-tgl').forEach(inp=>{
        inp._origVal = inp.value;
        inp.onchange = ()=>{
            const id = inp.dataset.id;
            const j = tbody.querySelector('.rd-edit-jam[data-id="'+id+'"]');
            if(j) j.dispatchEvent(new Event('change'));
        };
    });
    tbody.querySelectorAll('.rd-edit-tipe').forEach(sel=>{
        sel._origVal = sel.value;
        sel.onchange = async ()=>{
            const id = sel.dataset.id;
            const newTipe = sel.value;
            if(!id || !newTipe){ sel.value = sel._origVal; return; }
            try{
                sel.classList.add('kh-saving');
                await DB.ubahEvent(id, { tipe: newTipe, dibuat_oleh: SAYA ? SAYA.id : null });
                sel.classList.remove('kh-saving'); sel.classList.add('kh-saved');
                setTimeout(()=>sel.classList.remove('kh-saved'), 1200);
                sel._origVal = sel.value;
            }catch(err){
                console.error('rd edit tipe err', err);
                sel.classList.remove('kh-saving');
                alert('Gagal simpan tipe: '+pesanRamah(err));
                sel.value = sel._origVal;
            }
        };
    });
    tbody.querySelectorAll('.rd-hapus').forEach(b=>{
        b.onclick = async ()=>{
            const id = b.dataset.id;
            const nm = b.dataset.nama;
            const tipe = b.dataset.tipe;
            const lbl = TIPE[tipe] || tipe;
            if(!confirm('Hapus event '+lbl+' milik '+nm+'?\n\nHanya event ini yang dihapus. Event lain tidak terpengaruh.')) return;
            try{
                b.disabled = true; b.textContent = '...';
                await DB.hapusEvent(id);
                b.closest('tr').remove();
                try{ loadRekap(); }catch(e){}
            }catch(err){
                console.error('rd hapus err', err);
                alert('Gagal hapus: '+pesanRamah(err));
                b.disabled = false; b.textContent = '🗑️ Hapus';
            }
        };
    });
}
function closeRekapDetail(){
    document.getElementById('rekapDetailModal')?.classList.add('hidden');
}
document.addEventListener('DOMContentLoaded', ()=>{
    const closeBtn = document.getElementById('btnRekapDetailClose');
    if(closeBtn) closeBtn.onclick = closeRekapDetail;
    const modal = document.getElementById('rekapDetailModal');
    if(modal) modal.addEventListener('click', (e)=>{ if(e.target===modal) closeRekapDetail(); });
});

// Click logo brand untuk refresh halaman
(function(){
  const lg = document.getElementById('brandLogo');
  if (lg) lg.addEventListener('click', () => { window.location.reload(); });
})();

// ============================================================
// PAYROLL MODULE — gaji harian, dibayar bulanan
// ============================================================
// PR-CL87: input rupiah sering diketik pakai titik (1.750.000). Dulu kotaknya
// type=number jadi browser NOLAK isinya -> value kosong -> kesimpen 0 tanpa
// pesan error. Sekarang kotaknya text dan angkanya disaring di sini.
function __parseRp(v){ const d = String(v == null ? '' : v).replace(/[^0-9]/g, ''); return d ? parseInt(d, 10) : 0; }

// ===== PR-CL89: badge JABATAN + foto profil di tabel Payroll =====
// Kosakata jabatan disamain sama role di WMS biar sekali lihat langsung nyambung.
const PR_ROLE_STYLE = {
  'owner':        ['#3a2f12', '#fcd34d'],
  'kepala gudang':['#3b1d1d', '#fca5a5'],
  'superadmin':   ['#16233a', '#93c5fd'],
  'admin':        ['#0f2e2a', '#5eead4'],
  'operational':  ['#241a3a', '#c4b5fd'],
  'host live':    ['#331a2b', '#f9a8d4'],
  'packer':       ['#2a2118', '#fdba74'],
  'sourcing':     ['#1f2937', '#cbd5e1'],
  'trial':        ['#3a2f12', '#fbbf24']
};
// Cadangan: diambil dari role WMS per 30 Jul 2026, dipakai HANYA kalau field
// "Jabatan" di menu Karyawan masih kosong. Kalau ada yang pindah peran, isi
// field Jabatan-nya — itu selalu menang atas daftar ini.
// CATATAN: daftar nama di bawah ini bawaan GoodGems, bukan Kopikiri. Sengaja
// tidak dihapus (jiplak 1:1), tapi lihat laporan.
const PR_ROLE_SEED = {
  mila: 'superadmin', desti: 'admin', ila: 'admin',
  bunga: 'operational', rafi: 'operational', restu: 'operational',
  bahren: 'packer', dinda: 'packer', itang: 'packer', rafihm: 'packer',
  resta: 'packer', rifki: 'packer', yani: 'packer', naufal: 'sourcing'
};
function __prRole(r){
  const raw = String(r.jabatan || '').trim().toLowerCase();
  if (raw){
    if (raw.includes('kepala') || raw.includes('gudang')) return 'kepala gudang';
    if (raw.includes('superadmin') || raw.includes('super admin')) return 'superadmin';
    if (raw.includes('owner')) return 'owner';
    if (raw.includes('host')) return 'host live';
    if (raw.includes('admin')) return 'admin';
    if (raw.includes('operational') || raw.includes('operasional') || raw.includes('ops')) return 'operational';
    if (raw.includes('packer') || raw.includes('picker')) return 'packer';
    if (raw.includes('sourcing')) return 'sourcing';
    if (raw.includes('trial')) return 'trial';
    return raw;
  }
  const key = String(r.namaPanggilan || r.nama || '').trim().toLowerCase();
  return PR_ROLE_SEED[key] || '';
}
function __prRoleBadge(r){
  const role = __prRole(r);
  if (!role) return '';
  const st = PR_ROLE_STYLE[role] || ['#262626', '#a3a3a3'];
  return '<span class="pr-role-badge" style="background:' + st[0] + ';color:' + st[1] + '">' + role.toUpperCase() + '</span>';
}
// Foto profil sekarang satu kolom (karyawan.foto_url) — tidak perlu lagi
// menembak koleksi 'profil' satu per satu seperti versi Firebase.
function __prAvatar(r){
  const src = r.photoURL || '';
  if (src) return '<img class="pr-ava" src="' + src + '" alt="" loading="lazy" referrerpolicy="no-referrer" />';
  const ini = String(r.namaPanggilan || r.nama || '?').trim().charAt(0).toUpperCase();
  return '<span class="pr-ava ph">' + (ini || '?') + '</span>';
}
function __fmtRpPlain(n){ return (Number(n) || 0) === 0 ? '' : Number(n).toLocaleString('id-ID'); }
let __payrollData = null;
// PR-CL85: RATE LEMBUR FLAT — SAMA RATA buat SEMUA karyawan (keputusan owner).
// Sengaja angka tetap, bukan turunan dari base atau jam kontrak: lembur dianggap
// kerja tambahan yang nilainya sama siapa pun yang ngerjain. Base harian & upah
// pokok tetap beda-beda per orang (level/senioritas) — ini cuma soal lembur.
// Mau ubah nilainya? cukup ganti satu angka di bawah ini.
const RATE_LEMBUR_FLAT = 12500;

function prFormatRp(n){
  if (!n) return 'Rp 0';
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}
// Format jam desimal -> "X jam Y mnt" biar enak dibaca manusia (1.52 -> "1 jam 31 mnt").
function fmtLemburHM(hours){
  const h = parseFloat(hours) || 0;
  if (h <= 0) return '-';
  const totalMin = Math.round(h * 60);
  const jj = Math.floor(totalMin / 60), mm = totalMin % 60;
  if (jj === 0) return mm + ' mnt';
  if (mm === 0) return jj + ' jam';
  return jj + ' jam ' + mm + ' mnt';
}

// ===== Periode payroll berbasis TUTUP BUKU tanggal 25 =====
// Gajian tanggal 1, tapi buku ditutup tanggal 25 — jadi payroll bulan X =
// 26 (X-1) s/d 25 X. Rumusnya sekarang datang dari supabase-config
// (periodePayroll / PR_CUTOFF_DAY) supaya semua halaman pakai definisi yang
// sama persis. Aturan "bulan peralihan" milik GoodGems tidak dibawa ke sini —
// Kopikiri belum punya riwayat payroll yang perlu dijaga. Lihat laporan.
function prMonthRange(yyyymm){ return periodePayroll(yyyymm); }

async function loadPayroll(){
  const monthInput = $('prBulan');
  if (monthInput && !monthInput.value){
    const now = new Date();
    monthInput.value = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  }
  if (!monthInput.__wired){
    monthInput.__wired = true;
    monthInput.onchange = calcPayroll;
    $('btnPrRefresh').onclick = calcPayroll;
    $('btnPrExportCSV').onclick = exportPayrollCSV;
    $('btnPrDetailClose').onclick = () => $('payrollDetailModal').classList.add('hidden');
  }
  await calcPayroll();
}

async function calcPayroll(){
  const yyyymm = $('prBulan').value;
  if (!yyyymm){ alert('Pilih bulan dulu.'); return; }
  const range = prMonthRange(yyyymm);
  const start = range.start, end = range.end, label = range.label;
  // Tampilkan rentang tanggal periode di bawah pilihan bulan (tutup buku tgl 25).
  const _prInfo = $('prPeriodeInfo');
  if (_prInfo) _prInfo.textContent = 'Periode: ' + label;
  const tbody = document.querySelector('#tblPayroll tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="14" class="muted center">Menghitung...</td></tr>';
  $('prEmpty').classList.add('hidden');

  // SEMUA perangkaian sesi & penjumlahan jam sudah dikerjakan Postgres.
  // Yang datang ke browser: 1 baris per karyawan per hari kerja — dibutuhkan
  // apa adanya karena modal Detail & slip gaji menampilkan rincian harian.
  const [karyawan, rekap, penyesuaian, statusBayar] = await Promise.all([
    DB.karyawanSemua(),
    DB.rekapHarian(localDateStr(start), localDateStr(end)),
    DB.penyesuaianPeriode(yyyymm),
    DB.payrollStatusPeriode(yyyymm)
  ]);

  const perHari = new Map();
  rekap.forEach(r => {
    if (!perHari.has(r.karyawan_id)) perHari.set(r.karyawan_id, []);
    perHari.get(r.karyawan_id).push(r);
  });

  const bonusMap = new Map(), potonganMap = new Map();
  penyesuaian.forEach(p => {
    const j = num(p.jumlah);
    if (p.jenis === 'bonus') bonusMap.set(p.karyawan_id, (bonusMap.get(p.karyawan_id)||0) + j);
    else potonganMap.set(p.karyawan_id, (potonganMap.get(p.karyawan_id)||0) + j);  // potongan + kasbon
  });

  window.__payStatus = {};
  statusBayar.forEach(s => { if (s.status === 'dibayar') window.__payStatus[s.karyawan_id] = 'paid'; });

  const jamHM = iso => { if (!iso) return '--'; const d = new Date(iso); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };

  const rows = [];
  let totalBudget = 0, totalHari = 0, totalLemburJam = 0, totalJamKerjaAll = 0;
  for (const k of karyawan){
    const baseHarian = k.baseHarian;
    const jamKerja = k.jamKerja || 9;
    const multiplierLembur = k.multiplierLembur || 1;
    const netJamKerja = Math.max(1, jamKerja - 1);
    const ratePerJam = netJamKerja > 0 ? (baseHarian / netJamKerja) : 0;
    // PR-CL85: RATE LEMBUR = FLAT, sama rata semua karyawan.
    const rateLemburPerJam = RATE_LEMBUR_FLAT;

    const hariList = (perHari.get(k.id) || []).slice().sort((a,b)=> a.tanggal_kerja < b.tanggal_kerja ? -1 : 1);
    let hariHadir = 0, hariParsial = 0, totalJamLembur = 0, totalJamKerja = 0, totalKontribusi = 0, hariLupaCO = 0;
    const dailyDetails = [];

    for (const r of hariList){
      const istJam  = num(r.istirahat_menit) / 60;
      const jedaJam = num(r.jeda_menit) / 60;
      const masukMs = r.jam_masuk ? new Date(r.jam_masuk).getTime() : 0;
      const keluarMs = r.jam_keluar ? new Date(r.jam_keluar).getTime() : 0;
      // "Belum clock out" = sesi >18 jam (lupa) ATAU sesi yang masih terbuka.
      const tidakClockout = (r.ada_lupa_clock_out === true) || !r.jam_keluar;

      let durJam = 0, effJam = 0, effJamFinal = 0, kategori = 'absen', kontribusi = 0;
      if (tidakClockout){
        kategori = 'tidak-clockout';
        // Rumus versi lama: dibayar sebatas kontrak bersih dikurangi jeda.
        effJamFinal = Math.max(0, Math.min(netJamKerja, jamKerja - jedaJam));
        kontribusi = effJamFinal * ratePerJam;
        hariHadir++; hariLupaCO++;
      } else {
        const spanJam = (keluarMs && masukMs) ? (keluarMs - masukMs) / 3600000 : 0;
        durJam = Math.max(0, spanJam - istJam - jedaJam);   // belum dipagari kontrak
        effJam = Math.min(durJam, netJamKerja);
        effJamFinal = effJam;
        kontribusi = effJam * ratePerJam;
        if (durJam >= jamKerja * 0.75){ kategori = 'hadir'; hariHadir++; }
        else if (durJam > 0){ kategori = 'parsial'; hariParsial++; }
        else { kategori = 'short'; }
      }
      totalJamKerja += effJamFinal;
      totalKontribusi += kontribusi;

      // Lembur dihitung database: max(0, jam efektif mentah - kontrak bersih),
      // dan cuma kalau karyawannya beneran tap "Selesai Lembur".
      const lemburJam = num(r.jam_lembur);
      totalJamLembur += lemburJam;

      dailyDetails.push({
        date: r.tanggal_kerja,
        jamMasuk: jamHM(r.jam_masuk),
        jamKeluar: tidakClockout ? '--' : jamHM(r.jam_keluar),
        durJam: durJam.toFixed(2),
        effJam: effJam.toFixed(2),
        lemburJam: lemburJam.toFixed(2),
        kategori: kategori,
        kontribusi: kontribusi
      });
    }

    const upahPokok = totalKontribusi;
    const upahLembur = totalJamLembur * rateLemburPerJam * multiplierLembur;
    // PR-CL78: tunjangan peran flat bulanan — dibayar penuh selama ada kehadiran
    // bulan itu (baris tanpa kehadiran sudah di-skip guard di bawah).
    const tunjangan = k.tunjanganBulanan || 0;
    const total = upahPokok + upahLembur + tunjangan;
    const potongan = potonganMap.get(k.id) || 0;
    // PR-CL90: bonus sekali bayar — nempel cuma di periode terpilih.
    const bonus = bonusMap.get(k.id) || 0;
    const totalBayar = total + bonus - potongan;
    // Sembunyikan karyawan tanpa kehadiran periode ini (belum bergabung /
    // nonaktif / tidak hadir sama sekali). Yang aktif walau gaji Rp0 tetap
    // tampil biar owner sadar.
    if (hariHadir === 0 && hariParsial === 0 && totalJamLembur === 0) continue;
    rows.push({
      uid: k.id, nama: k.nama || '-', idKaryawan: k.idKaryawan || '-', nonaktif: (k.nonaktif===true),
      baseHarian: baseHarian, jamKerja: jamKerja, multiplierLembur: multiplierLembur,
      ratePerJam: ratePerJam, rateLemburPerJam: rateLemburPerJam,
      hariHadir: hariHadir, hariParsial: hariParsial, hariLupaCO: hariLupaCO,
      totalJamKerja: totalJamKerja, totalJamLembur: totalJamLembur,
      upahPokok: upahPokok, upahLembur: upahLembur, tunjangan: tunjangan, total: total,
      potongan: potongan, bonus: bonus, totalBayar: totalBayar,
      namaBank: k.namaBank || '', atasNamaRek: k.atasNamaRek || '', nomorRekening: k.nomorRekening || '',
      jabatan: k.jabatan || '', photoURL: k.photoURL || '',
      phone: k.phone || '', namaPanggilan: k.namaPanggilan || '',
      dailyDetails: dailyDetails
    });
    totalBudget += totalBayar;
    totalHari += hariHadir + hariParsial;
    totalLemburJam += totalJamLembur;
    totalJamKerjaAll += totalJamKerja;
  }
  rows.sort((a,b)=>(a.nama||'').localeCompare(b.nama||''));
  __payrollData = {yyyymm: yyyymm, label: label, rows: rows};
  renderPayrollTable();
  $('prTotalKaryawan').textContent = rows.length;
  $('prTotalBudget').textContent = prFormatRp(totalBudget);
  $('prTotalHari').textContent = totalHari.toFixed(1);
  $('prTotalLembur').textContent = fmtLemburHM(totalLemburJam);
  $('prLastCalc').textContent = 'Dihitung ' + new Date().toLocaleTimeString('id-ID') + ' — Bulan: ' + label;
}

// ===== Status pembayaran payroll (Lunas/Belum) — tabel payroll_status =====
window.__payStatus = window.__payStatus || {};

// CATATAN PINDAHAN: versi Firebase juga menulis snapshot slip ke dokumen
// karyawan (slipTerakhir) supaya aplikasi karyawan bisa menampilkannya 24 jam.
// Tabel karyawan yang baru tidak punya kolom itu. Statusnya sendiri tetap
// tersimpan rapi di payroll_status. Lihat laporan.
// PR-CL91/107: potret slip yang ditulis ke baris payroll_status saat ditandai LUNAS,
// dibaca aplikasi karyawan (tayang 24 jam sejak dibayar_at, lalu disembunyikan).
function __slipUntukKaryawan(row, yyyymm){
  if (!row) return null;
  return {
    yyyymm: yyyymm, label: (__payrollData && __payrollData.label) || yyyymm,
    hariHadir: row.hariHadir || 0, hariParsial: row.hariParsial || 0,
    totalJamKerja: Math.round((row.totalJamKerja || 0) * 10) / 10,
    totalJamLembur: Math.round((row.totalJamLembur || 0) * 100) / 100,
    upahPokok: Math.round(row.upahPokok || 0), upahLembur: Math.round(row.upahLembur || 0),
    tunjangan: Math.round(row.tunjangan || 0), bonus: Math.round(row.bonus || 0),
    potongan: Math.round(row.potongan || 0),
    totalBayar: Math.round(row.totalBayar != null ? row.totalBayar : (row.total || 0))
  };
}
async function togglePayStatus(uid){
  if (!__payrollData || !__payrollData.yyyymm){ alert('Hitung payroll dulu.'); return; }
  const yyyymm = __payrollData.yyyymm;
  const sudahPaid = window.__payStatus[uid] === 'paid';
  const jadi = sudahPaid ? 'unpaid' : 'paid';
  const row = (__payrollData.rows || []).find(function(x){ return x.uid === uid; });
  const nama = row ? (row.nama || '') : '';
  if (!confirm((jadi === 'paid' ? 'Tandai LUNAS' : 'Batalkan status lunas') + ' untuk ' + nama + ' (' + (__payrollData.label || yyyymm) + ')?')) return;
  try {
    await setPaidStatus(uid, jadi === 'paid');
  } catch(e){ alert('Gagal simpan status: ' + pesanRamah(e)); }
}
function __payStatusCell(uid){
  const paid = window.__payStatus[uid] === 'paid';
  const badge = paid
    ? '<span class="badge" style="background:#14321f;color:#86efac">Lunas</span>'
    : '<span class="badge" style="background:#3a2f12;color:#fcd34d">Belum Bayar</span>';
  return '<td>' + badge + '</td>';
}

// Set status bayar tanpa dialog konfirmasi ganda (dipakai flow modal Bayar).
async function setPaidStatus(uid, paid){
  if (!__payrollData || !__payrollData.yyyymm) return;
  const yyyymm = __payrollData.yyyymm;
  const row = (__payrollData.rows||[]).find(function(x){ return x.uid === uid; });
  const jumlah = row ? (row.totalBayar != null ? row.totalBayar : row.total) : null;
  await DB.setPayrollStatus(uid, yyyymm, !!paid, paid ? jumlah : null, paid ? __slipUntukKaryawan(row, yyyymm) : null);
  if (paid) window.__payStatus[uid] = 'paid'; else delete window.__payStatus[uid];
  renderPayrollTable();
}
// Kirim ringkasan slip gaji via WhatsApp ke nomor HP karyawan.
function kirimSlipWA(uid){
  const r = __payrollData && __payrollData.rows.find(function(x){ return x.uid === uid; });
  if (!r) return;
  let phone = String(r.phone || '').replace(/[^0-9]/g, '');
  if (!phone){ alert('Nomor HP karyawan belum diisi (menu Karyawan -> Edit).'); return; }
  if (phone.charAt(0) === '0') phone = '62' + phone.slice(1);
  else if (phone.slice(0,2) !== '62') phone = '62' + phone;
  const tb = r.totalBayar != null ? r.totalBayar : r.total;
  const L = ['Halo ' + (r.namaPanggilan || r.nama) + ',', '', 'Rincian gaji ' + __payrollData.label + ':',
    '- Upah Pokok: ' + prFormatRp(r.upahPokok), '- Upah Lembur: ' + prFormatRp(r.upahLembur)];
  if (r.tunjangan > 0) L.push('- Tunjangan Jabatan: ' + prFormatRp(r.tunjangan)); // PR-CL78
  if (r.bonus > 0) L.push('- Bonus: +' + prFormatRp(r.bonus)); // PR-CL90
  if (r.potongan > 0) L.push('- Potongan: -' + prFormatRp(r.potongan));
  L.push('- *Total Diterima: ' + prFormatRp(tb) + '*', '', 'Sudah ditransfer ya. Terima kasih! 🙏');
  window.open('https://wa.me/' + phone + '?text=' + encodeURIComponent(L.join('\n')), '_blank');
}
// Flow "Bayar Gaji": lihat total -> rekening -> konfirmasi transfer -> tandai lunas -> slip.
function openBayarModal(uid){
  if (!__payrollData) return;
  const r = __payrollData.rows.find(function(x){ return x.uid === uid; });
  if (!r) return;
  const paid = window.__payStatus[uid] === 'paid';
  const tb = r.totalBayar != null ? r.totalBayar : r.total;
  const titleEl = document.getElementById('bayarTitle'); if (titleEl) titleEl.textContent = 'Bayar Gaji — ' + r.nama;
  const adaRek = r.namaBank || r.nomorRekening || r.atasNamaRek;
  let h = '';
  h += '<div style="text-align:center;margin:4px 0 14px"><div class="muted small">Total Bayar (' + __payrollData.label + ')</div>'
     + '<div style="font-size:28px;font-weight:800;color:#34d399">' + prFormatRp(tb) + '</div>'
     + ((r.potongan > 0 || r.bonus > 0) ? '<div class="muted small">Gaji ' + prFormatRp(r.total) + (r.bonus > 0 ? ' + bonus ' + prFormatRp(r.bonus) : '') + (r.potongan > 0 ? ' &minus; potongan ' + prFormatRp(r.potongan) : '') + '</div>' : '')
     + '</div>';
  h += '<div style="background:#191919;border:1px solid #2a2a2a;border-radius:10px;padding:12px;margin-bottom:14px">';
  if (adaRek){
    h += '<div class="muted small" style="margin-bottom:6px">Transfer ke rekening:</div>'
       + '<div style="font-size:15px;font-weight:700">' + (r.namaBank || '-') + '</div>'
       + '<div style="font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:1px">' + (r.nomorRekening || '-') + '</div>'
       + '<div class="muted">a/n ' + (r.atasNamaRek || '-') + '</div>'
       + (r.nomorRekening ? '<button class="btn btn-sm btn-secondary" id="btnCopyRek" style="margin-top:8px">Salin No. Rekening</button>' : '');
  } else {
    h += '<div style="color:#fcd34d">⚠ Rekening belum diisi. Isi dulu di menu Karyawan -> Edit biar bisa transfer.</div>';
  }
  h += '</div>';
  if (paid){
    h += '<div style="text-align:center;margin-bottom:12px"><span style="color:#86efac;font-weight:700">✓ Sudah ditandai LUNAS</span><br><button class="btn-link" id="btnBatalLunas" style="color:#9ca3af;font-size:12px">Batalkan status lunas</button></div>';
  } else {
    h += '<button class="btn btn-primary" id="btnSudahTransfer" style="width:100%;margin-bottom:10px">✓ Saya Sudah Transfer — Tandai Lunas</button>';
  }
  h += '<div style="display:flex;gap:8px">'
     + '<button class="btn btn-secondary" id="btnBayarSlip" style="flex:1">Download Slip</button>'
     + (r.phone ? '<button class="btn btn-success" id="btnBayarWA" style="flex:1">Kirim WhatsApp</button>' : '')
     + '</div>';
  const body = document.getElementById('bayarBody'); if (body) body.innerHTML = h;
  const modal = document.getElementById('bayarModal');
  if (modal){ modal.classList.remove('hidden'); modal.onclick = function(e){ if (e.target === modal) modal.classList.add('hidden'); }; }
  const cl = document.getElementById('btnBayarClose'); if (cl) cl.onclick = function(){ if (modal) modal.classList.add('hidden'); };
  const cp = document.getElementById('btnCopyRek'); if (cp) cp.onclick = function(){ try { navigator.clipboard.writeText(r.nomorRekening || ''); cp.textContent = 'Tersalin ✓'; setTimeout(function(){ cp.textContent = 'Salin No. Rekening'; }, 1500); } catch(e){} };
  const st = document.getElementById('btnSudahTransfer'); if (st) st.onclick = async function(){ if (!confirm('Tandai LUNAS untuk ' + r.nama + '? Pastikan transfer sudah beneran masuk.')) return; st.disabled = true; st.textContent = 'Menyimpan...'; try { await setPaidStatus(uid, true); openBayarModal(uid); } catch(e){ alert('Gagal: ' + pesanRamah(e)); st.disabled = false; st.textContent = '✓ Saya Sudah Transfer — Tandai Lunas'; } };
  const sp = document.getElementById('btnBayarSlip'); if (sp) sp.onclick = function(){ downloadSlipGaji(uid); };
  const wa = document.getElementById('btnBayarWA'); if (wa) wa.onclick = function(){ kirimSlipWA(uid); };
  const bl = document.getElementById('btnBatalLunas'); if (bl) bl.onclick = async function(){ if (!confirm('Batalkan status LUNAS untuk ' + r.nama + '?')) return; try { await setPaidStatus(uid, false); openBayarModal(uid); } catch(e){ alert('Gagal: ' + pesanRamah(e)); } };
}

function renderPayrollTable(){
const tbody = document.querySelector('#tblPayroll tbody');
if (!tbody || !__payrollData) return;
tbody.innerHTML = '';
if (!__payrollData.rows.length){ $('prEmpty').classList.remove('hidden'); return; }
$('prEmpty').classList.add('hidden');
// Pengaman visual: tandai hari "Lupa Clock Out" (dibayar penuh otomatis -> wajib cek manual).
(function(){
  const _tbl = document.getElementById('tblPayroll');
  let _warn = document.getElementById('prLupaWarn');
  const _totalLupa = __payrollData.rows.reduce((s,r)=> s + (r.hariLupaCO||0), 0);
  const _orangLupa = __payrollData.rows.filter(r=> (r.hariLupaCO||0) > 0).length;
  if (_totalLupa > 0){
    if (!_warn && _tbl && _tbl.parentElement){
      _warn = document.createElement('div');
      _warn.id = 'prLupaWarn';
      _warn.style.cssText = 'margin:10px 0;padding:10px 14px;border-radius:10px;background:#3a2f12;color:#fcd34d;border:1px solid #a16207;font-size:13px;line-height:1.5;cursor:pointer;';
      _tbl.parentElement.insertAdjacentElement('beforebegin', _warn);
    }
    if (_warn){ _warn.innerHTML = '⚠ Ada <b>'+_totalLupa+' hari “Lupa Clock Out”</b> di '+_orangLupa+' karyawan — hari itu dibayar penuh otomatis. Cek manual dulu sebelum transfer gaji. <u>Klik untuk lihat detail &amp; edit ▸</u>'; _warn.onclick = openLupaModal; _warn.style.display=''; }
  } else if (_warn){ _warn.style.display = 'none'; }
})();
// Aktif dulu, lalu Nonaktif/resign dikelompokin di bawah (bisa di-collapse) biar daftar aktif bersih.
const _prRows = __payrollData.rows.slice().sort((a,b)=> ((a.nonaktif===true)?1:0) - ((b.nonaktif===true)?1:0));
const _prNon = _prRows.filter(r=>r.nonaktif===true);
const _prNonUnpaidRp = _prNon.reduce((s,r)=> s + ((window.__payStatus[r.uid]==='paid')?0:(r.totalBayar!=null?r.totalBayar:r.total)), 0);
let _prSepDone = false;
for (const r of _prRows){
if (r.nonaktif===true && !_prSepDone){
  _prSepDone = true;
  const sep = document.createElement('tr');
  sep.className = 'pr-nonaktif-sep';
  sep.style.cursor = 'pointer';
  sep.innerHTML = '<td colspan="14" style="padding:10px 14px;background:#161616;border-top:2px solid #2a2a2a;color:#9ca3af;font-size:13px;font-weight:600">'
    + '<span class="pr-non-caret">▸</span> Nonaktif / Resign (' + _prNon.length + ') — klik buat lihat/sembunyikan'
    + (_prNonUnpaidRp>0 ? ' <span style="color:#fcd34d">· belum dibayar ' + prFormatRp(_prNonUnpaidRp) + '</span>' : '')
    + '</td>';
  sep.onclick = ()=>{
    const rowsN = tbody.querySelectorAll('.pr-nonaktif-row');
    const show = rowsN.length && rowsN[0].style.display === 'none';
    rowsN.forEach(x=> x.style.display = show ? '' : 'none');
    const c = sep.querySelector('.pr-non-caret'); if (c) c.textContent = show ? '▾' : '▸';
  };
  tbody.appendChild(sep);
}
const tr = document.createElement('tr');
if (r.nonaktif){ tr.className = 'pr-nonaktif-row'; tr.style.opacity = '.6'; tr.style.display = 'none'; }
tr.innerHTML = '<td><div class="pr-name-cell">' + __prAvatar(r) + '<div class="pr-name-txt"><div class="pr-name-top"><b>' + r.nama + '</b>' + __prRoleBadge(r) + (r.nonaktif ? ' <span class="tag" title="Sudah resign / dinonaktifkan. Muncul karena masih ada absen bulan ini.">Nonaktif</span>' : '') + '</div><small class="muted">' + r.idKaryawan + '</small>' + ((r.hariLupaCO||0) > 0 ? '<br><small style="color:#fcd34d">⚠ ' + r.hariLupaCO + ' hr lupa clock-out</small>' : '') + '</div></div></td>' +
'<td class="num">' + prFormatRp(r.baseHarian) + '</td>' +
'<td class="num">' + r.hariHadir + (r.hariParsial ? ' <small class="muted" title="TETAP DIHITUNG HARI MASUK KERJA - cuma karena jamnya kurang dari 75% jam standar, bayarannya dihitung sesuai jam (bukan sehari penuh)">(+' + r.hariParsial + ' parsial)</small>' : '') + '</td>' +
'<td class="num">' + r.totalJamKerja.toFixed(1) + ' jam</td>' +
'<td class="num">' + fmtLemburHM(r.totalJamLembur) + '</td>' +
'<td class="num">' + prFormatRp(r.upahPokok) + '</td>' +
'<td class="num">' + prFormatRp(r.upahLembur) + '</td>' +
'<td class="num pr-tun-cell" data-uid="' + r.uid + '"><span class="pr-tun-val">' + (r.tunjangan ? prFormatRp(r.tunjangan) : '<span class="muted">-</span>') + '</span> <button class="btn-link pr-tun-edit" data-uid="' + r.uid + '" style="color:#f97316">Edit</button></td>' +
'<td class="num">' + prFormatRp(r.total) + '</td>' +
'<td class="num pr-bon-cell" data-uid="' + r.uid + '"><span class="pr-bon-val">' + (r.bonus ? '<span style="color:#86efac">+' + prFormatRp(r.bonus) + '</span>' : '<span class="muted">-</span>') + '</span> <button class="btn-link pr-bon-edit" data-uid="' + r.uid + '" style="color:#f97316">Edit</button></td>' +
'<td class="num pr-pot-cell" data-uid="' + r.uid + '"><span class="pr-pot-val">' + (r.potongan ? prFormatRp(r.potongan) : '<span class="muted">-</span>') + '</span> <button class="btn-link pr-pot-edit" data-uid="' + r.uid + '" style="color:#f97316">Edit</button></td>' +
'<td class="num"><b class="pr-totalbayar" data-uid="' + r.uid + '" style="color:#34d399">' + prFormatRp(r.totalBayar!=null ? r.totalBayar : r.total) + '</b></td>' +
__payStatusCell(r.uid) +
'<td>' + (window.__payStatus[r.uid] === 'paid'
  ? '<button class="btn btn-sm pr-bayar-btn" data-uid="' + r.uid + '" style="background:#14321f;color:#86efac;border:1px solid #2f6b43" title="Sudah dibayar. Klik untuk kirim slip / batalkan.">✓ Lunas</button>'
  : '<button class="btn btn-sm btn-primary pr-bayar-btn" data-uid="' + r.uid + '">Bayar</button>')
  + ' <button class="btn btn-sm btn-secondary pr-detail-btn" data-uid="' + r.uid + '">Detail</button></td>';
tbody.appendChild(tr);
}
document.querySelectorAll('.pr-detail-btn').forEach(b => { b.onclick = () => showPayrollDetail(b.dataset.uid); });
document.querySelectorAll('.pr-paid-btn').forEach(b => { b.onclick = () => togglePayStatus(b.dataset.uid); });
document.querySelectorAll('.pr-pot-edit').forEach(b => { b.onclick = () => startEditPotongan(b.dataset.uid); });
document.querySelectorAll('.pr-bon-edit').forEach(b => { b.onclick = () => startEditBonus(b.dataset.uid); }); // PR-CL90
document.querySelectorAll('.pr-tun-edit').forEach(b => { b.onclick = () => startEditTunjangan(b.dataset.uid); }); // PR-CL79
document.querySelectorAll('.pr-bayar-btn').forEach(b => { b.onclick = () => openBayarModal(b.dataset.uid); });
// Ringkasan status bayar (update tiap render, termasuk setelah tandai lunas).
let _sudahBayar = 0, _belumBayar = 0, _grossTot = 0, _potTot = 0, _bonTot = 0;
for (const _r of __payrollData.rows){
  const _tb = _r.totalBayar != null ? _r.totalBayar : _r.total;
  if (window.__payStatus[_r.uid] === 'paid') _sudahBayar += _tb; else _belumBayar += _tb;
  _grossTot += (_r.total || 0);
  _potTot += (_r.potongan || 0);
  _bonTot += (_r.bonus || 0);
}
const _seEl = document.getElementById('prSudahBayar'); if (_seEl) _seEl.textContent = prFormatRp(_sudahBayar);
const _beEl = document.getElementById('prBelumBayar'); if (_beEl) _beEl.textContent = prFormatRp(_belumBayar);
const _grEl = document.getElementById('prTotalGross'); if (_grEl) _grEl.textContent = prFormatRp(_grossTot);
const _poEl = document.getElementById('prTotalPotongan'); if (_poEl) _poEl.textContent = prFormatRp(_potTot);
const _boEl = document.getElementById('prTotalBonus'); if (_boEl) _boEl.textContent = prFormatRp(_bonTot);
}

// Potongan/kasbon: tampil sebagai TEKS (font sama dgn tabel); klik "Edit" baru muncul input + Simpan/Batal,
// biar nilainya tidak keubah ga sengaja.
function renderPotonganCell(uid){
  const cell = document.querySelector('.pr-pot-cell[data-uid="' + uid + '"]');
  if (!cell) return;
  const row = __payrollData && __payrollData.rows.find(x => x.uid === uid);
  const pot = row ? (row.potongan || 0) : 0;
  cell.innerHTML = '<span class="pr-pot-val">' + (pot ? prFormatRp(pot) : '<span class="muted">-</span>') + '</span> <button class="btn-link pr-pot-edit" data-uid="' + uid + '" style="color:#f97316">Edit</button>';
  const eb = cell.querySelector('.pr-pot-edit'); if (eb) eb.onclick = () => startEditPotongan(uid);
}
function startEditPotongan(uid){
  const cell = document.querySelector('.pr-pot-cell[data-uid="' + uid + '"]');
  if (!cell) return;
  const row = __payrollData && __payrollData.rows.find(x => x.uid === uid);
  const cur = row ? (row.potongan || 0) : 0;
  cell.innerHTML = '<input type="number" class="pr-pot-input" min="0" step="1000" value="' + cur + '" style="width:90px;font:inherit;text-align:right;padding:3px 5px;background:#191919;color:#e6e3d8;border:1px solid #f97316;border-radius:6px"> '
    + '<button class="btn-link pr-pot-save" style="color:#34d399">Simpan</button> '
    + '<button class="btn-link pr-pot-cancel" style="color:#9ca3af">Batal</button>';
  const inp = cell.querySelector('.pr-pot-input');
  if (inp){ inp.focus(); inp.select(); inp.onkeydown = (e) => { if (e.key === 'Enter') savePotongan(uid); else if (e.key === 'Escape') renderPotonganCell(uid); }; }
  cell.querySelector('.pr-pot-save').onclick = () => savePotongan(uid);
  cell.querySelector('.pr-pot-cancel').onclick = () => renderPotonganCell(uid);
}
// Simpan potongan periode ini ke tabel penyesuaian_gaji (jenis 'potongan').
async function savePotongan(uid){
  if (!__payrollData) return;
  const yyyymm = __payrollData.yyyymm;
  const row = __payrollData.rows.find(x => x.uid === uid);
  if (!row) return;
  const cell = document.querySelector('.pr-pot-cell[data-uid="' + uid + '"]');
  const inp = cell ? cell.querySelector('.pr-pot-input') : null;
  const amount = Math.max(0, parseInt(inp ? inp.value : row.potongan, 10) || 0);
  const saveBtn = cell ? cell.querySelector('.pr-pot-save') : null;
  if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Menyimpan...'; }
  try {
    await DB.setPenyesuaian(uid, yyyymm, 'potongan', amount);
    row.potongan = amount;
    row.totalBayar = row.total + (row.bonus || 0) - amount;
    const cb = document.querySelector('.pr-totalbayar[data-uid="' + uid + '"]');
    if (cb) cb.textContent = prFormatRp(row.totalBayar);
    const budget = __payrollData.rows.reduce((s, x) => s + (x.totalBayar != null ? x.totalBayar : x.total), 0);
    const bEl = document.getElementById('prTotalBudget'); if (bEl) bEl.textContent = prFormatRp(budget);
    renderPotonganCell(uid);
  } catch (e) {
    alert('Gagal simpan potongan: ' + pesanRamah(e));
    if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = 'Simpan'; }
  }
}

// PR-CL90: Bonus inline edit — pola persis Potongan, tapi NAMBAH ke Total Bayar.
// Kayak potongan, nilainya cuma nempel di periode terpilih — sekali bayar, ga kebawa bulan depan.
function renderBonusCell(uid){
  const cell = document.querySelector('.pr-bon-cell[data-uid="' + uid + '"]');
  if (!cell) return;
  const row = __payrollData && __payrollData.rows.find(x => x.uid === uid);
  const bon = row ? (row.bonus || 0) : 0;
  cell.innerHTML = '<span class="pr-bon-val">' + (bon ? '<span style="color:#86efac">+' + prFormatRp(bon) + '</span>' : '<span class="muted">-</span>') + '</span> <button class="btn-link pr-bon-edit" data-uid="' + uid + '" style="color:#f97316">Edit</button>';
  const eb = cell.querySelector('.pr-bon-edit'); if (eb) eb.onclick = () => startEditBonus(uid);
}
function startEditBonus(uid){
  const cell = document.querySelector('.pr-bon-cell[data-uid="' + uid + '"]');
  if (!cell) return;
  const row = __payrollData && __payrollData.rows.find(x => x.uid === uid);
  const cur = row ? (row.bonus || 0) : 0;
  cell.innerHTML = '<input type="number" class="pr-bon-input" min="0" step="1000" value="' + cur + '" style="width:90px;font:inherit;text-align:right;padding:3px 5px;background:#191919;color:#e6e3d8;border:1px solid #f97316;border-radius:6px"> '
    + '<button class="btn-link pr-bon-save" style="color:#34d399">Simpan</button> '
    + '<button class="btn-link pr-bon-cancel" style="color:#9ca3af">Batal</button>'
    + '<br><small class="muted">cuma bulan ini</small>';
  const inp = cell.querySelector('.pr-bon-input');
  if (inp){ inp.focus(); inp.select(); inp.onkeydown = (e) => { if (e.key === 'Enter') saveBonus(uid); else if (e.key === 'Escape') renderBonusCell(uid); }; }
  cell.querySelector('.pr-bon-save').onclick = () => saveBonus(uid);
  cell.querySelector('.pr-bon-cancel').onclick = () => renderBonusCell(uid);
}
async function saveBonus(uid){
  if (!__payrollData) return;
  const yyyymm = __payrollData.yyyymm;
  const row = __payrollData.rows.find(x => x.uid === uid);
  if (!row) return;
  const cell = document.querySelector('.pr-bon-cell[data-uid="' + uid + '"]');
  const inp = cell ? cell.querySelector('.pr-bon-input') : null;
  const amount = Math.max(0, parseInt(inp ? inp.value : row.bonus, 10) || 0);
  const saveBtn = cell ? cell.querySelector('.pr-bon-save') : null;
  if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Menyimpan...'; }
  try {
    await DB.setPenyesuaian(uid, yyyymm, 'bonus', amount);
    row.bonus = amount;
    row.totalBayar = row.total + amount - (row.potongan || 0);
    const cb = document.querySelector('.pr-totalbayar[data-uid="' + uid + '"]');
    if (cb) cb.textContent = prFormatRp(row.totalBayar);
    const budget = __payrollData.rows.reduce((s, x) => s + (x.totalBayar != null ? x.totalBayar : x.total), 0);
    const bEl = document.getElementById('prTotalBudget'); if (bEl) bEl.textContent = prFormatRp(budget);
    const _bt = __payrollData.rows.reduce((s, x) => s + (x.bonus || 0), 0);
    const _boEl2 = document.getElementById('prTotalBonus'); if (_boEl2) _boEl2.textContent = prFormatRp(_bt);
    renderBonusCell(uid);
  } catch (e) {
    alert('Gagal simpan bonus: ' + pesanRamah(e));
    if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = 'Simpan'; }
  }
}

// PR-CL79: Tunjangan inline edit di tabel payroll (pola sama kayak Potongan).
// BEDA PENTING: potongan cuma buat periode terpilih; tunjangan itu FLAT —
// nilainya nempel di karyawan (tunjangan_bulanan) dan otomatis kebayar TIAP
// BULAN sampai diubah lagi.
function startEditTunjangan(uid){
  const cell = document.querySelector('.pr-tun-cell[data-uid="' + uid + '"]');
  if (!cell) return;
  const row = __payrollData && __payrollData.rows.find(x => x.uid === uid);
  const cur = row ? (row.tunjangan || 0) : 0;
  cell.innerHTML = '<input type="text" inputmode="numeric" class="pr-tun-input" value="' + __fmtRpPlain(cur) + '" style="width:100px;font:inherit;text-align:right;padding:3px 5px;background:#191919;color:#e6e3d8;border:1px solid #f97316;border-radius:6px"> '
    + '<button class="btn-link pr-tun-save" style="color:#34d399">Simpan</button> '
    + '<button class="btn-link pr-tun-cancel" style="color:#9ca3af">Batal</button>'
    + '<br><small class="muted">flat — berlaku tiap bulan</small>';
  const inp = cell.querySelector('.pr-tun-input');
  if (inp){ inp.focus(); inp.select(); inp.onkeydown = (e) => { if (e.key === 'Enter') saveTunjangan(uid); else if (e.key === 'Escape') renderPayrollTable(); }; }
  cell.querySelector('.pr-tun-save').onclick = () => saveTunjangan(uid);
  cell.querySelector('.pr-tun-cancel').onclick = () => renderPayrollTable();
}
async function saveTunjangan(uid){
  if (!__payrollData) return;
  const row = __payrollData.rows.find(x => x.uid === uid);
  if (!row) return;
  const cell = document.querySelector('.pr-tun-cell[data-uid="' + uid + '"]');
  const inp = cell ? cell.querySelector('.pr-tun-input') : null;
  const amount = Math.max(0, inp ? __parseRp(inp.value) : (row.tunjangan || 0)); // PR-CL87
  const saveBtn = cell ? cell.querySelector('.pr-tun-save') : null;
  if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Menyimpan...'; }
  try {
    await DB.simpanKaryawan(uid, { tunjangan_bulanan: amount });
    row.tunjangan = amount;
    row.total = (row.upahPokok || 0) + (row.upahLembur || 0) + amount;
    row.totalBayar = row.total + (row.bonus || 0) - (row.potongan || 0);
    renderPayrollTable(); // re-render penuh biar Total, Total Bayar & ringkasan ikut keupdate
    const budget = __payrollData.rows.reduce((s, x) => s + (x.totalBayar != null ? x.totalBayar : x.total), 0);
    const bEl = document.getElementById('prTotalBudget'); if (bEl) bEl.textContent = prFormatRp(budget);
  } catch (e) {
    alert('Gagal simpan tunjangan: ' + pesanRamah(e));
    if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = 'Simpan'; }
  }
}

// Popup rangkuman hari "Lupa Clock Out" (dipanggil saat banner peringatan di Payroll diklik).
function openLupaModal(){
    if (!__payrollData || !__payrollData.rows) return;
    const items = [];
    for (const r of __payrollData.rows){
        (r.dailyDetails||[]).forEach(function(d){
            if (d.kategori === 'tidak-clockout'){
                items.push({ uid:r.uid, nama:r.nama||'-', idKaryawan:r.idKaryawan||'', date:d.date, jamMasuk:d.jamMasuk, kontribusi:d.kontribusi });
            }
        });
    }
    items.sort(function(a,b){ if (a.date!==b.date) return a.date<b.date?-1:1; return (a.nama||'').localeCompare(b.nama||''); });
    const sub = document.getElementById('lupaSub');
    if (sub) sub.textContent = items.length + ' hari di ' + (new Set(items.map(function(i){return i.uid;})).size) + ' karyawan — Clock In tapi tidak ada Clock Out, jadi dibayar penuh otomatis.';
    const tb = document.getElementById('lupaTbody');
    if (tb){
        tb.innerHTML = items.map(function(it){
            var tgl = it.date; try { tgl = new Date(it.date+'T00:00:00').toLocaleDateString('id-ID',{weekday:'short',day:'2-digit',month:'short',year:'numeric'}); } catch(e){}
            return '<tr>'
                 + '<td><b>'+it.nama+'</b><br><small class="muted">'+it.idKaryawan+'</small></td>'
                 + '<td>'+tgl+'</td>'
                 + '<td>'+(it.jamMasuk||'--')+'</td>'
                 + '<td class="num">'+prFormatRp(Math.round(it.kontribusi||0))+'</td>'
                 + '<td><button class="btn btn-sm btn-secondary lupa-edit-btn" data-date="'+it.date+'">Cek &amp; Edit</button></td>'
                 + '</tr>';
        }).join('');
        tb.querySelectorAll('.lupa-edit-btn').forEach(function(b){ b.onclick = function(){ gotoKehadiranDate(b.dataset.date); }; });
    }
    const modal = document.getElementById('lupaModal');
    if (modal){
        modal.classList.remove('hidden');
        modal.onclick = function(e){ if (e.target === modal) modal.classList.add('hidden'); };
    }
    const close = document.getElementById('btnLupaClose');
    if (close) close.onclick = function(){ document.getElementById('lupaModal').classList.add('hidden'); };
}

// Pindah ke Kehadiran Harian pada tanggal tertentu (untuk koreksi jam pulang yang lupa di-clock-out).
function gotoKehadiranDate(dateStr){
    try {
        const p = (dateStr||'').split('-');
        if (p.length === 3){
            currentKhDate = new Date(Number(p[0]), Number(p[1])-1, Number(p[2]));
            const inp = document.getElementById('khDate'); if (inp) inp.value = dateToInputStr(currentKhDate);
        }
    } catch(e){}
    const m = document.getElementById('lupaModal'); if (m) m.classList.add('hidden');
    const link = document.querySelector('.nav-link[data-page="kehadiran"]');
    if (link) link.click(); else { try { loadKehadiranMatrix(); } catch(e){} }
}

function showPayrollDetail(uid){
if (!__payrollData) return;
const r = __payrollData.rows.find(x => x.uid === uid);
if (!r) return;
$('prDetailTitle').textContent = 'Detail Payroll — ' + r.nama;
$('prDetailSub').textContent = 'Periode: ' + __payrollData.label + ' — Total Jam: ' + r.totalJamKerja.toFixed(1) + ' jam — Rate pokok: ' + prFormatRp(r.ratePerJam||0) + '/jam — Rate lembur: ' + prFormatRp(r.rateLemburPerJam||r.ratePerJam||0) + '/jam — Total: ' + prFormatRp(r.total);
const tb = document.querySelector('#tblPayrollDetail tbody');
tb.innerHTML = '';
if (!r.dailyDetails.length){
tb.innerHTML = '<tr><td colspan="8" class="muted center">Tidak ada catatan kehadiran bulan ini.</td></tr>';
} else {
const _rate = r.rateLemburPerJam || r.ratePerJam || 0; // PR-CL84: kolom lembur pakai rate lembur
const _mult = r.multiplierLembur || 1;
for (const d of r.dailyDetails){
const tr = document.createElement('tr');
const kategoriBadge = d.kategori === 'hadir' ? '<span style="color:#16a34a">✓ Hadir</span>'
: d.kategori === 'parsial' ? '<span style="color:#ea580c">Parsial</span>'
: d.kategori === 'short' ? '<span style="color:#94a3b8">Short</span>'
: d.kategori === 'tidak-clockout' ? '<span style="color:#dc2626">Belum Clock Out</span>'
: '<span class="muted">' + d.kategori + '</span>';
const jamLabel = d.durJam + ' jam' + (parseFloat(d.effJam) < parseFloat(d.durJam) ? ' <small class="muted">(eff ' + d.effJam + ')</small>' : '');
const _lemJam = parseFloat(d.lemburJam) || 0;
const _lemRp = _lemJam * _rate * _mult;
const _lemJamCell = _lemJam > 0 ? fmtLemburHM(_lemJam) : '<span class="muted">-</span>';
const _lemRpCell = _lemJam > 0 ? prFormatRp(_lemRp) : '<span class="muted">-</span>';
tr.innerHTML = '<td>' + d.date + '</td><td>' + d.jamMasuk + '</td><td>' + d.jamKeluar + '</td><td>' + jamLabel + '</td><td>' + kategoriBadge + '</td><td class="num">' + prFormatRp(d.kontribusi) + '</td><td class="num">' + _lemJamCell + '</td><td class="num">' + _lemRpCell + '</td>';
tb.appendChild(tr);
}
// Baris TOTAL (subtotal per kolom) + TOTAL AKHIR (pokok + lembur)
const trT = document.createElement('tr');
trT.style.cssText = 'border-top:2px solid #a16207;font-weight:700';
trT.innerHTML = '<td colspan="5" style="text-align:right">TOTAL</td>'
+ '<td class="num">' + prFormatRp(r.upahPokok) + '</td>'
+ '<td class="num">' + fmtLemburHM(r.totalJamLembur||0) + '</td>'
+ '<td class="num">' + prFormatRp(r.upahLembur) + '</td>';
tb.appendChild(trT);
const trG = document.createElement('tr');
trG.style.cssText = 'font-weight:800';
trG.innerHTML = '<td colspan="7" style="text-align:right">TOTAL AKHIR (Pokok + Lembur' + (r.tunjangan > 0 ? ' + Tunjangan Jabatan ' + prFormatRp(r.tunjangan) : '') + ')</td>'
+ '<td class="num" style="color:#34d399;font-size:14px">' + prFormatRp(r.total) + '</td>';
tb.appendChild(trG);
}
$('payrollDetailModal').classList.remove('hidden');
}

function exportPayrollCSV(){
if (!__payrollData || !__payrollData.rows.length){ alert('Belum ada data. Hitung dulu.'); return; }
const headers = ['Nama','ID Karyawan','Base Harian','Hari Hadir','Hari Parsial','Total Jam Kerja','Jam Lembur','Upah Pokok','Upah Lembur','Tunjangan','Total','Bonus','Potongan','Total Bayar','Bank','Atas Nama','Nomor Rekening'];
const lines = [headers.join(',')];
for (const r of __payrollData.rows){
const cells = [
r.nama, r.idKaryawan, r.baseHarian, r.hariHadir, r.hariParsial,
r.totalJamKerja.toFixed(2), r.totalJamLembur.toFixed(2),
Math.round(r.upahPokok), Math.round(r.upahLembur), Math.round(r.tunjangan||0), Math.round(r.total), Math.round(r.bonus||0), Math.round(r.potongan||0), Math.round(r.totalBayar!=null?r.totalBayar:r.total),
r.namaBank, r.atasNamaRek, r.nomorRekening
].map(v => '"' + String(v).replace(/"/g, '""') + '"');
lines.push(cells.join(','));
}
const csv = '﻿' + lines.join('\n');
const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
const a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = 'payroll-' + __payrollData.yyyymm + '.csv';
a.click();
setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Auto-wire payroll buttons + expose to window for debug
window.loadPayroll = loadPayroll;
window.calcPayroll = calcPayroll;
(function(){
  function wirePayrollOnce(){
    const btn = document.getElementById('btnPrRefresh');
    const exp = document.getElementById('btnPrExportCSV');
    const close = document.getElementById('btnPrDetailClose');
    const mi = document.getElementById('prBulan');
    if (!btn || btn.__wired) return;
    btn.__wired = true;
    btn.onclick = function(){ calcPayroll().catch(e => { console.error('calcPayroll error', e); alert('Error: ' + pesanRamah(e)); }); };
    if (exp) exp.onclick = exportPayrollCSV;
    if (close) close.onclick = function(){ document.getElementById('payrollDetailModal').classList.add('hidden'); };
    if (mi && !mi.value){
      const now = new Date();
      mi.value = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
      mi.onchange = btn.onclick;
    }
  }
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', wirePayrollOnce);
  } else {
    wirePayrollOnce();
  }
  document.addEventListener('click', function(e){
    const t = e.target;
    if (t && t.classList && t.classList.contains('nav-link') && t.dataset.page === 'payroll'){
      setTimeout(wirePayrollOnce, 50);
    }
  }, true);
  window.addEventListener('hashchange', function(){
    if (location.hash === '#payroll') setTimeout(wirePayrollOnce, 100);
  });
  if (location.hash === '#payroll') setTimeout(wirePayrollOnce, 500);
})();

// ===== Download Slip Gaji (detail & transparan) =====
// Slip gaji per karyawan, di-convert otomatis dari hasil payroll.
// Tujuan: transparan — karyawan bisa lihat rincian per hari (full/partial/lembur).
function __slipFmtRp(n) {
  const numx = Math.round(Number(n) || 0);
  return 'Rp' + numx.toLocaleString('id-ID');
}

function __slipJam(n) {
  const x = Math.round((Number(n) || 0) * 10) / 10;
  return x + ' jam';
}

function __slipPeriode() {
  // Ambil dari input bulan payroll dan pakai rentang tutup-buku yang sama (26->25),
  // bukan nama bulan, biar periode di slip tidak pernah beda dgn yang dihitung.
  const el = document.getElementById('prBulan');
  const val = el && el.value ? el.value : '';
  if (/^\d{4}-\d{2}$/.test(val)) return prMonthRange(val).label;
  return val || '-';
}

// Ubah kode kategori internal jadi label yang ramah + warna.
function __slipKategori(kat) {
  switch (kat) {
    case 'hadir':           return { label: 'Hari Penuh', color: '#16a34a' };
    case 'parsial':         return { label: 'Sebagian',   color: '#d97706' };
    case 'short':           return { label: 'Kurang Jam', color: '#d97706' };
    case 'tidak-clockout':  return { label: 'Lupa Clock Out', color: '#dc2626' };
    case 'absen':           return { label: 'Tidak Hadir', color: '#9ca3af' };
    default:                return { label: kat || '-', color: '#374151' };
  }
}

function downloadSlipGaji(uid) {
  const rows = (typeof __payrollData !== 'undefined' && __payrollData && __payrollData.rows) ? __payrollData.rows : [];
  const r = rows.find(x => x.uid === uid);
  if (!r) {
    alert('Data payroll tidak ditemukan untuk karyawan ini. Klik "Hitung Ulang" dulu.');
    return;
  }
  const periode = (typeof __payrollData !== 'undefined' && __payrollData && __payrollData.label) ? __payrollData.label : __slipPeriode();
  const days = Array.isArray(r.dailyDetails) ? r.dailyDetails : [];

  // Baris rincian per hari
  let rowsHtml = '';
  for (const d of days) {
    const k = __slipKategori(d.kategori);
    const lembur = (d.lemburJam && d.lemburJam > 0) ? __slipJam(d.lemburJam) : '-';
    rowsHtml +=
      '<tr>' +
      '<td>' + (d.date || '-') + '</td>' +
      '<td class="c">' + (d.jamMasuk || '-') + '</td>' +
      '<td class="c">' + (d.jamKeluar || '-') + '</td>' +
      '<td class="c">' + __slipJam(d.durJam) + '</td>' +
      '<td class="c">' + __slipJam(d.effJam) + '</td>' +
      '<td class="c">' + lembur + '</td>' +
      '<td class="c"><span style="color:' + k.color + ';font-weight:600">' + k.label + '</span></td>' +
      '<td class="r">' + __slipFmtRp(d.kontribusi) + '</td>' +
      '</tr>';
  }
  if (!rowsHtml) {
    rowsHtml = '<tr><td colspan="8" class="c" style="color:#9ca3af">Tidak ada catatan kehadiran di periode ini.</td></tr>';
  }

  // Info bank (kalau ada)
  let bankHtml = '';
  if (r.namaBank || r.nomorRekening) {
    bankHtml =
      '<tr><td>Bank</td><td class="r">' + (r.namaBank || '-') + '</td></tr>' +
      '<tr><td>No. Rekening</td><td class="r">' + (r.nomorRekening || '-') + '</td></tr>' +
      '<tr><td>Atas Nama</td><td class="r">' + (r.atasNamaRek || '-') + '</td></tr>';
  }

  const rateJam = r.ratePerJam || 0;
  const rateLembur = r.rateLemburPerJam || rateJam; // PR-CL84
  const jamLembur = r.totalJamLembur || 0;
  const sudahLunas = (window.__payStatus && window.__payStatus[uid] === 'paid');

  const html = '<!doctype html><html lang="id"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Slip Gaji - ' + (r.nama || '') + ' - ' + periode + '</title>' +
    '<style>' +
    'body{font-family:Arial,Helvetica,sans-serif;color:#1f2937;margin:0;padding:24px;background:#f3f4f6;}' +
    '.slip{max-width:820px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 32px;}' +
    '.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #f97316;padding-bottom:14px;margin-bottom:18px;}' +
    'h1{font-size:22px;margin:0;color:#f97316;}.brand{font-size:13px;color:#6b7280;margin-top:2px;}' +
    '.per{text-align:right;font-size:13px;color:#374151;}' +
    'h2{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin:22px 0 8px;}' +
    'table{width:100%;border-collapse:collapse;font-size:13px;}' +
    '.info td{padding:6px 4px;border-bottom:1px solid #f1f5f9;}' +
    '.info td.r{text-align:right;font-weight:600;}' +
    '.rincian th{background:#f8fafc;color:#475569;padding:8px 6px;border-bottom:2px solid #e2e8f0;text-align:left;font-size:12px;}' +
    '.rincian td{padding:7px 6px;border-bottom:1px solid #f1f5f9;}' +
    '.rincian td.c{text-align:center;}.rincian td.r{text-align:right;}' +
    '.rincian tr:nth-child(even) td{background:#fafafa;}' +
    '.calc td{padding:7px 4px;border-bottom:1px solid #f1f5f9;}.calc td.r{text-align:right;}' +
    '.calc .tot td{border-top:2px solid #111827;font-weight:bold;font-size:17px;padding-top:12px;color:#f97316;}' +
    '.muted{color:#6b7280;font-size:12px;}' +
    '.foot{margin-top:22px;color:#9ca3af;font-size:11px;text-align:center;}' +
    '@media print{body{background:#fff;padding:0;}.slip{border:none;}}' +
    '</style></head><body><div class="slip">' +
    '<div class="head"><div><h1>Slip Gaji</h1><div class="brand">GoodGems Absensi</div></div>' +
    '<div class="per"><strong>Periode</strong><br>' + periode + '</div></div>' +

    '<h2>Identitas Karyawan</h2>' +
    '<table class="info">' +
    '<tr><td>Nama</td><td class="r">' + (r.nama || '-') + '</td></tr>' +
    '<tr><td>ID Karyawan</td><td class="r">' + (r.idKaryawan || '-') + '</td></tr>' +
    '<tr><td>Upah Harian</td><td class="r">' + __slipFmtRp(r.baseHarian) + ' / ' + (r.jamKerja || '-') + ' jam</td></tr>' +
    '<tr><td>Tarif per Jam <span class="muted">(upah pokok)</span></td><td class="r">' + __slipFmtRp(rateJam) + '</td></tr>' +
    '<tr><td>Tarif Lembur per Jam</td><td class="r">' + __slipFmtRp(rateLembur) + '</td></tr>' +
    '<tr><td>Status Pembayaran</td><td class="r">' + (sudahLunas ? '<strong style="color:#16a34a">LUNAS / PAID</strong>' : 'Belum Dibayar') + '</td></tr>' +
    bankHtml +
    '</table>' +

    '<h2>Rincian Kehadiran Harian</h2>' +
    '<table class="rincian">' +
    '<thead><tr><th>Tanggal</th><th>Masuk</th><th>Keluar</th><th>Total</th><th>Efektif</th><th>Lembur</th><th>Kategori</th><th>Upah Pokok</th></tr></thead>' +
    '<tbody>' + rowsHtml + '</tbody>' +
    '</table>' +

    '<h2>Ringkasan Kehadiran</h2>' +
    '<table class="info">' +
    '<tr><td>Hari Hadir Penuh</td><td class="r">' + (r.hariHadir != null ? r.hariHadir : '-') + ' hari</td></tr>' +
    '<tr><td>Hari Kerja Singkat <span style="font-size:10px;color:#888">(tetap dihitung masuk &mdash; dibayar sesuai jam)</span></td><td class="r">' + (r.hariParsial != null ? r.hariParsial : 0) + ' hari</td></tr>' +
    '<tr><td>Total Jam Kerja Efektif</td><td class="r">' + __slipJam(r.totalJamKerja) + '</td></tr>' +
    '<tr><td>Total Jam Lembur</td><td class="r">' + __slipJam(jamLembur) + '</td></tr>' +
    '</table>' +

    '<h2>Perhitungan Gaji</h2>' +
    '<table class="calc">' +
    '<tr><td>Upah Pokok <span class="muted">(akumulasi kontribusi harian)</span></td><td class="r">' + __slipFmtRp(r.upahPokok) + '</td></tr>' +
    '<tr><td>Upah Lembur <span class="muted">(' + __slipJam(jamLembur) + ' &times; ' + __slipFmtRp(rateLembur) + ')</span></td><td class="r">' + __slipFmtRp(r.upahLembur) + '</td></tr>' +
    ((r.tunjangan && r.tunjangan > 0) ? '<tr><td>Tunjangan Jabatan <span class="muted">(tetap per bulan)</span></td><td class="r">' + __slipFmtRp(r.tunjangan) + '</td></tr>' : '') +
    ((r.bonus && r.bonus > 0) ? '<tr><td>Bonus</td><td class="r">+ ' + __slipFmtRp(r.bonus) + '</td></tr>' : '') +
    ((r.potongan && r.potongan > 0) ? '<tr><td>Potongan / Kasbon</td><td class="r">- ' + __slipFmtRp(r.potongan) + '</td></tr>' : '') +
    '<tr class="tot"><td>Total Diterima</td><td class="r">' + __slipFmtRp(r.totalBayar != null ? r.totalBayar : r.total) + '</td></tr>' +
    '</table>' +

    '<div class="foot">Slip ini dibuat otomatis dari sistem absensi GoodGems pada ' + new Date().toLocaleString('id-ID') + '. Perhitungan transparan berdasarkan catatan kehadiran. Bukan bukti pembayaran resmi.</div>' +
    '</div></body></html>';

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = String(r.nama || 'karyawan').replace(/[^a-zA-Z0-9]+/g, '_');
  a.href = url;
  a.download = 'Slip_Gaji_' + safeName + '_' + periode.replace(/\s+/g, '_') + '.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Delegasi klik untuk tombol slip gaji.
document.addEventListener('click', function (e) {
  const b = e.target.closest && e.target.closest('.pr-slip-btn');
  if (b) {
    downloadSlipGaji(b.dataset.uid);
  }
});

// ===== Modal Profil Karyawan (read-only) =====
async function showProfilKaryawan(uid){
  try {
    const d = await DB.karyawanSatu(uid);
    if(!d){ alert('Data karyawan tidak ditemukan'); return; }
    const esc = (v)=>{ if(v===undefined||v===null||v==='') return '-'; return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
    let tj = '-';
    if(d.tanggalJoin){ try { const t = new Date(d.tanggalJoin+'T00:00:00'); tj = t.toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'}); } catch(e){} }
    const baseH = d.baseHarian ? ('Rp '+Number(d.baseHarian).toLocaleString('id-ID')) : '-';
    const row = (label,val)=>'<div style="display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.08);"><span style="color:#94a3b8;">'+label+'</span><span style="text-align:right;font-weight:600;">'+val+'</span></div>';
    const sec = (title)=>'<h4 style="margin:14px 0 4px;color:#e2e8f0;">'+title+'</h4>';
    let html = '';
    html += sec('Data Pribadi');
    html += row('Nama Lengkap', esc(d.full_name || d.nama));
    html += row('Nama Panggilan', esc(d.namaPanggilan || d.nama));
    html += row('No. HP', esc(d.phone));
    html += row('ID Karyawan', esc(d.idKaryawan));
    html += row('Jabatan', esc(d.jabatan));
    html += row('Peran', esc(d.peran));
    html += row('Tanggal Join', tj);
    html += sec('Payroll');
    html += row('Base Harian', baseH);
    html += row('Jam Kerja / hari', esc(d.jamKerja));
    html += row('Multiplier Lembur', esc(d.multiplierLembur));
    html += sec('Rekening Bank');
    html += row('Nama Bank', esc(d.namaBank));
    html += row('Atas Nama', esc(d.atasNamaRek));
    html += row('Nomor Rekening', esc(d.nomorRekening));
    html += sec('Dokumen');
    html += row('Status Rekening', d.rekeningLocked ? 'Terkunci (sudah diisi karyawan)' : 'Belum dikunci');
    if(d.ktpUrl){ html += '<div style="margin-top:8px;"><div style="color:#94a3b8;margin-bottom:4px;">Foto KTP</div><a href="'+d.ktpUrl+'" target="_blank" rel="noopener"><img src="'+d.ktpUrl+'" style="max-width:100%;border-radius:8px;"></a></div>'; }
    else { html += row('Foto KTP', 'Belum diupload'); }
    const body = document.getElementById('profilViewBody');
    if(body) body.innerHTML = html;
    const ttl = document.getElementById('pvTitle');
    if(ttl) ttl.textContent = 'Profil: ' + (d.full_name || d.nama || '-');
    const modal = document.getElementById('profilViewModal');
    if(modal) modal.classList.remove('hidden');
  } catch(e){ console.error('showProfilKaryawan', e); alert('Gagal memuat profil: ' + pesanRamah(e)); }
}
(function(){
  var btn = document.getElementById('btnProfilViewClose');
  if(btn) btn.onclick = function(){ var m = document.getElementById('profilViewModal'); if(m) m.classList.add('hidden'); };
})();

/* ===== Kode Clock-out di sidebar owner (PR-CL55) =====
   Kode yang sama dengan yang tampil di halaman admin bertugas.
   Hanya dirender kalau yang login beneran owner (sekarang dicek dari kolom
   karyawan.peran, bukan daftar email di kode). */
function renderKodeSidebar(){
  const sbEl = document.getElementById('sidebar');
  if (!sbEl || sbEl.__kodeBox) return;
  const box = document.createElement('div');
  sbEl.__kodeBox = box;
  box.style.cssText = 'margin:14px 12px;padding:10px 12px;border-radius:10px;background:#141414;border:1px solid #2a2a2a;display:none';
  box.innerHTML = '<div style="font-size:11px;color:#9ca3af;font-weight:600;letter-spacing:.05em">&#x1F511; KODE CLOCK-OUT</div>'
    + '<div id="sbKodeVal" style="font-size:22px;font-weight:800;letter-spacing:.3em;color:#f97316">----</div>'
    + '<div id="sbKodeTimer" style="font-size:11px;color:#9ca3af">-</div>';
  sbEl.appendChild(box);
  const render = ()=>{
    const isOwner = !!(SAYA && SAYA.peran === 'owner');
    box.style.display = isOwner ? '' : 'none';
    if (!isOwner) return;
    const v = document.getElementById('sbKodeVal'); if (v) v.textContent = kodeClockout(0);
    const sisa = KODE_SLOT_MS - (Date.now() % KODE_SLOT_MS);
    const t = document.getElementById('sbKodeTimer');
    if (t) t.textContent = 'ganti dalam ' + Math.floor(sisa/60000) + ':' + String(Math.floor((sisa%60000)/1000)).padStart(2,'0');
  };
  render();
  setInterval(render, 1000);
}

// ===== Backfill nama existing -> panggilan lowercase (1 kata) + nama lengkap, untuk sync WMS =====
// Hanya menyentuh kolom nama; data kehadiran (keyed by karyawan_id) tidak diubah.
// Konfirmasi per orang (klik Simpan).
(function(){
  const openBtn = document.getElementById('btnSyncNama');
  if (!openBtn) return;
  let modal = null;
  const escHtml = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const escAttr = s => escHtml(s).replace(/"/g,'&quot;');

  function buildModal(){
    modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:9999;padding:16px';
    modal.innerHTML =
      '<div style="background:var(--gg-surface,#262522);color:var(--gg-text,#f5f3ec);border:1px solid var(--gg-border,#403d37);border-radius:12px;max-width:840px;width:100%;max-height:88vh;overflow:auto;padding:18px">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px"><h3 style="margin:0">Sinkronkan Nama ke WMS</h3><button type="button" id="syncNamaClose" class="btn btn-secondary">Tutup</button></div>'
      + '<p class="muted" style="font-size:13px;margin:0 0 12px">Cek tiap baris. <b>Panggilan</b> = 1 kata huruf kecil (dibaca WMS). <b>Nama Lengkap</b> tampil di profil. Klik <b>Simpan</b> per orang. Data kehadiran tidak tersentuh.</p>'
      + '<div id="syncNamaWarn" style="color:#fca5a5;font-size:13px;margin-bottom:8px"></div>'
      + '<div id="syncNamaList"></div>'
      + '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    modal.querySelector('#syncNamaClose').onclick = () => { modal.style.display = 'none'; };
  }

  function checkDupes(){
    const seen = {}, dupes = new Set();
    modal.querySelectorAll('.syncRow').forEach(r => {
      const v = (r.querySelector('.sync-pg').value||'').trim().toLowerCase();
      if (!v) return;
      if (seen[v]) dupes.add(v); else seen[v] = true;
    });
    modal.querySelectorAll('.syncRow').forEach(r => {
      const inp = r.querySelector('.sync-pg');
      const v = (inp.value||'').trim().toLowerCase();
      inp.style.outline = (v && dupes.has(v)) ? '2px solid #ef4444' : '';
    });
    modal.querySelector('#syncNamaWarn').textContent = dupes.size
      ? ('Panggilan kembar: ' + Array.from(dupes).join(', ') + ' — bikin unik dulu sebelum simpan.') : '';
  }

  async function saveRow(btnEl){
    const row = btnEl.closest('.syncRow');
    const uid = row.dataset.uid;
    const full = (row.querySelector('.sync-full').value||'').trim();
    const pg = normalizePanggilan(row.querySelector('.sync-pg').value||'');
    if (!pg.ok){ alert(pg.error); return; }
    if (!full){ alert('Nama lengkap wajib diisi.'); return; }
    btnEl.disabled = true; btnEl.textContent = '...';
    try {
      if (await panggilanTaken(pg.value, uid)){ alert('Panggilan "' + pg.value + '" sudah dipakai karyawan lain.'); btnEl.disabled = false; btnEl.textContent = 'Simpan'; return; }
      await DB.simpanKaryawan(uid, { nama: pg.value, nama_lengkap: full });
      btnEl.textContent = 'Tersimpan ✓'; btnEl.classList.remove('btn-primary'); btnEl.classList.add('btn-success');
      row.querySelector('.sync-cur').textContent = 'skrg: ' + pg.value;
    } catch(e){ alert('Gagal simpan: ' + pesanRamah(e)); btnEl.disabled = false; btnEl.textContent = 'Simpan'; }
  }

  async function open(){
    if (!modal) buildModal();
    modal.style.display = 'flex';
    const list = modal.querySelector('#syncNamaList');
    list.innerHTML = '<p class="muted">Memuat...</p>';
    let rows = [];
    try { rows = await DB.karyawanSemua(); }
    catch(e){ list.innerHTML = '<p style="color:#fca5a5">Gagal memuat: ' + pesanRamah(e) + '</p>'; return; }
    rows.sort((a,b)=>String(a.nama||'').localeCompare(String(b.nama||'')));
    list.innerHTML = rows.map(r => {
      const full = r.full_name || r.nama || '';
      const nrm = normalizePanggilan(r.namaPanggilan || '');
      const sugg = nrm.ok ? nrm.value : suggestPanggilan(full || r.nama || '');
      return '<div class="syncRow" data-uid="' + escAttr(r.id) + '" style="display:grid;grid-template-columns:1.2fr 1fr auto auto;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--gg-border,#403d37)">'
        + '<input class="sync-full" type="text" value="' + escAttr(full) + '" placeholder="Nama lengkap" style="padding:6px 8px">'
        + '<input class="sync-pg" type="text" maxlength="20" value="' + escAttr(sugg) + '" placeholder="panggilan" style="padding:6px 8px">'
        + '<span class="sync-cur muted" style="font-size:12px;white-space:nowrap">skrg: ' + escHtml(r.nama||'-') + '</span>'
        + '<button type="button" class="btn btn-sm btn-primary sync-save">Simpan</button>'
        + '</div>';
    }).join('') || '<p class="muted">Belum ada karyawan.</p>';
    checkDupes();
    list.querySelectorAll('.sync-pg').forEach(inp => inp.addEventListener('input', () => {
      const cleaned = (inp.value||'').toLowerCase().replace(/[^a-z0-9]/g,'');
      if (cleaned !== inp.value) inp.value = cleaned;
      checkDupes();
    }));
    list.querySelectorAll('.sync-save').forEach(b => b.onclick = () => saveRow(b));
  }

  openBtn.onclick = open;
})();
