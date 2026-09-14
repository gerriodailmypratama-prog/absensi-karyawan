-- PR-CL114 (temuan audit port):
-- 1) Usulan libur yang masih MENUNGGU boleh direvisi (versi Firebase menimpa usulan lama).
-- 2) Karyawan pindahan yang di Firebase tidak punya createdAt tercatat "dibuat" saat migrasi;
--    dipakai tanggal masuk (versi lama memakai createdAt || tanggalJoin untuk umur akun).
-- Isi lengkap: lihat riwayat migrasi Supabase absensi_0011_libur_revisi_dan_tanggal_akun.
create or replace function absensi.ajukan_libur(p_pilihan smallint[])
returns absensi.libur_request
language plpgsql security definer set search_path = absensi, pg_catalog as $fn$
declare
  v_id    uuid := absensi.karyawan_saya();
  v_libur smallint;
  v_hasil absensi.libur_request;
begin
  if v_id is null then
    raise exception 'Akun kamu belum didaftarkan owner.' using errcode = '28000';
  end if;
  select libur_hari into v_libur from absensi.karyawan where id = v_id;
  if v_libur is not null then
    raise exception 'Hari libur kamu sudah ditetapkan dan sifatnya tetap.' using errcode = '42501';
  end if;
  if p_pilihan is null or array_length(p_pilihan, 1) is null then
    raise exception 'Minimal pilih 1 hari.' using errcode = '22023';
  end if;
  if array_length(p_pilihan, 1) <> (select count(distinct x) from unnest(p_pilihan) x) then
    raise exception 'Pilihan harus hari yang berbeda-beda.' using errcode = '22023';
  end if;

  update absensi.libur_request set pilihan = p_pilihan, created_at = now()
   where karyawan_id = v_id and status = 'menunggu'
   returning * into v_hasil;
  if found then return v_hasil; end if;

  insert into absensi.libur_request (karyawan_id, pilihan, status)
  values (v_id, p_pilihan, 'menunggu')
  returning * into v_hasil;
  return v_hasil;
end $fn$;
revoke all on function absensi.ajukan_libur(smallint[]) from public, anon;
grant execute on function absensi.ajukan_libur(smallint[]) to authenticated;

update absensi.karyawan
   set created_at = (tanggal_masuk::timestamp at time zone 'Asia/Jakarta')
 where firebase_uid is not null and tanggal_masuk is not null
   and created_at >= timestamptz '2026-09-14 00:00+07' and created_at < timestamptz '2026-09-15 00:00+07'
   and not (ekstra ? 'createdAt');
