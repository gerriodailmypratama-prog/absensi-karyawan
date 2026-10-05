-- PR-CL136: istirahat dihitung MINIMAL 60 menit di jam kerja efektif (shift >= 5 jam).
-- Owner, 5 Okt 2026: banyak yang datang telat tapi tetap pulang cepat — telatnya ketutup dengan
-- tap istirahat pendek (data 30 hari: 55% sesi tap < 55 menit, 43% di lokasi < 9 jam).
-- Dulu jam_efektif_mentah = durasi - istirahat YANG DI-TAP - jeda, jadi tap 20 menit cukup di
-- lokasi 8j20m buat 8 jam efektif. Sekarang yang dipotong = GREATEST(istirahat di-tap,
-- potong_istirahat_kontrak_jam * 60) — "telat masuk = telat pulang" tetap jalan, istirahat
-- gak bisa didekin. Owner pilih "pasang sekarang".
--   * berlaku mulai rekap_konfig.istirahat_min_mulai (2026-10-05); hari sebelumnya & periode
--     gaji yang udah tutup buku gak berubah (dipagari di bawah).
--   * cuma sesi dengan durasi >= 5 jam (sama dengan SHIFT_WAJIB_ISTIRAHAT_MS di app; PR-CL105).
--   * istirahat_menit yang tampil tetap angka TAP asli; yang berubah jam_efektif_mentah ->
--     jam_efektif, jam_lembur, kategori_hari.
--   * sesi lupa clock-out tetap pakai rumus lama (jam_net).
-- Simulasi 30 hari sebelum dipasang: 69 dari 160 sesi normal (>= 5 jam, tanpa lembur) kena,
-- rata-rata jam efektif turun 20 menit (maks 58), 12 orang.
set lock_timeout = '5s';
set statement_timeout = '60s';

alter table absensi.rekap_konfig add column if not exists istirahat_min_mulai date;
comment on column absensi.rekap_konfig.istirahat_min_mulai is
  'PR-CL136: mulai tanggal kerja ini, istirahat dipotong minimal potong_istirahat_kontrak_jam (shift >= 5 jam). NULL = mati.';
update absensi.rekap_konfig set istirahat_min_mulai = date '2026-10-05'
 where satu_baris and istirahat_min_mulai is null;

-- jangan nimpa versi orang lain
do $$
begin
  if md5(pg_get_functiondef('absensi.f_sesi_kerja(date,date)'::regprocedure)) <> 'd2cbe6129e27f99f55780f00f9472868'
     and position('PR-CL136' in pg_get_functiondef('absensi.f_sesi_kerja(date,date)'::regprocedure)) = 0 then
    raise exception 'PR-CL136: f_sesi_kerja udah diubah sesi lain — tarik definisi terbaru dulu';
  end if;
end $$;

create temp table _pr136_lama on commit drop as
select * from absensi.f_sesi_kerja(current_date - 45, current_date);

create or replace function absensi.f_sesi_kerja(p_dari date default null::date, p_sampai date default null::date)
 returns table(karyawan_id uuid, no_sesi bigint, tanggal_kerja date, cabang_id uuid, ts_masuk timestamp with time zone, ts_keluar timestamp with time zone, ts_keluar_dugaan timestamp with time zone, status_sesi text, lupa_clock_out boolean, ada_lembur boolean, ada_istirahat_terbuka boolean, ada_jeda_terbuka boolean, ada_luar_radius boolean, istirahat_menit numeric, jeda_menit numeric, durasi_kotor_menit numeric, jam_efektif_mentah numeric, jam_efektif numeric, jam_lembur numeric, kategori_hari text, jam_kontrak integer, jml_event integer)
 language sql
 stable
 set search_path to 'absensi', 'pg_catalog'
as $function$
  -- PR-CL136: istirahat dipotong minimal potong_istirahat_kontrak_jam (shift >= 5 jam,
  -- tanggal kerja >= rekap_konfig.istirahat_min_mulai). Lihat 0021_istirahat_min_60.sql.
  with k as (
    select kf.zona_waktu, kf.jam_mulai_hari, kf.maks_durasi_sesi_jam,
           kf.ambang_hadir, kf.potong_istirahat_kontrak_jam, kf.maks_istirahat_dugaan_jam,
           kf.istirahat_min_mulai
    from rekap_konfig kf where kf.satu_baris
  ),
  ev as (
    select a.id, a.karyawan_id, a.cabang_id, a.tipe, a.ts, a.in_radius
    from absensi a
    where (p_dari is null
           or a.ts >= (((p_dari - 2)::timestamp) at time zone (select kk.zona_waktu from k kk)))
      and (p_sampai is null
           or a.ts <  (((p_sampai + 3)::timestamp) at time zone (select kk.zona_waktu from k kk)))
  ),
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
                      coalesce(u.arah_sebelum, 'keluar') = 'keluar'
                      or hari_absen(u.ts_sebelum, k.zona_waktu, k.jam_mulai_hari)
                         is distinct from
                         hari_absen(u.ts, k.zona_waktu, k.jam_mulai_hari)
                     )
                then 1 else 0 end as buka
    from urut u
    cross join k
  ),
  nomor as (
    select t.id, t.karyawan_id, t.cabang_id, t.tipe, t.ts, t.in_radius, t.arah,
           sum(t.buka) over (partition by t.karyawan_id order by t.ts, t.id
                             rows between unbounded preceding and current row) as no_sesi
    from tandai t
  ),
  blok as (
    select n.karyawan_id,
           n.no_sesi,
           min(n.ts) as ts_masuk,
           coalesce(
             min(n.ts) filter (where n.tipe = 'clock_out'),
             max(n.ts) filter (where n.tipe = 'overtime_out')
           ) as ts_keluar,
           (array_agg(n.cabang_id order by n.ts, n.id))[1] as cabang_id,
           bool_or(n.tipe = 'overtime_out') as ada_lembur,
           bool_or(n.in_radius is false) as ada_luar_radius,
           count(*)::integer as jml_event
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
  sesi_batas as (
    select s.*,
           coalesce(s.ts_keluar, least(coalesce(s.ts_masuk_berikut, 'infinity'::timestamptz), now())) as ts_akhir
    from sesi s
  ),
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
           min(pn.ts) as ts_mulai,
           max(pn.ts) filter (where pn.arah = 'selesai') as ts_selesai
    from potong_nomor pn
    where pn.no_pasang > 0
    group by pn.karyawan_id, pn.jenis, pn.no_pasang
  ),
  potong_sesi as (
    select sb.karyawan_id, sb.no_sesi,
           coalesce(sum(
             case when pg.ts_selesai is null or pg.jenis <> 'istirahat' then 0
                  else greatest(0, extract(epoch from (
                         least(pg.ts_selesai, sb.ts_akhir) - greatest(pg.ts_mulai, sb.ts_masuk)
                       )) / 60.0)
             end
           ), 0) as istirahat_menit,
           coalesce(sum(
             case when pg.ts_selesai is null or pg.jenis <> 'jeda' then 0
                  else greatest(0, extract(epoch from (
                         least(pg.ts_selesai, sb.ts_akhir) - greatest(pg.ts_mulai, sb.ts_masuk)
                       )) / 60.0)
             end
           ), 0) as jeda_menit,
           coalesce(bool_or(pg.no_pasang is not null and pg.ts_selesai is null
                            and pg.jenis = 'istirahat'), false) as ada_istirahat_terbuka,
           coalesce(bool_or(pg.no_pasang is not null and pg.ts_selesai is null
                            and pg.jenis = 'jeda'), false) as ada_jeda_terbuka
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
           coalesce(kr.jam_kerja, 9) as jam_kontrak,
           greatest(1, coalesce(kr.jam_kerja, 9) - k.potong_istirahat_kontrak_jam) as jam_net,
           k.zona_waktu, k.jam_mulai_hari, k.ambang_hadir, k.maks_istirahat_dugaan_jam,
           k.potong_istirahat_kontrak_jam, k.istirahat_min_mulai,
           extract(epoch from (coalesce(sb.ts_keluar, now()) - sb.ts_masuk)) / 60.0 as span_menit,
           (extract(epoch from (coalesce(sb.ts_keluar, now()) - sb.ts_masuk)) / 3600.0)
             > k.maks_durasi_sesi_jam as lupa
    from sesi_batas sb
    cross join k
    left join potong_sesi ps on ps.karyawan_id = sb.karyawan_id and ps.no_sesi = sb.no_sesi
    left join v_karyawan_ringkas kr on kr.id = sb.karyawan_id
  ),
  hitung2 as (
    -- PR-CL136: istirahat yang DIPOTONG (beda dengan istirahat_menit yang di-tap)
    select h.*,
           case when h.istirahat_min_mulai is not null
                 and hari_absen(h.ts_masuk, h.zona_waktu, h.jam_mulai_hari) >= h.istirahat_min_mulai
                 and h.span_menit >= 300
                then greatest(coalesce(h.istirahat_menit, 0), h.potong_istirahat_kontrak_jam * 60)
                else coalesce(h.istirahat_menit, 0)
           end as istirahat_potong_menit
    from hitung h
  ),
  jadi as (
    select h.karyawan_id,
           h.no_sesi,
           hari_absen(h.ts_masuk, h.zona_waktu, h.jam_mulai_hari) as tanggal_kerja,
           h.cabang_id,
           h.ts_masuk,
           h.ts_keluar,
           case when h.lupa and h.ts_keluar is null
                then h.ts_masuk
                     + make_interval(mins => round(h.jam_net * 60)::integer)
                     + make_interval(mins => round(least(coalesce(h.istirahat_menit, 0)
                                                         + coalesce(h.jeda_menit, 0),
                                                         h.maks_istirahat_dugaan_jam * 60))::integer)
           end as ts_keluar_dugaan,
           case when h.lupa                     then 'lupa_clock_out'
                when h.ts_keluar is not null    then 'selesai'
                when h.ada_istirahat_terbuka    then 'istirahat'
                when h.ada_jeda_terbuka         then 'jeda'
                else                                 'berjalan'
           end as status_sesi,
           h.lupa as lupa_clock_out,
           coalesce(h.ada_lembur, false) as ada_lembur,
           coalesce(h.ada_istirahat_terbuka, false) as ada_istirahat_terbuka,
           coalesce(h.ada_jeda_terbuka, false) as ada_jeda_terbuka,
           coalesce(h.ada_luar_radius, false) as ada_luar_radius,
           round(coalesce(h.istirahat_menit, 0), 1) as istirahat_menit,
           round(coalesce(h.jeda_menit, 0), 1) as jeda_menit,
           round(h.span_menit, 1) as durasi_kotor_menit,
           round(greatest(0, (h.span_menit
                              - h.istirahat_potong_menit
                              - coalesce(h.jeda_menit, 0)) / 60.0), 2) as jam_efektif_mentah,
           coalesce(h.jeda_menit, 0) / 60.0 as jeda_jam,
           h.lupa, h.jam_net, h.jam_kontrak, h.ambang_hadir, h.jml_event
    from hitung2 h
  )
  select j.karyawan_id, j.no_sesi, j.tanggal_kerja, j.cabang_id, j.ts_masuk, j.ts_keluar,
         j.ts_keluar_dugaan, j.status_sesi, j.lupa_clock_out, j.ada_lembur,
         j.ada_istirahat_terbuka, j.ada_jeda_terbuka, j.ada_luar_radius,
         j.istirahat_menit, j.jeda_menit, j.durasi_kotor_menit, j.jam_efektif_mentah,
         case when j.lupa then round(greatest(0, least(j.jam_net, j.jam_kontrak - j.jeda_jam)), 2)
              else round(least(j.jam_efektif_mentah, j.jam_net), 2) end as jam_efektif,
         case when j.lupa then 0::numeric
              when j.ada_lembur then round(greatest(0, j.jam_efektif_mentah - j.jam_net), 2)
              else 0::numeric end as jam_lembur,
         case when j.lupa                                                  then 'hadir'
              when j.ts_keluar is null                                     then 'berjalan'
              when j.jam_efektif_mentah >= j.jam_kontrak * j.ambang_hadir  then 'hadir'
              when j.jam_efektif_mentah > 0                                then 'parsial'
              else                                                              'singkat'
         end as kategori_hari,
         j.jam_kontrak,
         j.jml_event
  from jadi j
  where (p_dari   is null or j.tanggal_kerja >= p_dari)
    and (p_sampai is null or j.tanggal_kerja <= p_sampai)
$function$;

-- pagar: sebelum istirahat_min_mulai SAMA PERSIS; sejak itu jam efektif cuma boleh turun
do $$
declare v_mulai date := (select istirahat_min_mulai from absensi.rekap_konfig where satu_baris);
        n_lama_beda int; n_naik int; n_turun int;
begin
  select count(*) into n_lama_beda
    from _pr136_lama l
    join absensi.f_sesi_kerja(current_date - 45, current_date) b
      on b.karyawan_id = l.karyawan_id and b.no_sesi = l.no_sesi
   where l.tanggal_kerja < v_mulai
     and (b.jam_efektif, b.jam_lembur, b.kategori_hari, b.istirahat_menit, b.jam_efektif_mentah)
         is distinct from (l.jam_efektif, l.jam_lembur, l.kategori_hari, l.istirahat_menit, l.jam_efektif_mentah);
  if n_lama_beda > 0 then
    raise exception 'PR-CL136: % sesi sebelum % berubah — batal', n_lama_beda, v_mulai;
  end if;
  select count(*) filter (where b.jam_efektif_mentah > l.jam_efektif_mentah + 0.02),
         count(*) filter (where b.jam_efektif_mentah < l.jam_efektif_mentah - 0.02)
    into n_naik, n_turun
    from _pr136_lama l
    join absensi.f_sesi_kerja(current_date - 45, current_date) b
      on b.karyawan_id = l.karyawan_id and b.no_sesi = l.no_sesi
   where l.tanggal_kerja >= v_mulai and l.ts_keluar is not null;
  if n_naik > 0 then
    raise exception 'PR-CL136: % sesi jam efektifnya NAIK — batal', n_naik;
  end if;
  raise notice 'PR-CL136: sesi selesai sejak % yang jam efektifnya turun: %', v_mulai, n_turun;
end $$;
