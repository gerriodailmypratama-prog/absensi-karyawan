-- PR-CL130: jabatan karyawan absensi ikut jabatan di WMS (wms.user_profiles.jabatan).
-- Owner, 1 Okt 2026: badge jabatan di Payroll absensi nggak sinkron sama WMS (Restu di WMS
-- sudah "Personal Assistant", di absensi masih OPERATIONAL dari daftar cadangan 30 Jul).
--
-- WMS = sumber kebenaran. Fungsi ini menyalin jabatan WMS ke absensi.karyawan.jabatan untuk
-- karyawan yang ketemu pasangannya (wms.user_profiles.absensi_uid = firebase_uid / id / user_id).
-- Jabatan WMS kosong tidak menimpa apa pun. Dijalankan tiap jam lewat pg_cron.
-- Hanya membaca wms.user_profiles; tidak mengubah tabel/policy WMS.
set lock_timeout = '5s';
set statement_timeout = '60s';

create or replace function absensi.sinkron_jabatan_wms()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  update absensi.karyawan k
     set jabatan = btrim(u.jabatan),
         updated_at = now()
    from wms.user_profiles u
   where u.absensi_uid is not null
     and u.absensi_uid in (k.firebase_uid, k.id::text, k.user_id::text)
     and nullif(btrim(u.jabatan), '') is not null
     and k.jabatan is distinct from btrim(u.jabatan);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function absensi.sinkron_jabatan_wms() from public, anon, authenticated;

comment on function absensi.sinkron_jabatan_wms() is
  'PR-CL130: salin wms.user_profiles.jabatan ke absensi.karyawan.jabatan. Balikin jumlah baris yang berubah. Jalan tiap jam (cron absensi-sinkron-jabatan).';

do $$
begin
  if exists (select 1 from cron.job where jobname = 'absensi-sinkron-jabatan') then
    perform cron.unschedule('absensi-sinkron-jabatan');
  end if;
  perform cron.schedule('absensi-sinkron-jabatan', '25 * * * *', 'select absensi.sinkron_jabatan_wms()');
end $$;
