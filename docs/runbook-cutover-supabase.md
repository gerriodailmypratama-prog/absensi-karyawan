# Runbook peralihan absensi GoodGems: Firebase → Supabase

Malam **25 → 26 Oktober 2026** (setelah tutup buku tgl 25, sebelum shift pagi 26).
Semua yang ada di sini sudah disiapkan dan diuji per 15 Sep 2026; malam itu tinggal dijalankan berurutan.

## Yang sudah siap (tidak perlu dikerjakan lagi)

| Bagian | Di mana | Status |
|---|---|---|
| Skema `absensi` + RLS + fungsi + bucket privat | project WMS `ryuwnsxwtwfmndnbysxw`, migrasi `absensi_0001`–`0012` (file: `supabase/absensi/`) | terpasang, diuji 62 kasus RLS |
| Data Firebase → Supabase | edge fn `absensi-pindah` (mode `data`, `foto`, `banding`) | jalan & idempoten; gaji Mei–Sep identik, slip 19/19 |
| Aplikasi (karyawan, owner, SPV, login) | cabang `migrasi/app-supabase` | owner.js lewat `js/firebase-shim.js`, diuji lawan Firebase (Jul–Sep identik) |
| API skema `absensi` | `pgrst.db_schemas` (migrasi 0009) | terbuka, anon ditolak |
| WMS `sync-absensi` | repo goodgems-wms PR-CL1214, deploy v9 | dua sumber; uji 40/40 identik |
| WMS `absensi-ping` | repo goodgems-wms PR-CL1214, deploy v3 | terima token Firebase & Supabase |
| Laporan Telegram harian & gajian | edge fn `absensi-laporan` + `absensi.panggil_laporan()` | jalan (mode uji); jadwal belum dibuat |

## Sebelum malam H (paling lambat 24 Okt)

1. **Owner:** Supabase Dashboard → Authentication → URL Configuration → tambah Redirect URL
   `https://absensi.goodgems.online/**` (login Google balik ke app absensi, bukan ke WMS).
2. **Owner + 1–2 karyawan:** uji app di preview (login Google, clock in/out, istirahat, profil, slip, kasbon, dashboard owner, Pantau Tim).
3. Beri tahu 4 karyawan yang login pakai password saja: akun lama tidak ikut pindah, mereka login pakai Google
   atau daftar ulang dengan email yang sama (datanya tersambung otomatis lewat email, tanpa kode).
4. Ganti kode pendaftaran `GOODGEMS2026` (sudah terlihat publik di repo) — di `absensi.daftar_karyawan` dan `js/supabase-config.js`.
5. Deploy ulang `absensi-pindah` dari repo (versi terbaru ikut memindahkan pengajuan kasbon & `created_at` dari tanggal masuk),
   lalu salin juga 2 foto profil yang di Firestore masih base64 (belum didukung mode foto).
6. Jalankan banding sekali lagi: `select absensi.panggil_pindah('{"mode":"banding","periode":["2026-10"]}'::jsonb);`

## Malam H — urutan

1. **Bekukan Firebase** (sekitar 04:00 WIB 26 Okt, saat tidak ada yang absen): deploy `firestore.rules` hanya-baca
   (semua `allow write: if false`) lewat workflow firestore-rules. Karyawan yang masih buka app lama tidak bisa menulis.
2. **Salinan data terakhir** (buang dulu jejak uji coba dari `/uji/` — sebelum peralihan semua absen
   yang sah berasal dari Firebase, jadi baris tanpa `firebase_doc_id` pasti hasil uji):
   ```sql
   delete from absensi.absensi where firebase_doc_id is null;
   -- kasbon_request, libur_request, payroll_status, penyesuaian_gaji ikut ditulis ulang utuh oleh mode data
   ```
   ```sql
   select absensi.panggil_pindah('{"mode":"data","uji":false}'::jsonb);
   select absensi.panggil_pindah('{"mode":"foto","batas_detik":20}'::jsonb);  -- ulang sampai selfie_sisa = 0
   select absensi.panggil_pindah('{"mode":"banding","periode":["2026-10"]}'::jsonb);  -- wajib 100% cocok
   ```
3. **Rilis app:** merge cabang `migrasi/app-supabase` ke `main` (naikkan versi cache service worker) dan hapus folder `uji/`,
   tunggu GitHub Pages, cek `absensi.goodgems.online` bisa login.
4. **WMS sinkron dari Supabase:**
   ```sql
   -- ganti body-nya saja; header Authorization di perintah lama tetap dipakai
   select cron.alter_job(j.jobid,
     command := replace(j.command, $q$'{"days":3}'::jsonb$q$, $q$'{"days":3,"sumber":"supabase"}'::jsonb$q$))
   from cron.job j where j.jobname = 'sync-absensi-hourly';
   select command like '%"sumber":"supabase"%' as sudah_ganti from cron.job where jobname = 'sync-absensi-hourly';
   ```
5. **Laporan Telegram:**
   ```sql
   select cron.schedule('absensi-laporan-harian', '30 22 * * *', $$select absensi.panggil_laporan('harian')$$);
   select cron.schedule('absensi-laporan-gajian', '0 0 26 * *',  $$select absensi.panggil_laporan('gajian')$$);
   ```
   Workflow GitHub bot lama ikut hilang saat merge (sudah dicabut di cabang).
6. **Cek pagi 26 Okt:** clock in pertama muncul di papan owner, ping "masuk" muncul di grup, `attendance_daily` terisi, laporan 05:30 terkirim 27 Okt.

## Kalau gagal (rollback)

- App: revert merge di `main` → app kembali ke Firebase. Buka lagi `firestore.rules` normal.
- WMS: kembalikan body cron `sync-absensi-hourly` ke `{"days":3}`; hapus jadwal `absensi-laporan-*`.
- Absen yang sempat tercatat di Supabase selama gangguan: salin manual ke Firestore dari tabel `absensi.absensi` (baris `firebase_doc_id is null`).

## Bersih-bersih (seminggu setelah stabil)

- Firebase dibiarkan hanya-baca 1 minggu, lalu dimatikan.
- Hapus: edge fn `absensi-pindah`, `absensi-uji-shim`; Vault `absensi_pindah_token`; tabel `absensi.foto_sumber`;
  cabang Firebase di `sync-absensi` & `absensi-ping`; Vault `absensi_firebase_sa` (setelah WMS tidak butuh).
- `js/firebase-shim.js` boleh tetap (dashboard owner memakainya).
