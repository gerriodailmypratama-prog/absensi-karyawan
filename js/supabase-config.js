// ============================================================================
// Fondasi koneksi ke Supabase — pengganti firebase-config.js
//
// SEMUA file lain wajib lewat sini kalau mau ngomong ke database. Jangan bikin
// klien Supabase sendiri di file lain; kalau caranya beda-beda, nanti susah
// dirapiin dan gampang ada yang lupa pasang pengaman.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Kunci di bawah ini MEMANG boleh kelihatan publik — pengaman sesungguhnya ada
// di aturan RLS di database, bukan di sini. Jangan pernah menaruh service role
// key di file ini; itu kunci master dan tempatnya cuma di server/GitHub Secret.
const SUPABASE_URL = 'https://llhctygpgvmionmvtrjn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_8lND6wAdh4WZ84z_07045w_duXWQ1DO';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,      // sesi disimpan di HP, ga perlu login tiap buka
    autoRefreshToken: true,
    detectSessionInUrl: true   // buat login Google yang balik lewat URL
  }
});

// Kode rahasia pendaftaran karyawan. Ganti kapan saja kalau bocor.
export const KODE_PENDAFTARAN = 'KOPIKIRI2026';

// ============================================================ GEOFENCE
// Absen di luar radius TETAP BOLEH — cuma ditandai. Ini disengaja: memblokir
// orang gara-gara GPS ngaco cuma bikin drama, sementara owner tetap butuh tahu.

const GPS_TOLERANSI_MAX_M = 75;   // maklum untuk GPS HP yang meleset

// Jarak dua titik di bumi, dalam meter (rumus haversine).
export function jarakMeter(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = d => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

// Dianggap "di dalam radius" kalau jaraknya masuk, setelah dikasih kelonggaran
// sebesar akurasi GPS yang dilaporkan HP (dibatasi biar ga bisa diakalin).
export function dalamRadius(jarak, akurasi, radiusCabang) {
  const toleransi = Math.min(Math.max(Number(akurasi) || 0, 0), GPS_TOLERANSI_MAX_M);
  return (jarak - toleransi) <= (Number(radiusCabang) || 150);
}

// ============================================================== CABANG
// Beda dari GoodGems yang titiknya dipatok di kode: di sini daftar cabang
// datang dari database, jadi owner bisa tambah/pindah outlet tanpa ganti kode.

let _cacheCabang = null;

export async function ambilCabang({ paksaSegar = false } = {}) {
  if (_cacheCabang && !paksaSegar) return _cacheCabang;
  const { data, error } = await sb
    .from('cabang').select('*').eq('aktif', true).order('nama');
  if (error) throw error;
  _cacheCabang = data || [];
  return _cacheCabang;
}

// Cari cabang TERDEKAT dari posisi sekarang. Dipakai supaya staf yang lagi
// bantu outlet lain tetap kehitung absen di outlet tempat dia berdiri,
// bukan di outlet tetapnya.
export function cabangTerdekat(daftarCabang, lat, lng) {
  let terdekat = null, jarakTerdekat = Infinity;
  for (const c of daftarCabang) {
    if (c.lat == null || c.lng == null) continue;
    const j = jarakMeter(lat, lng, c.lat, c.lng);
    if (j < jarakTerdekat) { jarakTerdekat = j; terdekat = c; }
  }
  return terdekat ? { cabang: terdekat, jarak: jarakTerdekat } : null;
}

// =============================================== KODE VERIFIKASI CLOCK-OUT
// Kode 4 angka yang GANTI OTOMATIS tiap 10 menit. Ditampilkan di layar
// kasir/kantor cabang, diketik karyawan saat clock out — biar orang ga bisa
// pulang duluan lalu clock out dari rumah. Ini "pager", bukan gembok baja:
// cukup untuk disiplin staf, bukan untuk nahan orang yang niat banget.
//
// CATATAN: rahasianya SENGAJA beda dari GoodGems. Kalau disamakan, orang yang
// tahu kode di satu sistem otomatis tahu kode di sistem satunya.
export const KODE_SLOT_MS = 10 * 60 * 1000;

export function kodeClockout(geserSlot) {
  const slot = Math.floor(Date.now() / KODE_SLOT_MS) + (geserSlot || 0);
  const s = 'kopikiri-absensi-kode-2026:' + slot;
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  // Diaduk biar kode slot yang berurutan hasilnya ga ikut berurutan
  // (jadi ga bisa ditebak dari kode sebelumnya).
  h ^= h >>> 15; h = Math.imul(h, 2246822519);
  h ^= h >>> 13; h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  return String(Math.abs(h) % 10000).padStart(4, '0');
}

// ======================================================= SESI & IDENTITAS

// Data karyawan yang lagi login (termasuk cabangnya). Di-cache karena dipakai
// di banyak tempat dan isinya jarang berubah dalam satu sesi.
let _cacheSaya = null;

export async function karyawanSaya({ paksaSegar = false } = {}) {
  if (_cacheSaya && !paksaSegar) return _cacheSaya;
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;

  const { data, error } = await sb
    .from('karyawan')
    .select('*, cabang:cabang_id (id, kode, nama, lat, lng, radius_m)')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;

  _cacheSaya = data || null;
  return _cacheSaya;
}

export function lupakanCacheSaya() { _cacheSaya = null; }

export async function keluar() {
  _cacheSaya = null;
  _cacheCabang = null;
  await sb.auth.signOut();
  location.href = 'index.html';
}

// Ke mana orang diarahkan setelah login, berdasarkan perannya di database.
// Beda dari GoodGems yang mencocokkan daftar email di kode — di sini peran
// disimpan di tabel karyawan, jadi owner bisa mengangkat SPV tanpa ganti kode.
export function halamanUntuk(karyawan) {
  if (!karyawan) return 'karyawan.html';
  if (karyawan.peran === 'owner') return 'owner.html';
  if (karyawan.peran === 'spv') return 'spv.html';
  return 'karyawan.html';
}

// =========================================================== NAMA PANGGILAN
// Satu kata, huruf kecil (mis. "andi"). Dipakai sebagai nama yang tampil di
// papan kehadiran biar rapi dan gampang dibaca sekilas.
export function rapikanPanggilan(mentah) {
  const trim = (mentah || '').trim();
  if (!trim) return { ok: false, nilai: '', error: 'Nama panggilan wajib diisi.' };
  const kecil = trim.toLowerCase();
  if (/\s/.test(kecil)) {
    return { ok: false, nilai: '', error: 'Nama panggilan harus SATU kata (tanpa spasi).' };
  }
  if (!/^[a-z0-9]+$/.test(kecil)) {
    return { ok: false, nilai: '', error: 'Nama panggilan cuma boleh huruf dan angka.' };
  }
  return { ok: true, nilai: kecil, error: '' };
}

// Nomor HP -> format WhatsApp (62xxx) biar link wa.me langsung jalan.
export function nomorWa(mentah) {
  let p = String(mentah || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (p.startsWith('0')) p = '62' + p.slice(1);
  else if (p.startsWith('8')) p = '62' + p;   // orang sering ketik 8xxx tanpa 0
  return p;
}

// ============================================================ PESAN ERROR
// Supabase memberi pesan dalam bahasa Inggris teknis. Staf non-teknis butuh
// kalimat yang bisa mereka tindak lanjuti sendiri.
const PESAN_ERROR = [
  [/invalid login credentials/i,        'Email atau password salah.'],
  [/email not confirmed/i,              'Email belum diverifikasi. Cek inbox/spam ya.'],
  [/user already registered/i,          'Email ini sudah terdaftar. Silakan Login.'],
  [/password should be at least/i,      'Password minimal 6 karakter.'],
  [/unable to validate email/i,         'Format email tidak valid.'],
  [/rate limit|too many requests/i,     'Terlalu banyak percobaan. Tunggu ~5 menit lalu coba lagi.'],
  [/network|fetch failed|load failed/i, 'Koneksi internet bermasalah. Cek WiFi/data lalu coba lagi.'],
  [/popup/i,                            'Popup login diblokir browser. Coba pakai email/password.'],
  [/row-level security|permission/i,    'Akun kamu belum didaftarkan owner. Hubungi admin ya.']
];

export function pesanRamah(err) {
  const t = String((err && (err.message || err.error_description)) || err || '');
  for (const [pola, pesan] of PESAN_ERROR) if (pola.test(t)) return pesan;
  return 'Gagal: ' + (t || 'ada yang error, coba lagi sebentar lagi');
}
