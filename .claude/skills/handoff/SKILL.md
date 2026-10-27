---
name: handoff
description: Tutup session dengan benar. Tulis hasil kerja repo ini ke goodgems-hq (file proyek + log harian), commit dan push HQ, supaya bos dan session berikutnya di device apapun langsung tau. Jalankan tiap selesai kerja atau tiap ada yang LIVE.
---

# /handoff (absensi-karyawan (Absensi GoodGems))

Tujuan: bos di goodgems-hq tau apa yang terjadi di repo ini TANPA baca chat ini.

Lokasi HQ: `C:\Users\gerri\Documents\goodgems-hq` (komputer Gerrio) atau `../goodgems-hq` (mesin lain). Sebut $HQ di bawah = folder itu.

Lakukan berurutan, jangan tanya-tanya:
1. `git -C $HQ pull --rebase`.
2. Update file proyek yang relevan di $HQ/projects/:
   - `projects/absen.md`, bagian GoodGems
   - "Status sekarang": tulis ulang jadi kondisi TERBARU, bukan ditambah di bawah.
   - "Keputusan penting": tambah kalau Gerrio ambil keputusan baru, pakai tanggal.
   - "Next step": centang yang selesai, tambah yang baru.
   - "Lokasi": lengkapi kalau nemu URL/env/db baru.
   - PR yang live: catat nomor + tanggal.
3. Kalau kolom "Status 1 baris" di $HQ/CLAUDE.md buat proyek ini berubah, update.
4. Tambah entri di $HQ/log/YYYY-MM-DD.md (buat kalau belum ada), format di $HQ/log/README.md. Sebut repo ini dan device (lokal/cloud).
5. Pastikan perubahan di repo ini sendiri udah di-commit/di-push sesuai AGENTS.md.
6. `git -C $HQ add -A && git -C $HQ commit -m "handoff: $(date +%F) absensi-karyawan (Absensi GoodGems): <ringkasan 1 baris>" && git -C $HQ push`
   Gagal karena network: coba lagi sampai 4 kali (2s, 4s, 8s, 16s). Tetap gagal: bilang jelas ke Gerrio bahwa HQ BELUM ter-push.
7. Tutup dengan 3 baris ke Gerrio: apa yang dicatat, apa yang belum, 1 kalimat yang bisa dia paste ke session berikutnya.

Jangan tulis rahasia ke HQ.
