-- PR-CL128: lembur = izin dulu -> Mulai Lembur -> Selesai Lembur (menggantikan alur PR-CL127
-- "ACC setelah lembur" untuk sesi baru). Keputusan owner 29 Sep 2026:
--   * Lembur harus ada niat: DISURUH Lead/SPV/owner, atau karyawan MINTA izin + alasan lalu
--     di-ACC Lead/SPV/owner. Tanpa izin disetujui, overtime_in DITOLAK database.
--   * Lembur dihitung dari tap Mulai Lembur (overtime_in, jam server) sampai Selesai Lembur,
--     dipotong istirahat/pause di dalam jendela itu. Mulai baru boleh setelah jam kerja normal
--     efektif kelar. Izin cuma berlaku untuk sesi clock-in yang sedang berjalan.
--   * Tidak boleh ACC / nyuruh / batalin punya sendiri. Izin disetujui bisa dibatalin selama
--     belum Mulai Lembur.
--   * Mila (lembur_akses.bebas_acc) tetap alur lama (overtime_in otomatis). PA tanpa lembur.
--   * Rate 1,5x dihitung di payroll owner.js per hari (>= 2026-09-29), bukan lewat kolom
--     karyawan.multiplier_lembur, supaya periode lama tidak ikut berubah.
-- Additive: 1 tabel baru (RLS: baca punya sendiri / owner, tulis cuma lewat RPC), 1 trigger
-- BEFORE INSERT overtime_in, fungsi baru, dan lembur_acc_catat (PR-CL127) diganti supaya lembur
-- yang lewat izin tidak masuk antrian ACC-belakang lagi.
set lock_timeout = '5s';
set statement_timeout = '60s';

create table if not exists absensi.lembur_izin (
  id               uuid primary key default gen_random_uuid(),
  karyawan_id      uuid not null references absensi.karyawan(id),
  sesi_ci_id       uuid not null,          -- event clock_in sesi yang berjalan saat izin dibuat
  tanggal          date not null,          -- tanggal clock-in (WIB), sama dengan pengelompokan payroll
  jenis            text not null,          -- 'minta' (karyawan) | 'suruh' (Lead/SPV/owner)
  alasan           text,                   -- alasan karyawan / catatan yang nyuruh
  status           text not null default 'menunggu',
  diminta_oleh     uuid references absensi.karyawan(id),
  diputus_oleh     uuid references absensi.karyawan(id),
  diputus_at       timestamptz,
  catatan_putus    text,
  mulai_absen_id   uuid,                   -- event overtime_in
  mulai_at         timestamptz,
  selesai_absen_id uuid,                   -- event overtime_out
  selesai_at       timestamptz,
  riwayat          jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lembur_izin_status_cek') then
    alter table absensi.lembur_izin add constraint lembur_izin_status_cek
      check (status in ('menunggu', 'disetujui', 'ditolak', 'dibatalkan'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lembur_izin_jenis_cek') then
    alter table absensi.lembur_izin add constraint lembur_izin_jenis_cek
      check (jenis in ('minta', 'suruh'));
  end if;
end $$;
create unique index if not exists lembur_izin_satu_aktif_idx
  on absensi.lembur_izin (sesi_ci_id) where status in ('menunggu', 'disetujui');
create index if not exists lembur_izin_tanggal_idx on absensi.lembur_izin (tanggal, karyawan_id);
create index if not exists lembur_izin_mulai_idx on absensi.lembur_izin (mulai_absen_id);
comment on table absensi.lembur_izin is 'PR-CL128: izin lembur per sesi (minta+ACC atau disuruh). overtime_in non-Mila non-PA hanya boleh kalau ada izin disetujui di sesi berjalan.';

drop trigger if exists trg_lembur_izin_updated_at on absensi.lembur_izin;
create trigger trg_lembur_izin_updated_at before update on absensi.lembur_izin
  for each row execute function absensi.set_updated_at();

alter table absensi.lembur_izin enable row level security;
drop policy if exists lembur_izin_baca on absensi.lembur_izin;
create policy lembur_izin_baca on absensi.lembur_izin for select to authenticated
  using (karyawan_id = absensi.karyawan_saya() or absensi.is_owner());
revoke all on absensi.lembur_izin from anon, public;
grant select on absensi.lembur_izin to authenticated;
grant all on absensi.lembur_izin to service_role;

-- ------------------------------------------------------------------ helper
-- Sesi yang sedang berjalan: clock_in terakhir (<= 20 jam) yang belum ditutup clock_out/overtime_out.
create or replace function absensi.lembur_sesi_terbuka(p_karyawan uuid)
returns table (ci_id uuid, ci_ts timestamptz)
language sql stable security definer set search_path = absensi, pg_catalog as $$
  select a.id, a.ts from absensi.absensi a
   where a.karyawan_id = p_karyawan and a.tipe = 'clock_in'
     and a.ts > now() - interval '20 hours' and a.ts <= now() + interval '5 minutes'
     and not exists (select 1 from absensi.absensi b
                      where b.karyawan_id = p_karyawan and b.tipe in ('clock_out', 'overtime_out') and b.ts >= a.ts)
   order by a.ts desc limit 1
$$;

-- Menit istirahat + pause yang jatuh di dalam [p_dari, p_sampai] (yang masih kebuka dihitung s/d p_sampai).
create or replace function absensi.lembur_jeda_menit(p_karyawan uuid, p_dari timestamptz, p_sampai timestamptz)
returns numeric language plpgsql stable security definer set search_path = absensi, pg_catalog as $$
declare r record; v_b timestamptz; v_p timestamptz; v_tot numeric := 0;
begin
  if p_dari is null or p_sampai is null or p_sampai <= p_dari then return 0; end if;
  for r in select a.tipe::text as t, a.ts from absensi.absensi a
            where a.karyawan_id = p_karyawan and a.ts >= p_dari - interval '1 day' and a.ts <= p_sampai
              and a.tipe in ('break_in', 'break_out', 'pause_in', 'pause_out')
            order by a.ts, a.id loop
    if r.t = 'break_in' then v_b := r.ts;
    elsif r.t = 'break_out' and v_b is not null then
      v_tot := v_tot + greatest(0, extract(epoch from (least(r.ts, p_sampai) - greatest(v_b, p_dari)))); v_b := null;
    elsif r.t = 'pause_in' then v_p := r.ts;
    elsif r.t = 'pause_out' and v_p is not null then
      v_tot := v_tot + greatest(0, extract(epoch from (least(r.ts, p_sampai) - greatest(v_p, p_dari)))); v_p := null;
    end if;
  end loop;
  if v_b is not null then v_tot := v_tot + greatest(0, extract(epoch from (p_sampai - greatest(v_b, p_dari)))); end if;
  if v_p is not null then v_tot := v_tot + greatest(0, extract(epoch from (p_sampai - greatest(v_p, p_dari)))); end if;
  return round(v_tot / 60.0, 2);
end $$;

-- Jam paling cepat boleh Mulai Lembur = clock-in + (jam kontrak - 1 jam hak istirahat) + jeda sesi.
-- Sama dengan effectiveWorkHours() + totalNonWorkMs() di karyawan.js.
create or replace function absensi.lembur_bisa_mulai_at(p_karyawan uuid, p_ci_ts timestamptz)
returns timestamptz language sql stable security definer set search_path = absensi, pg_catalog as $$
  select p_ci_ts
       + make_interval(mins => (greatest(0, coalesce((select k.jam_kerja from absensi.karyawan k where k.id = p_karyawan), 9) - 1) * 60)::integer)
       + make_interval(secs => (absensi.lembur_jeda_menit(p_karyawan, p_ci_ts, now()) * 60)::double precision)
$$;

create or replace function absensi.lembur_bebas(p_karyawan uuid)
returns boolean language sql stable security definer set search_path = absensi, pg_catalog as $$
  select coalesce((select la.bebas_acc from absensi.lembur_akses la where la.karyawan_id = p_karyawan), false)
$$;

create or replace function absensi.lembur_is_pa(p_karyawan uuid)
returns boolean language sql stable security definer set search_path = absensi, pg_catalog as $$
  select coalesce((select k.pa_mulai is not null and k.pa_mulai <= (now() at time zone 'Asia/Jakarta')::date
                     from absensi.karyawan k where k.id = p_karyawan), false)
$$;

-- ------------------------------------------------------------------ penjaga overtime_in
create or replace function absensi.lembur_izin_jaga()
returns trigger language plpgsql security definer set search_path = absensi, pg_catalog as $$
declare
  v_peran text;
  v_s     record;
  v_i     absensi.lembur_izin%rowtype;
  v_bisa  timestamptz;
begin
  -- Job backend (tanpa JWT) & owner (koreksi manual dari dashboard) tidak dijaga.
  if (select auth.uid()) is null or absensi.is_owner() then return new; end if;
  select k.peran into v_peran from absensi.karyawan k where k.id = new.karyawan_id;
  if not found or v_peran = 'owner' then return new; end if;
  if absensi.lembur_bebas(new.karyawan_id) then return new; end if;          -- Mila: alur lama
  if absensi.lembur_is_pa(new.karyawan_id) then
    raise exception 'Personal Assistant tidak punya lembur.';
  end if;

  select * into v_s from absensi.lembur_sesi_terbuka(new.karyawan_id);
  if v_s.ci_id is null then raise exception 'Belum Clock In, lembur tidak bisa dimulai.'; end if;
  select * into v_i from absensi.lembur_izin
   where sesi_ci_id = v_s.ci_id and status = 'disetujui'
   order by created_at desc limit 1 for update;
  if not found then
    raise exception 'Belum ada izin lembur yang di-ACC buat shift ini. Tap Minta Lembur dulu, atau tunggu disuruh Lead / SPV.';
  end if;
  if v_i.mulai_absen_id is not null then raise exception 'Lembur shift ini sudah dimulai.'; end if;
  v_bisa := absensi.lembur_bisa_mulai_at(new.karyawan_id, v_s.ci_ts);
  if now() + interval '1 minute' < v_bisa then
    raise exception 'Jam kerja normal belum kelar. Mulai Lembur bisa jam %.', to_char(v_bisa at time zone 'Asia/Jakarta', 'HH24:MI');
  end if;

  new.ts := now();          -- lembur dihitung dari jam server, bukan jam HP / backdate
  new.otomatis := false;
  update absensi.lembur_izin
     set mulai_absen_id = new.id, mulai_at = new.ts,
         riwayat = riwayat || jsonb_build_array(jsonb_build_object('aksi', 'mulai', 'at', new.ts))
   where id = v_i.id;
  return new;
end $$;

drop trigger if exists trg_lembur_izin_jaga on absensi.absensi;
create trigger trg_lembur_izin_jaga before insert on absensi.absensi
  for each row when (new.tipe = 'overtime_in') execute function absensi.lembur_izin_jaga();

-- ------------------------------------------------------------------ PR-CL127 pencatat, diperbarui
-- Selesai Lembur dari sesi yang pakai izin: tandai izin selesai, TIDAK masuk antrian ACC-belakang.
-- Selain itu (Mila / sesi lama / koreksi owner) perilakunya persis PR-CL127.
create or replace function absensi.lembur_acc_catat()
returns trigger language plpgsql security definer set search_path = absensi, pg_catalog as $$
declare
  v_ci      timestamptz;
  v_ci_id   uuid;
  v_oi      timestamptz;
  v_tanggal date;
  v_k       record;
  v_bebas   boolean;
begin
  begin
    select k.peran, k.pa_mulai into v_k from absensi.karyawan k where k.id = new.karyawan_id;
    if not found or v_k.peran = 'owner' then return new; end if;

    select a.ts, a.id into v_ci, v_ci_id from absensi.absensi a
     where a.karyawan_id = new.karyawan_id and a.tipe = 'clock_in'
       and a.ts <= new.ts and a.ts > new.ts - interval '30 hours'
     order by a.ts desc limit 1;

    -- PR-CL128: lembur lewat izin -> catat selesai di izinnya, selesai.
    if v_ci_id is not null then
      update absensi.lembur_izin
         set selesai_absen_id = new.id, selesai_at = new.ts,
             riwayat = riwayat || jsonb_build_array(jsonb_build_object('aksi', 'selesai', 'at', new.ts))
       where sesi_ci_id = v_ci_id and mulai_absen_id is not null and selesai_absen_id is null;
      if found then return new; end if;
    end if;

    v_tanggal := (coalesce(v_ci, new.ts) at time zone 'Asia/Jakarta')::date;
    if v_tanggal < absensi.lembur_acc_mulai() then return new; end if;
    if v_k.pa_mulai is not null and v_k.pa_mulai <= v_tanggal then return new; end if;

    select max(a.ts) into v_oi from absensi.absensi a
     where a.karyawan_id = new.karyawan_id and a.tipe = 'overtime_in'
       and a.ts <= new.ts and a.ts >= coalesce(v_ci, new.ts - interval '30 hours');
    select coalesce(bool_or(la.bebas_acc), false) into v_bebas
      from absensi.lembur_akses la where la.karyawan_id = new.karyawan_id;

    insert into absensi.lembur_acc (absen_id, karyawan_id, tanggal, ts_mulai, ts_selesai, menit_perkiraan,
                                    alasan, status, batas_acc)
    values (new.id, new.karyawan_id, v_tanggal, v_oi, new.ts,
            case when v_oi is not null then greatest(0, round(extract(epoch from (new.ts - v_oi)) / 60.0))::integer end,
            nullif(left(btrim(coalesce(new.ekstra ->> 'alasan_lembur', '')), 300), ''),
            case when v_bebas then 'bebas' else 'menunggu' end,
            (((new.ts at time zone 'Asia/Jakarta')::date + 2)::timestamp at time zone 'Asia/Jakarta'))
    on conflict (absen_id) do nothing;
  exception when others then
    raise warning 'lembur_acc_catat gagal untuk absen %: %', new.id, sqlerrm;
  end;
  return new;
end $$;

-- ------------------------------------------------------------------ RPC karyawan
-- Status izin shift yang sedang berjalan + riwayat lembur 4 hari terakhir.
create or replace function absensi.lembur_izin_saya()
returns jsonb language plpgsql stable security definer set search_path = absensi, pg_catalog as $$
declare
  v_saya uuid := absensi.karyawan_saya();
  v_s    record;
  v_izin jsonb;
  v_riw  jsonb;
begin
  if v_saya is null then return null; end if;
  select * into v_s from absensi.lembur_sesi_terbuka(v_saya);
  if v_s.ci_id is not null then
    select to_jsonb(x) into v_izin from (
      select i.id, i.jenis, i.status, i.alasan, i.catatan_putus, i.created_at, i.diputus_at,
             i.mulai_at, i.selesai_at, p.nama as penyetuju, d.nama as dibuat_oleh
        from absensi.lembur_izin i
        left join absensi.karyawan p on p.id = i.diputus_oleh
        left join absensi.karyawan d on d.id = i.diminta_oleh
       where i.sesi_ci_id = v_s.ci_id
       order by (i.status in ('menunggu', 'disetujui')) desc, i.created_at desc
       limit 1) x;
  end if;
  select coalesce(jsonb_agg(to_jsonb(y) order by y.mulai_at desc), '[]'::jsonb) into v_riw from (
    select i.id, i.jenis, i.tanggal, i.alasan, i.mulai_at, i.selesai_at, p.nama as penyetuju,
           absensi.lembur_jeda_menit(v_saya, i.mulai_at, coalesce(i.selesai_at, now())) as jeda_menit
      from absensi.lembur_izin i
      left join absensi.karyawan p on p.id = i.diputus_oleh
     where i.karyawan_id = v_saya and i.mulai_at is not null and i.mulai_at > now() - interval '4 days') y;
  return jsonb_build_object(
    'sesi_ci_id', v_s.ci_id, 'ci_ts', v_s.ci_ts,
    'bisa_mulai_at', case when v_s.ci_id is not null then absensi.lembur_bisa_mulai_at(v_saya, v_s.ci_ts) end,
    'izin', v_izin, 'riwayat', v_riw,
    'bebas_acc', absensi.lembur_bebas(v_saya), 'is_pa', absensi.lembur_is_pa(v_saya),
    'bisa_acc', absensi.lembur_boleh_acc(v_saya));
end $$;

create or replace function absensi.lembur_minta(p_alasan text)
returns uuid language plpgsql security definer set search_path = absensi, pg_catalog as $$
declare
  v_saya   uuid := absensi.karyawan_saya();
  v_alasan text := left(btrim(coalesce(p_alasan, '')), 300);
  v_s      record;
  v_id     uuid;
begin
  if v_saya is null then raise exception 'Akun belum terhubung ke data karyawan.'; end if;
  if length(v_alasan) < 3 then raise exception 'Alasan lembur minimal 3 huruf.'; end if;
  if absensi.lembur_bebas(v_saya) then raise exception 'Kamu bebas izin lembur, pakai Clock Out Lembur seperti biasa.'; end if;
  if absensi.lembur_is_pa(v_saya) then raise exception 'Personal Assistant tidak punya lembur.'; end if;
  select * into v_s from absensi.lembur_sesi_terbuka(v_saya);
  if v_s.ci_id is null then raise exception 'Clock In dulu, baru bisa minta lembur.'; end if;
  if exists (select 1 from absensi.absensi a where a.karyawan_id = v_saya and a.tipe = 'overtime_in' and a.ts >= v_s.ci_ts) then
    raise exception 'Lembur shift ini sudah dimulai.';
  end if;
  if exists (select 1 from absensi.lembur_izin i where i.sesi_ci_id = v_s.ci_id and i.status in ('menunggu', 'disetujui')) then
    raise exception 'Sudah ada permintaan / izin lembur buat shift ini.';
  end if;
  if exists (select 1 from absensi.lembur_izin i where i.sesi_ci_id = v_s.ci_id and i.status = 'ditolak') then
    raise exception 'Permintaan lembur shift ini sudah ditolak. Cukup Clock Out biasa ya.';
  end if;
  insert into absensi.lembur_izin (karyawan_id, sesi_ci_id, tanggal, jenis, alasan, status, diminta_oleh, riwayat)
  values (v_saya, v_s.ci_id, (v_s.ci_ts at time zone 'Asia/Jakarta')::date, 'minta', v_alasan, 'menunggu', v_saya,
          jsonb_build_array(jsonb_build_object('aksi', 'minta', 'oleh', v_saya, 'at', now())))
  returning id into v_id;
  return v_id;
end $$;

-- ------------------------------------------------------------------ RPC Lead / SPV / owner
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
  if v_i.mulai_absen_id is not null then raise exception 'Lembur sudah dimulai, izin tidak bisa dibatalin.'; end if;
  if v_i.status <> 'disetujui' then raise exception 'Cuma izin yang sudah disetujui yang bisa dibatalin.'; end if;
  update absensi.lembur_izin
     set status = 'dibatalkan', diputus_oleh = v_saya, diputus_at = now(), catatan_putus = v_cat,
         riwayat = riwayat || jsonb_build_array(jsonb_build_object('aksi', 'dibatalkan', 'oleh', v_saya, 'at', now(), 'catatan', v_cat))
   where id = p_id;
  return 'dibatalkan';
end $$;

-- Suruh lembur beberapa orang sekaligus. Hasil per orang: 'disuruh' / alasan kenapa dilewati.
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

-- Kotak "Lembur Hari Ini": izin 20 jam terakhir + yang masih jalan (tanpa punya sendiri).
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
     and (i.created_at > now() - interval '20 hours' or (i.mulai_at is not null and i.selesai_at is null))
   order by (i.status = 'menunggu') desc, i.created_at desc;
end $$;

-- Calon yang bisa disuruh: lagi masuk (sesi terbuka), bukan PA / Mila / diri sendiri.
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
     and s.ci_id is not null
   order by s.ci_ts;
end $$;

-- ------------------------------------------------------------------ RPC payroll owner
create or replace function absensi.lembur_izin_rentang(p_dari date, p_sampai date)
returns table (id uuid, karyawan_id uuid, tanggal date, jenis text, status text, alasan text,
               mulai_absen_id uuid, mulai_at timestamptz, selesai_at timestamptz, penyetuju text)
language plpgsql stable security definer set search_path = absensi, pg_catalog as $$
begin
  if not absensi.is_owner() then raise exception 'Khusus owner.'; end if;
  return query
  select i.id, i.karyawan_id, i.tanggal, i.jenis, i.status, i.alasan, i.mulai_absen_id, i.mulai_at, i.selesai_at, p.nama
    from absensi.lembur_izin i
    left join absensi.karyawan p on p.id = i.diputus_oleh
   where i.tanggal between p_dari - 1 and p_sampai + 1;
end $$;

revoke all on function absensi.lembur_sesi_terbuka(uuid) from public, anon, authenticated;
revoke all on function absensi.lembur_jeda_menit(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function absensi.lembur_bisa_mulai_at(uuid, timestamptz) from public, anon, authenticated;
revoke all on function absensi.lembur_bebas(uuid) from public, anon, authenticated;
revoke all on function absensi.lembur_is_pa(uuid) from public, anon, authenticated;
revoke all on function absensi.lembur_izin_jaga() from public, anon, authenticated;
revoke all on function absensi.lembur_izin_saya() from public, anon;
revoke all on function absensi.lembur_minta(text) from public, anon;
revoke all on function absensi.lembur_izin_putus(uuid, boolean, text) from public, anon;
revoke all on function absensi.lembur_izin_batal(uuid, text) from public, anon;
revoke all on function absensi.lembur_suruh(uuid[], text) from public, anon;
revoke all on function absensi.lembur_hari_ini() from public, anon;
revoke all on function absensi.lembur_kandidat_suruh() from public, anon;
revoke all on function absensi.lembur_izin_rentang(date, date) from public, anon;
grant execute on function absensi.lembur_izin_saya() to authenticated;
grant execute on function absensi.lembur_minta(text) to authenticated;
grant execute on function absensi.lembur_izin_putus(uuid, boolean, text) to authenticated;
grant execute on function absensi.lembur_izin_batal(uuid, text) to authenticated;
grant execute on function absensi.lembur_suruh(uuid[], text) to authenticated;
grant execute on function absensi.lembur_hari_ini() to authenticated;
grant execute on function absensi.lembur_kandidat_suruh() to authenticated;
grant execute on function absensi.lembur_izin_rentang(date, date) to authenticated;

notify pgrst, 'reload schema';
