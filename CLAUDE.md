# absensi-karyawan (Absensi GoodGems) — baca ini dulu

1. Aturan kerja repo ini ada di `AGENTS.md`. Baca itu dulu dan ikuti semuanya.
2. Repo ini bagian dari sistem yang lebih besar. Ingatan lintas proyek (status, keputusan Gerrio, next step) ada di repo **goodgems-hq** (`gerriodailmypratama-prog/goodgems-hq`). Session ini WAJIB nyambung ke sana, dua arah.

## Lokasi HQ
- Komputer Gerrio: `C:\Users\gerri\Documents\goodgems-hq`
- Cloud / mesin lain: `../goodgems-hq`. Kalau belum ada: `git clone https://github.com/gerriodailmypratama-prog/goodgems-hq ../goodgems-hq`
- Kalau dua-duanya nggak bisa diakses, bilang ke Gerrio di awal session, lalu lanjut kerja.

## Awal session (wajib)
1. `git pull` di folder HQ.
2. Baca file proyek yang relevan buat repo ini:
   - `projects/absen.md`, bagian GoodGems
3. Status terakhir, keputusan yang udah diambil, dan next step ada di sana. Jangan tanya Gerrio hal yang udah dijawab di file itu. Kalau perintah Gerrio bentrok sama file, ikuti Gerrio dan catat perubahannya.

## Akhir session, atau tiap ada yang LIVE (wajib)
Jalankan `/handoff` (skill ada di repo ini). Intinya:
- Update file proyek di HQ: "Status sekarang" ditulis ulang jadi kondisi terbaru, "Keputusan penting" ditambah kalau ada, "Next step" dicentang/ditambah, PR yang live dicatat nomornya.
- Tambah entri di `log/YYYY-MM-DD.md` di HQ (format di `log/README.md`).
- Commit dan push HQ.
- Detail teknis boleh tetap di README/docs repo ini. File HQ = ringkasan level bisnis buat bos.
- Jangan tulis rahasia (token, password, kunci) ke HQ. Tulis "ada di X".
