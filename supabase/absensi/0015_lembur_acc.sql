-- PR-CL127: lembur wajib di-ACC Lead / SPV / owner.
-- Owner, 29 Sep 2026: lembur September ~657 jam (2,5x Agustus), shift malam bebas lembur
-- padahal shift pagi nganggur. Aturan baru mulai sesi 29 Sep 2026 (WIB):
--   * Tiap "Selesai Lembur" (event overtime_out) otomatis bikin satu baris lembur_acc
--     status 'menunggu' + alasan dari karyawan.
--   * Lead (lembur_akses.bisa_acc), SPV, atau owner boleh ACC / tolak sampai akhir hari
--     BESOKNYA (H+1 WIB, dihitung dari tanggal tap Selesai Lembur). Lewat itu terkunci =
--     tidak di-ACC. Tidak ada yang boleh ACC lembur miliknya sendiri.
--   * Payroll (owner.js) cuma membayar lembur yang 'disetujui' atau 'bebas'. Selain itu
--     menit lembur dibayar 0 (jam normal tetap dibayar). lembur_override_menit owner tetap menang.
--   * Bebas ACC (lembur_akses.bebas_acc): Mila. Statusnya 'bebas' = dibayar seperti dulu.
--   * PA (pa_mulai) tidak dicatat sama sekali: PA memang tanpa lembur (PR-CL124).
-- Sesi sebelum 29 Sep tidak dibuatkan baris dan payroll-nya tidak berubah.
--
-- Additive: 2 tabel baru, 1 trigger AFTER INSERT di absensi.absensi (dibungkus penangkap
-- error: kalau gagal, absen tetap tersimpan), fungsi RPC baru. Tidak ada kolom/policy lama
-- yang diubah. Tabel baru cuma bisa DIBACA langsung (RLS); semua tulis lewat RPC.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- ------------------------------------------------------------------ konfigurasi
create or replace function absensi.lembur_acc_mulai()
returns date language sql immutable as $$ select date '2026-09-29' $$;
comment on function absensi.lembur_acc_mulai() is 'PR-CL127: sesi kerja (tanggal clock-in WIB) mulai tanggal ini lemburnya wajib ACC.';

create table if not exists absensi.lembur_akses (
  karyawan_id uuid primary key references absensi.karyawan(id),
  bebas_acc   boolean not null default false,
  bisa_acc    boolean not null default false,
  catatan     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table absensi.lembur_akses is 'PR-CL127: siapa yang lemburnya bebas ACC (bebas_acc) dan siapa Lead yang boleh ACC lembur orang lain (bisa_acc). SPV & owner otomatis boleh ACC lewat kolom peran.';

create table if not exists absensi.lembur_acc (
  id              uuid primary key default gen_random_uuid(),
  absen_id        uuid not null unique,   -- event overtime_out; sengaja tanpa FK supaya arsip absen tidak menghapus jejak ACC
  karyawan_id     uuid not null references absensi.karyawan(id),
  tanggal         date not null,          -- tanggal sesi = tanggal clock-in (WIB), sama dengan pengelompokan payroll owner.js
  ts_mulai        timestamptz,            -- overtime_in (otomatis, titik jam kontrak terpenuhi)
  ts_selesai      timestamptz not null,   -- overtime_out
  menit_perkiraan integer,
  alasan          text,
  status          text not null default 'menunggu',
  batas_acc       timestamptz not null,
  diputus_oleh    uuid references absensi.karyawan(id),
  diputus_at      timestamptz,
  catatan_putus   text,
  riwayat         jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lembur_acc_status_cek') then
    alter table absensi.lembur_acc add constraint lembur_acc_status_cek
      check (status in ('menunggu', 'disetujui', 'ditolak', 'bebas'));
  end if;
end $$;
create index if not exists lembur_acc_status_batas_idx on absensi.lembur_acc (status, batas_acc);
create index if not exists lembur_acc_karyawan_tanggal_idx on absensi.lembur_acc (karyawan_id, tanggal);
comment on table absensi.lembur_acc is 'PR-CL127: satu baris per Selesai Lembur sejak lembur_acc_mulai(). Payroll hanya membayar status disetujui/bebas; menunggu yang lewat batas_acc = kedaluwarsa (tidak dibayar).';

drop trigger if exists trg_lembur_akses_updated_at on absensi.lembur_akses;
create trigger trg_lembur_akses_updated_at before update on absensi.lembur_akses
  for each row execute function absensi.set_updated_at();
drop trigger if exists trg_lembur_acc_updated_at on absensi.lembur_acc;
create trigger trg_lembur_acc_updated_at before update on absensi.lembur_acc
  for each row execute function absensi.set_updated_at();

alter table absensi.lembur_akses enable row level security;
alter table absensi.lembur_acc enable row level security;
drop policy if exists lembur_akses_baca on absensi.lembur_akses;
create policy lembur_akses_baca on absensi.lembur_akses for select to authenticated
  using (karyawan_id = absensi.karyawan_saya() or absensi.is_owner());
drop policy if exists lembur_akses_kelola on absensi.lembur_akses;
create policy lembur_akses_kelola on absensi.lembur_akses for all to authenticated
  using (absensi.is_owner()) with check (absensi.is_owner());
drop policy if exists lembur_acc_baca on absensi.lembur_acc;
create policy lembur_acc_baca on absensi.lembur_acc for select to authenticated
  using (karyawan_id = absensi.karyawan_saya() or absensi.is_owner());

revoke all on absensi.lembur_akses, absensi.lembur_acc from anon, public;
grant select on absensi.lembur_akses, absensi.lembur_acc to authenticated;
grant all on absensi.lembur_akses, absensi.lembur_acc to service_role;

-- Seed: Mila bebas ACC; Lead (level Lead di WMS: Mila, Desti, Itang) boleh ACC.
-- Rafi (peran spv) dan owner tidak perlu baris: haknya dari kolom peran.
insert into absensi.lembur_akses (karyawan_id, bebas_acc, bisa_acc, catatan)
select k.id, (k.nama = 'mila'), true, 'PR-CL127 seed: Lead'
  from absensi.karyawan k
 where k.nama in ('mila', 'desti', 'itang') and k.nonaktif = false
on conflict (karyawan_id) do nothing;

-- ------------------------------------------------------------------ helper
create or replace function absensi.lembur_boleh_acc(p_karyawan uuid)
returns boolean language sql stable security definer set search_path = absensi, pg_catalog as $$
  select coalesce((select k.peran in ('owner', 'spv') and not k.nonaktif from absensi.karyawan k where k.id = p_karyawan), false)
      or exists (select 1 from absensi.lembur_akses a join absensi.karyawan k on k.id = a.karyawan_id
                  where a.karyawan_id = p_karyawan and a.bisa_acc and not k.nonaktif)
$$;

create or replace function absensi.lembur_status_efektif(p_status text, p_batas timestamptz)
returns text language sql stable as $$
  select case when p_status = 'menunggu' and now() > p_batas then 'kedaluwarsa' else p_status end
$$;

-- ------------------------------------------------------------------ trigger pencatat
create or replace function absensi.lembur_acc_catat()
returns trigger language plpgsql security definer set search_path = absensi, pg_catalog as $$
declare
  v_ci      timestamptz;
  v_oi      timestamptz;
  v_tanggal date;
  v_k       record;
  v_bebas   boolean;
begin
  begin
    select k.peran, k.pa_mulai into v_k from absensi.karyawan k where k.id = new.karyawan_id;
    if not found or v_k.peran = 'owner' then return new; end if;

    -- Sesi = clock_in terakhir sebelum Selesai Lembur (maks 30 jam ke belakang).
    select max(a.ts) into v_ci from absensi.absensi a
     where a.karyawan_id = new.karyawan_id and a.tipe = 'clock_in'
       and a.ts <= new.ts and a.ts > new.ts - interval '30 hours';
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
            -- akhir hari BESOKNYA (WIB) dari tanggal tap Selesai Lembur
            (((new.ts at time zone 'Asia/Jakarta')::date + 2)::timestamp at time zone 'Asia/Jakarta'))
    on conflict (absen_id) do nothing;
  exception when others then
    -- Absen TIDAK boleh gagal gara-gara pencatatan ACC.
    raise warning 'lembur_acc_catat gagal untuk absen %: %', new.id, sqlerrm;
  end;
  return new;
end $$;

drop trigger if exists trg_lembur_acc_catat on absensi.absensi;
create trigger trg_lembur_acc_catat after insert on absensi.absensi
  for each row when (new.tipe = 'overtime_out') execute function absensi.lembur_acc_catat();

-- ------------------------------------------------------------------ RPC karyawan
create or replace function absensi.lembur_info_saya()
returns jsonb language sql stable security definer set search_path = absensi, pg_catalog as $$
  select jsonb_build_object(
    'mulai', absensi.lembur_acc_mulai(),
    'bebas_acc', coalesce((select la.bebas_acc from absensi.lembur_akses la where la.karyawan_id = absensi.karyawan_saya()), false),
    'bisa_acc', absensi.lembur_boleh_acc(absensi.karyawan_saya()))
$$;

create or replace function absensi.lembur_acc_saya(p_hari integer default 7)
returns table (id uuid, tanggal date, ts_mulai timestamptz, ts_selesai timestamptz, menit_perkiraan integer,
               alasan text, status text, status_efektif text, batas_acc timestamptz,
               penyetuju text, diputus_at timestamptz, catatan_putus text)
language sql stable security definer set search_path = absensi, pg_catalog as $$
  select l.id, l.tanggal, l.ts_mulai, l.ts_selesai, l.menit_perkiraan, l.alasan, l.status,
         absensi.lembur_status_efektif(l.status, l.batas_acc), l.batas_acc,
         p.nama, l.diputus_at, l.catatan_putus
    from absensi.lembur_acc l
    left join absensi.karyawan p on p.id = l.diputus_oleh
   where l.karyawan_id = absensi.karyawan_saya()
     and l.ts_selesai >= now() - make_interval(days => greatest(1, least(coalesce(p_hari, 7), 62)))
     and exists (select 1 from absensi.absensi a where a.id = l.absen_id)
   order by l.ts_selesai desc
$$;

create or replace function absensi.lembur_isi_alasan(p_id uuid, p_alasan text)
returns void language plpgsql security definer set search_path = absensi, pg_catalog as $$
declare v_alasan text := left(btrim(coalesce(p_alasan, '')), 300);
begin
  if length(v_alasan) < 3 then raise exception 'Alasan lembur minimal 3 huruf.'; end if;
  update absensi.lembur_acc l set alasan = v_alasan
   where l.id = p_id and l.karyawan_id = absensi.karyawan_saya()
     and l.status in ('menunggu', 'bebas') and now() <= l.batas_acc;
  if not found then raise exception 'Lembur ini tidak bisa diubah lagi.'; end if;
end $$;

-- ------------------------------------------------------------------ RPC penyetuju
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
  -- Yang masih bisa diputus (belum lewat batas): menunggu + yang sudah diputus (bisa diralat).
  return query
  select l.id, l.karyawan_id, k.nama, l.tanggal, l.ts_mulai, l.ts_selesai, l.menit_perkiraan, l.alasan,
         l.status, l.batas_acc, p.nama, l.diputus_at, l.catatan_putus
    from absensi.lembur_acc l
    join absensi.karyawan k on k.id = l.karyawan_id
    left join absensi.karyawan p on p.id = l.diputus_oleh
   where l.status in ('menunggu', 'disetujui', 'ditolak')
     and now() <= l.batas_acc
     and l.karyawan_id <> v_saya
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

-- ------------------------------------------------------------------ RPC payroll owner
create or replace function absensi.lembur_acc_rentang(p_dari date, p_sampai date)
returns table (id uuid, absen_id uuid, karyawan_id uuid, tanggal date, menit_perkiraan integer, alasan text,
               status text, status_efektif text, batas_acc timestamptz, penyetuju text, diputus_at timestamptz)
language plpgsql stable security definer set search_path = absensi, pg_catalog as $$
begin
  if not absensi.is_owner() then raise exception 'Khusus owner.'; end if;
  return query
  select l.id, l.absen_id, l.karyawan_id, l.tanggal, l.menit_perkiraan, l.alasan, l.status,
         absensi.lembur_status_efektif(l.status, l.batas_acc), l.batas_acc, p.nama, l.diputus_at
    from absensi.lembur_acc l
    left join absensi.karyawan p on p.id = l.diputus_oleh
   where l.tanggal between p_dari and p_sampai;
end $$;

revoke all on function absensi.lembur_boleh_acc(uuid) from public, anon, authenticated;
revoke all on function absensi.lembur_acc_catat() from public, anon, authenticated;
revoke all on function absensi.lembur_info_saya() from public, anon;
revoke all on function absensi.lembur_acc_saya(integer) from public, anon;
revoke all on function absensi.lembur_isi_alasan(uuid, text) from public, anon;
revoke all on function absensi.lembur_acc_antrian() from public, anon;
revoke all on function absensi.lembur_acc_putus(uuid, boolean, text) from public, anon;
revoke all on function absensi.lembur_acc_rentang(date, date) from public, anon;
grant execute on function absensi.lembur_info_saya() to authenticated;
grant execute on function absensi.lembur_acc_saya(integer) to authenticated;
grant execute on function absensi.lembur_isi_alasan(uuid, text) to authenticated;
grant execute on function absensi.lembur_acc_antrian() to authenticated;
grant execute on function absensi.lembur_acc_putus(uuid, boolean, text) to authenticated;
grant execute on function absensi.lembur_acc_rentang(date, date) to authenticated;
grant execute on function absensi.lembur_acc_mulai() to authenticated;

notify pgrst, 'reload schema';
