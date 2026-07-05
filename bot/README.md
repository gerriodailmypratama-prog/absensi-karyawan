# Bot Absensi Telegram

Laporan absensi GoodGems otomatis ke Telegram. Jalan via **GitHub Actions cron**
(bukan Firebase Cloud Functions) — **baca-saja** dari Firestore, **ga pernah
nyentuh flow absen** karyawan.

## Apa yang dikirim

| Laporan | Jadwal | Isi |
|---|---|---|
| **Harian** | tiap hari **21:00 WIB** | Hadir (masuk→pulang · jam efektif), Telat (masuk lewat menit :15), Ga masuk, Total tim |
| **Rekap gajian** | tiap **tgl 26, 07:00 WIB** | Per karyawan: total hari hadir + total jam efektif (periode 26 lalu–25 ini), urut terbanyak. Tanpa estimasi upah. |

Jam efektif dihitung **sama persis** kayak dashboard (span jam masuk→keluar −
istirahat − pause, di-clamp ke sesi). Timezone: **WIB (UTC+7)**.

## Cara nyalain (sekali doang) — 4 langkah

1. **Bikin bot Telegram baru** — chat `@BotFather` → `/newbot` → ikutin →
   dia kasih **token** (kayak `123456:ABC-DEF...`). Bot ini KHUSUS absensi,
   jangan campur bot lain.
2. **Bikin grup/chat tujuan** — bikin grup Telegram, **masukin bot-nya** ke
   grup. Buat dapet **chat id**: tambahin `@RawDataBot` (atau `@getidsbot`) ke
   grup sebentar, dia nampilin `chat id` (grup biasanya diawali `-100...`),
   terus keluarin lagi bot info-nya.
3. **Service account Firebase** — Firebase Console → ⚙ Project settings →
   **Service accounts** → **Generate new private key** → download file JSON.
4. **Isi 3 secret di GitHub** — repo → Settings → *Secrets and variables* →
   *Actions* → *New repository secret*:
   - `TELEGRAM_BOT_TOKEN` = token dari langkah 1
   - `TELEGRAM_CHAT_ID` = chat id dari langkah 2
   - `FIREBASE_SERVICE_ACCOUNT` = **isi seluruh isi file JSON** dari langkah 3

Selesai. Sebelum secret diisi, workflow-nya skip diam (ga error).

## Ngetes sekarang (ga usah nunggu jadwal)

Repo → tab **Actions** → **Bot Absensi Telegram** → **Run workflow** → pilih
`daily` atau `gajian` → Run. Cek grup Telegram-mu.

## Prinsip teknis

- **Ga ada fire-and-forget:** tiap laporan dicatat di koleksi `telegram_outbox`
  (status `sending`/`sent`/`failed` + teks disimpan). Gagal kirim ⇒ teksnya
  **ga hilang**, rerun nyoba ulang.
- **Idempotent:** dedup per tanggal (`daily_YYYY-MM-DD`, `gajian_YYYY-MM-DD`) —
  ga kekirim dobel walau workflow jalan 2×.
- **Plain text** (tanpa Markdown/HTML) — nama dengan karakter spesial aman.
- **Token di secret**, ga pernah di-hardcode.

## Ganti jadwal / jam

Edit `.github/workflows/telegram-bot.yml` (cron dalam **UTC**; WIB = UTC+7).
Batas telat (default menit `:15`) ada di `daily.js`.
