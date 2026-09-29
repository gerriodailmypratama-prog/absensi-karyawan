-- PR-CL124: mode Personal Assistant (PA) — dibayar per hari hadir, tanpa hitung jam & lembur.
-- Owner, 29 Sep 2026: PA (Restu, Ila) kerjanya ngikut kebutuhan owner/istri, bukan jam.
-- Tombol istirahat & lembur dicopot, gaji = hari hadir x tarif harian (+ tunjangan/bonus manual).
--
-- pa_mulai       : tanggal (WIB) mulai berlaku. Hari SEBELUM tanggal ini tetap dihitung cara lama
--                  (jam efektif + lembur), jadi periode yang belum dibayar tidak berubah mundur.
-- pa_tarif_harian: rupiah per hari hadir. base_harian lama sengaja tidak disentuh.
-- is_pa di karyawan_publik: dipakai Pantau Tim untuk memisahkan PA (SPV tidak melihat PA).
set lock_timeout = '5s';
set statement_timeout = '60s';

alter table absensi.karyawan
  add column if not exists pa_mulai date,
  add column if not exists pa_tarif_harian integer;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'karyawan_pa_tarif_harian_cek') then
    alter table absensi.karyawan add constraint karyawan_pa_tarif_harian_cek
      check (pa_tarif_harian is null or pa_tarif_harian >= 0);
  end if;
end $$;

comment on column absensi.karyawan.pa_mulai is 'Mode PA mulai tanggal ini (WIB): dibayar per hari hadir, tanpa istirahat/lembur. NULL = karyawan biasa.';
comment on column absensi.karyawan.pa_tarif_harian is 'Tarif per hari hadir untuk mode PA (rupiah).';

create or replace view absensi.karyawan_publik with (security_barrier = true) as
 select id,
    nama,
    foto_url,
    to_char(tanggal_lahir::timestamp with time zone, 'MM-DD'::text) as ultah_mmdd,
    cabang_id,
    (pa_mulai is not null and pa_mulai <= (now() at time zone 'Asia/Jakarta')::date) as is_pa
   from absensi.karyawan k
  where nonaktif = false and (absensi.karyawan_saya() is not null or (current_user = any (array['postgres'::name, 'service_role'::name, 'supabase_admin'::name])));
