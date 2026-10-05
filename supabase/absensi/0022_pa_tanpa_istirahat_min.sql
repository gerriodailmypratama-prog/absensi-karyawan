-- PR-CL137: karyawan mode PA (Restu, Ila) gak kena "istirahat minimal 60 menit" (PR-CL136).
-- Owner, 5 Okt 2026: PA gak punya tombol istirahat (PR-CL124, dibayar per hari hadir, laporan
-- langsung) — jadi gak bisa tap, dan aturan 0021 motong 60 menit dari jam efektif mereka.
-- Bahaya: kategori_hari 'hadir' butuh jam_efektif_mentah >= 9 x 0,75 = 6,75 jam; Ila 5 Okt
-- turun 7,76 -> 6,76 (nyaris 'parsial' = gaji per hari hadir kepotong).
--   * v_karyawan_ringkas + kolom pa_mulai (paling belakang, additive).
--   * f_sesi_kerja: syarat potong minimal 60 menit ditambah "bukan PA pada tanggal kerja itu".
--     Diubah lewat replace di badan fungsi 0021 (dua titik, dicek harus kena dua-duanya).
-- Pagar: cuma sesi PA mulai istirahat_min_mulai yang boleh berubah, dan cuma boleh NAIK.
set lock_timeout = '5s';
set statement_timeout = '60s';

create or replace view absensi.v_karyawan_ringkas with (security_barrier = true) as
 select id,
    cabang_id,
    nama,
    jabatan,
    peran,
    id_karyawan,
    jam_kerja,
    libur_hari,
    nonaktif,
    tanggal_masuk,
    pa_mulai
   from absensi.karyawan k
  where absensi.is_spv() or user_id = (( select auth.uid() as uid)) or (current_user = any (array['postgres'::name, 'service_role'::name, 'supabase_admin'::name]));

create temp table _pr137_lama on commit drop as
select * from absensi.f_sesi_kerja(current_date - 45, current_date);

do $$
declare
  d text := pg_get_functiondef('absensi.f_sesi_kerja(date,date)'::regprocedure);
  a1 text := 'k.potong_istirahat_kontrak_jam, k.istirahat_min_mulai,';
  a2 text := 'and h.span_menit >= 300';
begin
  if position('PR-CL137' in d) > 0 then return; end if;          -- udah kepasang
  if position('PR-CL136' in d) = 0 then
    raise exception 'PR-CL137: f_sesi_kerja bukan versi 0021 — tarik definisi terbaru dulu';
  end if;
  if (length(d) - length(replace(d, a1, ''))) / length(a1) <> 1
     or (length(d) - length(replace(d, a2, ''))) / length(a2) <> 1 then
    raise exception 'PR-CL137: titik sisip di f_sesi_kerja gak ketemu persis satu kali';
  end if;
  d := replace(d, a1, a1 || ' kr.pa_mulai,');
  d := replace(d, a2, a2 || E'\n                 -- PR-CL137: PA (gak punya tombol istirahat) gak kena minimal 60 menit'
                        || E'\n                 and not (h.pa_mulai is not null and hari_absen(h.ts_masuk, h.zona_waktu, h.jam_mulai_hari) >= h.pa_mulai)');
  execute d;
end $$;

do $$
declare n_salah int; n_naik int;
begin
  select count(*) filter (where not (k.pa_mulai is not null and l.tanggal_kerja >= k.pa_mulai
                                     and b.jam_efektif_mentah >= l.jam_efektif_mentah)),
         count(*) filter (where b.jam_efektif_mentah > l.jam_efektif_mentah)
    into n_salah, n_naik
    from _pr137_lama l
    join absensi.f_sesi_kerja(current_date - 45, current_date) b
      on b.karyawan_id = l.karyawan_id and b.no_sesi = l.no_sesi
    join absensi.karyawan k on k.id = l.karyawan_id
   where l.ts_keluar is not null
     and (b.jam_efektif, b.jam_lembur, b.kategori_hari, b.jam_efektif_mentah)
         is distinct from (l.jam_efektif, l.jam_lembur, l.kategori_hari, l.jam_efektif_mentah);
  if n_salah > 0 then
    raise exception 'PR-CL137: % sesi berubah di luar PA / malah turun — batal', n_salah;
  end if;
  raise notice 'PR-CL137: % sesi PA selesai jam efektifnya balik naik', n_naik;
end $$;
