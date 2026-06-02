# 🤖 AGENTS.md — Absensi Karyawan (GoodGems)

> Catatan kerja untuk agent/bot yang ngebantu maintain sistem absensi & payroll GoodGems.
> Ditulis biar siapa pun (atau bot lain) bisa langsung paham pola kerja, aturan bisnis, dan struktur data tanpa harus investigasi ulang.

## ⚡ TL;DR (briefing 60 detik)

- **App**: PWA absensi karyawan (Clock In/Out, Break, Pause, Overtime, GPS, Selfie).
- **Backend**: Google **Firestore** (project `absensi-karyawan-207d9`). **BUKAN Supabase.**
- **Hosting**: GitHub Pages dari branch `main` → CNAME → `absensi.goodgems.online`. **Push ke main = auto-deploy ke produksi.**
- **Sumber data lembur eksternal**: app **Hadirr** (user.hadirr.com) — dipakai buat verifikasi/serap jam lembur.
- **Aturan emas**: jangan pernah force-push kode yang belum terverifikasi ke `main`. Selalu lewat **branch + Pull Request** biar owner yang kontrol merge/deploy.

## 🧱 Model Data (Firestore)

Data bersifat **event-based**. Tiap aksi clock = 1 dokumen di koleksi `absensi`.

Field tiap dokumen: `{ tipe, ts (Timestamp), nama, uid, email, inRadius, jarak, lokasi, ... }`

Nilai `tipe` yang valid:
`clock_in`, `clock_out`, `break_in`, `break_out`, `pause_in`, `pause_out`, `overtime_in`, `overtime_out`.

Koleksi lain: `karyawan` (master data gaji), `profil`.

Field gaji per karyawan: `baseHarian` (upah harian), `jamKerja` (kuota jam kerja, ada yg 9 ada yg 10).

## 💰 Aturan Bisnis Lembur (PENTING — jangan diubah tanpa konfirmasi owner)

1. **Tarif lembur = FLAT**, sama dengan tarif jam normal.
   `ratePerJam = baseHarian / jamKerja`. `upahLembur = ratePerJam × jamLembur`.

2. **Overtime mulai otomatis** saat kuota jam kerja NET terpenuhi:
   `otInMs = clockIn.ts + (jamKerja × 3.600.000 ms) + totalDurasiPause`.

3. **Pause/Break TIDAK dihitung sebagai jam kerja.** Kalau karyawan pause, jam kerja mundur — kuota 9/10 jam harus benar-benar NET di luar pause. Yang dijumlahkan: pasangan `break_in→break_out` DAN `pause_in→pause_out`.

4. **Lembur HANYA terhitung kalau karyawan menekan "Clock Out Lembur" (Selesai Lembur).** Clock out biasa TIDAK PERNAH menghitung lembur, meskipun sudah melebihi jam kerja. Alasannya: karyawan sering lupa clock out, jadi clock out biasa nggak bisa dipercaya sebagai penanda lembur.

## 🧭 Pola Kerja Owner (cara owner ngasih tugas)

- Owner ngomong casual ("bro"), **nggak ngerti kode sama sekali** — bot yang ngerjain teknisnya.
- Owner biasanya kasih masalah dulu ("kenapa X?"), lalu klarifikasi aturan bisnis bertahap. Selalu konfirmasi pemahaman sebelum nulis data/kode.
- Untuk perubahan kode: kerjakan sendiri, **lewat PR**, jangan langsung ke main.
- Kalau serap data eksternal (Hadirr): tampilkan tabel dulu ke owner buat di-approve sebelum nulis ke Firestore.

## 🔧 Teknik & Catatan Operasional

- **Baca/tulis Firestore dari app**: `import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js')` → `getApps()[0]`, lalu modul firestore (`getFirestore/getDocs/collection/query/where/addDoc/Timestamp`). Read & write dua-duanya jalan.
- **Konversi waktu WIB→UTC**: `new Date('2026-05-15T19:07:00+07:00')`.
- **Editor web GitHub (CodeMirror)**: hindari select-all + paste manual (pernah bikin file korup/duplikat). Lebih aman edit minimal & targeted, atau set lewat API editor.
- **Deploy**: commit ke branch baru → buka PR → owner yang merge.

## ✅ Checklist sebelum PR

- [ ] Logika lembur masih sesuai 4 aturan di atas (flat rate, kuota NET, pause mundur, hanya via Clock Out Lembur).
- [ ] Tidak ada perubahan langsung ke `main`.
- [ ] Perubahan kode sudah divalidasi sintaks.
- [ ] PR menjelaskan apa yang berubah dengan bahasa non-teknis buat owner.

## 🛠️ Cara file ini dirawat

Update file ini tiap kali ada aturan bisnis baru, perubahan struktur data, atau pola kerja baru yang ketemu. Tulis ringkas, pakai bahasa yang owner ngerti.
