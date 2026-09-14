-- PR-CL113: token rahasia untuk edge function absensi-pindah (dibuat acak di database,
-- tidak pernah ditulis di mana pun) + pemanggilnya. Hapus keduanya setelah cutover.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'absensi_pindah_token',
  'Token pemanggil edge function absensi-pindah (migrasi data Firebase -> skema absensi). Hapus setelah cutover.')
where not exists (select 1 from vault.secrets where name = 'absensi_pindah_token');

create or replace function absensi.token_pindah_cocok(p_token text)
returns boolean language sql stable security definer set search_path = pg_catalog as $fn$
  select coalesce(length(p_token) = 64 and p_token = (select decrypted_secret from vault.decrypted_secrets where name = 'absensi_pindah_token'), false)
$fn$;
revoke all on function absensi.token_pindah_cocok(text) from public, anon, authenticated;

-- Pemanggil: kirim request ke edge function dengan token dari Vault (dipakai dari SQL editor / MCP).
create or replace function absensi.panggil_pindah(p_body jsonb)
returns bigint language sql security definer set search_path = pg_catalog, extensions as $fn$
  select net.http_post(
    url := 'https://ryuwnsxwtwfmndnbysxw.supabase.co/functions/v1/absensi-pindah',
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-pindah-token', (select decrypted_secret from vault.decrypted_secrets where name = 'absensi_pindah_token')),
    body := p_body,
    timeout_milliseconds := 400000)
$fn$;
revoke all on function absensi.panggil_pindah(jsonb) from public, anon, authenticated;
