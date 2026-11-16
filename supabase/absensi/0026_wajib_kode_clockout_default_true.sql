-- PR-CL144 (2026-11-16): wajib kode admin saat Clock Out = DEFAULT NYALA buat akun baru.
-- Latar: owner 16 Nov — "akun anak trial dan yang baru ga kena pakai kode" (Salsabila, Agil, Risma, Rara
-- clock-out tanpa kode). Kolom wajib_kode_clockout dibikin default false (0001, "pilot per orang") dan cuma
-- bisa dinyalain owner lewat Kelola karyawan; akun self-register (daftar_karyawan) nggak pernah kena.
-- Perubahan: default kolom jadi TRUE. Lead/SPV/PA/owner yang nggak perlu kode tetap dimatiin manual oleh owner.
-- Data: 4 akun di atas udah dinyalain manual 16 Nov (UPDATE di bawah aman diulang).
-- SUDAH di-apply ke prod 16 Nov 2026 (execute_sql); aman diulang.

alter table absensi.karyawan alter column wajib_kode_clockout set default true;
comment on column absensi.karyawan.wajib_kode_clockout is
  'PR-CL144 (16 Nov 2026): default TRUE — akun baru (trial/self-register) otomatis wajib kode admin saat Clock Out; owner matiin manual buat Lead/SPV/PA/owner.';

update absensi.karyawan set wajib_kode_clockout = true, updated_at = now()
 where not nonaktif and nama in ('salsabilla', 'agil', 'risma', 'rara') and wajib_kode_clockout = false;
