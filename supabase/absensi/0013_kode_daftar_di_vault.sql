-- PR-CL116: kode pendaftaran karyawan pindah ke Vault (kode lama sudah terlihat publik di repo).
-- Fungsinya membaca Vault `absensi_kode_daftar`, jadi file SQL di repo publik tidak memuat kodenya.
-- Ganti kode: select vault.update_secret(id, '<kode baru>') from vault.secrets where name = 'absensi_kode_daftar';
-- Isi lengkap fungsi: riwayat migrasi Supabase absensi_0013_kode_daftar_di_vault
-- (sama dengan 0003 daftar_karyawan, kecuali v_kode_benar dibaca dari vault.decrypted_secrets).
set lock_timeout = '5s';
set statement_timeout = '60s';
