-- PR-CL113: jaga_email_unik salah menolak INSERT ... ON CONFLICT (firebase_uid) DO UPDATE.
-- Trigger BEFORE INSERT jalan untuk baris usulan yang id-nya masih acak, jadi baris lama milik
-- orang yang SAMA (firebase_uid sama) terbaca sebagai "karyawan lain". Sekarang dikecualikan.
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
                    and (new.firebase_uid is null or k.firebase_uid is distinct from new.firebase_uid)
                    and (lower(k.email) = e or e = any (k.email_lain)))
   limit 1;

  if v_bentrok is not null then
    raise exception 'Email "%" sudah terdaftar pada karyawan lain.', v_bentrok using errcode = '23505';
  end if;
  return new;
end $fn$;
revoke all on function absensi.jaga_email_unik() from public, anon, authenticated;
