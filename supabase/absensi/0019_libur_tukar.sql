-- PR-CL132: jadwal libur bisa diubah SPV (Rafi) + owner, langsung berlaku di absensi & briefing WMS.
-- Owner, 4 Okt 2026: sejak briefing dipegang SPV Rafi, karyawan sering minta ganti libur langsung
-- ke Rafi -> jadwal di absensi / briefing nggak sinkron. Keputusan owner:
--   * dua jenis perubahan: TUKAR sekali (libur tanggal X pindah ke tanggal Y) dan PINDAH hari tetap
--   * yang boleh: SPV + owner (absensi.is_spv() = peran spv/owner)
--   * langsung berlaku, lalu dilaporkan ke Telegram channel 'absen'
--
-- Satu sumber kebenaran: absensi.libur_pada(karyawan, tanggal) = tukar aktif dulu, baru libur_hari.
-- Tabel libur_tukar tertutup (RLS nyala, tanpa policy): baca/tulis cuma lewat fungsi di bawah.
-- Batal = soft (dibatalkan_at), tidak pernah dihapus.
set lock_timeout = '5s';
set statement_timeout = '60s';

create table if not exists absensi.libur_tukar (
  id              uuid primary key default gen_random_uuid(),
  karyawan_id     uuid not null references absensi.karyawan(id),
  tanggal_asal    date not null,          -- jadwal libur yang ditukar -> hari itu MASUK
  tanggal_libur   date not null,          -- hari pengganti -> hari itu LIBUR
  catatan         text,
  dibuat_oleh     uuid references absensi.karyawan(id),
  created_at      timestamptz not null default now(),
  dibatalkan_at   timestamptz,
  dibatalkan_oleh uuid references absensi.karyawan(id),
  constraint libur_tukar_beda_hari check (tanggal_asal <> tanggal_libur)
);
create unique index if not exists libur_tukar_asal_unik  on absensi.libur_tukar (karyawan_id, tanggal_asal)  where dibatalkan_at is null;
create unique index if not exists libur_tukar_libur_unik on absensi.libur_tukar (karyawan_id, tanggal_libur) where dibatalkan_at is null;
alter table absensi.libur_tukar enable row level security;
revoke all on absensi.libur_tukar from anon, authenticated;
comment on table absensi.libur_tukar is 'PR-CL132: tukar libur sekali jalan (tanggal_asal jadi masuk, tanggal_libur jadi libur). Soft cancel via dibatalkan_at. Akses cuma lewat RPC.';

create or replace view absensi.libur_tukar_active as
  select * from absensi.libur_tukar where dibatalkan_at is null;
revoke all on absensi.libur_tukar_active from anon, authenticated;

create table if not exists absensi.libur_log (
  id          uuid primary key default gen_random_uuid(),
  karyawan_id uuid not null references absensi.karyawan(id),
  hari_lama   smallint,
  hari_baru   smallint,
  oleh        uuid references absensi.karyawan(id),
  created_at  timestamptz not null default now()
);
alter table absensi.libur_log enable row level security;
revoke all on absensi.libur_log from anon, authenticated;
comment on table absensi.libur_log is 'PR-CL132: jejak perubahan hari libur tetap lewat RPC ubah_libur_tetap (append-only).';

-- ---------------------------------------------------------------- helper
create or replace function absensi.fmt_tgl_id(p date)
returns text language sql immutable set search_path = '' as $$
  select (array['Min','Sen','Sel','Rab','Kam','Jum','Sab'])[extract(dow from p)::int + 1] || ', '
      || extract(day from p)::int || ' '
      || (array['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'])[extract(month from p)::int]
$$;

create or replace function absensi.hari_id(p smallint)
returns text language sql immutable set search_path = '' as $$
  select case when p between 0 and 6 then (array['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'])[p + 1] else '-' end
$$;

-- Libur atau nggak pada tanggal itu: tukar aktif menang, kalau nggak ada pakai hari libur tetap.
create or replace function absensi.libur_pada(p_karyawan uuid, p_tanggal date)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from absensi.libur_tukar t where t.karyawan_id = p_karyawan and t.dibatalkan_at is null and t.tanggal_libur = p_tanggal) then true
    when exists (select 1 from absensi.libur_tukar t where t.karyawan_id = p_karyawan and t.dibatalkan_at is null and t.tanggal_asal = p_tanggal) then false
    else coalesce((select k.libur_hari = extract(dow from p_tanggal)::smallint from absensi.karyawan k where k.id = p_karyawan), false)
  end
$$;

-- Versi buat WMS (briefing): kunci = wms.user_profiles.absensi_uid. NULL kalau karyawan tidak ketemu.
create or replace function absensi.libur_pada_uid(p_uid text, p_tanggal date)
returns boolean language sql stable security definer set search_path = '' as $$
  select absensi.libur_pada(k.id, p_tanggal)
    from absensi.karyawan k
   where p_uid is not null and p_uid in (k.firebase_uid, k.id::text, k.user_id::text)
   order by k.nonaktif, k.updated_at desc
   limit 1
$$;

revoke all on function absensi.libur_pada(uuid, date) from public, anon;
revoke all on function absensi.libur_pada_uid(text, date) from public, anon, authenticated;
grant execute on function absensi.libur_pada(uuid, date) to authenticated;

-- Target yang boleh diatur: aktif, bukan owner. SPV tidak boleh mengatur PA (PA lapor ke owner).
create or replace function absensi._cek_target_libur(p_karyawan uuid)
returns absensi.karyawan language plpgsql stable security definer set search_path = '' as $$
declare k absensi.karyawan;
begin
  if not absensi.is_spv() then
    raise exception 'Cuma SPV atau owner yang bisa ngatur libur.' using errcode = '42501';
  end if;
  select * into k from absensi.karyawan where id = p_karyawan;
  if not found or k.nonaktif or k.peran = 'owner' or (k.ekstra ? 'dihapus_owner_at') or (k.ekstra ? 'yatim_firebase') then
    raise exception 'Karyawan tidak ditemukan / sudah nonaktif.' using errcode = 'P0002';
  end if;
  if not absensi.is_owner() and k.pa_mulai is not null and k.pa_mulai <= (now() at time zone 'Asia/Jakarta')::date then
    raise exception 'Libur Personal Assistant diatur owner.' using errcode = '42501';
  end if;
  return k;
end $$;
revoke all on function absensi._cek_target_libur(uuid) from public, anon, authenticated;

create or replace function absensi._nama_saya()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select nama from absensi.karyawan where id = absensi.karyawan_saya()), 'owner')
$$;
revoke all on function absensi._nama_saya() from public, anon, authenticated;

-- Jumlah ORANG LAIN yang libur di tanggal itu (buat peringatan kuota).
create or replace function absensi._jumlah_libur(p_tanggal date, p_kecuali uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int from absensi.karyawan k
   where k.nonaktif = false and k.peran <> 'owner' and k.id is distinct from p_kecuali
     and not (k.ekstra ? 'dihapus_owner_at') and not (k.ekstra ? 'yatim_firebase')
     and absensi.libur_pada(k.id, p_tanggal)
$$;
revoke all on function absensi._jumlah_libur(date, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- RPC: baca
-- Daftar tim + hari libur tetap. SPV tidak melihat PA (sama seperti Pantau Tim).
create or replace function absensi.libur_tim()
returns table (karyawan_id uuid, nama text, libur_hari smallint, is_pa boolean)
language plpgsql stable security definer set search_path = '' as $$
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
       and (absensi.is_owner() or not (k.pa_mulai is not null and k.pa_mulai <= (now() at time zone 'Asia/Jakarta')::date))
     order by k.nama;
end $$;

-- Tukar aktif yang menyentuh rentang tanggal. SPV/owner: semua; karyawan biasa: punya sendiri.
create or replace function absensi.libur_tukar_daftar(p_dari date, p_sampai date)
returns table (id uuid, karyawan_id uuid, nama text, tanggal_asal date, tanggal_libur date,
               catatan text, dibuat_oleh_nama text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select t.id, t.karyawan_id, k.nama, t.tanggal_asal, t.tanggal_libur, t.catatan,
         (select o.nama from absensi.karyawan o where o.id = t.dibuat_oleh), t.created_at
    from absensi.libur_tukar_active t
    join absensi.karyawan k on k.id = t.karyawan_id
   where (t.tanggal_asal between p_dari and p_sampai or t.tanggal_libur between p_dari and p_sampai)
     and (absensi.is_spv() or t.karyawan_id = absensi.karyawan_saya())
   order by least(t.tanggal_asal, t.tanggal_libur), k.nama
$$;

-- ---------------------------------------------------------------- RPC: tulis
create or replace function absensi.atur_tukar_libur(p_karyawan uuid, p_tanggal_asal date, p_tanggal_libur date, p_catatan text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  k     absensi.karyawan;
  v_id  uuid;
  hari  date := (now() at time zone 'Asia/Jakarta')::date;
  n     integer;
  cat   text := nullif(btrim(coalesce(p_catatan, '')), '');
begin
  k := absensi._cek_target_libur(p_karyawan);
  if p_tanggal_asal is null or p_tanggal_libur is null then
    raise exception 'Tanggal wajib diisi.' using errcode = '22023';
  end if;
  if p_tanggal_asal = p_tanggal_libur then
    raise exception 'Tanggal asal dan pengganti tidak boleh sama.' using errcode = '22023';
  end if;
  if least(p_tanggal_asal, p_tanggal_libur) < hari - 7 or greatest(p_tanggal_asal, p_tanggal_libur) > hari + 60 then
    raise exception 'Tanggal harus antara seminggu lalu sampai 2 bulan ke depan.' using errcode = '22023';
  end if;
  if not absensi.libur_pada(k.id, p_tanggal_asal) then
    raise exception '% bukan jadwal libur %.', absensi.fmt_tgl_id(p_tanggal_asal), k.nama using errcode = '22023';
  end if;
  if absensi.libur_pada(k.id, p_tanggal_libur) then
    raise exception '% sudah libur di %.', k.nama, absensi.fmt_tgl_id(p_tanggal_libur) using errcode = '22023';
  end if;

  insert into absensi.libur_tukar (karyawan_id, tanggal_asal, tanggal_libur, catatan, dibuat_oleh)
  values (k.id, p_tanggal_asal, p_tanggal_libur, left(cat, 200), absensi.karyawan_saya())
  returning id into v_id;

  n := absensi._jumlah_libur(p_tanggal_libur, k.id);
  perform wms.bot_enqueue('absen',
    '🔄 Tukar libur — ' || k.nama || E'\n'
    || 'Libur ' || absensi.fmt_tgl_id(p_tanggal_asal) || ' → pindah ke ' || absensi.fmt_tgl_id(p_tanggal_libur) || E'\n'
    || coalesce('Catatan: ' || left(cat, 200) || E'\n', '')
    || 'oleh ' || absensi._nama_saya()
    || case when n >= 3 then E'\n⚠️ ' || absensi.fmt_tgl_id(p_tanggal_libur) || ' jadi ' || (n + 1) || ' orang libur' else '' end,
    'absensi-libur-tukar-' || v_id);
  return jsonb_build_object('ok', true, 'id', v_id, 'libur_lain', n);
end $$;

create or replace function absensi.batal_tukar_libur(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t absensi.libur_tukar; k absensi.karyawan;
begin
  select * into t from absensi.libur_tukar where id = p_id and dibatalkan_at is null;
  if not found then
    raise exception 'Tukar libur tidak ditemukan / sudah dibatalkan.' using errcode = 'P0002';
  end if;
  k := absensi._cek_target_libur(t.karyawan_id);
  update absensi.libur_tukar set dibatalkan_at = now(), dibatalkan_oleh = absensi.karyawan_saya() where id = p_id;
  perform wms.bot_enqueue('absen',
    '↩️ Tukar libur dibatalkan — ' || k.nama || E'\n'
    || 'Balik ke jadwal: libur ' || absensi.fmt_tgl_id(t.tanggal_asal) || ', masuk ' || absensi.fmt_tgl_id(t.tanggal_libur) || E'\n'
    || 'oleh ' || absensi._nama_saya(),
    'absensi-libur-batal-' || p_id);
  return jsonb_build_object('ok', true);
end $$;

-- Pindah hari libur tetap. Tukar yang belum lewat & tanggal asalnya ikut jadwal lama dibatalkan
-- otomatis (jadwal lamanya sudah tidak berlaku), dan disebut di laporan Telegram.
create or replace function absensi.ubah_libur_tetap(p_karyawan uuid, p_hari smallint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  k    absensi.karyawan;
  hari date := (now() at time zone 'Asia/Jakarta')::date;
  nb   integer;
  n    integer;
begin
  k := absensi._cek_target_libur(p_karyawan);
  if p_hari is null or p_hari not between 0 and 6 then
    raise exception 'Hari libur tidak valid.' using errcode = '22023';
  end if;
  if k.libur_hari is not distinct from p_hari then
    return jsonb_build_object('ok', true, 'berubah', false);
  end if;

  update absensi.libur_tukar set dibatalkan_at = now(), dibatalkan_oleh = absensi.karyawan_saya()
   where karyawan_id = k.id and dibatalkan_at is null and greatest(tanggal_asal, tanggal_libur) >= hari;
  get diagnostics nb = row_count;

  update absensi.karyawan set libur_hari = p_hari, updated_at = now() where id = k.id;
  insert into absensi.libur_log (karyawan_id, hari_lama, hari_baru, oleh) values (k.id, k.libur_hari, p_hari, absensi.karyawan_saya());

  select count(*)::int into n from absensi.karyawan x
   where x.nonaktif = false and x.peran <> 'owner' and x.id <> k.id and x.libur_hari = p_hari
     and not (x.ekstra ? 'dihapus_owner_at') and not (x.ekstra ? 'yatim_firebase');
  perform wms.bot_enqueue('absen',
    '📅 Libur tetap diganti — ' || k.nama || E'\n'
    || absensi.hari_id(k.libur_hari) || ' → ' || absensi.hari_id(p_hari) || ' (mulai minggu ini)' || E'\n'
    || 'oleh ' || absensi._nama_saya()
    || case when nb > 0 then E'\n' || nb || ' tukar libur yang belum lewat ikut dibatalkan' else '' end
    || case when n >= 3 then E'\n⚠️ ' || absensi.hari_id(p_hari) || ' jadi ' || (n + 1) || ' orang libur' else '' end,
    'absensi-libur-tetap-' || k.id || '-' || extract(epoch from now())::bigint);
  return jsonb_build_object('ok', true, 'berubah', true, 'tukar_dibatalkan', nb, 'libur_lain', n);
end $$;

revoke all on function absensi.libur_tim() from public, anon;
revoke all on function absensi.libur_tukar_daftar(date, date) from public, anon;
revoke all on function absensi.atur_tukar_libur(uuid, date, date, text) from public, anon;
revoke all on function absensi.batal_tukar_libur(uuid) from public, anon;
revoke all on function absensi.ubah_libur_tetap(uuid, smallint) from public, anon;
grant execute on function absensi.libur_tim() to authenticated;
grant execute on function absensi.libur_tukar_daftar(date, date) to authenticated;
grant execute on function absensi.atur_tukar_libur(uuid, date, date, text) to authenticated;
grant execute on function absensi.batal_tukar_libur(uuid) to authenticated;
grant execute on function absensi.ubah_libur_tetap(uuid, smallint) to authenticated;

-- ---------------------------------------------------------------- f_status_harian ikut tukar
create or replace function absensi.f_status_harian(p_tanggal date default null::date)
 returns table(tanggal_kerja date, karyawan_id uuid, nama text, jabatan text, id_karyawan text, cabang_id uuid, cabang_tetap_id uuid, status text, jam_masuk timestamp with time zone, jam_keluar timestamp with time zone, istirahat_menit numeric, jeda_menit numeric, jam_efektif numeric, jam_lembur numeric, ada_luar_radius boolean, jam_kontrak integer)
 language sql
 stable
 set search_path to 'absensi', 'pg_catalog'
as $function$
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
           when absensi.libur_pada(kr.id, (select hari.d from hari)) then 'libur'
           else 'belum_absen'
         end as status,
         r.jam_masuk, r.jam_keluar, r.istirahat_menit, r.jeda_menit, r.jam_efektif, r.jam_lembur,
         coalesce(r.ada_luar_radius, false) as ada_luar_radius,
         coalesce(r.jam_kontrak, kr.jam_kerja) as jam_kontrak
  from v_karyawan_ringkas kr
  left join rekap r on r.karyawan_id = kr.id
  where (kr.nonaktif = false and kr.peran <> 'owner') or r.karyawan_id is not null
$function$;
