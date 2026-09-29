-- PR-CL114: buka skema absensi ke API (PostgREST). Daftar lama disalin persis, cuma ditambah absensi.
-- Aman karena semua tabel absensi ber-RLS dan anon tidak punya USAGE pada skema absensi.
alter role authenticator set pgrst.db_schemas = 'public, graphql_public, wms, historical, goodfinds, cash, health, absensi';
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
