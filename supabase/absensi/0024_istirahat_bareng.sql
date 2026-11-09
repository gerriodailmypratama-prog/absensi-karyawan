-- PR-CL141: Istirahat Bareng — Lead mulai istirahat 60 menit buat satu divisi sekaligus.
-- Owner, 9 Nov 2026 ("gas"): istirahat tim sering kepencar (Fulfillment pagi ~12:07, siang
-- ~19:00-19:40), jadi lantai kosong-isi-kosong dan susah dicek siapa udah / belum istirahat.
--
--   * Lead / SPV / owner (absensi.lembur_boleh_acc) buka kartu "Istirahat Bareng", centang
--     orang divisinya yang lagi masuk, tap Mulai -> RPC istirahat_bareng_mulai() nulis
--     break_in buat semua di JAM SERVER YANG SAMA (flag 'istirahat_bareng', ekstra.bareng_id).
--     Lead cuma divisinya sendiri (divisi dari WMS, sama kayak ACC lembur PR-CL129); owner
--     milih divisi.
--   * Selesai: pg_cron tiap menit nulis break_out (otomatis=true) tepat di mulai+menit buat
--     peserta yang masih istirahat. Lead bisa nyelesain lebih cepat buat semua
--     (istirahat_bareng_selesai). Orang yang balik duluan tap Selesai Istirahat sendiri kayak
--     biasa (bayar tetap dipotong minimal 60 menit, aturan PR-CL136, gak berubah).
--   * Istirahat sendiri SESUDAH divisinya istirahat bareng di shift itu = 'susulan': app minta
--     kode admin (atau darurat), baris break_in-nya dapat flag 'susulan' + kode_verif. DB gak
--     ngeblok (owner minta jangan dikunci keras), cuma ditandai biar keliatan.
--   * View absensi.v_istirahat_harian buat WMS "Poin Disiplin" (aturan istirahat_tidak_bareng).
--
-- Additive: 1 tabel baru (RLS on, baca terbatas, tulis cuma lewat RPC), fungsi baru, 1 view,
-- 1 job pg_cron. Tidak ada kolom / policy / trigger lama yang diubah. Kolom absensi.flag
-- memang teks bebas (tanpa CHECK), jadi nilai baru 'istirahat_bareng' / 'susulan' gak perlu
-- ngubah constraint. Telegram lewat wms.bot_enqueue (channel 'absen'); gagal = diem.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- ------------------------------------------------------------------ tabel
create table if not exists absensi.istirahat_bareng (
  id                 uuid primary key default gen_random_uuid(),
  divisi             text not null,
  dimulai_oleh       uuid references absensi.karyawan(id),
  mulai_at           timestamptz not null default now(),
  menit              integer not null default 60,
  selesai_rencana_at timestamptz not null,
  selesai_at         timestamptz,              -- diisi job (otomatis) atau Lead (selesai lebih cepat)
  selesai_oleh       uuid references absensi.karyawan(id),   -- null + selesai_at terisi = otomatis
  peserta            uuid[] not null default '{}',
  dilewati           jsonb not null default '[]'::jsonb,     -- [{karyawan_id, nama, hasil}]
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'istirahat_bareng_menit_cek') then
    alter table absensi.istirahat_bareng add constraint istirahat_bareng_menit_cek check (menit between 15 and 120);
  end if;
end $$;
create index if not exists istirahat_bareng_divisi_mulai_idx on absensi.istirahat_bareng (divisi, mulai_at desc);
create index if not exists istirahat_bareng_terbuka_idx on absensi.istirahat_bareng (selesai_rencana_at) where selesai_at is null;
comment on table absensi.istirahat_bareng is
  'PR-CL141: satu baris per Istirahat Bareng yang dimulai Lead/SPV/owner. break_in/break_out peserta ada di absensi.absensi (flag istirahat_bareng, ekstra.bareng_id).';

drop trigger if exists trg_istirahat_bareng_updated_at on absensi.istirahat_bareng;
create trigger trg_istirahat_bareng_updated_at before update on absensi.istirahat_bareng
  for each row execute function absensi.set_updated_at();

alter table absensi.istirahat_bareng enable row level security;
drop policy if exists istirahat_bareng_baca on absensi.istirahat_bareng;
create policy istirahat_bareng_baca on absensi.istirahat_bareng for select to authenticated
  using (absensi.is_spv() or dimulai_oleh = absensi.karyawan_saya() or absensi.karyawan_saya() = any (peserta));
revoke all on absensi.istirahat_bareng from anon, public;
grant select on absensi.istirahat_bareng to authenticated;
grant all on absensi.istirahat_bareng to service_role;

-- ------------------------------------------------------------------ helper
-- Boleh mulai / nyelesain Istirahat Bareng divisi p_divisi? Owner: semua. Lead/SPV: divisinya sendiri.
create or replace function absensi.istirahat_bareng_boleh(p_saya uuid, p_divisi text)
returns boolean language sql stable security definer set search_path = absensi, pg_catalog as $$
  select coalesce(
    p_saya is not null and p_divisi is not null
    and absensi.lembur_boleh_acc(p_saya)
    and (coalesce((select k.peran = 'owner' from absensi.karyawan k where k.id = p_saya), false)
         or absensi.lembur_divisi(p_saya) = p_divisi), false)
$$;

-- Kenapa orang ini GAK bisa ikut Istirahat Bareng sekarang? null = bisa.
create or replace function absensi.istirahat_bareng_alasan_skip(p_karyawan uuid, p_ci_ts timestamptz)
returns text language sql stable security definer set search_path = absensi, pg_catalog as $$
  select case
    when p_ci_ts is null then 'belum masuk / sudah pulang'
    when exists (select 1 from absensi.absensi a where a.karyawan_id = p_karyawan and a.tipe = 'break_in' and a.ts >= p_ci_ts)
      then 'udah istirahat shift ini'
    when (select a.tipe from absensi.absensi a
           where a.karyawan_id = p_karyawan and a.tipe in ('pause_in', 'pause_out') and a.ts >= p_ci_ts
           order by a.ts desc, a.id desc limit 1) = 'pause_in'
      then 'lagi pause'
    else null end
$$;

-- Tutup Istirahat Bareng yang waktunya udah habis: break_out (otomatis) TEPAT di jam rencana
-- buat peserta yang masih istirahat & belum pulang. Dipanggil pg_cron tiap menit (+ di awal RPC).
create or replace function absensi.istirahat_bareng_tutup_otomatis()
returns integer language plpgsql security definer set search_path = absensi, pg_catalog as $$
declare
  r     record;
  v_k   uuid;
  v_n   integer := 0;
begin
  for r in select * from absensi.istirahat_bareng
            where selesai_at is null and selesai_rencana_at <= now()
            order by selesai_rencana_at for update skip locked loop
    foreach v_k in array r.peserta loop
      -- masih istirahat = event break terakhir sejak mulai adalah break_in bareng ini, dan belum pulang
      if (select a.tipe from absensi.absensi a
           where a.karyawan_id = v_k and a.tipe in ('break_in', 'break_out') and a.ts >= r.mulai_at
           order by a.ts desc, a.id desc limit 1) = 'break_in'
         and not exists (select 1 from absensi.absensi a
                          where a.karyawan_id = v_k and a.tipe in ('clock_out', 'overtime_out') and a.ts >= r.mulai_at) then
        insert into absensi.absensi (karyawan_id, cabang_id, tipe, ts, otomatis, flag, catatan, ekstra)
        select k.id, k.cabang_id, 'break_out', r.selesai_rencana_at, true, 'istirahat_bareng',
               'Istirahat Bareng selesai otomatis', jsonb_build_object('bareng_id', r.id)
          from absensi.karyawan k where k.id = v_k;
        v_n := v_n + 1;
      end if;
    end loop;
    update absensi.istirahat_bareng set selesai_at = r.selesai_rencana_at where id = r.id;
  end loop;
  return v_n;
end $$;

-- ------------------------------------------------------------------ RPC Lead
create or replace function absensi.istirahat_bareng_kandidat(p_divisi text default null)
returns jsonb language plpgsql stable security definer set search_path = absensi, pg_catalog as $$
declare
  v_saya  uuid := absensi.karyawan_saya();
  v_owner boolean;
  v_div   text;
  v_jalan jsonb;
begin
  if v_saya is null or not coalesce(absensi.lembur_boleh_acc(v_saya), false) then
    raise exception 'Hanya Lead, SPV, atau owner.';
  end if;
  select coalesce(k.peran = 'owner', false) into v_owner from absensi.karyawan k where k.id = v_saya;
  v_owner := coalesce(v_owner, false);
  v_div := case when v_owner then nullif(btrim(coalesce(p_divisi, '')), '') else absensi.lembur_divisi(v_saya) end;

  select jsonb_build_object('id', b.id, 'mulai_at', b.mulai_at, 'selesai_rencana_at', b.selesai_rencana_at,
           'menit', b.menit, 'oleh', o.nama,
           'peserta', coalesce((select jsonb_agg(jsonb_build_object('karyawan_id', k.id, 'nama', k.nama,
                         'masih', (select a.tipe from absensi.absensi a
                                    where a.karyawan_id = k.id and a.tipe in ('break_in', 'break_out') and a.ts >= b.mulai_at
                                    order by a.ts desc, a.id desc limit 1) = 'break_in') order by k.nama)
                       from absensi.karyawan k where k.id = any (b.peserta)), '[]'::jsonb))
    into v_jalan
    from absensi.istirahat_bareng b left join absensi.karyawan o on o.id = b.dimulai_oleh
   where b.divisi = v_div and b.selesai_at is null and b.selesai_rencana_at > now()
   order by b.mulai_at desc limit 1;

  return jsonb_build_object(
    'owner', v_owner,
    'divisi', v_div,
    'divisi_list', case when v_owner then
        coalesce((select jsonb_agg(d order by d) from (
                    select distinct absensi.lembur_divisi(k.id) d from absensi.karyawan k
                     where not k.nonaktif and k.peran <> 'owner' and not absensi.lembur_is_pa(k.id)
                       and not coalesce(k.ekstra ? 'dihapus_owner_at' or k.ekstra ? 'yatim_firebase', false)) x
                   where d is not null), '[]'::jsonb)
      else '[]'::jsonb end,
    'berjalan', v_jalan,
    'riwayat', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'mulai_at', b.mulai_at, 'selesai_at', b.selesai_at,
                           'menit', b.menit, 'oleh', o.nama, 'jumlah', cardinality(b.peserta)) order by b.mulai_at desc)
                         from absensi.istirahat_bareng b left join absensi.karyawan o on o.id = b.dimulai_oleh
                        where b.divisi = v_div and b.mulai_at > now() - interval '20 hours'), '[]'::jsonb),
    'kandidat', case when v_div is null then '[]'::jsonb else
        coalesce((select jsonb_agg(jsonb_build_object('karyawan_id', t.id, 'nama', t.nama, 'ci_ts', t.ci_ts,
                           'saya', t.id = v_saya, 'alasan', t.alasan) order by (t.alasan is null) desc, t.ci_ts)
                    from (select k.id, k.nama, s.ci_ts, absensi.istirahat_bareng_alasan_skip(k.id, s.ci_ts) alasan
                            from absensi.karyawan k
                            cross join lateral absensi.lembur_sesi_terbuka(k.id) s
                           where not k.nonaktif and k.peran <> 'owner' and not absensi.lembur_is_pa(k.id)
                             and s.ci_id is not null
                             and absensi.lembur_divisi(k.id) = v_div) t), '[]'::jsonb) end);
end $$;

create or replace function absensi.istirahat_bareng_mulai(p_karyawan uuid[], p_menit integer default 60, p_divisi text default null)
returns jsonb language plpgsql security definer set search_path = absensi, pg_catalog as $$
declare
  v_saya   uuid := absensi.karyawan_saya();
  v_owner  boolean;
  v_nama_s text;
  v_div    text;
  v_menit  integer := coalesce(p_menit, 60);
  v_now    timestamptz := now();
  v_sampai timestamptz;
  v_id     uuid := gen_random_uuid();
  v_k      uuid;
  v_kar    record;
  v_ci     timestamptz;
  v_hasil  text;
  v_ok     uuid[] := '{}';
  v_out    jsonb := '[]'::jsonb;
  v_skip   jsonb := '[]'::jsonb;
  v_teks   text;
begin
  if v_saya is null or not coalesce(absensi.lembur_boleh_acc(v_saya), false) then
    raise exception 'Hanya Lead, SPV, atau owner yang bisa mulai Istirahat Bareng.';
  end if;
  if v_menit < 15 or v_menit > 120 then raise exception 'Lama istirahat harus 15-120 menit.'; end if;
  select coalesce(k.peran = 'owner', false), k.nama into v_owner, v_nama_s from absensi.karyawan k where k.id = v_saya;
  v_owner := coalesce(v_owner, false);
  if v_owner then
    v_div := nullif(btrim(coalesce(p_divisi, '')), '');
    if v_div is null then raise exception 'Pilih divisinya dulu.'; end if;
  else
    v_div := absensi.lembur_divisi(v_saya);
    if v_div is null then raise exception 'Divisi kamu belum diisi di WMS. Minta owner isi dulu.'; end if;
    if nullif(btrim(coalesce(p_divisi, '')), '') is not null and btrim(p_divisi) <> v_div then
      raise exception 'Beda divisi: kamu cuma bisa mulai Istirahat Bareng divisi %.', v_div;
    end if;
  end if;
  if not absensi.istirahat_bareng_boleh(v_saya, v_div) then
    raise exception 'Kamu gak pegang divisi ini.';
  end if;

  -- satu divisi satu Istirahat Bareng dalam satu waktu (dua Lead pencet barengan = yang kedua ditolak)
  perform pg_advisory_xact_lock(hashtext('absensi.istirahat_bareng:' || v_div));
  perform absensi.istirahat_bareng_tutup_otomatis();
  if exists (select 1 from absensi.istirahat_bareng b where b.divisi = v_div and b.selesai_at is null) then
    raise exception 'Divisi % masih ada Istirahat Bareng yang jalan.', v_div;
  end if;
  v_sampai := v_now + make_interval(mins => v_menit);

  foreach v_k in array (select coalesce(array_agg(distinct x), '{}') from unnest(coalesce(p_karyawan, '{}'::uuid[])) x) loop
    select k.id, k.nama, k.peran, k.cabang_id, k.nonaktif into v_kar from absensi.karyawan k where k.id = v_k;
    v_ci := null; v_hasil := null;
    if v_kar.id is null or v_kar.nonaktif then v_hasil := 'karyawan tidak ditemukan';
    elsif v_kar.peran = 'owner' then v_hasil := 'owner gak ikut';
    elsif absensi.lembur_is_pa(v_k) then v_hasil := 'PA gak punya istirahat';
    elsif absensi.lembur_divisi(v_k) is distinct from v_div then v_hasil := 'beda divisi';
    else
      select s.ci_ts into v_ci from absensi.lembur_sesi_terbuka(v_k) s;
      v_hasil := absensi.istirahat_bareng_alasan_skip(v_k, v_ci);
    end if;
    if v_hasil is null then
      v_ok := v_ok || v_k;
      v_out := v_out || jsonb_build_array(jsonb_build_object('karyawan_id', v_k, 'nama', v_kar.nama, 'hasil', 'ok'));
    else
      v_skip := v_skip || jsonb_build_array(jsonb_build_object('karyawan_id', v_k, 'nama', v_kar.nama, 'hasil', v_hasil));
    end if;
  end loop;

  if cardinality(v_ok) = 0 then
    return jsonb_build_object('id', null, 'divisi', v_div, 'mulai_at', null, 'selesai_rencana_at', null,
                              'menit', v_menit, 'hasil', v_skip);
  end if;

  insert into absensi.istirahat_bareng (id, divisi, dimulai_oleh, mulai_at, menit, selesai_rencana_at, peserta, dilewati)
  values (v_id, v_div, v_saya, v_now, v_menit, v_sampai, v_ok, v_skip);

  insert into absensi.absensi (karyawan_id, cabang_id, tipe, ts, otomatis, flag, dibuat_oleh, catatan, ekstra)
  select k.id, k.cabang_id, 'break_in', v_now, true, 'istirahat_bareng', v_saya, 'Istirahat Bareng',
         jsonb_build_object('bareng_id', v_id, 'bareng_sampai', v_sampai, 'bareng_oleh', v_nama_s)
    from absensi.karyawan k where k.id = any (v_ok);

  -- Satu ringkasan ke grup Telegram absen. Gagal kirim gak boleh gagalin istirahatnya.
  begin
    select '🍽️ Istirahat Bareng — ' || v_div || E'\n'
           || 'Mulai ' || to_char(v_now at time zone 'Asia/Jakarta', 'HH24:MI') || ' s/d '
           || to_char(v_sampai at time zone 'Asia/Jakarta', 'HH24:MI') || ' WIB (' || v_menit || ' menit) · oleh ' || coalesce(v_nama_s, '-') || E'\n'
           || 'Ikut (' || cardinality(v_ok) || '): ' || coalesce((select string_agg(k.nama, ', ' order by k.nama) from absensi.karyawan k where k.id = any (v_ok)), '-')
           || case when jsonb_array_length(v_skip) > 0
                   then E'\nGak ikut: ' || (select string_agg((e ->> 'nama') || ' (' || (e ->> 'hasil') || ')', ', ') from jsonb_array_elements(v_skip) e)
                   else '' end
      into v_teks;
    perform wms.bot_enqueue('absen', v_teks, 'absensi_istirahat_bareng:' || v_id::text);
  exception when others then
    raise warning 'istirahat_bareng telegram gagal: %', sqlerrm;
  end;

  return jsonb_build_object('id', v_id, 'divisi', v_div, 'mulai_at', v_now, 'selesai_rencana_at', v_sampai,
                            'menit', v_menit, 'hasil', v_out || v_skip);
end $$;

create or replace function absensi.istirahat_bareng_selesai(p_id uuid)
returns jsonb language plpgsql security definer set search_path = absensi, pg_catalog as $$
declare
  v_saya uuid := absensi.karyawan_saya();
  v_b    absensi.istirahat_bareng%rowtype;
  v_now  timestamptz := now();
  v_k    uuid;
  v_n    integer := 0;
begin
  select * into v_b from absensi.istirahat_bareng where id = p_id for update;
  if not found then raise exception 'Istirahat Bareng tidak ditemukan.'; end if;
  if not absensi.istirahat_bareng_boleh(v_saya, v_b.divisi) then
    raise exception 'Hanya Lead / SPV divisi % atau owner yang bisa nyelesain.', v_b.divisi;
  end if;
  if v_b.selesai_at is not null then raise exception 'Istirahat Bareng ini udah selesai.'; end if;
  if v_b.selesai_rencana_at <= v_now then
    perform absensi.istirahat_bareng_tutup_otomatis();
    return jsonb_build_object('id', p_id, 'ditutup', null, 'otomatis', true);
  end if;
  foreach v_k in array v_b.peserta loop
    if (select a.tipe from absensi.absensi a
         where a.karyawan_id = v_k and a.tipe in ('break_in', 'break_out') and a.ts >= v_b.mulai_at
         order by a.ts desc, a.id desc limit 1) = 'break_in'
       and not exists (select 1 from absensi.absensi a
                        where a.karyawan_id = v_k and a.tipe in ('clock_out', 'overtime_out') and a.ts >= v_b.mulai_at) then
      insert into absensi.absensi (karyawan_id, cabang_id, tipe, ts, otomatis, flag, dibuat_oleh, catatan, ekstra)
      select k.id, k.cabang_id, 'break_out', v_now, true, 'istirahat_bareng', v_saya,
             'Istirahat Bareng diselesaikan Lead', jsonb_build_object('bareng_id', p_id)
        from absensi.karyawan k where k.id = v_k;
      v_n := v_n + 1;
    end if;
  end loop;
  update absensi.istirahat_bareng set selesai_at = v_now, selesai_oleh = v_saya where id = p_id;
  return jsonb_build_object('id', p_id, 'ditutup', v_n, 'otomatis', false);
end $$;

-- ------------------------------------------------------------------ RPC karyawan
-- Status Istirahat Bareng buat HP karyawan: lagi ikut? dan kalau tap Istirahat sendiri,
-- wajib kode (susulan) gak? Susulan = divisinya udah / lagi Istirahat Bareng di shift ini.
create or replace function absensi.istirahat_bareng_saya()
returns jsonb language plpgsql stable security definer set search_path = absensi, pg_catalog as $$
declare
  v_saya uuid := absensi.karyawan_saya();
  v_div  text;
  v_ci   timestamptz;
  v_b    record;
  v_aktif jsonb;
begin
  if v_saya is null then return jsonb_build_object('susulan', false); end if;
  select s.ci_ts into v_ci from absensi.lembur_sesi_terbuka(v_saya) s;
  if v_ci is null or absensi.lembur_is_pa(v_saya) then return jsonb_build_object('susulan', false); end if;
  v_div := absensi.lembur_divisi(v_saya);

  select b.id, b.mulai_at, b.selesai_rencana_at, b.menit, o.nama oleh into v_b
    from absensi.istirahat_bareng b left join absensi.karyawan o on o.id = b.dimulai_oleh
   where v_saya = any (b.peserta) and b.selesai_at is null and b.mulai_at >= v_ci
   order by b.mulai_at desc limit 1;
  if v_b.id is not null then
    v_aktif := jsonb_build_object('id', v_b.id, 'mulai_at', v_b.mulai_at, 'selesai_rencana_at', v_b.selesai_rencana_at,
                                  'menit', v_b.menit, 'oleh', v_b.oleh);
  end if;

  select b.id, b.mulai_at, o.nama oleh into v_b
    from absensi.istirahat_bareng b left join absensi.karyawan o on o.id = b.dimulai_oleh
   where v_div is not null and b.divisi = v_div and b.mulai_at >= v_ci
   order by b.mulai_at desc limit 1;

  return jsonb_build_object('divisi', v_div, 'aktif', v_aktif,
                            'susulan', v_b.id is not null,
                            'bareng_id', v_b.id, 'bareng_mulai_at', v_b.mulai_at, 'bareng_oleh', v_b.oleh);
end $$;

-- Owner / SPV: Istirahat Bareng + istirahat susulan beberapa hari terakhir.
create or replace function absensi.istirahat_bareng_hari_ini(p_jam integer default 20)
returns jsonb language plpgsql stable security definer set search_path = absensi, pg_catalog as $$
declare v_dari timestamptz := now() - make_interval(hours => greatest(1, least(coalesce(p_jam, 20), 24 * 14)));
begin
  if not absensi.is_spv() then raise exception 'Hanya SPV atau owner.'; end if;
  return jsonb_build_object(
    'bareng', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'divisi', b.divisi, 'mulai_at', b.mulai_at,
                 'selesai_rencana_at', b.selesai_rencana_at, 'selesai_at', b.selesai_at, 'menit', b.menit,
                 'oleh', o.nama, 'selesai_oleh', so.nama,
                 'peserta', (select coalesce(jsonb_agg(k.nama order by k.nama), '[]'::jsonb) from absensi.karyawan k where k.id = any (b.peserta)),
                 'dilewati', b.dilewati) order by b.mulai_at desc)
               from absensi.istirahat_bareng b
               left join absensi.karyawan o on o.id = b.dimulai_oleh
               left join absensi.karyawan so on so.id = b.selesai_oleh
              where b.mulai_at >= v_dari), '[]'::jsonb),
    'susulan', coalesce((select jsonb_agg(jsonb_build_object('karyawan_id', a.karyawan_id, 'nama', k.nama, 'ts', a.ts,
                 'kode_verif', a.kode_verif) order by a.ts desc)
               from absensi.absensi a join absensi.karyawan k on k.id = a.karyawan_id
              where a.tipe = 'break_in' and a.flag = 'susulan' and a.ts >= v_dari), '[]'::jsonb));
end $$;

-- ------------------------------------------------------------------ view buat WMS
-- Satu baris per orang per tanggal kerja (hari mulai 04.00 WIB, sama dengan f_sesi_kerja)
-- yang punya istirahat. bareng = ikut Istirahat Bareng; susulan = istirahat sendiri sesudah
-- divisinya Istirahat Bareng; menit = total menit istirahat di-tap (yang belum ditutup dihitung s/d sekarang).
create or replace view absensi.v_istirahat_harian with (security_invoker = true) as
with k as (select kf.zona_waktu, kf.jam_mulai_hari from absensi.rekap_konfig kf where kf.satu_baris),
br as (
  select b.karyawan_id, b.ts, b.flag, b.kode_verif,
         (select min(o.ts) from absensi.absensi o
           where o.karyawan_id = b.karyawan_id and o.tipe in ('break_out', 'clock_out', 'overtime_out')
             and o.ts >= b.ts and o.ts < b.ts + interval '20 hours') as ts_selesai,
         (select max(c.ts) from absensi.absensi c
           where c.karyawan_id = b.karyawan_id and c.tipe = 'clock_in'
             and c.ts <= b.ts and c.ts > b.ts - interval '20 hours') as ts_masuk
    from absensi.absensi b
   where b.tipe = 'break_in'
)
select br.karyawan_id,
       absensi.hari_absen(coalesce(br.ts_masuk, br.ts), (select zona_waktu from k), (select jam_mulai_hari from k)) as tanggal,
       bool_or(br.flag = 'istirahat_bareng') as bareng,
       bool_or(br.flag = 'susulan') as susulan,
       bool_or(br.flag = 'susulan' and br.kode_verif = 'darurat') as susulan_darurat,
       count(*)::integer as jumlah,
       round(sum(greatest(0, extract(epoch from (coalesce(br.ts_selesai, least(now(), br.ts + interval '20 hours')) - br.ts)) / 60.0)))::integer as menit
  from br
 group by 1, 2;
comment on view absensi.v_istirahat_harian is
  'PR-CL141: per karyawan per tanggal kerja — bareng (ikut Istirahat Bareng), susulan (istirahat sendiri sesudah divisinya Istirahat Bareng), susulan_darurat (tanpa kode admin), jumlah tap, menit istirahat. Dibaca WMS Poin Disiplin (aturan istirahat_tidak_bareng).';
revoke all on absensi.v_istirahat_harian from anon, public;
grant select on absensi.v_istirahat_harian to authenticated, service_role;

-- ------------------------------------------------------------------ hak akses
revoke all on function absensi.istirahat_bareng_boleh(uuid, text) from public, anon, authenticated;
revoke all on function absensi.istirahat_bareng_alasan_skip(uuid, timestamptz) from public, anon, authenticated;
revoke all on function absensi.istirahat_bareng_tutup_otomatis() from public, anon, authenticated;
revoke all on function absensi.istirahat_bareng_kandidat(text) from public, anon;
revoke all on function absensi.istirahat_bareng_mulai(uuid[], integer, text) from public, anon;
revoke all on function absensi.istirahat_bareng_selesai(uuid) from public, anon;
revoke all on function absensi.istirahat_bareng_saya() from public, anon;
revoke all on function absensi.istirahat_bareng_hari_ini(integer) from public, anon;
grant execute on function absensi.istirahat_bareng_kandidat(text), absensi.istirahat_bareng_mulai(uuid[], integer, text),
  absensi.istirahat_bareng_selesai(uuid), absensi.istirahat_bareng_saya(), absensi.istirahat_bareng_hari_ini(integer)
  to authenticated;
grant execute on function absensi.istirahat_bareng_tutup_otomatis() to service_role;

-- ------------------------------------------------------------------ jadwal
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'absensi-istirahat-bareng-tutup') then
    perform cron.schedule('absensi-istirahat-bareng-tutup', '* * * * *', 'select absensi.istirahat_bareng_tutup_otomatis()');
  end if;
end $$;

notify pgrst, 'reload schema';
