import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";

import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

export const firebaseConfig = {
    apiKey: "AIzaSyAtbQWVdMYzIhp0hdtioPaDmULEYQBYvmg",
    authDomain: "absensi-karyawan-207d9.firebaseapp.com",
    projectId: "absensi-karyawan-207d9",
    storageBucket: "absensi-karyawan-207d9.firebasestorage.app",
    messagingSenderId: "819005025283",
    appId: "1:819005025283:web:459c4dba62bb22dcc63236",
    measurementId: "G-35DB38FN9P"
};

// Email OWNER (Dashboard owner access)
export const OWNER_EMAILS = [
    "gerriomail@gmail.com",
        "steffieerzamia@gmail.com"
  ];

// Lokasi kantor/ruko (Ruko BSM A2/9, Pakulonan, Serpong Utara)
// Hybrid geofence: absen tetap boleh, tapi diberi flag kalau di luar radius.
// NOTE: 'radius' adalah field utama (dipakai karyawan.js). 'radiusMeters' di-alias
// supaya kompatibel dengan kode lama yang mungkin masih referensi keduanya.
export const OFFICE_LOCATION = {
    lat: -6.238929,
    lng: 106.6459816,
    radius: 300,
        radiusMeters: 300
};

// === Kode verifikasi Clock Out (PR-CL55) ===
// Kode 4 angka yang GANTI OTOMATIS tiap 10 menit, dihitung dari slot waktu + secret.
// Dipakai bersama: owner & admin bertugas NAMPILIN kode, halaman karyawan VERIFIKASI input.
// Catatan: ini "pager" bukan gembok baja — cukup untuk disiplin staf non-teknis.
export const KODE_SLOT_MS = 10 * 60 * 1000; // kode ganti tiap 10 menit
export function kodeClockout(slotOffset) {
    const slot = Math.floor(Date.now() / KODE_SLOT_MS) + (slotOffset || 0);
    const s = 'gg-absensi-kode-2026:' + slot;
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    // Avalanche mixing: biar kode slot BERURUTAN tidak berurutan juga (ga bisa ditebak dari kode sebelumnya).
    h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13; h = Math.imul(h, 3266489917); h ^= h >>> 16;
    return String(Math.abs(h) % 10000).padStart(4, '0');
}

// ===== Sinkron identitas dengan WMS GoodGems =====
// WMS mengidentifikasi karyawan lewat NAMA PANGGILAN: satu kata, huruf kecil semua
// (mis. "mila", "fian"). Field `nama` di dokumen karyawan diisi panggilan ini supaya
// sync WMS match otomatis. Helper di bawah dipakai bersama oleh form daftar & owner.

// Normalisasi input panggilan -> { ok, value, error }.
// Aturan: wajib satu kata, huruf kecil, tanpa spasi/simbol/aksen.
export function normalizePanggilan(raw){
  const trimmed = (raw || '').trim();
  if (!trimmed) return { ok:false, value:'', error:'Nama panggilan wajib diisi.' };
  const lower = trimmed.toLowerCase();
  if (/\s/.test(lower)) return { ok:false, value:'', error:'Nama panggilan harus SATU kata (tanpa spasi).' };
  if (!/^[a-z0-9]+$/.test(lower)) return { ok:false, value:'', error:'Nama panggilan hanya boleh huruf/angka, tanpa simbol atau tanda baca.' };
  return { ok:true, value:lower, error:'' };
}

// Saran panggilan dari nama lengkap: ambil kata pertama, buang karakter non-alfanumerik.
export function suggestPanggilan(fullName){
  const first = (fullName || '').trim().split(/\s+/)[0] || '';
  return first.toLowerCase().replace(/[^a-z0-9]/g,'');
}

// === Jadwal libur mingguan (PR-CL60) ===
// Hari libur per karyawan (0=Minggu .. 6=Sabtu; cocok dgn Date.getDay() & wibParts.wd).
// Maks 2 orang libur di hari yang sama biar toko ga kosong. Unpaid — ga nyentuh payroll.
export const LIBUR_HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
export const LIBUR_MAX = 2;

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
