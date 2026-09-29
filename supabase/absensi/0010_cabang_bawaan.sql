-- PR-CL114: karyawan baru (daftar sendiri / ditambah owner) otomatis ditempatkan di cabang ruko,
-- supaya geofence absennya langsung terhitung (GoodGems cuma punya satu titik kantor).
create or replace function absensi.cabang_bawaan()
returns uuid language sql stable security definer set search_path = absensi, pg_catalog as $fn$
  select id from absensi.cabang where kode = 'ruko' and aktif limit 1
$fn$;
revoke all on function absensi.cabang_bawaan() from public, anon, authenticated;

create or replace function absensi.isi_cabang_bawaan()
returns trigger language plpgsql security definer set search_path = absensi, pg_catalog as $fn$
begin
  if new.cabang_id is null then new.cabang_id := absensi.cabang_bawaan(); end if;
  return new;
end $fn$;
revoke all on function absensi.isi_cabang_bawaan() from public, anon, authenticated;

drop trigger if exists trg_karyawan_cabang_bawaan on absensi.karyawan;
create trigger trg_karyawan_cabang_bawaan before insert on absensi.karyawan
  for each row execute function absensi.isi_cabang_bawaan();

update absensi.karyawan set cabang_id = absensi.cabang_bawaan() where cabang_id is null;
