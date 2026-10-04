-- PR-CL134: SPV cuma melihat & mengatur libur karyawan DIVISINYA SENDIRI.
-- Owner, 4 Okt 2026: Rafi (SPV) cuma briefing tim Fulfillment. Libur tim Live, PA, dan libur
-- Rafi sendiri wajib lewat owner. Divisi diambil dari WMS (absensi.lembur_divisi, sama dengan
-- aturan ACC lembur PR-CL129), jadi anak baru / pindah divisi di WMS otomatis ikut.
--   * owner      : semua karyawan
--   * SPV        : karyawan aktif non-PA dengan divisi WMS sama (tidak kosong); diri sendiri
--                  cuma terlihat, tidak bisa diubah
set lock_timeout = '5s';
set statement_timeout = '60s';

create or replace function absensi.libur_bisa_lihat(p_karyawan uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select absensi.is_owner()
      or (absensi.is_spv()
          and absensi.lembur_divisi(absensi.karyawan_saya()) is not null
          and absensi.lembur_divisi(p_karyawan) = absensi.lembur_divisi(absensi.karyawan_saya())
          and not exists (select 1 from absensi.karyawan k
                           where k.id = p_karyawan and k.pa_mulai is not null
                             and k.pa_mulai <= (now() at time zone 'Asia/Jakarta')::date))
$$;

comment on function absensi.libur_bisa_lihat(uuid) is
  'PR-CL134: owner = semua; SPV = karyawan non-PA se-divisi WMS (termasuk dirinya, cuma lihat).';

create or replace function absensi._cek_target_libur(p_karyawan uuid)
returns absensi.karyawan
language plpgsql
stable
security definer
set search_path = ''
as $$
declare k absensi.karyawan;
begin
  if not absensi.is_spv() then
    raise exception 'Cuma SPV atau owner yang bisa ngatur libur.' using errcode = '42501';
  end if;
  select * into k from absensi.karyawan where id = p_karyawan;
  if not found or k.nonaktif or k.peran = 'owner' or (k.ekstra ? 'dihapus_owner_at') or (k.ekstra ? 'yatim_firebase') then
    raise exception 'Karyawan tidak ditemukan / sudah nonaktif.' using errcode = 'P0002';
  end if;
  if not absensi.is_owner() then
    if k.pa_mulai is not null and k.pa_mulai <= (now() at time zone 'Asia/Jakarta')::date then
      raise exception 'Libur Personal Assistant diatur owner.' using errcode = '42501';
    end if;
    if k.id = absensi.karyawan_saya() then
      raise exception 'Libur kamu sendiri diatur owner.' using errcode = '42501';
    end if;
    if not absensi.libur_bisa_lihat(k.id) then
      raise exception 'Libur % diatur owner (beda divisi).', k.nama using errcode = '42501';
    end if;
  end if;
  return k;
end $$;

create or replace function absensi.libur_tim()
returns table(karyawan_id uuid, nama text, libur_hari smallint, is_pa boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not absensi.is_spv() then
    raise exception 'Cuma SPV atau owner.' using errcode = '42501';
  end if;
  return query
    select k.id, k.nama, k.libur_hari,
           (k.pa_mulai is not null and k.pa_mulai <= (now() at time zone 'Asia/Jakarta')::date)
      from absensi.karyawan k
     where k.nonaktif = false and k.peran <> 'owner'
       and not (k.ekstra ? 'dihapus_owner_at') and not (k.ekstra ? 'yatim_firebase')
       and absensi.libur_bisa_lihat(k.id)
     order by k.nama;
end $$;

create or replace function absensi.libur_tukar_daftar(p_dari date, p_sampai date)
returns table(id uuid, karyawan_id uuid, nama text, tanggal_asal date, tanggal_libur date, catatan text, dibuat_oleh_nama text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.karyawan_id, k.nama, t.tanggal_asal, t.tanggal_libur, t.catatan,
         (select o.nama from absensi.karyawan o where o.id = t.dibuat_oleh), t.created_at
    from absensi.libur_tukar_active t
    join absensi.karyawan k on k.id = t.karyawan_id
   where (t.tanggal_asal between p_dari and p_sampai or t.tanggal_libur between p_dari and p_sampai)
     and ((absensi.is_spv() and absensi.libur_bisa_lihat(t.karyawan_id)) or t.karyawan_id = absensi.karyawan_saya())
   order by least(t.tanggal_asal, t.tanggal_libur), k.nama
$$;

-- Dipanggil dari dalam RPC security definer saja.
revoke all on function absensi.libur_bisa_lihat(uuid) from public, anon, authenticated;
