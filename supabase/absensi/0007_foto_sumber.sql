-- PR-CL113: jejak asal file foto yang disalin dari Firebase Storage. Dipakai edge function
-- absensi-pindah supaya rerun mode data tidak menimpa path Supabase dengan URL Firebase yang
-- sama, tapi tetap menyalin ulang kalau URL Firebase-nya berubah (foto profil diganti).
-- Service role saja; hapus setelah cutover.
create table if not exists absensi.foto_sumber (
  karyawan_id uuid not null references absensi.karyawan(id) on delete cascade,
  kolom       text not null check (kolom in ('foto_url', 'ktp_url')),
  sumber_url  text not null,
  path        text not null,
  disalin_at  timestamptz not null default now(),
  primary key (karyawan_id, kolom)
);
alter table absensi.foto_sumber enable row level security;
revoke all on absensi.foto_sumber from public, anon, authenticated;
grant all on absensi.foto_sumber to service_role;
