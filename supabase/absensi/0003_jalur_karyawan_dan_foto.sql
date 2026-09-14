-- ============================================================================
-- GoodGems Absensi — jalur tulis karyawan, akun, pembatalan absen, foto
-- PR-CL112 · 14 Sep 2026
--
-- Karyawan TIDAK punya izin UPDATE ke barisnya sendiri (di sana ada gaji).
-- Semua yang boleh dia ubah lewat fungsi di bawah, dan penjaganya di sini —
-- pengganti daftar field yang dulu dijaga firestore.rules.
--
-- Beda dengan Kopikiri:
--   * klaim akun HANYA lewat email yang sudah terverifikasi. Jalur cocok-nomor-HP
--     Kopikiri tidak dibawa: nomor HP rekan kerja gampang diketahui orang lain,
--     jadi tidak boleh jadi kunci untuk masuk ke data gaji seseorang.
--   * periode kasbon dihitung database (periode_berjalan), bukan dikirim browser.
--   * foto di 3 bucket PRIVAT dengan nama policy berawalan absensi_ supaya tidak
--     tabrakan dengan policy storage WMS.
-- ============================================================================

set lock_timeout = '5s';
set statement_timeout = '60s';

-- ================================================================ 1. AKUN
-- Dipanggil tiap login. Email akun cocok dengan email utama / email_lain ->
-- disambungkan. Syarat: email sudah terverifikasi Supabase.
create or replace function absensi.klaim_akun_saya()
returns table (hasil text, karyawan_id uuid)
language plpgsql security definer set search_path = absensi, pg_catalog as $fn$
#variable_conflict use_column
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_row   absensi.karyawan%rowtype;
  v_id    uuid;
begin
  if v_uid is null then
    raise exception 'Harus login dulu.' using errcode = '28000';
  end if;

  select * into v_row from absensi.karyawan where user_id = v_uid;
  if found then
    return query select 'sudah_tersambung'::text, v_row.id;
    return;
  end if;

  select lower(u.email) into v_email from auth.users u
   where u.id = v_uid and u.email_confirmed_at is not null;
  if coalesce(v_email, '') = '' then
    return query select 'tidak_ada_email'::text, null::uuid;
    return;
  end if;

  select k.id into v_id from absensi.karyawan k
   where lower(k.email) = v_email or v_email = any (k.email_lain)
   limit 1;
  if v_id is null then
    return query select 'tidak_terdaftar'::text, null::uuid;
    return;
  end if;

  update absensi.karyawan set user_id = v_uid, updated_at = now()
   where id = v_id
   returning * into v_row;
  return query select 'tersambung'::text, v_row.id;
end $fn$;

-- Pendaftaran orang baru. Kode dicek DI DATABASE (dulu cuma di browser).
-- Yang emailnya sudah ada di daftar tidak perlu kode — itu urusan klaim_akun_saya.
create or replace function absensi.daftar_karyawan(
  p_kode text, p_panggilan text, p_nama_lengkap text, p_phone text
) returns table (hasil text, karyawan_id uuid)
language plpgsql security definer set search_path = absensi, pg_catalog as $fn$
#variable_conflict use_column
declare
  v_uid   uuid := auth.uid();
  v_ada   absensi.karyawan%rowtype;
  v_email text;
  v_kode_benar constant text := 'GOODGEMS2026';
begin
  if v_uid is null then
    raise exception 'Harus login dulu.' using errcode = '28000';
  end if;

  select * into v_ada from absensi.karyawan where user_id = v_uid;
  if found then
    return query select 'sudah_terdaftar'::text, v_ada.id;
    return;
  end if;

  select k.hasil, k.karyawan_id into hasil, karyawan_id from absensi.klaim_akun_saya() k;
  if hasil = 'tersambung' then
    return query select 'klaim'::text, karyawan_id;
    return;
  end if;

  if upper(coalesce(p_kode, '')) <> upper(v_kode_benar) then
    raise exception 'Kode pendaftaran salah. Minta kode yang benar ke admin.' using errcode = '28000';
  end if;

  select lower(u.email) into v_email from auth.users u
   where u.id = v_uid and u.email_confirmed_at is not null;
  if coalesce(v_email, '') = '' then
    raise exception 'Email akun belum terverifikasi.' using errcode = '28000';
  end if;

  p_panggilan := lower(btrim(coalesce(p_panggilan, '')));
  if p_panggilan !~ '^[a-z0-9]+$' then
    raise exception 'Nama panggilan harus satu kata, huruf kecil/angka saja.' using errcode = '22023';
  end if;
  if exists (select 1 from absensi.karyawan where lower(nama) = p_panggilan) then
    raise exception 'Nama panggilan "%" sudah dipakai karyawan lain. Pilih yang lain ya.', p_panggilan
      using errcode = '23505';
  end if;

  insert into absensi.karyawan (user_id, nama, nama_lengkap, email, phone, peran, perlu_tinjau)
  values (v_uid, p_panggilan, nullif(btrim(p_nama_lengkap), ''), v_email,
          nullif(btrim(p_phone), ''), 'staff', true)
  returning * into v_ada;

  return query select 'baru'::text, v_ada.id;
end $fn$;

-- Gabung akun dobel (owner saja). Absensi dipindah DULU karena FK-nya CASCADE.
create or replace function absensi.gabung_karyawan(p_duplikat uuid, p_tujuan uuid)
returns table (dipindah_absensi integer, nama_tujuan text)
language plpgsql security definer set search_path = absensi, pg_catalog as $fn$
#variable_conflict use_column
declare
  v_dup   absensi.karyawan%rowtype;
  v_tuj   absensi.karyawan%rowtype;
  v_absen integer;
begin
  if not absensi.is_owner() then
    raise exception 'Cuma owner yang boleh menggabungkan akun.' using errcode = '42501';
  end if;
  if p_duplikat = p_tujuan then
    raise exception 'Baris asal dan tujuan tidak boleh sama.' using errcode = '22023';
  end if;
  select * into v_dup from absensi.karyawan where id = p_duplikat;
  if not found then raise exception 'Akun duplikat tidak ditemukan.' using errcode = 'P0002'; end if;
  select * into v_tuj from absensi.karyawan where id = p_tujuan;
  if not found then raise exception 'Akun tujuan tidak ditemukan.' using errcode = 'P0002'; end if;

  update absensi.absensi set karyawan_id = p_tujuan where karyawan_id = p_duplikat;
  get diagnostics v_absen = row_count;
  update absensi.absensi          set dibuat_oleh = p_tujuan where dibuat_oleh = p_duplikat;
  update absensi.absensi_batal    set karyawan_id = p_tujuan where karyawan_id = p_duplikat;
  update absensi.libur_request    set karyawan_id = p_tujuan where karyawan_id = p_duplikat;
  update absensi.kasbon_request   set karyawan_id = p_tujuan where karyawan_id = p_duplikat;
  update absensi.penyesuaian_gaji set karyawan_id = p_tujuan where karyawan_id = p_duplikat;
  update absensi.payroll_status p set karyawan_id = p_tujuan
   where p.karyawan_id = p_duplikat
     and not exists (select 1 from absensi.payroll_status q where q.karyawan_id = p_tujuan and q.periode = p.periode);

  update absensi.karyawan set user_id = null, email = null, email_lain = '{}' where id = p_duplikat;

  update absensi.karyawan
     set user_id    = coalesce(v_tuj.user_id, v_dup.user_id),
         email      = coalesce(v_tuj.email, v_dup.email),
         email_lain = coalesce(v_tuj.email_lain, '{}') || coalesce(v_dup.email_lain, '{}')
                      || array_remove(array[v_dup.email], null),
         phone      = coalesce(nullif(btrim(v_tuj.phone), ''), v_dup.phone),
         foto_url   = coalesce(nullif(v_tuj.foto_url, ''), v_dup.foto_url),
         perlu_tinjau = false,
         updated_at = now()
   where id = p_tujuan;

  delete from absensi.karyawan where id = p_duplikat;
  return query select v_absen, v_tuj.nama;
end $fn$;

-- ======================================================= 2. DATA DIRI KARYAWAN
-- Rekening dikunci lagi tiap disimpan (owner yang buka). KTP cuma boleh diisi
-- saat masih kosong — sekali terisi, permanen (aturan lama firestore.rules).
create or replace function absensi.simpan_rekening_saya(
  p_nama_bank text, p_nomor_rekening text, p_atas_nama_rek text, p_ktp_url text default null
) returns void
language plpgsql security definer set search_path = absensi, pg_catalog as $fn$
declare
  v_id  uuid := absensi.karyawan_saya();
  v_row absensi.karyawan%rowtype;
  v_ktp text := nullif(btrim(coalesce(p_ktp_url, '')), '');
begin
  if v_id is null then
    raise exception 'Akun kamu belum didaftarkan owner.' using errcode = '28000';
  end if;
  select * into v_row from absensi.karyawan where id = v_id;

  -- KTP harus file di map miliknya sendiri di bucket absensi-ktp.
  if v_ktp is not null and v_ktp not like v_id::text || '/%' then
    raise exception 'File KTP tidak valid.' using errcode = '22023';
  end if;

  if not v_row.rekening_locked then
    if coalesce(btrim(p_nama_bank), '') = '' or coalesce(btrim(p_nomor_rekening), '') = ''
       or coalesce(btrim(p_atas_nama_rek), '') = '' then
      raise exception 'Lengkapi semua data rekening dulu ya.' using errcode = '22023';
    end if;
  end if;

  update absensi.karyawan
     set nama_bank       = case when v_row.rekening_locked then nama_bank      else btrim(p_nama_bank) end,
         nomor_rekening  = case when v_row.rekening_locked then nomor_rekening else btrim(p_nomor_rekening) end,
         atas_nama_rek   = case when v_row.rekening_locked then atas_nama_rek  else btrim(p_atas_nama_rek) end,
         ktp_url         = coalesce(nullif(btrim(coalesce(ktp_url, '')), ''), v_ktp),
         rekening_locked = true,
         updated_at      = now()
   where id = v_id;
end $fn$;

create or replace function absensi.simpan_foto_saya(p_foto_url text)
returns void language plpgsql security definer set search_path = absensi, pg_catalog as $fn$
declare
  v_id  uuid := absensi.karyawan_saya();
  v_url text := nullif(btrim(coalesce(p_foto_url, '')), '');
begin
  if v_id is null then
    raise exception 'Akun kamu belum didaftarkan owner.' using errcode = '28000';
  end if;
  if v_url is not null and v_url not like v_id::text || '/%' then
    raise exception 'File foto tidak valid.' using errcode = '22023';
  end if;
  update absensi.karyawan set foto_url = v_url, updated_at = now() where id = v_id;
end $fn$;

-- ID karyawan GG-XXXX, dibuat sekali kalau masih kosong.
create or replace function absensi.pastikan_id_karyawan()
returns text language plpgsql security definer set search_path = absensi, pg_catalog as $fn$
declare
  v_id  uuid := absensi.karyawan_saya();
  v_kar text;
begin
  if v_id is null then return null; end if;
  select id_karyawan into v_kar from absensi.karyawan where id = v_id;
  if coalesce(btrim(v_kar), '') <> '' then return v_kar; end if;
  v_kar := 'GG-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 4));
  update absensi.karyawan set id_karyawan = v_kar, updated_at = now() where id = v_id;
  return v_kar;
end $fn$;

-- ============================================================== 3. KASBON
-- Gaji berjalan versi konservatif (cermin hitungGajiBerjalan di karyawan.js):
-- jumlah TANGGAL yang ada clock_in sejak awal periode x base harian.
create or replace function absensi.gaji_berjalan_saya()
returns table (periode text, hari integer, gaji bigint)
language plpgsql stable security definer set search_path = absensi, pg_catalog as $fn$
#variable_conflict use_column
declare
  v_id   uuid := absensi.karyawan_saya();
  v_base integer;
  v_dari date;
  v_zona text;
begin
  if v_id is null then return; end if;
  select k.zona_waktu into v_zona from absensi.rekap_konfig k where k.satu_baris;
  periode := absensi.periode_berjalan(now());
  select r.dari into v_dari from absensi.rentang_periode(periode) r;
  select base_harian into v_base from absensi.karyawan where id = v_id;

  select count(distinct (a.ts at time zone v_zona)::date)::integer into hari
    from absensi.absensi a
   where a.karyawan_id = v_id and a.tipe = 'clock_in'
     and a.ts >= (v_dari::timestamp at time zone v_zona) and a.ts <= now();
  hari := coalesce(hari, 0);
  gaji := hari::bigint * coalesce(v_base, 0);
  return next;
end $fn$;

-- Jatah 1x per periode (yang mengunci: menunggu / disetujui; ditolak boleh coba lagi).
-- Status selalu 'menunggu'; plafon = gaji berjalan x persen plafon orang itu.
create or replace function absensi.ajukan_kasbon(p_jumlah integer, p_alasan text)
returns absensi.kasbon_request
language plpgsql security definer set search_path = absensi, pg_catalog as $fn$
declare
  v_id    uuid := absensi.karyawan_saya();
  v_row   absensi.karyawan%rowtype;
  v_gb    record;
  v_maks  integer;
  v_label text;
  v_hasil absensi.kasbon_request;
begin
  if v_id is null then
    raise exception 'Akun kamu belum didaftarkan owner.' using errcode = '28000';
  end if;
  select * into v_row from absensi.karyawan where id = v_id;
  if not v_row.kasbon_aktif or v_row.nonaktif then
    raise exception 'Kasbon belum dibuka untuk akun kamu. Hubungi owner ya.' using errcode = '42501';
  end if;
  if coalesce(p_jumlah, 0) <= 0 then
    raise exception 'Isi jumlah yang mau diajukan dulu ya.' using errcode = '22023';
  end if;

  select * into v_gb from absensi.gaji_berjalan_saya();

  -- Kunci per karyawan supaya dua klik bersamaan tidak lolos jatah 1x.
  perform pg_advisory_xact_lock(hashtext('absensi.kasbon:' || v_id::text));
  if exists (select 1 from absensi.kasbon_request r
              where r.karyawan_id = v_id and r.periode = v_gb.periode
                and r.status in ('menunggu', 'disetujui')) then
    raise exception 'Jatah kasbon periode ini sudah terpakai. Coba lagi periode berikutnya ya.' using errcode = '42501';
  end if;

  v_maks := greatest(0, floor(v_gb.gaji * v_row.kasbon_plafon_persen / 100.0)::integer);
  if p_jumlah > v_maks then
    raise exception 'Melebihi batas. Maksimal Rp %.', to_char(v_maks, 'FM999G999G999') using errcode = '22023';
  end if;

  select to_char(r.dari, 'FMDD Mon') || ' – ' || to_char(r.sampai, 'FMDD Mon YYYY') into v_label
    from absensi.rentang_periode(v_gb.periode) r;

  insert into absensi.kasbon_request (karyawan_id, jumlah, alasan, status, periode, periode_label)
  values (v_id, p_jumlah, nullif(btrim(coalesce(p_alasan, '')), ''), 'menunggu', v_gb.periode, v_label)
  returning * into v_hasil;
  return v_hasil;
end $fn$;

-- ======================================================= 4. HARI LIBUR
-- Yang sudah punya hari libur TIDAK boleh mengusulkan lagi (permanen, owner yang ubah).
create or replace function absensi.ajukan_libur(p_pilihan smallint[])
returns absensi.libur_request
language plpgsql security definer set search_path = absensi, pg_catalog as $fn$
declare
  v_id    uuid := absensi.karyawan_saya();
  v_libur smallint;
  v_hasil absensi.libur_request;
begin
  if v_id is null then
    raise exception 'Akun kamu belum didaftarkan owner.' using errcode = '28000';
  end if;
  select libur_hari into v_libur from absensi.karyawan where id = v_id;
  if v_libur is not null then
    raise exception 'Hari libur kamu sudah ditetapkan dan sifatnya tetap.' using errcode = '42501';
  end if;
  if p_pilihan is null or array_length(p_pilihan, 1) is null then
    raise exception 'Minimal pilih 1 hari.' using errcode = '22023';
  end if;
  if array_length(p_pilihan, 1) <> (select count(distinct x) from unnest(p_pilihan) x) then
    raise exception 'Pilihan harus hari yang berbeda-beda.' using errcode = '22023';
  end if;
  if exists (select 1 from absensi.libur_request where karyawan_id = v_id and status = 'menunggu') then
    raise exception 'Usulan kamu masih menunggu diproses owner.' using errcode = '42501';
  end if;

  insert into absensi.libur_request (karyawan_id, pilihan, status)
  values (v_id, p_pilihan, 'menunggu')
  returning * into v_hasil;
  return v_hasil;
end $fn$;

-- Hari yang kuotanya penuh. Cuma ANGKA hari, tanpa nama orangnya.
create or replace function absensi.libur_penuh(p_maks integer default 3)
returns smallint[] language sql stable security definer set search_path = absensi, pg_catalog as $fn$
  select case when absensi.karyawan_saya() is null then '{}'::smallint[] else
    coalesce((select array_agg(h.libur_hari order by h.libur_hari)
                from (select k.libur_hari from absensi.karyawan k
                       where k.nonaktif = false and k.libur_hari is not null
                         and k.id is distinct from absensi.karyawan_saya()
                       group by k.libur_hari
                      having count(*) >= p_maks) h), '{}') end
$fn$;

-- ================================================= 5. BATALKAN ABSEN (owner)
-- Bukan hapus permanen: dipindah ke arsip absensi_batal, bisa dipulihkan.
create or replace function absensi.batalkan_absen(p_id uuid, p_alasan text default null)
returns void language plpgsql security definer set search_path = absensi, pg_catalog as $fn$
begin
  if not absensi.is_owner() then
    raise exception 'Hanya owner yang boleh membatalkan catatan absen' using errcode = '42501';
  end if;
  insert into absensi.absensi_batal
    select a.*, now(), auth.uid(), nullif(btrim(p_alasan), '')
      from absensi.absensi a where a.id = p_id;
  if not found then
    raise exception 'Catatan absen tidak ditemukan' using errcode = 'P0002';
  end if;
  delete from absensi.absensi where id = p_id;
end $fn$;

create or replace function absensi.pulihkan_absen(p_id uuid)
returns void language plpgsql security definer set search_path = absensi, pg_catalog as $fn$
begin
  if not absensi.is_owner() then
    raise exception 'Hanya owner yang boleh memulihkan catatan absen' using errcode = '42501';
  end if;
  insert into absensi.absensi
    select r.*
      from absensi.absensi_batal b,
           jsonb_populate_record(null::absensi.absensi,
             to_jsonb(b) - 'dibatalkan_at' - 'dibatalkan_oleh' - 'alasan') r
     where b.id = p_id;
  if not found then
    raise exception 'Catatan yang dibatalkan tidak ditemukan' using errcode = 'P0002';
  end if;
  delete from absensi.absensi_batal where id = p_id;
end $fn$;

-- ------------------------------------------------------------- hak akses
do $blok$
declare f text;
begin
  foreach f in array array[
    'absensi.klaim_akun_saya()',
    'absensi.daftar_karyawan(text, text, text, text)',
    'absensi.gabung_karyawan(uuid, uuid)',
    'absensi.simpan_rekening_saya(text, text, text, text)',
    'absensi.simpan_foto_saya(text)',
    'absensi.pastikan_id_karyawan()',
    'absensi.gaji_berjalan_saya()',
    'absensi.ajukan_kasbon(integer, text)',
    'absensi.ajukan_libur(smallint[])',
    'absensi.libur_penuh(integer)',
    'absensi.batalkan_absen(uuid, text)',
    'absensi.pulihkan_absen(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $blok$;

-- ============================================================ 6. FOTO
-- Tiga bucket, semuanya PRIVAT. Kolom menyimpan PATH, link sementara dibuat
-- saat ditampilkan. Nama file selalu diawali id karyawan: '<karyawan_id>/...'.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('absensi-selfie', 'absensi-selfie', false, 2 * 1024 * 1024, array['image/jpeg', 'image/png', 'image/webp']),
  ('absensi-profil', 'absensi-profil', false, 3 * 1024 * 1024, array['image/jpeg', 'image/png', 'image/webp']),
  ('absensi-ktp',    'absensi-ktp',    false, 5 * 1024 * 1024, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- SELFIE: taruh di map sendiri; buka punya sendiri, SPV & owner buka semua.
drop policy if exists absensi_selfie_tulis on storage.objects;
create policy absensi_selfie_tulis on storage.objects for insert to authenticated
  with check (bucket_id = 'absensi-selfie' and (storage.foldername(name))[1] = absensi.karyawan_saya()::text);
drop policy if exists absensi_selfie_baca on storage.objects;
create policy absensi_selfie_baca on storage.objects for select to authenticated
  using (bucket_id = 'absensi-selfie'
         and ((storage.foldername(name))[1] = absensi.karyawan_saya()::text or absensi.is_spv()));

-- PROFIL: sesama karyawan boleh lihat (papan & ucapan ultah); ganti cuma punya sendiri.
drop policy if exists absensi_profil_tulis on storage.objects;
create policy absensi_profil_tulis on storage.objects for insert to authenticated
  with check (bucket_id = 'absensi-profil' and (storage.foldername(name))[1] = absensi.karyawan_saya()::text);
drop policy if exists absensi_profil_ganti on storage.objects;
create policy absensi_profil_ganti on storage.objects for update to authenticated
  using (bucket_id = 'absensi-profil' and (storage.foldername(name))[1] = absensi.karyawan_saya()::text)
  with check (bucket_id = 'absensi-profil' and (storage.foldername(name))[1] = absensi.karyawan_saya()::text);
drop policy if exists absensi_profil_baca on storage.objects;
create policy absensi_profil_baca on storage.objects for select to authenticated
  using (bucket_id = 'absensi-profil' and absensi.karyawan_saya() is not null);

-- KTP: taruh sekali (tanpa policy update/delete = tidak bisa ditimpa/dihapus
-- karyawan); buka cuma pemiliknya & owner. SPV TIDAK.
drop policy if exists absensi_ktp_tulis on storage.objects;
create policy absensi_ktp_tulis on storage.objects for insert to authenticated
  with check (bucket_id = 'absensi-ktp' and (storage.foldername(name))[1] = absensi.karyawan_saya()::text);
drop policy if exists absensi_ktp_baca on storage.objects;
create policy absensi_ktp_baca on storage.objects for select to authenticated
  using (bucket_id = 'absensi-ktp'
         and ((storage.foldername(name))[1] = absensi.karyawan_saya()::text or absensi.is_owner()));

-- Owner boleh mengelola semua file di tiga bucket (hapus selfie salah, ganti KTP buram).
drop policy if exists absensi_foto_kelola_owner on storage.objects;
create policy absensi_foto_kelola_owner on storage.objects for all to authenticated
  using (bucket_id in ('absensi-selfie', 'absensi-profil', 'absensi-ktp') and absensi.is_owner())
  with check (bucket_id in ('absensi-selfie', 'absensi-profil', 'absensi-ktp') and absensi.is_owner());
