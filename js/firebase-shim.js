// ============================================================================
// Penerjemah Firestore -> Supabase untuk dashboard owner (PR-CL114).
//
// owner.js GoodGems (3.600+ baris: rumus gaji, koreksi manual lembur/istirahat,
// kasbon, libur, slip) ditulis memakai API Firestore. Daripada menulis ulang
// logika yang sudah teruji dan jadi dasar gaji, file ini menyediakan fungsi
// dengan NAMA & BENTUK yang sama (collection, doc, getDocs, setDoc, ...) tapi
// di belakangnya membaca/menulis skema `absensi` di Supabase.
//
// Yang diterjemahkan cuma empat "koleksi" yang dipakai owner.js:
//   karyawan        -> tabel karyawan (+ payroll_status, penyesuaian_gaji,
//                      kasbon_request, libur_request untuk field peta per bulan)
//   absensi         -> tabel absensi
//   profil          -> kolom foto & tanggal lahir di tabel karyawan (baca saja)
//   payroll_status  -> tabel payroll_status
//
// Pengaman sesungguhnya tetap RLS di database: shim ini jalan dengan sesi owner
// yang login, jadi apa pun yang tidak diizinkan aturan database tetap ditolak.
//
// Beda perilaku yang DISENGAJA (lebih aman, tampilan sama):
//   * hapus event absen  -> diarsipkan lewat batalkan_absen() (bisa dipulihkan)
//   * hapus karyawan     -> dinonaktifkan & disembunyikan, riwayat absen utuh
//     (di Postgres baris absen ikut terhapus kalau karyawannya dihapus)
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  sb, kodeClockout, KODE_SLOT_MS, LIBUR_HARI, LIBUR_MAX, rapikanPanggilan,
  EMBER_SELFIE, EMBER_PROFIL, EMBER_KTP, SUPABASE_URL, SUPABASE_KEY
} from './supabase-config.js';

export { kodeClockout, KODE_SLOT_MS, LIBUR_HARI, LIBUR_MAX };

// Sama dengan js/firebase-config.js versi lama. Penjaga sungguhan: peran 'owner' di database.
export const OWNER_EMAILS = ['gerriomail@gmail.com', 'steffieerzamia@gmail.com'];
export const firebaseConfig = {};
export const db = { __shim: 'db' };
export const storage = { __shim: 'storage' };

export function normalizePanggilan(raw) {
  const r = rapikanPanggilan(raw);
  return { ok: r.ok, value: r.nilai, error: r.error };
}
export function suggestPanggilan(fullName) {
  const first = (fullName || '').trim().split(/\s+/)[0] || '';
  return first.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ------------------------------------------------------------------ waktu
export class Timestamp {
  constructor(ms) { this._ms = ms; this.seconds = Math.floor(ms / 1000); this.nanoseconds = 0; }
  static fromDate(d) { return new Timestamp(new Date(d).getTime()); }
  static fromMillis(ms) { return new Timestamp(ms); }
  static now() { return new Timestamp(Date.now()); }
  toDate() { return new Date(this._ms); }
  toMillis() { return this._ms; }
}
const SERVER_TS = { __serverTimestamp: true };
export const serverTimestamp = () => SERVER_TS;
const isServerTs = v => v === SERVER_TS;
const stempel = iso => (iso ? new Timestamp(new Date(iso).getTime()) : null);
const keIso = v => {
  if (v == null || v === '') return null;
  if (isServerTs(v)) return new Date().toISOString();
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  if (v && typeof v.toDate === 'function') return v.toDate().toISOString();
  return new Date(v).toISOString();
};
// Tanggal (tanpa jam) menurut WIB.
const keTanggalWib = v => {
  const iso = keIso(v);
  return iso ? new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' }) : null;
};
const jsonAman = o => JSON.parse(JSON.stringify(o, (k, v) => (isServerTs(v) ? new Date().toISOString()
  : (v instanceof Timestamp ? v.toDate().toISOString() : v))));

// ------------------------------------------------------------- referensi
export function collection(_db, nama) { return { __jenis: 'koleksi', nama, filter: [], urut: null, batas: null }; }
export function doc(_db, nama, id) { return { __jenis: 'dok', nama, id: String(id) }; }
export function where(field, op, value) { return { __q: 'where', field, op, value }; }
export function orderBy(field, arah) { return { __q: 'orderBy', field, arah: arah || 'asc' }; }
export function limit(n) { return { __q: 'limit', n }; }
export function query(kol, ...bagian) {
  const q = Object.assign({}, kol, { filter: [...kol.filter] });
  for (const b of bagian) {
    if (b.__q === 'where') q.filter.push(b);
    else if (b.__q === 'orderBy') q.urut = b;
    else if (b.__q === 'limit') q.batas = b.n;
  }
  return q;
}

function snapDok(id, data) {
  return { id, exists: () => data != null, data: () => (data == null ? undefined : data) };
}
function snapKoleksi(docs) {
  return { docs, size: docs.length, empty: docs.length === 0, forEach: fn => docs.forEach(fn) };
}

// --------------------------------------------------------- link foto tertutup
async function tandatangani(ember, paths) {
  const unik = [...new Set(paths.filter(p => p && !/^(https?:|data:|blob:)/i.test(p)))];
  const peta = new Map();
  for (let i = 0; i < unik.length; i += 500) {
    const potong = unik.slice(i, i + 500);
    const { data, error } = await sb.storage.from(ember).createSignedUrls(potong, 60 * 60);
    if (error) { console.warn('signed url ' + ember, error); continue; }
    (data || []).forEach(d => { if (d && d.path && d.signedUrl) peta.set(d.path, d.signedUrl); });
  }
  return p => (!p ? '' : (/^(https?:|data:|blob:)/i.test(p) ? p : (peta.get(p) || '')));
}

// ================================================================ KARYAWAN
const PETA_KOLOM_KARYAWAN = {
  email: 'email', phone: 'phone', idKaryawan: 'id_karyawan', jabatan: 'jabatan',
  statusKaryawan: 'status_kepegawaian', baseHarian: 'base_harian', jamKerja: 'jam_kerja',
  multiplierLembur: 'multiplier_lembur', tunjanganBulanan: 'tunjangan_bulanan', liburHari: 'libur_hari',
  nonaktif: 'nonaktif', gpsExempt: 'gps_exempt', wajibKodeClockout: 'wajib_kode_clockout', kodeAdmin: 'kode_admin',
  noShiftBarrier: 'no_shift_barrier', kasbonAktif: 'kasbon_aktif', kasbonPlafonPersen: 'kasbon_plafon_persen',
  namaBank: 'nama_bank', nomorRekening: 'nomor_rekening', atasNamaRek: 'atas_nama_rek', rekeningLocked: 'rekening_locked'
};

async function bacaKaryawan(id) {
  let q = sb.from('karyawan').select('*');
  if (id) q = q.eq('id', id);
  const [kar, pay, peny, kas, lib] = await Promise.all([
    q,
    sb.from('payroll_status').select('karyawan_id, periode, status, slip, dibayar_at').then(r => r),
    sb.from('penyesuaian_gaji').select('karyawan_id, periode, jenis, jumlah').then(r => r),
    sb.from('kasbon_request').select('*').order('created_at', { ascending: false }).then(r => r),
    sb.from('libur_request').select('*').order('created_at', { ascending: false }).then(r => r)
  ]);
  for (const r of [kar, pay, peny, kas, lib]) if (r.error) throw r.error;
  const baris = (kar.data || []).filter(k => !(k.ekstra && k.ekstra.dihapus_owner_at));
  const fotoUrl = await tandatangani(EMBER_PROFIL, baris.map(k => k.foto_url));
  const ktpUrl = await tandatangani(EMBER_KTP, baris.map(k => k.ktp_url));
  const per = (rows, kid) => (rows || []).filter(r => r.karyawan_id === kid);

  return baris.map(k => {
    const bayarBulan = {}, slipBulan = {}, bonusBulan = {}, potonganBulan = {};
    let slipTerakhir = null;
    for (const p of per(pay.data, k.id)) {
      bayarBulan[p.periode] = p.status === 'dibayar';
      if (p.slip && p.status === 'dibayar') {
        const s = Object.assign({}, p.slip, { paidAt: stempel(p.dibayar_at) });
        slipBulan[p.periode] = s;
        if (!slipTerakhir || (s.paidAt && slipTerakhir.paidAt && s.paidAt.toMillis() > slipTerakhir.paidAt.toMillis())) slipTerakhir = s;
      }
    }
    for (const p of per(peny.data, k.id)) {
      const peta = p.jenis === 'bonus' ? bonusBulan : potonganBulan;
      peta[p.periode] = (peta[p.periode] || 0) + Number(p.jumlah || 0);
    }
    const kb = per(kas.data, k.id)[0];
    const lb = per(lib.data, k.id)[0];
    const data = Object.assign({}, k.ekstra || {}, {
      uid: k.id,
      email: k.email || '',
      nama: k.nama || '',
      namaPanggilan: k.nama || '',
      full_name: k.nama_lengkap || '',
      phone: k.phone || '',
      idKaryawan: k.id_karyawan || '',
      jabatan: k.jabatan || '',
      statusKaryawan: k.status_kepegawaian || '',
      baseHarian: k.base_harian,
      jamKerja: k.jam_kerja,
      multiplierLembur: Number(k.multiplier_lembur),
      tunjanganBulanan: k.tunjangan_bulanan,
      tanggalJoin: k.tanggal_masuk ? new Timestamp(new Date(k.tanggal_masuk + 'T00:00:00+07:00').getTime()) : null,
      tanggalLahir: k.tanggal_lahir || '',
      liburHari: k.libur_hari,
      nonaktif: k.nonaktif === true,
      gpsExempt: k.gps_exempt === true,
      wajibKodeClockout: k.wajib_kode_clockout === true,
      kodeAdmin: k.kode_admin === true,
      noShiftBarrier: k.no_shift_barrier === true,
      kasbonAktif: k.kasbon_aktif === true,
      kasbonPlafonPersen: k.kasbon_plafon_persen,
      namaBank: k.nama_bank || '',
      nomorRekening: k.nomor_rekening || '',
      atasNamaRek: k.atas_nama_rek || '',
      ktpUrl: ktpUrl(k.ktp_url),
      rekeningLocked: k.rekening_locked === true,
      profilLocked: k.rekening_locked === true,
      spvAkses: k.peran === 'spv',
      peran: k.peran,
      photoURL: fotoUrl(k.foto_url),
      bayarBulan, slipBulan, slipTerakhir, bonusBulan, potonganBulan,
      createdAt: stempel(k.created_at),
      updatedAt: stempel(k.updated_at)
    });
    if (kb) {
      data.kasbonRequest = {
        _id: kb.id, jumlah: kb.jumlah, alasan: kb.alasan || '', status: kb.status,
        yyyymm: kb.periode, periodeLabel: kb.periode_label || kb.periode,
        disetujuiJumlah: kb.disetujui_jumlah, catatanOwner: kb.catatan_owner || '',
        createdAt: stempel(kb.created_at)
      };
      data.kasbonRequestAt = stempel(kb.created_at);
    }
    if (lb) {
      data.liburRequest = (lb.pilihan || []).map(Number);
      data.liburRequestPending = lb.status === 'menunggu';
      data.liburRequestAt = stempel(lb.created_at);
      data.__liburRequestId = lb.id;
    }
    return { id: k.id, data };
  });
}

const pendingAkun = new Map();   // id karyawan baru -> user_id akun login yang baru dibuat

async function tulisKaryawan(id, patch, gabung) {
  const baris = {};
  const ekstra = {};
  for (const [f, v] of Object.entries(patch)) {
    if (f in PETA_KOLOM_KARYAWAN) {
      baris[PETA_KOLOM_KARYAWAN[f]] = (v === '' && ['libur_hari'].includes(PETA_KOLOM_KARYAWAN[f])) ? null : v;
    } else if (f === 'nama' || f === 'namaPanggilan') {
      baris.nama = v;
    } else if (f === 'full_name') {
      baris.nama_lengkap = v || null;
    } else if (f === 'tanggalJoin') {
      baris.tanggal_masuk = keTanggalWib(v);
    } else if (f === 'tanggalLahir') {
      baris.tanggal_lahir = /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null;
    } else if (f === 'profilLocked' && !('rekeningLocked' in patch)) {
      baris.rekening_locked = v === true;
    } else if (f === 'ktpUrl') {
      if (!v) baris.ktp_url = null;          // owner mereset KTP (minta upload ulang)
    } else if (['bayarBulan', 'slipBulan', 'slipTerakhir', 'bonusBulan', 'potonganBulan',
                'kasbonRequest', 'liburRequest', 'liburRequestPending', 'spvAkses',
                'uid', 'createdAt', 'updatedAt'].includes(f)) {
      // ditangani di bawah / diabaikan (created_at & updated_at diurus database)
    } else {
      ekstra[f] = isServerTs(v) ? new Date().toISOString() : jsonAman(v);
    }
  }
  if (baris.email) baris.email = String(baris.email).trim().toLowerCase();

  const { data: lama, error: eLama } = await sb.from('karyawan').select('id, peran, ekstra').eq('id', id).maybeSingle();
  if (eLama) throw eLama;
  if ('spvAkses' in patch && (!lama || lama.peran !== 'owner')) baris.peran = patch.spvAkses ? 'spv' : 'staff';
  if (Object.keys(ekstra).length) baris.ekstra = Object.assign({}, (lama && lama.ekstra) || {}, ekstra);

  if (!lama) {
    const userId = pendingAkun.get(id) || null;
    pendingAkun.delete(id);
    if (!baris.nama) baris.nama = (baris.email || 'karyawan').split('@')[0].replace(/[^a-z0-9]/g, '');
    const { data: cab } = await sb.from('cabang').select('id').eq('kode', 'ruko').maybeSingle();
    const { error } = await sb.from('karyawan').insert(Object.assign({ id, user_id: userId, cabang_id: cab ? cab.id : null }, baris));
    if (error) throw error;
  } else if (Object.keys(baris).length) {
    const { error } = await sb.from('karyawan').update(baris).eq('id', id);
    if (error) throw error;
  }

  // ---- peta per bulan
  const saya = await idSaya();
  const bulanDari = obj => Object.keys(obj || {}).filter(m => /^\d{4}-\d{2}$/.test(m));
  const statusBaru = {};
  for (const m of bulanDari(patch.bayarBulan)) statusBaru[m] = patch.bayarBulan[m] === true;
  const slipBaru = {};
  for (const m of bulanDari(patch.slipBulan)) slipBaru[m] = patch.slipBulan[m];
  if (patch.slipTerakhir && patch.slipTerakhir.yyyymm && !(patch.slipTerakhir.yyyymm in slipBaru)) {
    slipBaru[patch.slipTerakhir.yyyymm] = patch.slipTerakhir;
  }
  for (const m of new Set([...Object.keys(statusBaru), ...Object.keys(slipBaru)])) {
    const { data: ada } = await sb.from('payroll_status').select('status').eq('karyawan_id', id).eq('periode', m).maybeSingle();
    const lunas = (m in statusBaru) ? statusBaru[m] : ((ada && ada.status === 'dibayar') || !!slipBaru[m]);
    const up = { karyawan_id: id, periode: m, status: lunas ? 'dibayar' : 'belum' };
    if (m in slipBaru) {
      const s = slipBaru[m];
      up.slip = s ? jsonAman(Object.assign({}, s, { paidAt: undefined })) : null;
      up.jumlah = s && s.totalBayar != null ? Math.round(s.totalBayar) : null;
    }
    if (lunas && (!ada || ada.status !== 'dibayar' || (m in slipBaru))) { up.dibayar_at = new Date().toISOString(); up.dibayar_oleh = saya; }
    if (!lunas) { up.dibayar_at = null; up.dibayar_oleh = null; up.slip = null; }
    const { error } = await sb.from('payroll_status').upsert(up, { onConflict: 'karyawan_id,periode' });
    if (error) throw error;
  }
  for (const [kunci, jenisHapus, jenisTulis] of [['bonusBulan', ['bonus'], 'bonus'], ['potonganBulan', ['potongan', 'kasbon'], 'potongan']]) {
    for (const m of bulanDari(patch[kunci])) {
      const n = Math.max(0, Math.round(Number(patch[kunci][m]) || 0));
      const { error: e1 } = await sb.from('penyesuaian_gaji').delete().eq('karyawan_id', id).eq('periode', m).in('jenis', jenisHapus);
      if (e1) throw e1;
      if (n > 0) {
        const { error: e2 } = await sb.from('penyesuaian_gaji').insert({ karyawan_id: id, periode: m, jenis: jenisTulis, jumlah: n, dibuat_oleh: saya });
        if (e2) throw e2;
      }
    }
  }
  if (patch.kasbonRequest && patch.kasbonRequest._id) {
    const r = patch.kasbonRequest;
    const { error } = await sb.from('kasbon_request').update({
      status: r.status,
      disetujui_jumlah: r.disetujuiJumlah != null ? Math.round(Number(r.disetujuiJumlah)) : null,
      catatan_owner: r.catatanOwner || null,
      diputus_at: r.status === 'menunggu' ? null : new Date().toISOString(),
      diputus_oleh: r.status === 'menunggu' ? null : saya
    }).eq('id', r._id);
    if (error) throw error;
  }
  if (patch.liburRequestPending === false) {
    const { error } = await sb.from('libur_request').update({ status: 'diproses', diputus_at: new Date().toISOString(), diputus_oleh: saya })
      .eq('karyawan_id', id).eq('status', 'menunggu');
    if (error) throw error;
  }
}

let _idSaya;
async function idSaya() {
  if (_idSaya !== undefined) return _idSaya;
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return (_idSaya = null);
  const { data } = await sb.from('karyawan').select('id').eq('user_id', user.id).maybeSingle();
  return (_idSaya = data ? data.id : null);
}

// ================================================================= ABSENSI
const KOLOM_ABSEN = '*, karyawan:karyawan_id (nama, email)';
const PETA_ABSEN = {
  ts: 'ts', tipe: 'tipe', jarak: 'jarak_m', inRadius: 'in_radius', gpsExempt: 'gps_exempt', noBreak: 'no_break',
  autoCap: 'auto_cap', auto: 'otomatis', flag: 'flag', lemburOverrideMin: 'lembur_override_menit',
  istirahatOverrideMin: 'istirahat_override_menit', earlyReason: 'alasan_pulang_cepat', kodeVerif: 'kode_verif'
};

async function bentukAbsen(rows) {
  const selfie = await tandatangani(EMBER_SELFIE, rows.map(r => r.foto_selfie));
  return rows.map(r => {
    const k = r.karyawan || {};
    const data = Object.assign({}, r.ekstra || {}, {
      uid: r.karyawan_id,
      nama: k.nama || '',
      email: k.email || '',
      tipe: r.tipe,
      ts: stempel(r.ts),
      lokasi: (r.lat == null && r.lng == null) ? null : { lat: r.lat, lng: r.lng, acc: r.akurasi_m, accuracy: r.akurasi_m },
      jarak: r.jarak_m == null ? null : Math.round(Number(r.jarak_m)),
      inRadius: r.in_radius,
      gpsExempt: r.gps_exempt === true,
      fotoSelfie: selfie(r.foto_selfie),
      noBreak: r.no_break === true,
      autoCap: r.auto_cap === true,
      auto: r.otomatis === true,
      flag: r.flag || undefined,
      manualEdit: r.edit_manual === true,
      editedByOwner: r.edit_manual === true,
      editedAt: stempel(r.diedit_at),
      earlyReason: r.alasan_pulang_cepat || undefined,
      catatan: r.catatan || undefined
    });
    if (r.lembur_override_menit != null) data.lemburOverrideMin = r.lembur_override_menit;
    if (r.istirahat_override_menit != null) data.istirahatOverrideMin = r.istirahat_override_menit;
    return { id: r.id, data };
  });
}

async function bacaAbsen(q) {
  // Firestore tidak membatasi jumlah dokumen; PostgREST membatasi per halaman,
  // jadi dibaca per 1000 sampai habis (atau sampai limit() yang diminta).
  const semua = [];
  const per = 1000;
  for (let dari = 0; ; dari += per) {
    let r = sb.from('absensi').select(KOLOM_ABSEN);
    for (const w of q.filter) {
      const kol = w.field === 'uid' ? 'karyawan_id' : (PETA_ABSEN[w.field] || w.field);
      const nilai = w.field === 'ts' ? keIso(w.value) : w.value;
      const op = { '==': 'eq', '>=': 'gte', '<=': 'lte', '>': 'gt', '<': 'lt', '!=': 'neq' }[w.op];
      if (!op) throw new Error('shim: operator ' + w.op + ' belum didukung');
      r = r[op](kol, nilai);
    }
    if (q.urut) r = r.order(q.urut.field === 'uid' ? 'karyawan_id' : (PETA_ABSEN[q.urut.field] || q.urut.field), { ascending: q.urut.arah !== 'desc' });
    else r = r.order('ts', { ascending: true });
    r = r.order('id', { ascending: true });
    const sisa = q.batas != null ? Math.min(per, q.batas - semua.length) : per;
    if (sisa <= 0) break;
    const { data, error } = await r.range(dari, dari + sisa - 1);
    if (error) throw error;
    semua.push(...(data || []));
    if (!data || data.length < sisa) break;
  }
  return bentukAbsen(semua);
}

async function barisAbsenDari(patch, lama) {
  const b = {};
  for (const [f, v] of Object.entries(patch)) {
    if (f in PETA_ABSEN) {
      b[PETA_ABSEN[f]] = f === 'ts' ? keIso(v) : (v === '' ? null : v);
    } else if (f === 'uid') {
      b.karyawan_id = v;
    } else if (f === 'lokasi') {
      b.lat = v ? v.lat : null; b.lng = v ? v.lng : null; b.akurasi_m = v ? (v.accuracy ?? v.acc ?? null) : null;
    } else if (f === 'fotoSelfie') {
      // owner tidak mengunggah selfie; nilai URL lama dibiarkan
    } else if (f === 'manualEdit' || f === 'editedByOwner') {
      if (v === true) b.edit_manual = true;
    } else if (f === 'editedAt') {
      b.diedit_at = keIso(v);
    } else if (['nama', 'email'].includes(f)) {
      // ikut tabel karyawan
    } else {
      b.ekstra = Object.assign({}, b.ekstra || (lama && lama.ekstra) || {}, { [f]: isServerTs(v) ? new Date().toISOString() : jsonAman(v) });
    }
  }
  return b;
}

// ============================================================== API umum
export async function getDocs(q) {
  if (q.nama === 'karyawan') {
    const rows = await bacaKaryawan(null);
    return snapKoleksi(rows.map(r => snapDok(r.id, r.data)));
  }
  if (q.nama === 'absensi') {
    const rows = await bacaAbsen(q);
    return snapKoleksi(rows.map(r => snapDok(r.id, r.data)));
  }
  if (q.nama === 'profil') {
    const rows = await bacaKaryawan(null);
    return snapKoleksi(rows.map(r => snapDok(r.id, profilDari(r.data))));
  }
  if (q.nama === 'payroll_status') {
    const { data, error } = await sb.from('payroll_status').select('karyawan_id, periode, status');
    if (error) throw error;
    return snapKoleksi((data || []).map(p => snapDok(p.periode + '_' + p.karyawan_id,
      { uid: p.karyawan_id, yyyymm: p.periode, status: p.status === 'dibayar' ? 'paid' : 'unpaid' })));
  }
  throw new Error('shim: koleksi ' + q.nama + ' belum didukung');
}

function profilDari(k) {
  const ultah = /^\d{4}-(\d{2}-\d{2})$/.exec(k.tanggalLahir || '');
  return { nama: k.namaPanggilan || k.nama, foto: k.photoURL || '', ultah: ultah ? ultah[1] : undefined, ultahNama: k.namaPanggilan || k.nama };
}

export async function getDoc(ref) {
  if (ref.nama === 'karyawan' || ref.nama === 'profil') {
    const rows = await bacaKaryawan(ref.id);
    const d = rows[0];
    return snapDok(ref.id, d ? (ref.nama === 'profil' ? profilDari(d.data) : d.data) : null);
  }
  if (ref.nama === 'absensi') {
    const { data, error } = await sb.from('absensi').select(KOLOM_ABSEN).eq('id', ref.id).maybeSingle();
    if (error) throw error;
    const rows = data ? await bentukAbsen([data]) : [];
    return snapDok(ref.id, rows[0] ? rows[0].data : null);
  }
  throw new Error('shim: getDoc ' + ref.nama + ' belum didukung');
}

export async function setDoc(ref, patch, opsi) {
  if (ref.nama === 'karyawan') return tulisKaryawan(ref.id, patch, opsi && opsi.merge);
  if (ref.nama === 'profil') return;   // foto & ultah sekarang dibaca langsung dari tabel karyawan
  if (ref.nama === 'payroll_status') {
    const [periode, uid] = [patch.yyyymm, patch.uid];
    if (!periode || !uid) return;
    return tulisKaryawan(uid, { bayarBulan: { [periode]: patch.status === 'paid' } }, true);
  }
  if (ref.nama === 'absensi') return updateDoc(ref, patch);
  throw new Error('shim: setDoc ' + ref.nama + ' belum didukung');
}

export async function updateDoc(ref, patch) {
  if (ref.nama === 'karyawan') return tulisKaryawan(ref.id, patch, true);
  if (ref.nama === 'absensi') {
    const { data: lama } = await sb.from('absensi').select('ekstra').eq('id', ref.id).maybeSingle();
    const b = await barisAbsenDari(patch, lama);
    if (!Object.keys(b).length) return;
    const { error } = await sb.from('absensi').update(b).eq('id', ref.id);
    if (error) throw error;
    return;
  }
  if (ref.nama === 'profil') return;
  throw new Error('shim: updateDoc ' + ref.nama + ' belum didukung');
}

export async function addDoc(kol, data) {
  if (kol.nama !== 'absensi') throw new Error('shim: addDoc ' + kol.nama + ' belum didukung');
  const b = await barisAbsenDari(data, null);
  const { data: kar } = await sb.from('karyawan').select('cabang_id').eq('id', b.karyawan_id).maybeSingle();
  b.cabang_id = kar ? kar.cabang_id : null;
  b.dibuat_oleh = await idSaya();
  const { data: baru, error } = await sb.from('absensi').insert(b).select('id').single();
  if (error) throw error;
  return { id: baru.id, nama: 'absensi' };
}

export async function deleteDoc(ref) {
  if (ref.nama === 'absensi') {
    const { error } = await sb.rpc('batalkan_absen', { p_id: ref.id, p_alasan: 'dihapus owner lewat dashboard' });
    if (error) throw error;
    return;
  }
  if (ref.nama === 'karyawan') {
    const { data: lama, error: e0 } = await sb.from('karyawan').select('ekstra').eq('id', ref.id).maybeSingle();
    if (e0) throw e0;
    const { error } = await sb.from('karyawan').update({
      nonaktif: true, user_id: null,
      ekstra: Object.assign({}, (lama && lama.ekstra) || {}, { dihapus_owner_at: new Date().toISOString() })
    }).eq('id', ref.id);
    if (error) throw error;
    return;
  }
  if (ref.nama === 'profil') return;
  throw new Error('shim: deleteDoc ' + ref.nama + ' belum didukung');
}

// Realtime versi sederhana: dibaca ulang tiap 20 detik (papan Beranda).
export function onSnapshot(q, onNext, onError) {
  let mati = false;
  const jalan = async () => {
    if (mati) return;
    try { onNext(await getDocs(q)); } catch (e) { if (onError) onError(e); }
  };
  jalan();
  const t = setInterval(jalan, 20000);
  return () => { mati = true; clearInterval(t); };
}

// ==================================================================== AUTH
function penggunaDari(user) {
  return user ? { uid: user.id, email: (user.email || '').toLowerCase() } : null;
}
export const auth = { currentUser: null };
export function onAuthStateChanged(_auth, cb) {
  sb.auth.getSession().then(async ({ data }) => {
    auth.currentUser = penggunaDari(data.session && data.session.user);
    // Sambungkan akun login ke baris karyawan (owner juga punya baris, peran 'owner').
    if (auth.currentUser) { try { await sb.rpc('klaim_akun_saya'); } catch (e) { console.warn('klaim akun:', e); } }
    cb(auth.currentUser);
  });
  sb.auth.onAuthStateChange((ev, session) => {
    if (ev === 'SIGNED_OUT') { auth.currentUser = null; cb(null); }
    else auth.currentUser = penggunaDari(session && session.user);
  });
}
export async function signOut() { await sb.auth.signOut(); }

// "Tambah karyawan" dari dashboard: akun login dibuat lewat klien terpisah yang
// tidak menyimpan sesi, supaya sesi owner tidak tertimpa (dulu: secondary app Firebase).
export function initializeApp() { return { __shim: 'app' }; }
export async function deleteApp() {}
export function getAuth() { return { __shim: 'auth-sekunder' }; }
export async function createUserWithEmailAndPassword(_auth, email, password) {
  const klien = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'gg-akun-baru' }
  });
  const { data, error } = await klien.auth.signUp({ email, password });
  if (error) {
    const e = new Error(error.message);
    if (/already registered/i.test(error.message)) e.code = 'auth/email-already-in-use';
    throw e;
  }
  const id = crypto.randomUUID();
  if (data && data.user) pendingAkun.set(id, data.user.id);
  return { user: { uid: id, email } };
}

// Storage Firebase tidak dipakai owner.js lagi; disediakan supaya import lama tidak pecah.
export const ref = () => ({});
export async function uploadBytes() { throw new Error('shim: uploadBytes tidak didukung'); }
export async function getDownloadURL() { throw new Error('shim: getDownloadURL tidak didukung'); }
export async function deleteObject() {}
