# Rencana Pindah Absensi GoodGems: Firebase → Supabase

Disusun 9 September 2026. Semua angka di bawah hasil pemeriksaan langsung ke
database, bukan perkiraan.

---

## Kesimpulan singkat

Perpindahan ini **jauh lebih ringan dari migrasi biasa**, karena bagian yang
paling sering bikin kacau — login — sudah beres sebelum kita mulai.

Tim GoodGems **sudah punya akun Supabase dan memakainya tiap hari** untuk WMS.
Kalau absensi ditaruh di project Supabase yang sama, mereka tinggal pakai akun
Google yang sama persis. Tidak ada daftar ulang, tidak ada reset kata sandi,
tidak ada akun baru. Alamat web sama, tampilan sama.

Dari sisi tim, idealnya yang terjadi cuma: **suatu pagi mereka absen seperti
biasa, dan tidak ada yang terasa berbeda.**

---

## Tujuan & bukan tujuan

**Tujuan**
- Memindahkan data & aplikasi absensi dari Firebase ke Supabase.
- Riwayat absensi utuh — ini dasar perhitungan gaji, tidak boleh hilang sebutir pun.
- Tim tidak perlu melakukan apa pun.

**Bukan tujuan (jangan dikerjakan sekalian)**
- Merombak tampilan.
- Menambah fitur baru (termasuk panduan bingkai selfie — kerjakan setelah stabil).
- Merapikan WMS. WMS hanya disentuh seperlunya agar tidak putus.

---

## Fakta terverifikasi

### Sumber (Firebase)
| Hal | Nilai |
|---|---|
| Project | `absensi-karyawan-207d9` |
| Koleksi | `karyawan`, `absensi`, `profil`, `payroll_status` |
| Titik panggil data | 96 (auth 3, karyawan 23, owner 66, spv 4) |
| Hosting | GitHub Pages, terbit otomatis saat push ke `main` |
| Alamat | absensi.goodgems.online |

### Tujuan (Supabase, project `ryuwnsxwtwfmndnbysxw` — "Wms Goodgems")
| Hal | Nilai |
|---|---|
| Skema terpakai | `wms` (267 tabel, 747 MB), `cash`, `goodfinds`, `health`, `historical`, `public` |
| Skema `absensi` | **belum ada** — namespace bersih |
| Bentrok nama tabel | **0** |
| Ukuran database | 983 MB |
| Bucket | `user-avatars`, `pack-recordings`, `po-photos`, `product-images`, `hiring-cv`, `todo-avatars` |

Menaruh aplikasi sebagai skema tersendiri **sudah jadi pola di project ini**
(`cash`, `goodfinds`, `health` semuanya begitu). Jadi `absensi` mengikuti pola
yang sudah ada, bukan hal baru.

### Login — inti dari "tidak terasa"
| Hal | Nilai |
|---|---|
| Akun di Supabase Auth | **51** |
| Aktif 30 hari terakhir | 29 |
| Memakai **Google** | **50** |
| Memakai kata sandi | **2** |

Kata sandi Firebase **tidak bisa dipindah** ke Supabase (cara pengacakannya
berbeda, Supabase tidak bisa memverifikasinya). Untungnya hampir semua orang
memakai Google, jadi masalah ini nyaris tidak ada. Yang memakai kata sandi
cukup sekali klik "Lupa Password".

### Sambungan WMS ↔ Absensi (yang wajib tetap hidup)
`wms.user_profiles` punya kolom `absensi_uid` (bertipe teks, berisi UID
Firebase seperti `lGlFIp0ULGcp...`), sementara `user_id` berisi uuid Supabase.
**Satu orang punya dua identitas** yang selama ini disambungkan manual.

| Hal | Nilai |
|---|---|
| Profil WMS | 36 (25 masih aktif) |
| Sudah tersambung ke absensi | 28 |
| Aktif tapi belum tersambung | 6 |
| Punya foto profil | 17 |

Enam fungsi WMS bergantung pada kolom itu:
`auto_link_absensi_uids`, `briefing_staff_list`, `get_candidate_trial_recap`,
`get_owner_staff_day`, `list_absensi_identities`, `tolak_naikin_hak`.

**Setelah pindah, dua identitas itu menjadi satu.** Sinkronisasi foto profil
Absensi→WMS yang selama ini menyalin data antar sistem juga tidak perlu lagi.

### Cetak biru yang sudah jadi
`C:\Users\gerri\projects\kopikiri-absensi` adalah **kode yang sama** yang sudah
selesai dipindah ke Supabase dan hidup di produksi sejak 1 September 2026.

- `sql/0001..0013` — **1.888 baris SQL** yang sudah terbukti jalan
- `js/supabase-config.js`, `auth.js`, `karyawan.js`, `owner.js`, `spv.js` — ±7.000 baris

Pekerjaan ini pada dasarnya **menerapkan ulang port itu**, bukan merancang dari nol.

---

## Yang belum diketahui — harus dibereskan lebih dulu

Kunci admin Firebase hanya ada di GitHub Secrets (`FIREBASE_SERVICE_ACCOUNT`),
tidak ada di komputer. Akibatnya belum bisa dihitung:

- jumlah karyawan aktif di absensi;
- berapa banyak riwayat absensi (menentukan lama migrasi);
- **berapa orang yang login pakai kata sandi, bukan Google** — merekalah
  satu-satunya yang akan merasakan perpindahan.

**Langkah nol:** turunkan kunci itu ke komputer (atau jalankan ekspor lewat
GitHub Action). Tanpa ini tidak ada yang bisa dimulai.

---

## Rancangan

```
project "Wms Goodgems"
├── auth            ← DIPAKAI BERSAMA (ini kunci mulusnya)
├── wms             ← tidak disentuh, kecuali 6 fungsi di atas
├── cash, goodfinds, health, historical
└── absensi         ← BARU: karyawan, absensi, cabang, payroll_status, dst
```

- Isolasi lewat **skema**, bukan project. WMS tidak tersentuh.
- Foto profil menumpang bucket `user-avatars` yang sudah ada → sinkronisasi
  antar sistem langsung hilang.
- Selfie absen pakai bucket baru `absensi-selfie`, **tertutup** (private),
  seperti di Kopikiri.

---

## Tahapan

**0. Akses Firebase** — turunkan service account, inventaris isi Firestore.

**1. Skema** — terapkan `sql/0001..0013` Kopikiri ke skema `absensi`, dengan
penyesuaian GoodGems (lihat bagian berikutnya). Belum menyentuh data.

**2. Pindahkan data** — tulis skrip Firestore → Postgres. Verifikasi **jumlah
baris dan sampel per orang**, bukan cuma totalnya.

**3. Sambungkan identitas** — cocokkan karyawan dengan `auth.users` lewat
email. Isi `absensi_uid` = `user_id` supaya 6 fungsi WMS tetap jalan tanpa
diubah. (Merapikan `absensi_uid` menjadi tidak perlu = pekerjaan lain, nanti.)

**4. Port kode** — ganti 96 titik panggil data, memakai versi Kopikiri sebagai
acuan. Berkas per berkas, bukan sekaligus.

**5. Uji** — jalankan uji keamanan yang sama seperti audit Kopikiri: masuk
sebagai staf biasa lalu coba ubah data orang lain, naikkan gaji sendiri, angkat
diri jadi owner, absen atas nama orang lain. Semua harus ditolak.

**6. Bandingkan** — hitung jam kerja periode yang sama di Firebase dan di
Supabase. **Angkanya harus identik sebelum beralih.** Ini pagar terakhir.

---

## Peralihan (bagian "tidak terasa")

1. **Jalan berdampingan.** Supabase sudah terisi dan benar, tapi aplikasi masih
   menunjuk Firebase. Tidak ada yang berubah bagi tim.
2. **Beralih saat sepi** — setelah absen pulang terakhir, sekitar tengah malam.
   Ganti tujuan data, terbitkan.
3. **Selisih terakhir.** Absen yang masuk antara ekspor dan peralihan disalin
   ulang (jumlahnya sedikit karena dilakukan saat toko tutup).
4. **Pagi berikutnya dipantau langsung** — pastikan absen pertama masuk.
5. **Firebase dibiarkan hidup (baca saja) seminggu** sebagai jaring pengaman.
   Baru setelah itu dimatikan.

**Yang perlu diberitahukan ke tim:** tidak ada — kecuali segelintir orang yang
login pakai kata sandi. Mereka diberitahu sehari sebelumnya: *"besok login pakai
tombol Google ya, akun yang sama seperti WMS."*

---

## Rencana mundur

Peralihan cuma soal ke mana aplikasi menunjuk. Kalau pagi itu ada yang tidak
beres: **kembalikan tunjukan ke Firebase**, terbitkan ulang, absensi jalan lagi
seperti semula. Firebase masih utuh karena tidak dimatikan.

Syaratnya satu: **Firebase tidak boleh dimatikan sebelum seminggu berjalan
mulus.**

---

## Beda GoodGems vs Kopikiri — jangan asal salin

1. `jam_kerja = 9` (Kopikiri 8). Di GoodGems, 9 jam di toko sudah termasuk
   1 jam istirahat, jadi jam kerja bersih 8. Setelan
   `potong_istirahat_kontrak_jam = 1` **sudah benar untuk GoodGems.**
2. **Kasbon aktif** (di Kopikiri dicabut karena di luar kontrak).
3. **Libur mingguan aktif lengkap dengan kuota maks 3 orang/hari**
   (di Kopikiri kuotanya dibuang).
4. Ada tunjangan jabatan, slip gaji, dan modul gajian yang dipakai sungguhan.
5. Prefix ID karyawan `GG-` (Kopikiri `KK-`).
6. **Kaitan WMS lewat nama panggilan**: kolom `nama` berisi satu kata huruf
   kecil yang dicocokkan WMS. Bukan panggilan API. Aman asalkan nilainya tidak
   berubah sedikit pun — wajib diverifikasi sebelum dan sesudah.
7. Perubahan terbaru yang harus ikut terbawa: PR-CL105 (shift pendek tidak
   dipaksa istirahat 1 jam), PR-CL106 (catatan privasi slip), PR-CL107 (satu
   slip per bulan), PR-CL108 (foto profil wajib).

---

## Jebakan yang sudah pernah menggigit — jangan terperosok dua kali

Semuanya nyata, terjadi saat port Kopikiri:

1. **Bucket tertutup menyimpan JALUR berkas, bukan URL.** Menempel jalur mentah
   ke `<img>` menghasilkan ikon gambar rusak. Wajib pakai link bertanda tangan.
   Terlewat di **6 tempat** dan baru ketahuan dari laporan pengguna.
2. **View tanpa penjaga bisa melewati RLS** — pernah membuat staf biasa bisa
   mengganti nama rekan kerja. Selalu cabut hak akses view secara eksplisit.
3. **Menguji RLS tanpa menyetel sesi login memberi hasil menyesatkan** — yang
   muncul nilai cadangan, bukan nilai sebenarnya. Selalu setel
   `request.jwt.claims` lalu `set local role authenticated`.
4. **Pencocokan akun: email dulu, lalu nomor HP.** Orang sering punya email
   Google berbeda dari catatan HRD. Tanpa ini lahir akun duplikat.
5. **Fungsi baru wajib mengunci `search_path`**, dan fungsi trigger wajib
   dicabut hak `EXECUTE`-nya supaya tidak terbuka sebagai endpoint.
6. **Tanggal format Indonesia (hari/bulan/tahun)** gampang tertukar jadi
   bulan/hari.

---

## Ceklis sebelum dinyatakan selesai

- [ ] Jumlah karyawan di Supabase = jumlah di Firebase
- [ ] Jumlah catatan absensi sama, sampel per orang cocok
- [ ] Kolom `nama` (panggilan) **identik** — kaitan WMS tidak putus
- [ ] Enam fungsi WMS masih mengembalikan hasil yang sama
- [ ] Jam kerja & lembur periode uji **identik** antara dua sistem
- [ ] Uji keamanan: staf biasa tidak bisa mengubah data siapa pun
- [ ] Foto profil & selfie tampil (link bertanda tangan, bukan jalur mentah)
- [ ] Absen pagi pertama masuk dan terlihat di papan owner
- [ ] Firebase masih hidup sebagai jaring pengaman
