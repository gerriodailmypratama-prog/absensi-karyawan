# Bot Absensi Telegram — Kopikiri

Laporan absensi Kopikiri otomatis ke Telegram. Jalan via **GitHub Actions cron**,
**baca-saja** dari **Postgres (Supabase)**, dan **ga pernah nyentuh flow absen**
karyawan.

Ini pindahan dari versi Firestore (repo `absensi-karyawan` / GoodGems). Yang
ganti **cuma sumber datanya**. Format pesan, jadwal, rumus jam efektif, dan
mekanisme anti-gagalnya dijiplak 1:1 — biar perilakunya sama persis.

## Apa yang dikirim

| Laporan | Jadwal | Isi |
|---|---|---|
| **Harian** | tiap hari **05:30 WIB** | Ulang tahun hari ini, Hadir (masuk→pulang · jam efektif), Telat, Lupa clock-out, Libur, Ga masuk, Total tim |
| **Rekap gajian** | tiap **tgl 26, 07:00 WIB** | Per karyawan: total hari hadir + total jam efektif (periode 26 lalu–25 ini), urut terbanyak. Tanpa estimasi upah. |

**Kenapa rekap harian dikirim subuh, bukan malam:** yang dilaporin bukan "hari
ini", tapi **jendela kerja yang paling baru kelar** — 04:00 WIB kemarin s/d
04:00 WIB tadi pagi. Dua alasannya, dua-duanya kejadian nyata di GoodGems:

1. Orang lembur lewat tengah malam (pulang 00:16, 02:28). Rekap jam 21:00 motong
   hari sebelum selesai, dan shift malam kecap **"Ga masuk"** padahal masuk.
2. GitHub cron bisa **ngaret berjam-jam**. Karena targetnya jendela yang udah
   kelar, telat pun tetap ngelaporin hari yang bener.

Timezone: **WIB (UTC+7)**, fixed — Jakarta ga ada DST.

> **Catatan cabang:** tabel udah punya kolom `cabang_id`, tapi bot **sengaja
> belum mecah rekap per outlet**. Datanya belum ada dari klien, dan tahap
> pertama emang mau sama persis dulu kayak GoodGems. Nanti cabang cuma jadi
> label + filter, bukan bongkar struktur.

## Cara nyalain (sekali doang) — 4 langkah

### 1. Bikin bot Telegram baru
Chat **@BotFather** di Telegram → `/newbot` → ikutin → dia kasih **token**
(bentuknya `123456789:AAH...`). Bot ini **KHUSUS absensi Kopikiri**, jangan
pakai token bot yang udah dipakai app lain.

### 2. Bikin grup tujuan & ambil chat id
Bikin grup Telegram, **masukin bot-nya ke grup**. Buat dapet **chat id**:
tambahin `@RawDataBot` (atau `@getidsbot`) ke grup sebentar — dia nampilin
`chat id` (grup biasanya diawali `-100...`) — terus **keluarin lagi** bot info
itu dari grup.

### 3. Ambil kredensial Supabase
Buka [Supabase Dashboard](https://supabase.com/dashboard) → pilih project
**kopikiri-absensi** → ⚙ **Project Settings** → **API keys**:

- **`SUPABASE_URL`** — di bagian *Project URL*, bentuknya
  `https://<project-ref>.supabase.co`
- **`SUPABASE_SERVICE_ROLE_KEY`** — di bagian *Project API keys*, yang labelnya
  **`service_role`** (bukan `anon`!). Harus diklik **Reveal** dulu.

> ⚠️ **`service_role` key itu kunci master** — dia ngelewatin semua aturan RLS.
> Dia boleh ada di **GitHub Secrets doang**. JANGAN pernah ditaruh di file
> `js/*.js`, `*.html`, atau di mana pun yang kebuka di browser. Yang buat
> browser itu key `anon`/publishable, bukan yang ini.

### 4. Isi 4 secret di GitHub
Repo → **Settings** → *Secrets and variables* → **Actions** →
*New repository secret*:

| Secret | Isinya | Ambil dari |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | token bot | langkah 1 (@BotFather) |
| `TELEGRAM_CHAT_ID` | id grup tujuan, mis. `-1001234567890` | langkah 2 (@RawDataBot) |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | langkah 3 (Project Settings → API keys) |
| `SUPABASE_SERVICE_ROLE_KEY` | key `service_role` | langkah 3 (klik Reveal) |

Selesai. **Sebelum secret diisi, workflow-nya skip diam** (ga error, ga merah) —
jadi aman di-merge duluan sambil nunggu kredensial dari klien.

## Ngetes sekarang (ga usah nunggu jadwal)

Repo → tab **Actions** → **Bot Absensi Telegram** → **Run workflow**:

- **report**: `daily` atau `gajian`
- **dry run**: centang kalau cuma mau **lihat teksnya di log** tanpa ngirim ke
  grup dan tanpa nyentuh outbox. Enak buat ngecek data dulu sebelum berisik.

Mau tes dari laptop:

```bash
cd bot
npm install
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DRY_RUN=1 node daily.js
```

## Prinsip teknis

- **Baca-saja.** Bot cuma `SELECT` dari `karyawan` dan `absensi`. Satu-satunya
  tabel yang dia tulis: **`telegram_outbox`** (punya dia sendiri). Kalau bot
  rusak, absen karyawan **ga ikut rusak**.
- **Ga ada fire-and-forget.** Tiap laporan dicatat di `telegram_outbox`
  (`sending`/`sent`/`failed` + **teksnya ikut disimpan sebelum dikirim**). Gagal
  kirim ⇒ teksnya **ga hilang**, tinggal rerun workflow buat nyoba ulang.
- **Idempotent.** Dedup per `(jenis, kunci)` — `harian_2026-08-28`,
  `gajian_2026-08-25`. Udah `sent` ⇒ rerun dilewati, ga kekirim dobel walau
  cron jalan 2×.
- **Query dipaging.** PostgREST motong hasil di 1000 baris. 150 karyawan × 30
  hari ≈ 18.000 event pas rekap gajian, jadi `fetchAll()` muter pakai `.range()`
  sampai habis. Ini jebakan baru yang ga ada di versi Firestore — **jangan
  diganti jadi sekali select**.
- **Plain text** (tanpa Markdown/HTML) — nama dengan karakter spesial aman.
  Pesan panjang dipecah otomatis di batas baris (limit Telegram 4096).
- **Token di secret**, ga pernah di-hardcode.

## Ganti jadwal / jam

Edit `.github/workflows/telegram-bot.yml` (cron dalam **UTC**; WIB = UTC+7).
Batas telat (default menit `:15`) dan cutoff jendela shift (default jam 4 pagi)
ada di `daily.js`.

## Isi folder

| File | Gunanya |
|---|---|
| `lib.js` | Semua yang dipakai bareng: koneksi Supabase, helper WIB, hitung jam efektif, kirim Telegram, outbox |
| `daily.js` | Rekap harian |
| `payroll.js` | Rekap gajian tgl 26 |

Tabel `telegram_outbox` dibikin di `sql/0003_pr_cl03_telegram_outbox.sql`.
