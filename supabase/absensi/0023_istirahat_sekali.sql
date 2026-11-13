-- PR-CL139: istirahat cuma 1x per shift — 1 tap Istirahat, 1 tap Selesai Istirahat.
-- Owner, 28 Okt 2026: "Istirahat hanya 1x tap istirahat dan 1x tap untuk kelar istirahat,
-- jadi ga bisa tap berkali-kali. Kecuali Mila, Restu, dan Ila."
-- Data 14 hari terakhir: 41 sesi dari 15 orang tap istirahat 2-4x sehari.
--
-- istirahat_bebas : true = boleh istirahat lebih dari 1x per shift (Mila, Restu, Ila).
-- Penjaga di DB (bukan cuma tombol di app) biar tap kedua ditolak walau app-nya versi lama / cache.
-- Yang TIDAK dijaga: job backend tanpa JWT, koreksi owner dari dashboard, dan pasangan
-- istirahat yang diisi otomatis pas Clock Out (itu cuma jalan kalau belum ada break_in di sesi).
set lock_timeout = '5s';
set statement_timeout = '60s';

alter table absensi.karyawan add column if not exists istirahat_bebas boolean not null default false;
comment on column absensi.karyawan.istirahat_bebas is
  'PR-CL139: true = boleh tap Istirahat lebih dari 1x per shift. Default false = cuma 1x (1 mulai + 1 selesai).';

update absensi.karyawan set istirahat_bebas = true
 where nonaktif = false and lower(nama) in ('mila', 'restu', 'ila') and istirahat_bebas = false;

create or replace function absensi.istirahat_bebas(p_karyawan uuid)
returns boolean language sql stable security definer set search_path = absensi, pg_catalog as $$
  select coalesce((select k.istirahat_bebas from absensi.karyawan k where k.id = p_karyawan), false)
$$;

create or replace function absensi.istirahat_sekali_jaga()
returns trigger language plpgsql security definer set search_path = absensi, pg_catalog as $$
declare
  v_peran text;
  v_ci_ts timestamptz;
begin
  -- Job backend (tanpa JWT) & owner (koreksi manual dari dashboard) tidak dijaga.
  if (select auth.uid()) is null or absensi.is_owner() then return new; end if;
  select k.peran into v_peran from absensi.karyawan k where k.id = new.karyawan_id;
  if not found or v_peran = 'owner' then return new; end if;
  if absensi.istirahat_bebas(new.karyawan_id) then return new; end if;

  -- Sesi = sejak Clock In terakhir. Belum Clock In = biarin app yang nolak (validateSequence).
  select a.ts into v_ci_ts from absensi.absensi a
   where a.karyawan_id = new.karyawan_id and a.tipe = 'clock_in'
   order by a.ts desc limit 1;
  if v_ci_ts is null then return new; end if;

  if exists (select 1 from absensi.absensi a
              where a.karyawan_id = new.karyawan_id and a.tipe = 'break_in' and a.ts > v_ci_ts) then
    raise exception 'Istirahat shift ini udah dipakai. Istirahat cuma 1x: tap Istirahat sekali, tap Selesai Istirahat sekali.';
  end if;
  return new;
end $$;

drop trigger if exists trg_istirahat_sekali_jaga on absensi.absensi;
create trigger trg_istirahat_sekali_jaga before insert on absensi.absensi
  for each row when (new.tipe = 'break_in') execute function absensi.istirahat_sekali_jaga();

revoke all on function absensi.istirahat_bebas(uuid) from public, anon;
revoke all on function absensi.istirahat_sekali_jaga() from public, anon;
