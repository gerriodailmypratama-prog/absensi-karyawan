-- ============================================================================
-- GoodGems Absensi — mesin rekap (sesi kerja, rekap harian, papan, payroll)
-- PR-CL112 · 14 Sep 2026
--
-- Dijiplak dari Kopikiri 0002 (yang sendirinya terjemahan owner.js GoodGems):
--   * sesi > 18 jam = lupa clock out
--   * jam efektif maks = jam_kerja - 1
--   * hadir kalau efektif >= 75% jam kontrak, di bawahnya parsial
--   * lembur cuma dihitung kalau ada overtime_out di sesi itu
--   * penutup sesi = clock_out pertama, kalau nihil overtime_out terakhir
--
-- Beda dengan Kopikiri:
--   * hari kerja GoodGems 04:00-04:00 (rekap_konfig.jam_mulai_hari = 4)
--   * periode payroll tutup buku tgl 25: periode 'YYYY-MM' = 26 bulan
--     sebelumnya s/d 25 bulan itu. Transisi: '2026-07' = 1-25 Jul, sebelum
--     itu satu bulan kalender penuh. (Cermin payrollRange() firebase-config.js)
--
-- Angka rupiah SENGAJA tidak dihitung di sini — view rekap tidak boleh jadi
-- jalur bocor gaji.
-- ============================================================================

set lock_timeout = '5s';
set statement_timeout = '60s';

-- ============================================================ 0. KONFIGURASI
create table if not exists absensi.rekap_konfig (
  satu_baris                   boolean primary key default true,
  zona_waktu                   text          not null default 'Asia/Jakarta',
  jam_mulai_hari               smallint      not null default 4,
  maks_durasi_sesi_jam         numeric(4,1)  not null default 18,
  ambang_hadir                 numeric(3,2)  not null default 0.75,
  potong_istirahat_kontrak_jam numeric(3,1)  not null default 1,
  maks_istirahat_dugaan_jam    numeric(3,1)  not null default 1,
  tanggal_tutup_buku           smallint      not null default 25,
  periode_transisi             text          not null default '2026-07',
  updated_at                   timestamptz   not null default now(),

  constraint rekap_konfig_tunggal   check (satu_baris),
  constraint rekap_konfig_jam_mulai check (jam_mulai_hari between 0 and 12),
  constraint rekap_konfig_maks_sesi check (maks_durasi_sesi_jam between 1 and 72),
  constraint rekap_konfig_ambang    check (ambang_hadir > 0 and ambang_hadir <= 1),
  constraint rekap_konfig_tutup     check (tanggal_tutup_buku between 1 and 28),
  constraint rekap_konfig_transisi  check (periode_transisi ~ '^[0-9]{4}-[0-9]{2}$')
);

insert into absensi.rekap_konfig (satu_baris) values (true) on conflict (satu_baris) do nothing;

comment on table absensi.rekap_konfig is 'Satu baris. Angka aturan rekap yang dulu di-hardcode di owner.js / firebase-config.js.';

drop trigger if exists trg_rekap_konfig_updated_at on absensi.rekap_konfig;
create trigger trg_rekap_konfig_updated_at before update on absensi.rekap_konfig
  for each row execute function absensi.set_updated_at();

alter table absensi.rekap_konfig enable row level security;
drop policy if exists rekap_konfig_baca on absensi.rekap_konfig;
create policy rekap_konfig_baca on absensi.rekap_konfig
  for select to authenticated using (absensi.karyawan_saya() is not null);
drop policy if exists rekap_konfig_kelola on absensi.rekap_konfig;
create policy rekap_konfig_kelola on absensi.rekap_konfig
  for update to authenticated using (absensi.is_owner()) with check (absensi.is_owner());
revoke all on absensi.rekap_konfig from public, anon, authenticated;
grant select, update on absensi.rekap_konfig to authenticated;
grant all on absensi.rekap_konfig to service_role;

-- ==================================================== 1. HELPER HARI & PERIODE
create or replace function absensi.hari_absen(
  p_ts timestamptz, p_zona text default 'Asia/Jakarta', p_jam_mulai integer default 4
) returns date language sql stable set search_path = absensi, pg_catalog as $fn$
  select ((p_ts at time zone p_zona) - make_interval(hours => p_jam_mulai))::date
$fn$;

create or replace function absensi.tanggal_kerja_kini()
returns date language sql stable set search_path = absensi, pg_catalog as $fn$
  select absensi.hari_absen(now(), k.zona_waktu, k.jam_mulai_hari) from absensi.rekap_konfig k where k.satu_baris
$fn$;

-- Rentang tanggal satu periode payroll. Cermin payrollRange() di firebase-config.js.
create or replace function absensi.rentang_periode(p_periode text)
returns table (dari date, sampai date)
language plpgsql stable set search_path = absensi, pg_catalog as $fn$
declare
  v_awal  date;
  v_tutup integer;
  v_trans text;
begin
  if p_periode is null or p_periode !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Periode harus format YYYY-MM, dapatnya: %', p_periode using errcode = '22023';
  end if;
  select k.tanggal_tutup_buku, k.periode_transisi into v_tutup, v_trans
    from absensi.rekap_konfig k where k.satu_baris;
  v_awal := to_date(p_periode || '-01', 'YYYY-MM-DD');

  if p_periode < v_trans then
    dari := v_awal;
    sampai := (v_awal + interval '1 month - 1 day')::date;
  elsif p_periode = v_trans then
    dari := v_awal;
    sampai := v_awal + (v_tutup - 1);
  else
    dari := (v_awal - interval '1 month')::date + v_tutup;
    sampai := v_awal + (v_tutup - 1);
  end if;
  return next;
end $fn$;

-- Periode yang SEDANG berjalan (dibayar tgl 1 berikutnya). Lewat tgl 25 = periode bulan depan.
create or replace function absensi.periode_berjalan(p_ts timestamptz default now())
returns text language sql stable set search_path = absensi, pg_catalog as $fn$
  select to_char(case when extract(day from (p_ts at time zone k.zona_waktu)) > k.tanggal_tutup_buku
                      then (p_ts at time zone k.zona_waktu) + interval '1 month'
                      else (p_ts at time zone k.zona_waktu) end, 'YYYY-MM')
    from absensi.rekap_konfig k where k.satu_baris
$fn$;

-- ============================================== 2. KARYAWAN RINGKAS & PUBLIK
-- Dua view ini SENGAJA bukan security_invoker (supaya bisa melewati RLS tabel
-- karyawan), jadi pagarnya klausa WHERE. Hak tulis dicabut total di bagian
-- hak akses: view sederhana di atas satu tabel otomatis bisa ditulis dan
-- tulisannya lolos RLS (temuan uji Kopikiri PR-CL06).
drop function if exists absensi.f_rekap_bulanan(text);
drop function if exists absensi.f_status_harian(date);
drop function if exists absensi.f_rekap_harian(date, date);
drop function if exists absensi.f_sesi_kerja(date, date);
drop view if exists absensi.v_karyawan_ringkas cascade;
drop view if exists absensi.karyawan_publik cascade;

create view absensi.v_karyawan_ringkas with (security_barrier = true) as
  select k.id, k.cabang_id, k.nama, k.jabatan, k.peran, k.id_karyawan,
         k.jam_kerja, k.libur_hari, k.nonaktif, k.tanggal_masuk
  from absensi.karyawan k
  where absensi.is_spv()
     or k.user_id = (select auth.uid())
     -- job backend (service role / cron) tidak punya JWT
     or current_user in ('postgres', 'service_role', 'supabase_admin');

-- Pengganti koleksi `profil`: nama, foto, tanggal-bulan ultah TANPA tahun.
-- Cuma untuk sesama karyawan GoodGems — pengguna WMS lain tidak dapat.
create view absensi.karyawan_publik with (security_barrier = true) as
  select k.id, k.nama, k.foto_url, to_char(k.tanggal_lahir, 'MM-DD') as ultah_mmdd, k.cabang_id
  from absensi.karyawan k
  where k.nonaktif = false
    and (absensi.karyawan_saya() is not null
         or current_user in ('postgres', 'service_role', 'supabase_admin'));

-- ======================================================== 3. SESI KERJA
create function absensi.f_sesi_kerja(p_dari date default null, p_sampai date default null)
returns table (
  karyawan_id             uuid,
  no_sesi                 bigint,
  tanggal_kerja           date,
  cabang_id               uuid,
  ts_masuk                timestamptz,
  ts_keluar               timestamptz,
  ts_keluar_dugaan        timestamptz,
  status_sesi             text,
  lupa_clock_out          boolean,
  ada_lembur              boolean,
  ada_istirahat_terbuka   boolean,
  ada_jeda_terbuka        boolean,
  ada_luar_radius         boolean,
  istirahat_menit         numeric,
  jeda_menit              numeric,
  durasi_kotor_menit      numeric,
  jam_efektif_mentah      numeric,
  jam_efektif             numeric,
  jam_lembur              numeric,
  kategori_hari           text,
  jam_kontrak             integer,
  jml_event               integer
)
language sql stable set search_path = absensi, pg_catalog as $fn$
  with k as (
    select kf.zona_waktu, kf.jam_mulai_hari, kf.maks_durasi_sesi_jam,
           kf.ambang_hadir, kf.potong_istirahat_kontrak_jam, kf.maks_istirahat_dugaan_jam
    from rekap_konfig kf where kf.satu_baris
  ),
  -- Event mentah, sudah dipotong rentang (pakai bantalan 2 hari di dua sisi).
  ev as (
    select a.id, a.karyawan_id, a.cabang_id, a.tipe, a.ts, a.in_radius
    from absensi a
    where (p_dari is null
           or a.ts >= (((p_dari - 2)::timestamp) at time zone (select kk.zona_waktu from k kk)))
      and (p_sampai is null
           or a.ts <  (((p_sampai + 3)::timestamp) at time zone (select kk.zona_waktu from k kk)))
  ),
  -- Langkah 1-2: tandai event pembuka sesi.
  pintu as (
    select e.id, e.karyawan_id, e.cabang_id, e.tipe, e.ts, e.in_radius,
           case when e.tipe in ('clock_in', 'overtime_in') then 'masuk' else 'keluar' end as arah
    from ev e
    where e.tipe in ('clock_in', 'overtime_in', 'clock_out', 'overtime_out')
  ),
  urut as (
    select p.id, p.karyawan_id, p.cabang_id, p.tipe, p.ts, p.in_radius, p.arah,
           lag(p.arah) over (partition by p.karyawan_id order by p.ts, p.id) as arah_sebelum,
           lag(p.ts)   over (partition by p.karyawan_id order by p.ts, p.id) as ts_sebelum
    from pintu p
  ),
  tandai as (
    select u.id, u.karyawan_id, u.cabang_id, u.tipe, u.ts, u.in_radius, u.arah,
           case when u.arah = 'masuk'
                 and (
                      -- sesi sebelumnya sudah ditutup (atau ini event pertama)
                      coalesce(u.arah_sebelum, 'keluar') = 'keluar'
                      -- ...ATAU clock-in ini sudah beda HARI KERJA dari event
                      -- masuk sebelumnya. Di owner.js efeknya sama karena event
                      -- dikelompokkan per tanggal dan look-ahead-nya berhenti
                      -- di clock_in berikutnya.
                      or hari_absen(u.ts_sebelum, k.zona_waktu, k.jam_mulai_hari)
                         is distinct from
                         hari_absen(u.ts, k.zona_waktu, k.jam_mulai_hari)
                     )
                then 1 else 0 end as buka
    from urut u
    cross join k
  ),
  -- Langkah 3: nomor sesi.
  nomor as (
    select t.id, t.karyawan_id, t.cabang_id, t.tipe, t.ts, t.in_radius, t.arah,
           sum(t.buka) over (partition by t.karyawan_id order by t.ts, t.id
                             rows between unbounded preceding and current row) as no_sesi
    from tandai t
  ),
  -- Langkah 4: satu baris per sesi. no_sesi = 0 berarti event keluar yatim
  -- (penutup shift yang clock-in-nya di luar rentang) — dibuang.
  blok as (
    select n.karyawan_id,
           n.no_sesi,
           min(n.ts)                                                     as ts_masuk,
           -- `co || oo` versi SQL: clock_out pertama, kalau nihil baru
           -- overtime_out terakhir.
           coalesce(
             min(n.ts) filter (where n.tipe = 'clock_out'),
             max(n.ts) filter (where n.tipe = 'overtime_out')
           )                                                             as ts_keluar,
           (array_agg(n.cabang_id order by n.ts, n.id))[1]                as cabang_id,
           bool_or(n.tipe = 'overtime_out')                               as ada_lembur,
           bool_or(n.in_radius is false)                                  as ada_luar_radius,
           count(*)::integer                                              as jml_event
    from nomor n
    where n.no_sesi > 0
    group by n.karyawan_id, n.no_sesi
  ),
  sesi as (
    select b.karyawan_id, b.no_sesi, b.ts_masuk, b.ts_keluar, b.cabang_id,
           b.ada_lembur, b.ada_luar_radius, b.jml_event,
           lead(b.ts_masuk) over (partition by b.karyawan_id order by b.no_sesi) as ts_masuk_berikut
    from blok b
  ),
  -- Batas atas sesi buat memotong istirahat: jam keluar kalau ada, kalau
  -- belum pulang pakai yang lebih dulu antara sekarang & sesi berikutnya.
  sesi_batas as (
    select s.*,
           coalesce(s.ts_keluar, least(coalesce(s.ts_masuk_berikut, 'infinity'::timestamptz), now())) as ts_akhir
    from sesi s
  ),
  -- Istirahat (break) & jeda (pause) dipasangkan dengan trik yang sama,
  -- masing-masing dihitung terpisah. Istirahat ganda (break_in dua kali tanpa
  -- break_out) tidak dihitung dobel: break_in kedua ikut ke pasangan yang
  -- sudah terbuka.
  potong_ev as (
    select e.id, e.karyawan_id, e.ts,
           case when e.tipe in ('break_in', 'break_out') then 'istirahat' else 'jeda' end as jenis,
           case when e.tipe in ('break_in', 'pause_in')  then 'mulai'     else 'selesai' end as arah
    from ev e
    where e.tipe in ('break_in', 'break_out', 'pause_in', 'pause_out')
  ),
  potong_tandai as (
    select pe.id, pe.karyawan_id, pe.ts, pe.jenis, pe.arah,
           case when pe.arah = 'mulai'
                 and coalesce(lag(pe.arah) over (partition by pe.karyawan_id, pe.jenis
                                                 order by pe.ts, pe.id), 'selesai') = 'selesai'
                then 1 else 0 end as buka
    from potong_ev pe
  ),
  potong_nomor as (
    select pt.id, pt.karyawan_id, pt.ts, pt.jenis, pt.arah,
           sum(pt.buka) over (partition by pt.karyawan_id, pt.jenis order by pt.ts, pt.id
                              rows between unbounded preceding and current row) as no_pasang
    from potong_tandai pt
  ),
  potong as (
    select pn.karyawan_id, pn.jenis, pn.no_pasang,
           min(pn.ts)                                          as ts_mulai,
           max(pn.ts) filter (where pn.arah = 'selesai')        as ts_selesai
    from potong_nomor pn
    where pn.no_pasang > 0
    group by pn.karyawan_id, pn.jenis, pn.no_pasang
  ),
  -- Pasangan yang BELUM ditutup tidak dipotong dari jam kerja (ikut repo
  -- lama), tapi ditandai supaya owner tahu ada yang lupa tap selesai.
  potong_sesi as (
    select sb.karyawan_id, sb.no_sesi,
           coalesce(sum(
             case when pg.ts_selesai is null or pg.jenis <> 'istirahat' then 0
                  else greatest(0, extract(epoch from (
                         least(pg.ts_selesai, sb.ts_akhir) - greatest(pg.ts_mulai, sb.ts_masuk)
                       )) / 60.0)
             end
           ), 0)                                            as istirahat_menit,
           coalesce(sum(
             case when pg.ts_selesai is null or pg.jenis <> 'jeda' then 0
                  else greatest(0, extract(epoch from (
                         least(pg.ts_selesai, sb.ts_akhir) - greatest(pg.ts_mulai, sb.ts_masuk)
                       )) / 60.0)
             end
           ), 0)                                            as jeda_menit,
           -- `pg.no_pasang is not null` penting: tanpa itu baris LEFT JOIN yang
           -- tidak ketemu pasangan ikut kebaca sebagai "masih terbuka".
           coalesce(bool_or(pg.no_pasang is not null and pg.ts_selesai is null
                            and pg.jenis = 'istirahat'), false)  as ada_istirahat_terbuka,
           coalesce(bool_or(pg.no_pasang is not null and pg.ts_selesai is null
                            and pg.jenis = 'jeda'), false)       as ada_jeda_terbuka
    from sesi_batas sb
    left join potong pg
      on  pg.karyawan_id = sb.karyawan_id
      and pg.ts_mulai   >= sb.ts_masuk
      and pg.ts_mulai   <  coalesce(sb.ts_masuk_berikut, 'infinity'::timestamptz)
    group by sb.karyawan_id, sb.no_sesi
  ),
  hitung as (
    select sb.karyawan_id, sb.no_sesi, sb.ts_masuk, sb.ts_keluar, sb.cabang_id,
           sb.ada_lembur, sb.ada_luar_radius, sb.jml_event,
           ps.istirahat_menit, ps.jeda_menit,
           ps.ada_istirahat_terbuka, ps.ada_jeda_terbuka,
           coalesce(kr.jam_kerja, 9)                                            as jam_kontrak,
           greatest(1, coalesce(kr.jam_kerja, 9) - k.potong_istirahat_kontrak_jam) as jam_net,
           k.zona_waktu, k.jam_mulai_hari, k.ambang_hadir, k.maks_istirahat_dugaan_jam,
           extract(epoch from (coalesce(sb.ts_keluar, now()) - sb.ts_masuk)) / 60.0 as span_menit,
           (extract(epoch from (coalesce(sb.ts_keluar, now()) - sb.ts_masuk)) / 3600.0)
             > k.maks_durasi_sesi_jam                                           as lupa
    from sesi_batas sb
    cross join k
    left join potong_sesi ps on ps.karyawan_id = sb.karyawan_id and ps.no_sesi = sb.no_sesi
    left join v_karyawan_ringkas kr on kr.id = sb.karyawan_id
  ),
  jadi as (
    select h.karyawan_id,
           h.no_sesi,
           hari_absen(h.ts_masuk, h.zona_waktu, h.jam_mulai_hari)  as tanggal_kerja,
           h.cabang_id,
           h.ts_masuk,
           h.ts_keluar,
           case when h.lupa and h.ts_keluar is null
                then h.ts_masuk
                     + make_interval(mins => round(h.jam_net * 60)::integer)
                     + make_interval(mins => round(least(coalesce(h.istirahat_menit, 0)
                                                         + coalesce(h.jeda_menit, 0),
                                                         h.maks_istirahat_dugaan_jam * 60))::integer)
           end                                                     as ts_keluar_dugaan,
           case when h.lupa                     then 'lupa_clock_out'
                when h.ts_keluar is not null    then 'selesai'
                when h.ada_istirahat_terbuka    then 'istirahat'
                when h.ada_jeda_terbuka         then 'jeda'
                else                                 'berjalan'
           end                                                     as status_sesi,
           h.lupa                                                  as lupa_clock_out,
           coalesce(h.ada_lembur, false)                           as ada_lembur,
           coalesce(h.ada_istirahat_terbuka, false)                as ada_istirahat_terbuka,
           coalesce(h.ada_jeda_terbuka, false)                     as ada_jeda_terbuka,
           coalesce(h.ada_luar_radius, false)                      as ada_luar_radius,
           round(coalesce(h.istirahat_menit, 0), 1)                as istirahat_menit,
           round(coalesce(h.jeda_menit, 0), 1)                     as jeda_menit,
           round(h.span_menit, 1)                                  as durasi_kotor_menit,
           round(greatest(0, (h.span_menit
                              - coalesce(h.istirahat_menit, 0)
                              - coalesce(h.jeda_menit, 0)) / 60.0), 2) as jam_efektif_mentah,
           coalesce(h.jeda_menit, 0) / 60.0                        as jeda_jam,
           h.lupa, h.jam_net, h.jam_kontrak, h.ambang_hadir, h.jml_event
    from hitung h
  )
  select j.karyawan_id,
         j.no_sesi,
         j.tanggal_kerja,
         j.cabang_id,
         j.ts_masuk,
         j.ts_keluar,
         j.ts_keluar_dugaan,
         j.status_sesi,
         j.lupa_clock_out,
         j.ada_lembur,
         j.ada_istirahat_terbuka,
         j.ada_jeda_terbuka,
         j.ada_luar_radius,
         j.istirahat_menit,
         j.jeda_menit,
         j.durasi_kotor_menit,
         j.jam_efektif_mentah,
         -- Yang lupa clock out TIDAK dihitung utuh: dibayar sebatas kontrak
         -- bersih dikurangi jeda, sama seperti owner.js. Yang normal tetap
         -- dipagari kontrak bersih.
         case when j.lupa then round(greatest(0, least(j.jam_net, j.jam_kontrak - j.jeda_jam)), 2)
              else round(least(j.jam_efektif_mentah, j.jam_net), 2) end          as jam_efektif,
         case when j.lupa then 0::numeric
              when j.ada_lembur then round(greatest(0, j.jam_efektif_mentah - j.jam_net), 2)
              else 0::numeric end                                                as jam_lembur,
         case when j.lupa                                                  then 'hadir'
              when j.ts_keluar is null                                     then 'berjalan'
              when j.jam_efektif_mentah >= j.jam_kontrak * j.ambang_hadir  then 'hadir'
              when j.jam_efektif_mentah > 0                                then 'parsial'
              else                                                              'singkat'
         end                                                                     as kategori_hari,
         j.jam_kontrak,
         j.jml_event
  from jadi j
  where (p_dari   is null or j.tanggal_kerja >= p_dari)
    and (p_sampai is null or j.tanggal_kerja <= p_sampai)
$fn$;

comment on function absensi.f_sesi_kerja(date, date)
  is 'Merangkai event absen mentah jadi sesi kerja per karyawan. Beri rentang tanggal supaya scan-nya sempit; NULL = semua data.';

create view absensi.v_sesi_kerja with (security_invoker = true) as
  select * from absensi.f_sesi_kerja(null, null);

comment on view absensi.v_sesi_kerja is 'Semua sesi kerja. Buat rentang besar lebih baik panggil f_sesi_kerja(dari, sampai).';

-- ==================================================== 5. REKAP PER HARI
-- Satu baris per karyawan per hari kerja. Kalau satu hari ada beberapa sesi
-- (mis. pulang lalu balik lagi buat lembur), semuanya dijumlah di sini.
create function absensi.f_rekap_harian(p_dari date default null, p_sampai date default null)
returns table (
  karyawan_id           uuid,
  tanggal_kerja         date,
  cabang_id             uuid,
  jml_sesi              integer,
  jam_masuk             timestamptz,
  jam_keluar            timestamptz,
  istirahat_menit       numeric,
  jeda_menit            numeric,
  jam_efektif           numeric,
  jam_lembur            numeric,
  kategori_hari         text,
  ada_lupa_clock_out    boolean,
  ada_istirahat_terbuka boolean,
  ada_luar_radius       boolean,
  status_terakhir       text,
  jam_kontrak           integer
)
language sql stable set search_path = absensi, pg_catalog as $fn$
  select s.karyawan_id,
         s.tanggal_kerja,
         (array_agg(s.cabang_id order by s.ts_masuk))[1]                         as cabang_id,
         count(*)::integer                                                       as jml_sesi,
         min(s.ts_masuk)                                                         as jam_masuk,
         max(coalesce(s.ts_keluar, s.ts_keluar_dugaan))                          as jam_keluar,
         round(sum(s.istirahat_menit), 1)                                        as istirahat_menit,
         round(sum(s.jeda_menit), 1)                                             as jeda_menit,
         round(sum(s.jam_efektif), 2)                                            as jam_efektif,
         round(sum(s.jam_lembur), 2)                                             as jam_lembur,
         case when bool_or(s.lupa_clock_out)                                          then 'hadir'
              when sum(s.jam_efektif_mentah) >= max(s.jam_kontrak) * (select kf.ambang_hadir from rekap_konfig kf where kf.satu_baris)
                                                                                      then 'hadir'
              when bool_or(s.ts_keluar is null)                                       then 'berjalan'
              when sum(s.jam_efektif_mentah) > 0                                      then 'parsial'
              else                                                                         'singkat'
         end                                                                     as kategori_hari,
         bool_or(s.lupa_clock_out)                                               as ada_lupa_clock_out,
         bool_or(s.ada_istirahat_terbuka or s.ada_jeda_terbuka)                  as ada_istirahat_terbuka,
         bool_or(s.ada_luar_radius)                                              as ada_luar_radius,
         (array_agg(s.status_sesi order by s.ts_masuk desc))[1]                  as status_terakhir,
         max(s.jam_kontrak)                                                      as jam_kontrak
  from f_sesi_kerja(p_dari, p_sampai) s
  group by s.karyawan_id, s.tanggal_kerja
$fn$;

comment on function absensi.f_rekap_harian(date, date)
  is 'Rekap per karyawan per hari kerja: jam masuk/keluar, istirahat, jeda, jam efektif, lembur, kategori hari.';

create view absensi.v_rekap_harian with (security_invoker = true) as
  select * from absensi.f_rekap_harian(null, null);

-- ================================================== 6. PAPAN HARIAN
-- Siapa hadir, siapa lagi istirahat, siapa sudah pulang, siapa belum absen —
-- pengganti dashboard "Kehadiran Harian" di owner.html.
--
-- Rekap per cabang TIDAK dibikin view sendiri. cabang_id ada di sini sebagai
-- kolom biasa, jadi tinggal:
--   select cabang_id,
--          count(*) filter (where status = 'berjalan')       as sedang_kerja,
--          count(*) filter (where status = 'istirahat')      as sedang_istirahat,
--          count(*) filter (where status = 'selesai')        as sudah_pulang,
--          count(*) filter (where ada_luar_radius)           as absen_luar_radius
--   from v_status_harian group by cabang_id;
-- Selama data cabang belum masuk, cabang_id NULL dan semua orang jatuh ke
-- satu grup NULL — hitungannya tetap benar.
create function absensi.f_status_harian(p_tanggal date default null)
returns table (
  tanggal_kerja     date,
  karyawan_id       uuid,
  nama              text,
  jabatan           text,
  id_karyawan       text,
  cabang_id         uuid,
  cabang_tetap_id   uuid,
  status            text,
  jam_masuk         timestamptz,
  jam_keluar        timestamptz,
  istirahat_menit   numeric,
  jeda_menit        numeric,
  jam_efektif       numeric,
  jam_lembur        numeric,
  ada_luar_radius   boolean,
  jam_kontrak       integer
)
language sql stable set search_path = absensi, pg_catalog as $fn$
  with hari as (
    select coalesce(p_tanggal, tanggal_kerja_kini()) as d
  ),
  rekap as (
    select r.* from f_rekap_harian((select hari.d from hari), (select hari.d from hari)) r
  )
  select (select hari.d from hari)                          as tanggal_kerja,
         kr.id                                              as karyawan_id,
         kr.nama,
         kr.jabatan,
         kr.id_karyawan,
         coalesce(r.cabang_id, kr.cabang_id)                as cabang_id,
         kr.cabang_id                                       as cabang_tetap_id,
         case
           when r.karyawan_id is not null then
             case when r.ada_lupa_clock_out then 'lupa_clock_out' else r.status_terakhir end
           when kr.libur_hari is not null
                and kr.libur_hari = extract(dow from (select hari.d from hari))::smallint then 'libur'
           else 'belum_absen'
         end                                                as status,
         r.jam_masuk,
         r.jam_keluar,
         r.istirahat_menit,
         r.jeda_menit,
         r.jam_efektif,
         r.jam_lembur,
         coalesce(r.ada_luar_radius, false)                 as ada_luar_radius,
         coalesce(r.jam_kontrak, kr.jam_kerja)              as jam_kontrak
  from v_karyawan_ringkas kr
  left join rekap r on r.karyawan_id = kr.id
  where kr.nonaktif = false or r.karyawan_id is not null
$fn$;

comment on function absensi.f_status_harian(date)
  is 'Papan kehadiran satu hari: tiap karyawan aktif + statusnya (berjalan / istirahat / jeda / selesai / lupa_clock_out / libur / belum_absen).';

create view absensi.v_status_harian with (security_invoker = true) as
  select * from absensi.f_status_harian(null);

comment on view absensi.v_status_harian is 'Papan kehadiran HARI INI (jendela hari kerja dari rekap_konfig). Group by cabang_id kalau mau versi per outlet.';

-- ================================================= 7. REKAP BULAN (PAYROLL)
-- Bahan payroll. Sengaja TIDAK menghitung rupiah — biar rumus upah tetap di
-- satu tempat dan view ini tidak jadi jalur bocor data gaji.
create function absensi.f_rekap_bulanan(p_periode text)
returns table (
  karyawan_id           uuid,
  nama                  text,
  id_karyawan           text,
  cabang_id             uuid,
  periode               text,
  jam_kontrak           integer,
  hari_hadir            integer,
  hari_parsial          integer,
  hari_singkat          integer,
  hari_lupa_clock_out   integer,
  hari_luar_radius      integer,
  total_jam_kerja       numeric,
  total_jam_lembur      numeric,
  total_istirahat_menit numeric,
  total_jeda_menit      numeric,
  tanggal_pertama       date,
  tanggal_terakhir      date
)
language plpgsql stable set search_path = absensi, pg_catalog as $fn$
declare
  v_dari   date;
  v_sampai date;
begin
  select r.dari, r.sampai into v_dari, v_sampai from absensi.rentang_periode(p_periode) r;

  return query
    select r.karyawan_id,
           kr.nama,
           kr.id_karyawan,
           (array_agg(r.cabang_id order by r.tanggal_kerja))[1]                 as cabang_id,
           p_periode                                                            as periode,
           max(r.jam_kontrak)                                                   as jam_kontrak,
           count(*) filter (where r.kategori_hari = 'hadir')::integer           as hari_hadir,
           count(*) filter (where r.kategori_hari = 'parsial')::integer         as hari_parsial,
           count(*) filter (where r.kategori_hari = 'singkat')::integer         as hari_singkat,
           count(*) filter (where r.ada_lupa_clock_out)::integer                as hari_lupa_clock_out,
           count(*) filter (where r.ada_luar_radius)::integer                   as hari_luar_radius,
           round(sum(r.jam_efektif), 2)                                         as total_jam_kerja,
           round(sum(r.jam_lembur), 2)                                          as total_jam_lembur,
           round(sum(r.istirahat_menit), 1)                                     as total_istirahat_menit,
           round(sum(r.jeda_menit), 1)                                          as total_jeda_menit,
           min(r.tanggal_kerja)                                                 as tanggal_pertama,
           max(r.tanggal_kerja)                                                 as tanggal_terakhir
    from f_rekap_harian(v_dari, v_sampai) r
    join v_karyawan_ringkas kr on kr.id = r.karyawan_id
    group by r.karyawan_id, kr.nama, kr.id_karyawan;
end $fn$;

-- ======================================================== 4. HAK AKSES
do $blok$
declare o text;
begin
  foreach o in array array['v_karyawan_ringkas', 'karyawan_publik', 'v_sesi_kerja', 'v_rekap_harian', 'v_status_harian'] loop
    execute format('revoke all on absensi.%I from public, anon, authenticated', o);
    execute format('grant select on absensi.%I to authenticated, service_role', o);
  end loop;
end $blok$;

do $blok$
declare f text;
begin
  foreach f in array array[
    'absensi.hari_absen(timestamptz, text, integer)',
    'absensi.tanggal_kerja_kini()',
    'absensi.rentang_periode(text)',
    'absensi.periode_berjalan(timestamptz)',
    'absensi.f_sesi_kerja(date, date)',
    'absensi.f_rekap_harian(date, date)',
    'absensi.f_status_harian(date)',
    'absensi.f_rekap_bulanan(text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $blok$;
