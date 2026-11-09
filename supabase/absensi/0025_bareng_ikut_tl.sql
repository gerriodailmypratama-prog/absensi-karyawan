-- PR-CL142: Istirahat Bareng = bareng dengan TL-nya (owner, 9 Nov 2026).
-- "Sesi pagi ikut Desti, sesi malam ikut Itang, tim Live ikut Mila (Bunga, Cia)."
--   * TL yang mulai SELALU ikut istirahat (otomatis ditambah ke peserta, gak bisa dilepas).
--   * Kandidat = tim divisi TL yang lagi masuk di SESI YANG SAMA dengan TL: clock-in sesi
--     berjalannya beda <= 4 jam dari clock-in TL (pagi ~06.xx vs malam ~14-15.xx beda ~8 jam).
--     TL belum Clock In = gak bisa mulai.
--   * Satu Istirahat Bareng jalan per (divisi, sesi): Desti (pagi) & Itang (malam) gak saling
--     ngeblok. Owner (gak punya sesi) tetap seluruh divisi seperti PR-CL141.
--   * Susulan dihitung per sesi juga: Istirahat Bareng sesi malam gak bikin orang sesi pagi
--     jadi "susulan".
-- Tetap sama: tutup otomatis 60 menit (pg_cron), flag susulan, view v_istirahat_harian.
-- Additive: 1 kolom nullable baru + CREATE OR REPLACE fungsi (tanda tangan sama).
set lock_timeout = '5s';
set statement_timeout = '60s';

alter table absensi.istirahat_bareng add column if not exists sesi_ci_at timestamptz;
comment on column absensi.istirahat_bareng.sesi_ci_at is
  'PR-CL142: jam Clock In sesi TL yang mulai (patokan "sesi yang sama", +-4 jam). NULL = dimulai owner (seluruh divisi).';

-- Dua jam clock-in = sesi/shift yang sama? (beda <= 4 jam). NULL salah satunya = dianggap sama.
create or replace function absensi.istirahat_bareng_satu_sesi(p_a timestamptz, p_b timestamptz)
returns boolean language sql immutable as $$
  select p_a is null or p_b is null or abs(extract(epoch from (p_a - p_b))) <= 4 * 3600
$$;

create or replace function absensi.istirahat_bareng_kandidat(p_divisi text default null)
returns jsonb language plpgsql stable security definer set search_path = absensi, pg_catalog as $$
declare
  v_saya  uuid := absensi.karyawan_saya();
  v_owner boolean;
  v_div   text;
  v_tl_ci timestamptz;
  v_jalan jsonb;
begin
  if v_saya is null or not coalesce(absensi.lembur_boleh_acc(v_saya), false) then
    raise exception 'Hanya Lead, SPV, atau owner.';
  end if;
  select coalesce(k.peran = 'owner', false) into v_owner from absensi.karyawan k where k.id = v_saya;
  v_owner := coalesce(v_owner, false);
  v_div := case when v_owner then nullif(btrim(coalesce(p_divisi, '')), '') else absensi.lembur_divisi(v_saya) end;
  if not v_owner then
    select s.ci_ts into v_tl_ci from absensi.lembur_sesi_terbuka(v_saya) s;
  end if;

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
     and (v_owner or absensi.istirahat_bareng_satu_sesi(b.sesi_ci_at, v_tl_ci))
   order by b.mulai_at desc limit 1;

  return jsonb_build_object(
    'owner', v_owner,
    'divisi', v_div,
    'sesi_ci', v_tl_ci,
    'belum_masuk', (not v_owner and v_tl_ci is null),
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
                        where b.divisi = v_div and b.mulai_at > now() - interval '20 hours'
                          and (v_owner or absensi.istirahat_bareng_satu_sesi(b.sesi_ci_at, v_tl_ci))), '[]'::jsonb),
    'kandidat', case when v_div is null or (not v_owner and v_tl_ci is null) then '[]'::jsonb else
        coalesce((select jsonb_agg(jsonb_build_object('karyawan_id', t.id, 'nama', t.nama, 'ci_ts', t.ci_ts,
                           'saya', t.id = v_saya, 'alasan', t.alasan) order by (t.id = v_saya) desc, (t.alasan is null) desc, t.ci_ts)
                    from (select k.id, k.nama, s.ci_ts, absensi.istirahat_bareng_alasan_skip(k.id, s.ci_ts) alasan
                            from absensi.karyawan k
                            cross join lateral absensi.lembur_sesi_terbuka(k.id) s
                           where not k.nonaktif and k.peran <> 'owner' and not absensi.lembur_is_pa(k.id)
                             and s.ci_id is not null
                             and (v_owner or absensi.istirahat_bareng_satu_sesi(s.ci_ts, v_tl_ci))
                             and absensi.lembur_divisi(k.id) = v_div) t), '[]'::jsonb) end);
end $$;

create or replace function absensi.istirahat_bareng_mulai(p_karyawan uuid[], p_menit integer default 60, p_divisi text default null)
returns jsonb language plpgsql security definer set search_path = absensi, pg_catalog as $$
declare
  v_saya   uuid := absensi.karyawan_saya();
  v_owner  boolean;
  v_nama_s text;
  v_div    text;
  v_tl_ci  timestamptz;
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
  v_ids    uuid[];
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
    -- PR-CL142: Istirahat Bareng ikut sesi TL. TL wajib lagi masuk.
    select s.ci_ts into v_tl_ci from absensi.lembur_sesi_terbuka(v_saya) s;
    if v_tl_ci is null then
      raise exception 'Kamu belum Clock In. Istirahat Bareng ikut sesi kamu — Clock In dulu.';
    end if;
  end if;
  if not absensi.istirahat_bareng_boleh(v_saya, v_div) then
    raise exception 'Kamu gak pegang divisi ini.';
  end if;

  perform pg_advisory_xact_lock(hashtext('absensi.istirahat_bareng:' || v_div));
  perform absensi.istirahat_bareng_tutup_otomatis();
  if exists (select 1 from absensi.istirahat_bareng b
              where b.divisi = v_div and b.selesai_at is null
                and (v_owner or absensi.istirahat_bareng_satu_sesi(b.sesi_ci_at, v_tl_ci))) then
    raise exception 'Divisi % masih ada Istirahat Bareng yang jalan di sesi ini.', v_div;
  end if;
  v_sampai := v_now + make_interval(mins => v_menit);

  -- PR-CL142: TL (bukan owner) SELALU ikut — ditaruh paling depan.
  v_ids := coalesce(p_karyawan, '{}'::uuid[]);
  if not v_owner then v_ids := array_prepend(v_saya, v_ids); end if;

  foreach v_k in array (select coalesce(array_agg(x order by min_o), '{}')
                          from (select x, min(o) min_o from unnest(v_ids) with ordinality u(x, o) group by x) q) loop
    select k.id, k.nama, k.peran, k.cabang_id, k.nonaktif into v_kar from absensi.karyawan k where k.id = v_k;
    v_ci := null; v_hasil := null;
    if v_kar.id is null or v_kar.nonaktif then v_hasil := 'karyawan tidak ditemukan';
    elsif v_kar.peran = 'owner' then v_hasil := 'owner gak ikut';
    elsif absensi.lembur_is_pa(v_k) then v_hasil := 'PA gak punya istirahat';
    elsif absensi.lembur_divisi(v_k) is distinct from v_div then v_hasil := 'beda divisi';
    else
      select s.ci_ts into v_ci from absensi.lembur_sesi_terbuka(v_k) s;
      v_hasil := absensi.istirahat_bareng_alasan_skip(v_k, v_ci);
      if v_hasil is null and not v_owner and not absensi.istirahat_bareng_satu_sesi(v_ci, v_tl_ci) then
        v_hasil := 'beda sesi';
      end if;
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

  insert into absensi.istirahat_bareng (id, divisi, dimulai_oleh, mulai_at, menit, selesai_rencana_at, peserta, dilewati, sesi_ci_at)
  values (v_id, v_div, v_saya, v_now, v_menit, v_sampai, v_ok, v_skip, v_tl_ci);

  insert into absensi.absensi (karyawan_id, cabang_id, tipe, ts, otomatis, flag, dibuat_oleh, catatan, ekstra)
  select k.id, k.cabang_id, 'break_in', v_now, true, 'istirahat_bareng', v_saya, 'Istirahat Bareng',
         jsonb_build_object('bareng_id', v_id, 'bareng_sampai', v_sampai, 'bareng_oleh', v_nama_s)
    from absensi.karyawan k where k.id = any (v_ok);

  begin
    select '🍽️ Istirahat Bareng — ' || v_div
           || case when v_tl_ci is not null then ' (sesi masuk ' || to_char(v_tl_ci at time zone 'Asia/Jakarta', 'HH24:MI') || ')' else '' end || E'\n'
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

  -- PR-CL142: susulan cuma kalau Istirahat Bareng-nya di SESI yang sama (TL sesi kamu).
  select b.id, b.mulai_at, o.nama oleh into v_b
    from absensi.istirahat_bareng b left join absensi.karyawan o on o.id = b.dimulai_oleh
   where v_div is not null and b.divisi = v_div and b.mulai_at >= v_ci
     and absensi.istirahat_bareng_satu_sesi(b.sesi_ci_at, v_ci)
   order by b.mulai_at desc limit 1;

  return jsonb_build_object('divisi', v_div, 'aktif', v_aktif,
                            'susulan', v_b.id is not null,
                            'bareng_id', v_b.id, 'bareng_mulai_at', v_b.mulai_at, 'bareng_oleh', v_b.oleh,
                            'bisa_mulai', coalesce(absensi.lembur_boleh_acc(v_saya), false));
end $$;

revoke all on function absensi.istirahat_bareng_satu_sesi(timestamptz, timestamptz) from public, anon, authenticated;

notify pgrst, 'reload schema';
