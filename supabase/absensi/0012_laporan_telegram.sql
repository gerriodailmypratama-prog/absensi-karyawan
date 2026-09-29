-- PR-CL114: laporan Telegram absensi dari dalam Supabase (pengganti bot GitHub Actions + Firestore).
-- Token acak di Vault untuk memanggil edge function absensi-laporan; pemanggilnya fungsi SQL
-- supaya jadwal pg_cron tidak perlu menyimpan token apa pun.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'absensi_laporan_token',
  'Token pemanggil edge function absensi-laporan (laporan Telegram harian & gajian absensi GoodGems).')
where not exists (select 1 from vault.secrets where name = 'absensi_laporan_token');

create or replace function absensi.panggil_laporan(p_jenis text, p_uji boolean default false)
returns bigint language sql security definer set search_path = pg_catalog, extensions as $fn$
  select net.http_post(
    url := 'https://ryuwnsxwtwfmndnbysxw.supabase.co/functions/v1/absensi-laporan',
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-laporan-token', (select decrypted_secret from vault.decrypted_secrets where name = 'absensi_laporan_token')),
    body := jsonb_build_object('jenis', p_jenis, 'uji', p_uji),
    timeout_milliseconds := 120000)
$fn$;
revoke all on function absensi.panggil_laporan(text, boolean) from public, anon, authenticated;

-- Jadwal (pg_cron) SENGAJA belum dibuat: selama app absensi masih Firebase, bot GitHub yang lama
-- tetap mengirim. Dibuat malam cutover:
--   select cron.schedule('absensi-laporan-harian', '30 22 * * *', $$select absensi.panggil_laporan('harian')$$);
--   select cron.schedule('absensi-laporan-gajian', '0 0 26 * *',  $$select absensi.panggil_laporan('gajian')$$);
