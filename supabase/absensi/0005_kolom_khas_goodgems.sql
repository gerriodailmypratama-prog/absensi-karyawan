-- ============================================================================
-- GoodGems Absensi — kolom khas GoodGems yang ketemu saat inventaris Firestore
-- PR-CL113 · 14 Sep 2026
--
-- Inventaris field Firestore (nama field saja, tanpa isi) menemukan yang tidak
-- ada di cetak biru Kopikiri:
--   * absensi.lemburOverrideMin / istirahatOverrideMin — koreksi manual owner per
--     hari (ditaruh di event clock_in). Masuk hitungan gaji, jadi WAJIB kolom.
--   * absensi.earlyReason — alasan pulang cepat.
--   * sisa field kecil (auto, backfillSource, lupaClockOut, autoCutByForgot,
--     autoClockOut, tanggal, editNote, ...) disimpan utuh di `ekstra` supaya
--     tidak ada yang hilang saat dibandingkan.
-- Plus: titik kantor ruko jadi baris cabang, dan owner tidak ikut papan kehadiran.
-- ============================================================================

set lock_timeout = '5s';
set statement_timeout = '60s';

alter table absensi.absensi add column if not exists lembur_override_menit    integer;
alter table absensi.absensi add column if not exists istirahat_override_menit integer;
alter table absensi.absensi add column if not exists alasan_pulang_cepat      text;
alter table absensi.absensi add column if not exists ekstra jsonb not null default '{}';

alter table absensi.absensi_batal add column if not exists lembur_override_menit    integer;
alter table absensi.absensi_batal add column if not exists istirahat_override_menit integer;
alter table absensi.absensi_batal add column if not exists alasan_pulang_cepat      text;
alter table absensi.absensi_batal add column if not exists ekstra jsonb not null default '{}';

comment on column absensi.absensi.lembur_override_menit    is 'Lembur hari itu ditetapkan manual owner (menit). Dulu lemburOverrideMin, biasanya di event clock_in.';
comment on column absensi.absensi.istirahat_override_menit is 'Istirahat hari itu ditetapkan manual owner (menit). Dulu istirahatOverrideMin.';
comment on column absensi.absensi.ekstra                   is 'Field Firestore lain yang jarang (auto, backfillSource, lupaClockOut, dst), disimpan apa adanya.';

alter table absensi.karyawan add column if not exists ekstra jsonb not null default '{}';
comment on column absensi.karyawan.ekstra is 'Field Firestore karyawan yang tidak punya kolom sendiri (selfRegistered, liburSetBy, dst).';

-- Kolom absensi_batal harus sama urutannya dengan absensi supaya batalkan_absen()
-- (insert ... select a.*, now(), ...) tetap pas. Kolom baru di absensi ada di
-- belakang, di absensi_batal ada SETELAH kolom arsip -> susun ulang lewat fungsi.
create or replace function absensi.batalkan_absen(p_id uuid, p_alasan text default null)
returns void language plpgsql security definer set search_path = absensi, pg_catalog as $fn$
begin
  if not absensi.is_owner() then
    raise exception 'Hanya owner yang boleh membatalkan catatan absen' using errcode = '42501';
  end if;
  insert into absensi.absensi_batal
    select r.*
      from absensi.absensi a,
           jsonb_populate_record(null::absensi.absensi_batal,
             to_jsonb(a) || jsonb_build_object('dibatalkan_at', now(), 'dibatalkan_oleh', auth.uid(),
                                               'alasan', nullif(btrim(p_alasan), ''))) r
     where a.id = p_id;
  if not found then
    raise exception 'Catatan absen tidak ditemukan' using errcode = 'P0002';
  end if;
  delete from absensi.absensi where id = p_id;
end $fn$;
revoke all on function absensi.batalkan_absen(uuid, text) from public, anon;
grant execute on function absensi.batalkan_absen(uuid, text) to authenticated;

-- Kantor ruko (OFFICE_LOCATION di js/firebase-config.js).
insert into absensi.cabang (kode, nama, alamat, lat, lng, radius_m)
values ('ruko', 'Ruko GoodGems', 'Ruko BSM A2/9, Pakulonan, Serpong Utara', -6.238929, 106.6459816, 300)
on conflict (kode) do nothing;

-- Papan kehadiran: owner bukan orang yang diabsen.
create or replace function absensi.f_status_harian(p_tanggal date default null)
returns table (
  tanggal_kerja date, karyawan_id uuid, nama text, jabatan text, id_karyawan text,
  cabang_id uuid, cabang_tetap_id uuid, status text, jam_masuk timestamptz, jam_keluar timestamptz,
  istirahat_menit numeric, jeda_menit numeric, jam_efektif numeric, jam_lembur numeric,
  ada_luar_radius boolean, jam_kontrak integer
)
language sql stable set search_path = absensi, pg_catalog as $fn$
  with hari as (
    select coalesce(p_tanggal, tanggal_kerja_kini()) as d
  ),
  rekap as (
    select r.* from f_rekap_harian((select hari.d from hari), (select hari.d from hari)) r
  )
  select (select hari.d from hari) as tanggal_kerja,
         kr.id as karyawan_id,
         kr.nama,
         kr.jabatan,
         kr.id_karyawan,
         coalesce(r.cabang_id, kr.cabang_id) as cabang_id,
         kr.cabang_id as cabang_tetap_id,
         case
           when r.karyawan_id is not null then
             case when r.ada_lupa_clock_out then 'lupa_clock_out' else r.status_terakhir end
           when kr.libur_hari is not null
                and kr.libur_hari = extract(dow from (select hari.d from hari))::smallint then 'libur'
           else 'belum_absen'
         end as status,
         r.jam_masuk, r.jam_keluar, r.istirahat_menit, r.jeda_menit, r.jam_efektif, r.jam_lembur,
         coalesce(r.ada_luar_radius, false) as ada_luar_radius,
         coalesce(r.jam_kontrak, kr.jam_kerja) as jam_kontrak
  from v_karyawan_ringkas kr
  left join rekap r on r.karyawan_id = kr.id
  where (kr.nonaktif = false and kr.peran <> 'owner') or r.karyawan_id is not null
$fn$;
