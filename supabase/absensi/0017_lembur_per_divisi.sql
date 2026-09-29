-- PR-CL129: ACC / tolak / suruh / batalin izin lembur PER DIVISI.
-- Owner, 29 Sep 2026: "mila boleh acc divisi dia seperti bunga, yang lain juga sifatnya gitu
-- harus acc by divisi". Lead / Head (SPV) cuma boleh memutus lembur karyawan DIVISI YANG SAMA.
-- Owner tetap boleh semua. Karyawan yang divisinya kosong / tidak ketemu: cuma owner.
-- Sumber divisi = wms.user_profiles.divisi, disambung lewat karyawan.firebase_uid = absensi_uid,
-- cadangannya email / email_lain akun login WMS.
-- Tidak ada perubahan rumus bayar. Semua fungsi CREATE OR REPLACE dengan tanda tangan yang sama.
set lock_timeout = '5s';
set statement_timeout = '60s';

create or replace function absensi.lembur_divisi(p_karyawan uuid)
returns text language sql stable security definer set search_path = absensi, pg_catalog as $$
  select coalesce(
    (select nullif(btrim(up.divisi), '') from absensi.karyawan k
       join wms.user_profiles up on up.absensi_uid = coalesce(k.firebase_uid, k.ekstra ->> 'uid') and up.active
      where k.id = p_karyawan limit 1),
    (select nullif(btrim(up.divisi), '') from absensi.karyawan k
       join auth.users u on lower(u.email) = lower(k.email)
                         or lower(u.email) = any (select lower(x) from unnest(coalesce(k.email_lain, '{}'::text[])) x)
       join wms.user_profiles up on up.user_id = u.id and up.active
      where k.id = p_karyawan limit 1))
$$;
comment on function absensi.lembur_divisi(uuid) is 'PR-CL129: divisi karyawan absensi menurut wms.user_profiles (firebase_uid = absensi_uid, cadangan email).';

-- Boleh memutus lembur p_target? Owner: semua (kecuali diri sendiri). Lead/SPV: divisi sama & tidak kosong.
create or replace function absensi.lembur_boleh_acc_untuk(p_penyetuju uuid, p_target uuid)
returns boolean language sql stable security definer set search_path = absensi, pg_catalog as $$
  select p_penyetuju is not null and p_target is not null and p_penyetuju <> p_target
     and absensi.lembur_boleh_acc(p_penyetuju)
     and (coalesce((select k.peran = 'owner' from absensi.karyawan k where k.id = p_penyetuju), false)
          or (absensi.lembur_divisi(p_penyetuju) is not null
              and absensi.lembur_divisi(p_penyetuju) = absensi.lembur_divisi(p_target)))
$$;

-- Info buat tampilan: owner? divisi saya, tim yang saya pegang, dan (owner) karyawan yang divisinya kosong.
create or replace function absensi.lembur_divisi_info()
returns jsonb language plpgsql stable security definer set search_path = absensi, pg_catalog as $$
declare
  v_saya  uuid := absensi.karyawan_saya();
  v_owner boolean;
  v_div   text;
begin
  if v_saya is null or not absensi.lembur_boleh_acc(v_saya) then
    raise exception 'Hanya Lead, SPV, atau owner.';
  end if;
  select k.peran = 'owner' into v_owner from absensi.karyawan k where k.id = v_saya;
  v_div := absensi.lembur_divisi(v_saya);
  return jsonb_build_object(
    'owner', coalesce(v_owner, false),
    'divisi', v_div,
    'tim', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'nama', t.nama, 'divisi', t.divisi) order by t.divisi nulls last, t.nama)
                       from (select k.id, k.nama, absensi.lembur_divisi(k.id) as divisi
                               from absensi.karyawan k
                              where not k.nonaktif and k.peran <> 'owner' and not absensi.lembur_is_pa(k.id)
                                and not coalesce(k.ekstra ? 'dihapus_owner_at' or k.ekstra ? 'yatim_firebase', false)) t
                      where coalesce(v_owner, false) or (v_div is not null and t.divisi = v_div)), '[]'::jsonb),
    'kosong', case when coalesce(v_owner, false) then
                coalesce((select jsonb_agg(k.nama order by k.nama) from absensi.karyawan k
                           where not k.nonaktif and k.peran <> 'owner' and not absensi.lembur_is_pa(k.id)
                             and not coalesce(k.ekstra ? 'dihapus_owner_at' or k.ekstra ? 'yatim_firebase', false)
                             and absensi.lembur_divisi(k.id) is null), '[]'::jsonb)
              else '[]'::jsonb end);
end $$;

-- ------------------------------------------------------------------ alur izin (PR-CL128) + divisi
create or replace function absensi.lembur_izin_putus(p_id uuid, p_setuju boolean, p_catatan text default null)
returns text language plpgsql security definer set search_path = absensi, pg_catalog as $$
declare
  v_saya uuid := absensi.karyawan_saya();
  v_i    absensi.lembur_izin%rowtype;
  v_baru text := case when p_setuju then 'disetujui' else 'ditolak' end;
  v_cat  text := nullif(left(btrim(coalesce(p_catatan, '')), 300), '');
begin
  if v_saya is null or not absensi.lembur_boleh_acc(v_saya) then
    raise exception 'Hanya Lead, SPV, atau owner yang bisa ACC lembur.';
  end if;
  select * into v_i from absensi.lembur_izin where id = p_id for update;
  if not found then raise exception 'Permintaan lembur tidak ditemukan.'; end if;
  if v_i.karyawan_id = v_saya then raise exception 'Tidak bisa ACC / tolak lembur sendiri.'; end if;
  if not absensi.lembur_boleh_acc_untuk(v_saya, v_i.karyawan_id) then
    raise exception 'Beda divisi: lembur ini cuma bisa diputus Lead / Head divisinya (atau owner).';
  end if;
  if v_i.status <> 'menunggu' then raise exception 'Permintaan ini sudah diputus.'; end if;
  if not exists (select 1 from absensi.lembur_sesi_terbuka(v_i.karyawan_id) s where s.ci_id = v_i.sesi_ci_id) then
    raise exception 'Shift orangnya sudah selesai, izin tidak berlaku lagi.';
  end if;
  update absensi.lembur_izin
     set status = v_baru, diputus_oleh = v_saya, diputus_at = now(), catatan_putus = v_cat,
         riwayat = riwayat || jsonb_build_array(jsonb_build_object('aksi', v_baru, 'oleh', v_saya, 'at', now(), 'catatan', v_cat))
   where id = p_id;
  return v_baru;
end $$;

create or replace function absensi.lembur_izin_batal(p_id uuid, p_catatan text default null)
returns text language plpgsql security definer set search_path = absensi, pg_catalog as $$
declare
  v_saya uuid := absensi.karyawan_saya();
  v_i    absensi.lembur_izin%rowtype;
  v_cat  text := nullif(left(btrim(coalesce(p_catatan, '')), 300), '');
begin
  if v_saya is null or not absensi.lembur_boleh_acc(v_saya) then
    raise exception 'Hanya Lead, SPV, atau owner yang bisa membatalkan izin lembur.';
  end if;
  select * into v_i from absensi.lembur_izin where id = p_id for update;
  if not found then raise exception 'Izin lembur tidak ditemukan.'; end if;
  if v_i.karyawan_id = v_saya then raise exception 'Tidak bisa membatalkan izin lembur sendiri.'; end if;
  if not absensi.lembur_boleh_acc_untuk(v_saya, v_i.karyawan_id) then
    raise exception 'Beda divisi: izin ini cuma bisa dibatalin Lead / Head divisinya (atau owner).';
  end if;
  if v_i.mulai_absen_id is not null then raise exception 'Lembur sudah dimulai, izin tidak bisa dibatalin.'; end if;
  if v_i.status <> 'disetujui' then raise exception 'Cuma izin yang sudah disetujui yang bisa dibatalin.'; end if;
  update absensi.lembur_izin
     set status = 'dibatalkan', diputus_oleh = v_saya, diputus_at = now(), catatan_putus = v_cat,
         riwayat = riwayat || jsonb_build_array(jsonb_build_object('aksi', 'dibatalkan', 'oleh', v_saya, 'at', now(), 'catatan', v_cat))
   where id = p_id;
  return 'dibatalkan';
end $$;

create or replace function absensi.lembur_suruh(p_karyawan uuid[], p_catatan text default null)
returns jsonb language plpgsql security definer set search_path = absensi, pg_catalog as $$
declare
  v_saya uuid := absensi.karyawan_saya();
  v_cat  text := nullif(left(btrim(coalesce(p_catatan, '')), 300), '');
  v_k    uuid;
  v_nama text;
  v_s    record;
  v_i    absensi.lembur_izin%rowtype;
  v_out  jsonb := '[]'::jsonb;
  v_hasil text;
begin
  if v_saya is null or not absensi.lembur_boleh_acc(v_saya) then
    raise exception 'Hanya Lead, SPV, atau owner yang bisa nyuruh lembur.';
  end if;
  foreach v_k in array coalesce(p_karyawan, '{}'::uuid[]) loop
    select k.nama into v_nama from absensi.karyawan k where k.id = v_k and not k.nonaktif;
    v_hasil := null;
    if v_nama is null then v_hasil := 'karyawan tidak ditemukan';
    elsif v_k = v_saya then v_hasil := 'tidak bisa nyuruh diri sendiri';
    elsif absensi.lembur_is_pa(v_k) then v_hasil := 'PA tidak lembur';
    elsif absensi.lembur_bebas(v_k) then v_hasil := 'bebas izin (alur lama)';
    elsif not absensi.lembur_boleh_acc_untuk(v_saya, v_k) then v_hasil := 'beda divisi';
    else
      select * into v_s from absensi.lembur_sesi_terbuka(v_k);
      if v_s.ci_id is null then v_hasil := 'belum masuk / sudah pulang';
      elsif exists (select 1 from absensi.absensi a where a.karyawan_id = v_k and a.tipe = 'overtime_in' and a.ts >= v_s.ci_ts) then
        v_hasil := 'lembur sudah dimulai';
      else
        select * into v_i from absensi.lembur_izin
         where sesi_ci_id = v_s.ci_id and status in ('menunggu', 'disetujui') for update;
        if found and v_i.status = 'disetujui' then v_hasil := 'sudah punya izin';
        elsif found then
          update absensi.lembur_izin
             set status = 'disetujui', diputus_oleh = v_saya, diputus_at = now(), catatan_putus = coalesce(v_cat, catatan_putus),
                 riwayat = riwayat || jsonb_build_array(jsonb_build_object('aksi', 'disetujui', 'oleh', v_saya, 'at', now(), 'lewat', 'suruh'))
           where id = v_i.id;
          v_hasil := 'disuruh';
        else
          insert into absensi.lembur_izin (karyawan_id, sesi_ci_id, tanggal, jenis, alasan, status, diminta_oleh,
                                           diputus_oleh, diputus_at, riwayat)
          values (v_k, v_s.ci_id, (v_s.ci_ts at time zone 'Asia/Jakarta')::date, 'suruh', v_cat, 'disetujui', v_saya,
                  v_saya, now(), jsonb_build_array(jsonb_build_object('aksi', 'suruh', 'oleh', v_saya, 'at', now())));
          v_hasil := 'disuruh';
        end if;
      end if;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('karyawan_id', v_k, 'nama', v_nama, 'hasil', v_hasil));
  end loop;
  return v_out;
end $$;

create or replace function absensi.lembur_hari_ini()
returns table (id uuid, karyawan_id uuid, nama text, jenis text, alasan text, status text,
               penyetuju text, dibuat_oleh text, catatan_putus text, created_at timestamptz,
               diputus_at timestamptz, mulai_at timestamptz, selesai_at timestamptz, sesi_terbuka boolean,
               jeda_menit numeric)
language plpgsql stable security definer set search_path = absensi, pg_catalog as $$
declare v_saya uuid := absensi.karyawan_saya();
begin
  if v_saya is null or not absensi.lembur_boleh_acc(v_saya) then
    raise exception 'Hanya Lead, SPV, atau owner yang bisa melihat lembur tim.';
  end if;
  return query
  select i.id, i.karyawan_id, k.nama, i.jenis, i.alasan, i.status, p.nama, d.nama, i.catatan_putus,
         i.created_at, i.diputus_at, i.mulai_at, i.selesai_at,
         exists (select 1 from absensi.lembur_sesi_terbuka(i.karyawan_id) s where s.ci_id = i.sesi_ci_id),
         case when i.mulai_at is not null then absensi.lembur_jeda_menit(i.karyawan_id, i.mulai_at, coalesce(i.selesai_at, now())) end
    from absensi.lembur_izin i
    join absensi.karyawan k on k.id = i.karyawan_id
    left join absensi.karyawan p on p.id = i.diputus_oleh
    left join absensi.karyawan d on d.id = i.diminta_oleh
   where i.karyawan_id <> v_saya
     and absensi.lembur_boleh_acc_untuk(v_saya, i.karyawan_id)
     and (i.created_at > now() - interval '20 hours' or (i.mulai_at is not null and i.selesai_at is null))
   order by (i.status = 'menunggu') desc, i.created_at desc;
end $$;

create or replace function absensi.lembur_kandidat_suruh()
returns table (karyawan_id uuid, nama text, ci_ts timestamptz, status_izin text)
language plpgsql stable security definer set search_path = absensi, pg_catalog as $$
declare v_saya uuid := absensi.karyawan_saya();
begin
  if v_saya is null or not absensi.lembur_boleh_acc(v_saya) then
    raise exception 'Hanya Lead, SPV, atau owner yang bisa nyuruh lembur.';
  end if;
  return query
  select k.id, k.nama, s.ci_ts,
         (select case when i.mulai_at is not null then 'lembur' else i.status end
            from absensi.lembur_izin i where i.sesi_ci_id = s.ci_id
           order by (i.status in ('menunggu', 'disetujui')) desc, i.created_at desc limit 1)
    from absensi.karyawan k
    cross join lateral absensi.lembur_sesi_terbuka(k.id) s
   where not k.nonaktif and k.peran <> 'owner' and k.id <> v_saya
     and not absensi.lembur_is_pa(k.id) and not absensi.lembur_bebas(k.id)
     and absensi.lembur_boleh_acc_untuk(v_saya, k.id)
     and s.ci_id is not null
   order by s.ci_ts;
end $$;

-- ------------------------------------------------------------------ sisa alur PR-CL127 + divisi
create or replace function absensi.lembur_acc_antrian()
returns table (id uuid, karyawan_id uuid, nama text, tanggal date, ts_mulai timestamptz, ts_selesai timestamptz,
               menit_perkiraan integer, alasan text, status text, batas_acc timestamptz,
               penyetuju text, diputus_at timestamptz, catatan_putus text)
language plpgsql stable security definer set search_path = absensi, pg_catalog as $$
declare v_saya uuid := absensi.karyawan_saya();
begin
  if v_saya is null or not absensi.lembur_boleh_acc(v_saya) then
    raise exception 'Hanya Lead, SPV, atau owner yang bisa melihat antrian ACC lembur.';
  end if;
  return query
  select l.id, l.karyawan_id, k.nama, l.tanggal, l.ts_mulai, l.ts_selesai, l.menit_perkiraan, l.alasan,
         l.status, l.batas_acc, p.nama, l.diputus_at, l.catatan_putus
    from absensi.lembur_acc l
    join absensi.karyawan k on k.id = l.karyawan_id
    left join absensi.karyawan p on p.id = l.diputus_oleh
   where l.status in ('menunggu', 'disetujui', 'ditolak')
     and now() <= l.batas_acc
     and l.karyawan_id <> v_saya
     and absensi.lembur_boleh_acc_untuk(v_saya, l.karyawan_id)
     and exists (select 1 from absensi.absensi a where a.id = l.absen_id)
   order by (l.status = 'menunggu') desc, l.batas_acc, l.ts_selesai;
end $$;

create or replace function absensi.lembur_acc_putus(p_id uuid, p_setuju boolean, p_catatan text default null)
returns text language plpgsql security definer set search_path = absensi, pg_catalog as $$
declare
  v_saya uuid := absensi.karyawan_saya();
  v_l    absensi.lembur_acc%rowtype;
  v_baru text := case when p_setuju then 'disetujui' else 'ditolak' end;
  v_cat  text := nullif(left(btrim(coalesce(p_catatan, '')), 300), '');
begin
  if v_saya is null or not absensi.lembur_boleh_acc(v_saya) then
    raise exception 'Hanya Lead, SPV, atau owner yang bisa ACC lembur.';
  end if;
  select * into v_l from absensi.lembur_acc where id = p_id for update;
  if not found then raise exception 'Data lembur tidak ditemukan.'; end if;
  if v_l.karyawan_id = v_saya then raise exception 'Tidak bisa ACC / tolak lembur sendiri.'; end if;
  if not absensi.lembur_boleh_acc_untuk(v_saya, v_l.karyawan_id) then
    raise exception 'Beda divisi: lembur ini cuma bisa diputus Lead / Head divisinya (atau owner).';
  end if;
  if v_l.status = 'bebas' then raise exception 'Lembur ini bebas ACC.'; end if;
  if now() > v_l.batas_acc then raise exception 'Batas ACC sudah lewat (sampai akhir hari besoknya). Lembur ini terkunci tidak di-ACC.'; end if;
  if not exists (select 1 from absensi.absensi a where a.id = v_l.absen_id) then
    raise exception 'Absen lemburnya sudah dihapus.';
  end if;
  update absensi.lembur_acc
     set status = v_baru, diputus_oleh = v_saya, diputus_at = now(), catatan_putus = v_cat,
         riwayat = riwayat || jsonb_build_array(jsonb_build_object(
           'status', v_baru, 'oleh', v_saya, 'at', now(), 'catatan', v_cat))
   where id = p_id;
  return v_baru;
end $$;

revoke all on function absensi.lembur_divisi(uuid) from public, anon, authenticated;
revoke all on function absensi.lembur_boleh_acc_untuk(uuid, uuid) from public, anon, authenticated;
revoke all on function absensi.lembur_divisi_info() from public, anon;
grant execute on function absensi.lembur_divisi_info() to authenticated;

notify pgrst, 'reload schema';
