-- ============================================================================
-- GoodGems Absensi di Supabase (project WMS) — skema inti
-- PR-CL112 · 14 Sep 2026
--
-- Rumah baru absensi GoodGems, pengganti Firestore. Ditulis ulang dari cetak
-- biru Kopikiri (kopikiri-absensi/sql 0001-0014) dengan tiga beda besar:
--   1. Semua di skema `absensi`, bukan `public` — project ini juga dipakai WMS,
--      jadi nama tabel/fungsi tidak boleh tabrakan (WMS sudah punya
--      public.set_updated_at, wms.is_owner, dst).
--   2. TIDAK membawa event trigger ensure_rls/rls_auto_enable milik Kopikiri:
--      event trigger berlaku ke seluruh database dan bakal diam-diam mengubah
--      tabel WMS. RLS dinyalakan eksplisit per tabel di bawah.
--   3. Aturan khas GoodGems: jam kontrak default 9, plafon kasbon default 50%,
--      hari kerja 04:00-04:00, periode gaji tutup buku tgl 25 (lihat 0002).
--
-- Hak akses: anon tidak dapat apa-apa. Pengguna WMS yang login tapi bukan
-- karyawan GoodGems juga tidak dapat apa-apa — semua pagar berpatokan ke
-- karyawan_saya(), bukan sekadar "sudah login".
-- ============================================================================

set lock_timeout = '5s';
set statement_timeout = '60s';

create schema if not exists absensi;
comment on schema absensi is 'Absensi & payroll karyawan GoodGems (pindahan dari Firebase). Terpisah dari WMS.';

revoke all on schema absensi from public, anon;
grant usage on schema absensi to authenticated, service_role;

-- Fungsi baru di Postgres otomatis bisa dieksekusi PUBLIC. Dicabut sebagai
-- bawaan, lalu dibuka satu per satu di akhir tiap migrasi.
alter default privileges in schema absensi revoke execute on functions from public;

-- ------------------------------------------------------------------- enum
do $blok$ begin
  create type absensi.tipe_absen as enum (
    'clock_in', 'clock_out', 'break_in', 'break_out',
    'overtime_in', 'overtime_out', 'pause_in', 'pause_out'
  );
exception when duplicate_object then null; end $blok$;

do $blok$ begin
  create type absensi.peran_karyawan as enum ('owner', 'spv', 'staff');
exception when duplicate_object then null; end $blok$;

-- ============================================================== 1. CABANG
-- GoodGems sekarang cuma satu titik (ruko). Tetap dibikin tabel supaya titik &
-- radius bisa diubah owner tanpa ganti kode, dan siap kalau nanti buka cabang.
create table if not exists absensi.cabang (
  id             uuid primary key default gen_random_uuid(),
  kode           text not null unique,
  nama           text not null,
  alamat         text,
  lat            double precision,
  lng            double precision,
  radius_m       integer not null default 300,
  geofence_aktif boolean not null default true,
  aktif          boolean not null default true,
  catatan        text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ============================================================ 2. KARYAWAN
create table if not exists absensi.karyawan (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid unique references auth.users(id) on delete set null,
  firebase_uid          text unique,              -- jejak balik ke dokumen Firestore
  cabang_id             uuid references absensi.cabang(id) on delete restrict,

  -- identitas
  nama                  text not null,            -- nama panggilan (sama dengan WMS)
  nama_lengkap          text,
  email                 text,
  email_lain            text[] not null default '{}',
  phone                 text,
  id_karyawan           text,                     -- GG-XXXX
  jabatan               text,
  status_kepegawaian    text,
  nik                   text,
  peran                 absensi.peran_karyawan not null default 'staff',
  foto_url              text,                     -- PATH di bucket absensi-profil, bukan URL
  tanggal_lahir         date,
  tanggal_masuk         date,

  -- upah
  base_harian           integer not null default 0,
  jam_kerja             integer not null default 9,
  multiplier_lembur     numeric(3,2) not null default 1.50,
  tunjangan_bulanan     integer not null default 0,

  -- aturan kerja
  libur_hari            smallint,                 -- 0=Minggu .. 6=Sabtu, permanen setelah ditetapkan owner
  nonaktif              boolean not null default false,
  gps_exempt            boolean not null default false,
  wajib_kode_clockout   boolean not null default false,
  kode_admin            boolean not null default false,
  no_shift_barrier      boolean not null default false,

  -- kasbon
  kasbon_aktif          boolean not null default false,
  kasbon_plafon_persen  integer not null default 50,

  -- rekening & KTP
  nama_bank             text,
  nomor_rekening        text,
  atas_nama_rek         text,
  ktp_url               text,                     -- PATH di bucket absensi-ktp
  rekening_locked       boolean not null default false,

  perlu_tinjau          boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint karyawan_libur_hari_valid check (libur_hari is null or libur_hari between 0 and 6),
  constraint karyawan_jam_kerja_wajar  check (jam_kerja between 1 and 24),
  constraint karyawan_plafon_wajar     check (kasbon_plafon_persen between 0 and 100)
);

create index if not exists karyawan_cabang_idx on absensi.karyawan (cabang_id) where nonaktif = false;
create unique index if not exists karyawan_email_unik on absensi.karyawan (lower(email)) where email is not null;

comment on column absensi.karyawan.peran        is 'owner = pemilik; spv = supervisor (dulu toggle spvAkses) boleh pantau absen semua orang; staff = biasa.';
comment on column absensi.karyawan.firebase_uid is 'UID Firebase lama. Dipakai saat pindah data & mencocokkan WMS (wms.user_profiles.absensi_uid).';

-- ============================================================= 3. ABSENSI
create table if not exists absensi.absensi (
  id               uuid primary key default gen_random_uuid(),
  karyawan_id      uuid not null references absensi.karyawan(id) on delete cascade,
  cabang_id        uuid references absensi.cabang(id) on delete set null,
  tipe             absensi.tipe_absen not null,
  ts               timestamptz not null default now(),

  lat              double precision,
  lng              double precision,
  akurasi_m        double precision,
  jarak_m          double precision,
  in_radius        boolean,
  gps_exempt       boolean not null default false,

  foto_selfie      text,                          -- PATH di bucket absensi-selfie
  catatan          text,

  kode_verif       text check (kode_verif is null or kode_verif in ('ok', 'darurat')),
  no_break         boolean not null default false,
  auto_cap         boolean not null default false,
  otomatis         boolean not null default false,
  flag             text,

  edit_manual      boolean not null default false,  -- dulu manualEdit / editedByOwner
  diedit_at        timestamptz,
  dibuat_oleh      uuid references absensi.karyawan(id) on delete set null,
  firebase_doc_id  text unique,                    -- jejak balik saat pindah data
  created_at       timestamptz not null default now()
);

create index if not exists absensi_karyawan_ts_idx on absensi.absensi (karyawan_id, ts desc);
create index if not exists absensi_ts_idx          on absensi.absensi (ts desc);
create index if not exists absensi_luar_radius_idx on absensi.absensi (ts desc) where in_radius is false;

-- Arsip absen yang dibatalkan owner (pengganti "hapus permanen").
create table if not exists absensi.absensi_batal (
  like absensi.absensi including defaults,
  dibatalkan_at   timestamptz not null default now(),
  dibatalkan_oleh uuid,
  alasan          text,
  primary key (id),
  constraint absensi_batal_karyawan_fk foreign key (karyawan_id)
    references absensi.karyawan(id) on delete cascade
);
create index if not exists absensi_batal_dibatalkan_idx on absensi.absensi_batal (dibatalkan_at desc);

-- ============================================================ 4. UANG
-- Bonus/potongan per periode. Dulu bonusBulan{yyyymm} & potonganBulan{yyyymm}
-- di dokumen karyawan; kasbon yang disetujui masuk sebagai jenis 'kasbon'.
create table if not exists absensi.penyesuaian_gaji (
  id           uuid primary key default gen_random_uuid(),
  karyawan_id  uuid not null references absensi.karyawan(id) on delete cascade,
  periode      text not null,
  jenis        text not null check (jenis in ('bonus', 'potongan', 'kasbon')),
  jumlah       integer not null,
  catatan      text,
  dibuat_oleh  uuid references absensi.karyawan(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint penyesuaian_periode_format check (periode ~ '^[0-9]{4}-[0-9]{2}$')
);
create index if not exists penyesuaian_karyawan_periode_idx on absensi.penyesuaian_gaji (karyawan_id, periode);

-- Status lunas + slip per periode. Dulu bayarBulan{yyyymm} & slipBulan{yyyymm}.
create table if not exists absensi.payroll_status (
  id           uuid primary key default gen_random_uuid(),
  karyawan_id  uuid not null references absensi.karyawan(id) on delete cascade,
  periode      text not null,
  status       text not null default 'belum' check (status in ('belum', 'dibayar')),
  jumlah       integer,
  slip         jsonb,
  dibayar_at   timestamptz,
  dibayar_oleh uuid references absensi.karyawan(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (karyawan_id, periode),
  constraint payroll_periode_format check (periode ~ '^[0-9]{4}-[0-9]{2}$')
);

create table if not exists absensi.kasbon_request (
  id               uuid primary key default gen_random_uuid(),
  karyawan_id      uuid not null references absensi.karyawan(id) on delete cascade,
  jumlah           integer not null check (jumlah > 0),
  alasan           text,
  status           text not null default 'menunggu' check (status in ('menunggu', 'disetujui', 'ditolak')),
  periode          text not null,
  periode_label    text,
  disetujui_jumlah integer,
  catatan_owner    text,
  diputus_at       timestamptz,
  diputus_oleh     uuid references absensi.karyawan(id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint kasbon_request_periode_format check (periode ~ '^[0-9]{4}-[0-9]{2}$')
);
create index if not exists kasbon_request_karyawan_idx on absensi.kasbon_request (karyawan_id, created_at desc);

create table if not exists absensi.libur_request (
  id            uuid primary key default gen_random_uuid(),
  karyawan_id   uuid not null references absensi.karyawan(id) on delete cascade,
  pilihan       smallint[] not null,
  status        text not null default 'menunggu' check (status in ('menunggu', 'diproses')),
  diputus_at    timestamptz,
  diputus_oleh  uuid references absensi.karyawan(id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint libur_request_pilihan_wajar
    check (array_length(pilihan, 1) between 1 and 3 and pilihan <@ array[0,1,2,3,4,5,6]::smallint[])
);
create index if not exists libur_request_karyawan_idx on absensi.libur_request (karyawan_id, created_at desc);

-- ====================================================== 5. OUTBOX TELEGRAM
-- Satu-satunya tabel yang ditulis bot. Cuma service role yang bisa menyentuh.
create table if not exists absensi.telegram_outbox (
  id                  uuid primary key default gen_random_uuid(),
  jenis               text not null,
  kunci               text not null,
  chat_id             text,
  teks                text not null,
  status              text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  attempts            integer not null default 0,
  error               text,
  telegram_message_id bigint,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  sent_at             timestamptz,
  constraint telegram_outbox_jenis_kunci_unik unique (jenis, kunci)
);
create index if not exists telegram_outbox_nyangkut_idx on absensi.telegram_outbox (updated_at desc) where status <> 'sent';

-- =============================================== updated_at otomatis
create or replace function absensi.set_updated_at()
returns trigger language plpgsql set search_path = pg_catalog as $fn$
begin
  new.updated_at = now();
  return new;
end $fn$;

do $blok$
declare t text;
begin
  foreach t in array array['cabang', 'karyawan', 'payroll_status', 'telegram_outbox'] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on absensi.%1$I', t);
    execute format('create trigger trg_%1$s_updated_at before update on absensi.%1$I
                    for each row execute function absensi.set_updated_at()', t);
  end loop;
end $blok$;

-- ========================================================= HELPER PERAN
-- SECURITY DEFINER supaya tidak kena RLS tabel karyawan (kalau kena, aturan
-- RLS karyawan memanggil dirinya sendiri terus-terusan).
create or replace function absensi.karyawan_saya()
returns uuid language sql stable security definer set search_path = absensi, pg_catalog as $fn$
  select id from absensi.karyawan where user_id = (select auth.uid())
$fn$;

create or replace function absensi.is_owner()
returns boolean language sql stable security definer set search_path = absensi, pg_catalog as $fn$
  select coalesce((select peran from absensi.karyawan where user_id = (select auth.uid())) = 'owner', false)
$fn$;

-- Owner otomatis ikut dianggap SPV (boleh pantau).
create or replace function absensi.is_spv()
returns boolean language sql stable security definer set search_path = absensi, pg_catalog as $fn$
  select coalesce((select peran from absensi.karyawan where user_id = (select auth.uid())) in ('owner', 'spv'), false)
$fn$;

-- Satu email tidak boleh dipakai dua orang (email utama maupun email_lain).
create or replace function absensi.jaga_email_unik()
returns trigger language plpgsql security definer set search_path = absensi, pg_catalog as $fn$
declare v_bentrok text;
begin
  new.email := nullif(lower(btrim(coalesce(new.email, ''))), '');
  new.email_lain := array(
    select distinct lower(btrim(x)) from unnest(coalesce(new.email_lain, '{}')) x
     where nullif(btrim(x), '') is not null
       and lower(btrim(x)) is distinct from new.email
  );

  select e into v_bentrok
    from unnest(array_remove(array_append(new.email_lain, new.email), null)) e
   where exists (select 1 from absensi.karyawan k
                  where k.id <> new.id
                    and (lower(k.email) = e or e = any (k.email_lain)))
   limit 1;

  if v_bentrok is not null then
    raise exception 'Email "%" sudah terdaftar pada karyawan lain.', v_bentrok using errcode = '23505';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_karyawan_jaga_email on absensi.karyawan;
create trigger trg_karyawan_jaga_email before insert or update of email, email_lain on absensi.karyawan
  for each row execute function absensi.jaga_email_unik();

-- ==================================================================== RLS
alter table absensi.cabang           enable row level security;
alter table absensi.karyawan         enable row level security;
alter table absensi.absensi          enable row level security;
alter table absensi.absensi_batal    enable row level security;
alter table absensi.penyesuaian_gaji enable row level security;
alter table absensi.payroll_status   enable row level security;
alter table absensi.kasbon_request   enable row level security;
alter table absensi.libur_request    enable row level security;
alter table absensi.telegram_outbox  enable row level security;

-- CABANG: karyawan GoodGems boleh lihat (buat geofence). Pengguna WMS lain tidak.
create policy cabang_baca on absensi.cabang
  for select to authenticated using (absensi.karyawan_saya() is not null);
create policy cabang_kelola on absensi.cabang
  for all to authenticated using (absensi.is_owner()) with check (absensi.is_owner());

-- KARYAWAN: staf cuma lihat dirinya. SPV SENGAJA tidak dapat baris orang lain
-- (gaji, KTP, rekening). Tidak ada izin UPDATE buat staf — jalurnya lewat RPC.
create policy karyawan_baca_sendiri on absensi.karyawan
  for select to authenticated using (user_id = (select auth.uid()) or absensi.is_owner());
create policy karyawan_kelola_owner on absensi.karyawan
  for all to authenticated using (absensi.is_owner()) with check (absensi.is_owner());

-- ABSENSI: staf baca & tambah punya sendiri; SPV/owner baca semua; ubah/hapus owner.
create policy absensi_baca on absensi.absensi
  for select to authenticated
  using (karyawan_id = absensi.karyawan_saya() or absensi.is_spv());
create policy absensi_tulis_sendiri on absensi.absensi
  for insert to authenticated
  with check (karyawan_id = absensi.karyawan_saya() and edit_manual = false and dibuat_oleh is null);
create policy absensi_koreksi_owner on absensi.absensi
  for all to authenticated using (absensi.is_owner()) with check (absensi.is_owner());

create policy absensi_batal_baca_owner on absensi.absensi_batal
  for select to authenticated using (absensi.is_owner());

-- UANG: staf lihat punya sendiri (slip), selebihnya owner.
create policy penyesuaian_baca on absensi.penyesuaian_gaji
  for select to authenticated using (karyawan_id = absensi.karyawan_saya() or absensi.is_owner());
create policy penyesuaian_kelola on absensi.penyesuaian_gaji
  for all to authenticated using (absensi.is_owner()) with check (absensi.is_owner());

create policy payroll_baca on absensi.payroll_status
  for select to authenticated using (karyawan_id = absensi.karyawan_saya() or absensi.is_owner());
create policy payroll_kelola on absensi.payroll_status
  for all to authenticated using (absensi.is_owner()) with check (absensi.is_owner());

-- Pengajuan: staf baca punya sendiri; kirimnya wajib lewat RPC (plafon & jatah dicek di sana).
create policy kasbon_request_baca on absensi.kasbon_request
  for select to authenticated using (karyawan_id = absensi.karyawan_saya() or absensi.is_owner());
create policy kasbon_request_kelola on absensi.kasbon_request
  for all to authenticated using (absensi.is_owner()) with check (absensi.is_owner());

create policy libur_request_baca on absensi.libur_request
  for select to authenticated using (karyawan_id = absensi.karyawan_saya() or absensi.is_owner());
create policy libur_request_kelola on absensi.libur_request
  for all to authenticated using (absensi.is_owner()) with check (absensi.is_owner());

-- telegram_outbox: sengaja tanpa policy -> cuma service role.

-- ============================================================= HAK AKSES
revoke all on all tables in schema absensi from public, anon, authenticated;
grant select, insert, update, delete on
  absensi.cabang, absensi.karyawan, absensi.absensi, absensi.penyesuaian_gaji,
  absensi.payroll_status, absensi.kasbon_request, absensi.libur_request
  to authenticated;
grant select on absensi.absensi_batal to authenticated;
grant all on all tables in schema absensi to service_role;

revoke all on function absensi.set_updated_at()   from public, anon, authenticated;
revoke all on function absensi.jaga_email_unik()  from public, anon, authenticated;
revoke all on function absensi.karyawan_saya()    from public, anon;
revoke all on function absensi.is_owner()         from public, anon;
revoke all on function absensi.is_spv()           from public, anon;
grant execute on function absensi.karyawan_saya(), absensi.is_owner(), absensi.is_spv()
  to authenticated, service_role;
