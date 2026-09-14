// absensi-pindah — pindahkan data absensi GoodGems dari Firestore ke skema `absensi` (PR-CL113).
//
// Dipanggil HANYA lewat absensi.panggil_pindah(jsonb) dari database: header x-pindah-token
// dicocokkan ke Vault (absensi_pindah_token). verify_jwt dimatikan karena anon key WMS publik.
// Nulis lewat koneksi Postgres langsung (SUPABASE_DB_URL), jadi skema absensi tidak perlu
// dibuka ke API selama masa pindahan.
//
// Balasan cuma ANGKA — tidak pernah nama, email, UID, rekening, atau isi dokumen.
//
// Mode:
//   inventaris  -> nama field + tipe per koleksi (tanpa nilai)
//   data        -> karyawan, absensi, status bayar/slip, bonus/potongan, usulan libur; {uji:true}
//                  (bawaan) memproses semuanya lalu MEMBATALKAN, balasannya cuma hitungan.
//   banding     -> {periode:[...]} rumus gaji owner.js dijalankan pada data Firebase & Supabase, dibandingkan.
//   foto        -> {batas_detik} salin selfie/KTP/foto profil ke bucket privat, kolom jadi path.
import postgres from "npm:postgres@3.4.5";
import { createClient } from "npm:@supabase/supabase-js@2";
import { GESER_WIB_MS, hitungPayroll, type Ev, type Kar } from "./payroll-goodgems.ts";

const DB_URL = Deno.env.get("SUPABASE_DB_URL")!;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function googleToken(sa: any, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson({
    iss: sa.client_email, scope, aud: sa.token_uri, iat: now, exp: now + 3600,
  })}`;
  const pem = sa.private_key.replace(/-----[A-Z ]+ KEY-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${unsigned}.${b64url(new Uint8Array(sig))}`,
  });
  const j = await res.json();
  if (!j.access_token) throw new Error("google token gagal");
  return j.access_token;
}

// Firestore REST value -> JS biasa.
function fv(v: any): any {
  if (!v || typeof v !== "object") return null;
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("timestampValue" in v) return new Date(v.timestampValue);
  if ("geoPointValue" in v) return { lat: v.geoPointValue.latitude, lng: v.geoPointValue.longitude };
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fv);
  if ("mapValue" in v) {
    const o: Record<string, any> = {};
    for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = fv(x);
    return o;
  }
  return null;
}
function tipe(v: any): string {
  if (!v || typeof v !== "object") return "?";
  const k = Object.keys(v)[0] || "?";
  return k.replace("Value", "");
}

async function listAll(sa: any, token: string, koleksi: string) {
  const out: { id: string; raw: Record<string, any> }[] = [];
  let pageToken = "";
  do {
    const u = new URL(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${koleksi}`);
    u.searchParams.set("pageSize", "300");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`firestore ${koleksi} http ${r.status}`);
    const j = await r.json();
    for (const d of j.documents || []) out.push({ id: String(d.name).split("/").pop()!, raw: d.fields || {} });
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

// ------------------------------------------------------------------ mode data
const OWNER_EMAILS = ["gerriomail@gmail.com", "steffieerzamia@gmail.com"]; // = js/firebase-config.js
const TIPE_SAH = new Set(["clock_in", "clock_out", "break_in", "break_out", "overtime_in", "overtime_out", "pause_in", "pause_out"]);
const BATAL_UJI = "__batal_uji__";

const wibDate = (d: any) =>
  d instanceof Date && !isNaN(d.getTime()) ? d.toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" }) : null;
const angka = (x: any) => (x === "" || x == null || !Number.isFinite(Number(x)) ? null : Number(x));
const bulat = (x: any) => (angka(x) == null ? null : Math.round(Number(x)));
const teks = (x: any) => (x == null || String(x).trim() === "" ? null : String(x).trim());
const periodeKey = (k: string) => {
  const m = /^(\d{4})-?(\d{2})$/.exec(String(k));
  return m ? `${m[1]}-${m[2]}` : null;
};
// Date di dalam objek -> ISO string, supaya aman masuk jsonb.
const jsonAman = (o: any): any =>
  o instanceof Date ? o.toISOString()
  : Array.isArray(o) ? o.map(jsonAman)
  : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, jsonAman(v)]))
  : o;
const sisa = (obj: Record<string, any>, dipakai: Set<string>) =>
  jsonAman(Object.fromEntries(Object.entries(obj).filter(([k]) => !dipakai.has(k))));

const KAR_DIPAKAI = new Set([
  "nama", "namaPanggilan", "full_name", "email", "phone", "idKaryawan", "jabatan", "statusKaryawan", "spvAkses",
  "tanggalLahir", "tanggalJoin", "baseHarian", "jamKerja", "multiplierLembur", "tunjanganBulanan", "liburHari",
  "nonaktif", "gpsExempt", "wajibKodeClockout", "kodeAdmin", "noShiftBarrier", "kasbonAktif", "kasbonPlafonPersen",
  "namaBank", "nomorRekening", "atasNamaRek", "ktpUrl", "rekeningLocked", "profilLocked", "createdAt",
  "bayarBulan", "bonusBulan", "potonganBulan", "slipTerakhir", "slipBulan", "kasbonRequest", "kasbonRequestAt",
  "liburRequest", "liburRequestPending", "liburRequestAt",
]);
const ABS_DIPAKAI = new Set([
  "uid", "nama", "email", "tipe", "ts", "lokasi", "jarak", "inRadius", "gpsExempt", "fotoSelfie", "kodeVerif",
  "noBreak", "autoCap", "auto", "flag", "manualEdit", "editedByOwner", "editedAt", "lemburOverrideMin",
  "istirahatOverrideMin", "earlyReason",
]);

async function pindahData(sql: any, sa: any, gtok: string, uji: boolean) {
  const [karDocs, profDocs, absDocs] = await Promise.all([
    listAll(sa, gtok, "karyawan"), listAll(sa, gtok, "profil"), listAll(sa, gtok, "absensi"),
  ]);
  const c: Record<string, number> = {
    firestore_karyawan: karDocs.length, firestore_profil: profDocs.length, firestore_absensi: absDocs.length,
  };
  const inc = (k: string, n = 1) => (c[k] = (c[k] || 0) + n);

  const foto = new Map<string, string>();
  for (const p of profDocs) {
    const f = fv(p.raw.foto);
    if (typeof f === "string" && /^https?:\/\//.test(f)) foto.set(p.id, f);
    else if (typeof f === "string" && f) inc("profil_foto_base64_dilewati");
  }

  // ---- karyawan
  const emailDipakai = new Set<string>();
  const kar = karDocs.map((d) => {
    const x: Record<string, any> = Object.fromEntries(Object.entries(d.raw).map(([k, v]) => [k, fv(v)]));
    return { uid: d.id, x };
  });
  // yang aktif duluan dapat email kalau ada email dobel
  kar.sort((a, b) => Number(!!a.x.nonaktif) - Number(!!b.x.nonaktif));
  const karRows = kar.map(({ uid, x }) => {
    let email = teks(x.email)?.toLowerCase() || null;
    if (email && emailDipakai.has(email)) { inc("karyawan_email_dobel_dikosongkan"); email = null; }
    if (email) emailDipakai.add(email);
    const panggilan = teks(x.namaPanggilan) || teks(x.nama) || "tanpa-nama";
    const lahir = /^\d{4}-\d{2}-\d{2}$/.test(String(x.tanggalLahir || "").trim()) ? String(x.tanggalLahir).trim() : null;
    if (x.tanggalLahir && !lahir) inc("karyawan_tgl_lahir_tak_terbaca");
    const jam = bulat(x.jamKerja);
    const peran = email && OWNER_EMAILS.includes(email) ? "owner" : x.spvAkses === true ? "spv" : "staff";
    return {
      firebase_uid: uid,
      nama: panggilan,
      nama_lengkap: teks(x.full_name) || (teks(x.nama) !== panggilan ? teks(x.nama) : null),
      email,
      phone: teks(x.phone),
      id_karyawan: teks(x.idKaryawan),
      jabatan: teks(x.jabatan),
      status_kepegawaian: teks(x.statusKaryawan),
      peran,
      foto_url: foto.get(uid) || null,
      tanggal_lahir: lahir,
      tanggal_masuk: wibDate(x.tanggalJoin),
      base_harian: bulat(x.baseHarian) ?? 0,
      jam_kerja: jam && jam >= 1 && jam <= 24 ? jam : 9,
      multiplier_lembur: angka(x.multiplierLembur) || 1,
      tunjangan_bulanan: bulat(x.tunjanganBulanan) ?? 0,
      libur_hari: bulat(x.liburHari),
      nonaktif: x.nonaktif === true,
      gps_exempt: x.gpsExempt === true,
      wajib_kode_clockout: x.wajibKodeClockout === true,
      kode_admin: x.kodeAdmin === true,
      no_shift_barrier: x.noShiftBarrier === true,
      kasbon_aktif: x.kasbonAktif === true,
      kasbon_plafon_persen: bulat(x.kasbonPlafonPersen) ?? 50,
      nama_bank: teks(x.namaBank),
      nomor_rekening: teks(x.nomorRekening),
      atas_nama_rek: teks(x.atasNamaRek),
      ktp_url: teks(x.ktpUrl),
      rekening_locked: x.rekeningLocked !== undefined ? x.rekeningLocked === true : x.profilLocked === true,
      cabang_kode: "ruko",
      created_at: x.createdAt instanceof Date ? x.createdAt.toISOString() : new Date().toISOString(),
      ekstra: sisa(x, KAR_DIPAKAI),
      _x: x,
    };
  });

  const selesai = async (tx: any) => {
    const [{ id: rukoId }] = await tx`select id from absensi.cabang where kode = 'ruko'`;

    for (const r of karRows) {
      const [{ baru }] = await tx`
        insert into absensi.karyawan (firebase_uid, cabang_id, nama, nama_lengkap, email, phone, id_karyawan, jabatan,
          status_kepegawaian, peran, foto_url, tanggal_lahir, tanggal_masuk, base_harian, jam_kerja, multiplier_lembur,
          tunjangan_bulanan, libur_hari, nonaktif, gps_exempt, wajib_kode_clockout, kode_admin, no_shift_barrier,
          kasbon_aktif, kasbon_plafon_persen, nama_bank, nomor_rekening, atas_nama_rek, ktp_url, rekening_locked,
          created_at, ekstra)
        values (${r.firebase_uid}, ${rukoId}, ${r.nama}, ${r.nama_lengkap}, ${r.email}, ${r.phone}, ${r.id_karyawan},
          ${r.jabatan}, ${r.status_kepegawaian}, ${r.peran}, ${r.foto_url}, ${r.tanggal_lahir}, ${r.tanggal_masuk},
          ${r.base_harian}, ${r.jam_kerja}, ${r.multiplier_lembur}, ${r.tunjangan_bulanan}, ${r.libur_hari}, ${r.nonaktif},
          ${r.gps_exempt}, ${r.wajib_kode_clockout}, ${r.kode_admin}, ${r.no_shift_barrier}, ${r.kasbon_aktif},
          ${r.kasbon_plafon_persen}, ${r.nama_bank}, ${r.nomor_rekening}, ${r.atas_nama_rek}, ${r.ktp_url},
          ${r.rekening_locked}, ${r.created_at}, ${tx.json(r.ekstra)})
        on conflict (firebase_uid) do update set
          nama = excluded.nama, nama_lengkap = excluded.nama_lengkap, email = excluded.email, phone = excluded.phone,
          id_karyawan = excluded.id_karyawan, jabatan = excluded.jabatan, status_kepegawaian = excluded.status_kepegawaian,
          peran = excluded.peran,
          foto_url = case when excluded.foto_url is null then absensi.karyawan.foto_url
                          when exists (select 1 from absensi.foto_sumber fs where fs.karyawan_id = absensi.karyawan.id
                                        and fs.kolom = 'foto_url' and fs.sumber_url = excluded.foto_url) then absensi.karyawan.foto_url
                          else excluded.foto_url end,
          tanggal_lahir = excluded.tanggal_lahir, tanggal_masuk = excluded.tanggal_masuk, base_harian = excluded.base_harian,
          jam_kerja = excluded.jam_kerja, multiplier_lembur = excluded.multiplier_lembur,
          tunjangan_bulanan = excluded.tunjangan_bulanan, libur_hari = excluded.libur_hari, nonaktif = excluded.nonaktif,
          gps_exempt = excluded.gps_exempt, wajib_kode_clockout = excluded.wajib_kode_clockout,
          kode_admin = excluded.kode_admin, no_shift_barrier = excluded.no_shift_barrier,
          kasbon_aktif = excluded.kasbon_aktif, kasbon_plafon_persen = excluded.kasbon_plafon_persen,
          nama_bank = excluded.nama_bank, nomor_rekening = excluded.nomor_rekening, atas_nama_rek = excluded.atas_nama_rek,
          ktp_url = case when excluded.ktp_url is null then absensi.karyawan.ktp_url
                         when exists (select 1 from absensi.foto_sumber fs where fs.karyawan_id = absensi.karyawan.id
                                       and fs.kolom = 'ktp_url' and fs.sumber_url = excluded.ktp_url) then absensi.karyawan.ktp_url
                         else excluded.ktp_url end,
          rekening_locked = excluded.rekening_locked, ekstra = excluded.ekstra
        returning (xmax = 0) as baru`;
      inc(baru ? "karyawan_baru" : "karyawan_diperbarui");
    }

    // Owner yang tidak punya dokumen karyawan tetap butuh baris supaya bisa buka dashboard.
    for (const em of OWNER_EMAILS) {
      const ada = await tx`select 1 from absensi.karyawan where lower(email) = ${em} or ${em} = any (email_lain)`;
      if (ada.length) continue;
      await tx`insert into absensi.karyawan (nama, email, peran, cabang_id) values (${em.split("@")[0].replace(/[^a-z0-9]/g, "")}, ${em}, 'owner', ${rukoId})`;
      inc("owner_dibuat");
    }

    const idByUid = new Map<string, string>();
    for (const r of await tx`select id, firebase_uid from absensi.karyawan where firebase_uid is not null`) idByUid.set(r.firebase_uid, r.id);

    // ---- absensi
    const absRows: any[] = [];
    const yatim = new Map<string, string>();
    for (const d of absDocs) {
      const x: Record<string, any> = Object.fromEntries(Object.entries(d.raw).map(([k, v]) => [k, fv(v)]));
      if (!TIPE_SAH.has(x.tipe) || !(x.ts instanceof Date)) { inc("absensi_dilewati_tipe_atau_ts"); continue; }
      if (!x.uid) { inc("absensi_dilewati_tanpa_uid"); continue; }
      if (!idByUid.has(x.uid) && !yatim.has(x.uid)) yatim.set(x.uid, teks(x.nama) || "mantan");
      absRows.push({ id: d.id, x });
    }
    // Event milik UID yang dokumen karyawannya sudah dihapus: dibuatkan baris nonaktif supaya riwayat utuh.
    for (const [uid, nm] of yatim) {
      const [{ id }] = await tx`
        insert into absensi.karyawan (firebase_uid, nama, nonaktif, perlu_tinjau, cabang_id, ekstra)
        values (${uid}, ${nm.toLowerCase().split(/\s+/)[0] || "mantan"}, true, true, ${rukoId}, '{"yatim_firebase": true}'::jsonb)
        on conflict (firebase_uid) do update set nonaktif = true
        returning id`;
      idByUid.set(uid, id);
      inc("karyawan_yatim");
    }

    const rows = absRows.map(({ id, x }) => ({
      firebase_doc_id: id,
      karyawan_id: idByUid.get(x.uid),
      cabang_id: rukoId,
      tipe: x.tipe,
      ts: x.ts.toISOString(),
      lat: angka(x.lokasi?.lat),
      lng: angka(x.lokasi?.lng),
      jarak_m: angka(x.jarak),
      in_radius: typeof x.inRadius === "boolean" ? x.inRadius : null,
      gps_exempt: x.gpsExempt === true,
      foto_selfie: teks(x.fotoSelfie),
      kode_verif: x.kodeVerif === "ok" || x.kodeVerif === "darurat" ? x.kodeVerif : null,
      no_break: x.noBreak === true,
      auto_cap: x.autoCap === true,
      otomatis: x.auto === true,
      flag: teks(x.flag),
      edit_manual: x.manualEdit === true || x.editedByOwner === true,
      diedit_at: x.editedAt instanceof Date ? x.editedAt.toISOString() : null,
      lembur_override_menit: bulat(x.lemburOverrideMin),
      istirahat_override_menit: bulat(x.istirahatOverrideMin),
      alasan_pulang_cepat: teks(x.earlyReason),
      ekstra: sisa(x, ABS_DIPAKAI),
      created_at: x.ts.toISOString(),
    }));
    const kolom = Object.keys(rows[0] || {});
    for (let i = 0; i < rows.length; i += 500) {
      const potong = rows.slice(i, i + 500);
      const r = await tx`
        insert into absensi.absensi ${tx(potong, kolom)}
        on conflict (firebase_doc_id) do update set
          karyawan_id = excluded.karyawan_id, tipe = excluded.tipe, ts = excluded.ts, lat = excluded.lat, lng = excluded.lng,
          jarak_m = excluded.jarak_m, in_radius = excluded.in_radius, gps_exempt = excluded.gps_exempt,
          foto_selfie = case when absensi.absensi.foto_selfie like 'http%' or absensi.absensi.foto_selfie is null
                             then excluded.foto_selfie else absensi.absensi.foto_selfie end,
          kode_verif = excluded.kode_verif, no_break = excluded.no_break, auto_cap = excluded.auto_cap,
          otomatis = excluded.otomatis, flag = excluded.flag, edit_manual = excluded.edit_manual,
          diedit_at = excluded.diedit_at, lembur_override_menit = excluded.lembur_override_menit,
          istirahat_override_menit = excluded.istirahat_override_menit,
          alasan_pulang_cepat = excluded.alasan_pulang_cepat, ekstra = excluded.ekstra`;
      inc("absensi_ditulis", r.count);
    }
    const idsAda = rows.map((r) => r.firebase_doc_id);
    const hapus = await tx`delete from absensi.absensi where firebase_doc_id is not null and not (firebase_doc_id = any (${idsAda}::text[]))`;
    inc("absensi_dihapus_karena_hilang_di_firebase", hapus.count);

    // ---- uang & usulan: selama jalan berdampingan Firebase yang jadi sumber, jadi ditulis ulang utuh.
    const idsKar = [...idByUid.values()];
    await tx`delete from absensi.payroll_status   where karyawan_id = any (${idsKar}::uuid[])`;
    await tx`delete from absensi.penyesuaian_gaji where karyawan_id = any (${idsKar}::uuid[])`;
    await tx`delete from absensi.libur_request    where karyawan_id = any (${idsKar}::uuid[])`;

    for (const r of karRows) {
      const kid = idByUid.get(r.firebase_uid)!;
      const x = r._x;
      const slips = new Map<string, any>();
      for (const s of [x.slipTerakhir, ...Object.values(x.slipBulan || {})]) {
        const p = s && periodeKey(s.yyyymm);
        if (p && (!slips.has(p) || (s.paidAt > (slips.get(p).paidAt || 0)))) slips.set(p, s);
      }
      const periodes = new Set<string>([...slips.keys()]);
      for (const k of Object.keys(x.bayarBulan || {})) { const p = periodeKey(k); if (p) periodes.add(p); }
      for (const p of periodes) {
        const lunas = Object.entries(x.bayarBulan || {}).some(([k, v]) => periodeKey(k) === p && v === true);
        const s = slips.get(p);
        await tx`
          insert into absensi.payroll_status (karyawan_id, periode, status, jumlah, slip, dibayar_at)
          values (${kid}, ${p}, ${lunas ? "dibayar" : "belum"}, ${lunas && s ? bulat(s.totalBayar) : null},
                  ${lunas && s ? tx.json(jsonAman(s)) : null},
                  ${lunas && s?.paidAt instanceof Date ? s.paidAt.toISOString() : null})`;
        inc(lunas ? "payroll_lunas" : "payroll_belum");
        if (lunas && s) inc("payroll_dengan_slip");
      }
      for (const [jenis, peta] of [["bonus", x.bonusBulan], ["potongan", x.potonganBulan]] as const) {
        for (const [k, v] of Object.entries(peta || {})) {
          const p = periodeKey(k), n = bulat(v);
          if (!p || !n) continue;
          await tx`insert into absensi.penyesuaian_gaji (karyawan_id, periode, jenis, jumlah) values (${kid}, ${p}, ${jenis}, ${n})`;
          inc("penyesuaian_" + jenis);
        }
      }
      const pil = Array.isArray(x.liburRequest) ? x.liburRequest.map(bulat).filter((n: any) => n != null && n >= 0 && n <= 6) : [];
      if (pil.length) {
        await tx`
          insert into absensi.libur_request (karyawan_id, pilihan, status, created_at)
          values (${kid}, ${[...new Set(pil)].slice(0, 3)}::smallint[], ${x.liburRequestPending === true ? "menunggu" : "diproses"},
                  ${x.liburRequestAt instanceof Date ? x.liburRequestAt.toISOString() : new Date().toISOString()})`;
        inc(x.liburRequestPending === true ? "libur_usulan_menunggu" : "libur_usulan_diproses");
      }
    }

    // ---- sambungkan akun Supabase. Karyawan NONAKTIF sengaja tidak disambungkan (peta WMS
    // untuk mantan karyawan pernah dicocokkan otomatis lewat nama — tidak dipercaya).
    const l0 = await tx`update absensi.karyawan set user_id = null where nonaktif and firebase_uid is not null and user_id is not null`;
    inc("akun_nonaktif_dilepas", l0.count);
    // 1) email terverifikasi sama persis
    const l1 = await tx`
      update absensi.karyawan k set user_id = u.id
        from auth.users u
       where k.user_id is null and not k.nonaktif and u.email_confirmed_at is not null
         and (lower(u.email) = lower(k.email) or lower(u.email) = any (k.email_lain))
         and not exists (select 1 from absensi.karyawan k2 where k2.user_id = u.id)`;
    inc("akun_tersambung_lewat_email", l1.count);
    // 2) peta WMS (absensi_uid) untuk yang email kerjanya beda; email WMS dicatat sebagai email_lain
    const l2 = await tx`
      update absensi.karyawan k
         set user_id = up.user_id,
             email_lain = case when lower(u.email) = any (k.email_lain) or lower(u.email) = lower(k.email)
                               then k.email_lain else k.email_lain || lower(u.email) end
        from wms.user_profiles up
        join auth.users u on u.id = up.user_id
       where up.absensi_uid = k.firebase_uid and k.user_id is null and not k.nonaktif
         and u.email_confirmed_at is not null
         and not exists (select 1 from absensi.karyawan k2 where k2.user_id = up.user_id)
         and not exists (select 1 from absensi.karyawan k3 where k3.id <> k.id
                          and (lower(k3.email) = lower(u.email) or lower(u.email) = any (k3.email_lain)))`;
    inc("akun_tersambung_lewat_wms", l2.count);

    const [cek] = await tx`
      select (select count(*) from absensi.karyawan)::int as total_karyawan,
             (select count(*) from absensi.karyawan where not nonaktif and peran <> 'owner')::int as aktif_bukan_owner,
             (select count(*) from absensi.karyawan where not nonaktif and peran <> 'owner' and user_id is null)::int as aktif_belum_punya_akun,
             (select count(*) from absensi.absensi)::int as total_absensi,
             (select count(*) from absensi.absensi where foto_selfie like 'http%')::int as selfie_masih_url_firebase`;
    Object.assign(c, cek);

    if (uji) throw new Error(BATAL_UJI);
  };

  try {
    await sql.begin(selesai);
  } catch (e) {
    if (String((e as any)?.message) !== BATAL_UJI) throw e;
  }
  return c;
}

// ---------------------------------------------------------------- mode banding
// Rumus gaji owner.js dijalankan dua kali: data Firebase vs data Supabase, per orang per periode.
// Plus dicocokkan ke slip yang sudah dibayar (potret angka saat itu).
async function bandingPayroll(sql: any, sa: any, gtok: string, periodes: string[]) {
  const geser = (d: Date) => new Date(d.getTime() + GESER_WIB_MS);

  const [karDocs, absDocs] = await Promise.all([listAll(sa, gtok, "karyawan"), listAll(sa, gtok, "absensi")]);
  const fbKar: Kar[] = karDocs.map((d) => {
    const x: Record<string, any> = Object.fromEntries(Object.entries(d.raw).map(([k, v]) => [k, fv(v)]));
    return { ...x, uid: d.id } as Kar;
  });
  const fbEv: Ev[] = [];
  for (const d of absDocs) {
    const x: Record<string, any> = Object.fromEntries(Object.entries(d.raw).map(([k, v]) => [k, fv(v)]));
    if (!(x.ts instanceof Date)) continue;
    fbEv.push({ id: d.id, uid: x.uid, email: x.email, tipe: x.tipe, ts: geser(x.ts), lemburOverrideMin: x.lemburOverrideMin, istirahatOverrideMin: x.istirahatOverrideMin });
  }

  const sbKarRows = await sql`
    select k.id, coalesce(k.firebase_uid, k.id::text) as uid, k.email, k.nama, k.base_harian, k.jam_kerja,
           k.multiplier_lembur::float8 as multiplier_lembur, k.tunjangan_bulanan
      from absensi.karyawan k
     where not (k.ekstra ? 'yatim_firebase') and k.firebase_uid is not null`;
  const peny = await sql`select karyawan_id, periode, jenis, sum(jumlah)::int as jumlah from absensi.penyesuaian_gaji group by 1, 2, 3`;
  const sbKar: Kar[] = sbKarRows.map((k: any) => {
    const pot: Record<string, number> = {}, bon: Record<string, number> = {};
    for (const p of peny) {
      if (p.karyawan_id !== k.id) continue;
      if (p.jenis === "bonus") bon[p.periode] = (bon[p.periode] || 0) + p.jumlah;
      else pot[p.periode] = (pot[p.periode] || 0) + p.jumlah;
    }
    return { uid: k.uid, email: k.email, nama: k.nama, baseHarian: k.base_harian, jamKerja: k.jam_kerja,
             multiplierLembur: k.multiplier_lembur, tunjanganBulanan: k.tunjangan_bulanan, potonganBulan: pot, bonusBulan: bon };
  });
  const sbEvRows = await sql`
    select a.firebase_doc_id as id, k.firebase_uid as uid, a.tipe::text as tipe, a.ts,
           a.lembur_override_menit, a.istirahat_override_menit
      from absensi.absensi a join absensi.karyawan k on k.id = a.karyawan_id`;
  const sbEv: Ev[] = sbEvRows.map((r: any) => ({
    id: r.id, uid: r.uid, tipe: r.tipe, ts: geser(new Date(r.ts)),
    lemburOverrideMin: r.lembur_override_menit ?? undefined, istirahatOverrideMin: r.istirahat_override_menit ?? undefined,
  }));
  const slips = await sql`
    select k.firebase_uid as uid, p.periode, (p.slip->>'totalBayar')::int as total_bayar
      from absensi.payroll_status p join absensi.karyawan k on k.id = p.karyawan_id where p.slip is not null`;

  const out: any[] = [];
  const sama = (a: number, b: number) => Math.abs((a || 0) - (b || 0)) < 1e-6;
  for (const per of periodes) {
    const fb = new Map(hitungPayroll(per, fbKar, fbEv).map((r) => [r.uid, r]));
    const sb = new Map(hitungPayroll(per, sbKar, sbEv).map((r) => [r.uid, r]));
    const uids = new Set([...fb.keys(), ...sb.keys()]);
    let cocok = 0;
    const beda: any[] = [];
    for (const u of uids) {
      const a = fb.get(u), b = sb.get(u);
      const ok = a && b && a.hariHadir === b.hariHadir && a.hariParsial === b.hariParsial && a.hariLupaCO === b.hariLupaCO &&
        sama(a.totalJamKerja, b.totalJamKerja) && sama(a.totalJamLembur, b.totalJamLembur) &&
        Math.round(a.totalBayar) === Math.round(b.totalBayar);
      if (ok) cocok++;
      else beda.push({ nama: (a || b).nama, firebase: a ? Math.round(a.totalBayar) : null, supabase: b ? Math.round(b.totalBayar) : null,
                       hadir: [a?.hariHadir, b?.hariHadir], jam: [a?.totalJamKerja, b?.totalJamKerja], lembur: [a?.totalJamLembur, b?.totalJamLembur] });
    }
    const slipPer = slips.filter((s: any) => s.periode === per);
    const slipBeda = slipPer
      .filter((s: any) => Math.round(sb.get(s.uid)?.totalBayar ?? -1) !== s.total_bayar)
      .map((s: any) => ({ nama: sb.get(s.uid)?.nama || "?", slip: s.total_bayar, hitung_ulang: Math.round(sb.get(s.uid)?.totalBayar ?? 0) }));
    const totalFb = [...fb.values()].reduce((t, r) => t + Math.round(r.totalBayar), 0);
    const totalSb = [...sb.values()].reduce((t, r) => t + Math.round(r.totalBayar), 0);
    out.push({ periode: per, orang: uids.size, cocok, beda, total_firebase: totalFb, total_supabase: totalSb,
               slip: slipPer.length, slip_cocok: slipPer.length - slipBeda.length, slip_beda: slipBeda });
  }
  return out;
}

// ------------------------------------------------------------------- mode foto
// Salin file dari Firebase Storage (URL unduhan) ke bucket privat Supabase, lalu kolomnya diganti
// jadi PATH. Jalan sampai batas waktu, sisanya dikerjakan panggilan berikutnya (idempoten:
// yang sudah berupa path tidak disentuh lagi).
async function salinFoto(sql: any, batasDetik: number) {
  const mulai = Date.now();
  const base = Deno.env.get("SUPABASE_URL")!;
  const kunci = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const c: Record<string, number> = {};
  const inc = (k: string) => (c[k] = (c[k] || 0) + 1);
  const ekstensi = (ct: string) => (ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg");

  async function ambil(sumber: string): Promise<{ bytes: Uint8Array; ct: string } | null> {
    if (sumber.startsWith("data:")) {
      const m = sumber.match(/^data:([^;]+);base64,(.*)$/s);
      return m ? { ct: m[1], bytes: Uint8Array.from(atob(m[2]), (x) => x.charCodeAt(0)) } : null;
    }
    const r = await fetch(sumber);
    if (!r.ok) { inc("unduh_gagal_http_" + r.status); return null; }
    const ct = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
    return { ct: ct.startsWith("image/") ? ct : "image/jpeg", bytes: new Uint8Array(await r.arrayBuffer()) };
  }
  const supa = createClient(base, kunci, { auth: { persistSession: false } });
  async function unggah(bucket: string, path: string, f: { bytes: Uint8Array; ct: string }) {
    const { error } = await supa.storage.from(bucket)
      .upload(path, new Blob([f.bytes], { type: f.ct }), { contentType: f.ct, upsert: true });
    if (error) {
      inc(`unggah_gagal_${bucket}`);
      const t = String(error.message || error).replace(/[^a-zA-Z0-9 _.:-]/g, " ").slice(0, 80);
      c["contoh_error_" + t] = (c["contoh_error_" + t] || 0) + 1;
      return false;
    }
    return true;
  }
  const waktuHabis = () => (Date.now() - mulai) / 1000 > batasDetik;

  // profil & KTP (sedikit) duluan. Foto profil base64 diambil ulang dari Firestore tidak perlu:
  // kolom foto_url hanya berisi URL; yang base64 dilewati di mode data.
  for (const k of await sql`select id, foto_url, ktp_url from absensi.karyawan where foto_url like 'http%' or ktp_url like 'http%'`) {
    if (waktuHabis()) break;
    for (const [kolom, bucket, nama] of [["foto_url", "absensi-profil", "avatar"], ["ktp_url", "absensi-ktp", "ktp"]] as const) {
      const src = k[kolom];
      if (!src || !src.startsWith("http")) continue;
      const f = await ambil(src).catch(() => null);
      if (!f) { inc(kolom + "_gagal"); continue; }
      const path = `${k.id}/${nama}.${ekstensi(f.ct)}`;
      if (!(await unggah(bucket, path, f))) { inc(kolom + "_gagal"); continue; }
      await sql.begin(async (tx: any) => {
        await tx`update absensi.karyawan set ${tx(kolom)} = ${path} where id = ${k.id}`;
        await tx`insert into absensi.foto_sumber (karyawan_id, kolom, sumber_url, path) values (${k.id}, ${kolom}, ${src}, ${path})
                 on conflict (karyawan_id, kolom) do update set sumber_url = excluded.sumber_url, path = excluded.path, disalin_at = now()`;
      });
      inc(kolom + "_disalin");
    }
  }

  while (!waktuHabis()) {
    const batch = await sql`
      select id, karyawan_id, firebase_doc_id, foto_selfie from absensi.absensi
       where foto_selfie like 'http%' and not (ekstra ? 'selfie_gagal_disalin')
       order by ts desc limit 40`;
    if (!batch.length) break;
    await Promise.all(batch.map(async (a: any) => {
      const f = await ambil(a.foto_selfie).catch(() => null);
      const path = f ? `${a.karyawan_id}/${a.firebase_doc_id || a.id}.${ekstensi(f.ct)}` : "";
      if (f && (await unggah("absensi-selfie", path, f))) {
        await sql`update absensi.absensi set foto_selfie = ${path} where id = ${a.id}`;
        inc("selfie_disalin");
      } else {
        // ditandai supaya tidak diulang terus; URL aslinya tetap disimpan
        await sql`update absensi.absensi set ekstra = ekstra || '{"selfie_gagal_disalin": true}'::jsonb where id = ${a.id}`;
        inc("selfie_gagal");
      }
    }));
  }

  const [sisaNya] = await sql`
    select (select count(*) from absensi.absensi where foto_selfie like 'http%' and not (ekstra ? 'selfie_gagal_disalin'))::int as selfie_sisa,
           (select count(*) from absensi.absensi where ekstra ? 'selfie_gagal_disalin')::int as selfie_gagal_total,
           (select count(*) from absensi.absensi where foto_selfie is not null and foto_selfie not like 'http%' and foto_selfie not like 'data:%')::int as selfie_sudah_path,
           (select count(*) from absensi.absensi where foto_selfie like 'data:%')::int as selfie_base64,
           (select count(*) from absensi.karyawan where foto_url like 'http%' or ktp_url like 'http%')::int as profil_ktp_sisa`;
  return { ...c, ...sisaNya, detik: Math.round((Date.now() - mulai) / 1000) };
}

Deno.serve(async (req: Request) => {
  const sql = postgres(DB_URL, { max: 1, prepare: false });
  try {
    const token = req.headers.get("x-pindah-token") || "";
    const [{ ok }] = await sql`select absensi.token_pindah_cocok(${token}) as ok`;
    if (!ok) return new Response(JSON.stringify({ ok: false, error: "forbidden" }), { status: 403 });

    const body = await req.json().catch(() => ({}));
    const [{ sa_text }] = await sql`select decrypted_secret as sa_text from vault.decrypted_secrets where name = 'absensi_firebase_sa'`;
    const sa = JSON.parse(sa_text);
    const gtok = await googleToken(sa, "https://www.googleapis.com/auth/datastore");

    if (body.mode === "inventaris") {
      const hasil: Record<string, any> = {};
      for (const kol of ["karyawan", "profil", "absensi"]) {
        const docs = await listAll(sa, gtok, kol);
        const fields: Record<string, Record<string, number>> = {};
        const sub: Record<string, Record<string, number>> = {};
        for (const d of docs) {
          for (const [k, v] of Object.entries(d.raw)) {
            const t = tipe(v);
            (fields[k] ||= {})[t] = ((fields[k] || {})[t] || 0) + 1;
            if (t === "map") {
              // kunci di dalam map: tahun-bulan disamaratakan jadi YYYY-MM
              for (const [k2, v2] of Object.entries((v as any).mapValue.fields || {})) {
                const kk = k + "." + k2.replace(/^\d{4}-?\d{2}$/, "YYYYMM") + ":" + tipe(v2);
                (sub[kk] ||= {}).n = ((sub[kk] || {}).n || 0) + 1;
              }
            }
          }
        }
        hasil[kol] = { docs: docs.length, fields, sub };
      }
      return new Response(JSON.stringify({ ok: true, hasil }), { headers: { "content-type": "application/json" } });
    }

    if (body.mode === "data") {
      const hasil = await pindahData(sql, sa, gtok, body.uji !== false);
      return new Response(JSON.stringify({ ok: true, uji: body.uji !== false, hasil }), { headers: { "content-type": "application/json" } });
    }

    if (body.mode === "banding") {
      const periodes: string[] = (Array.isArray(body.periode) ? body.periode : [body.periode])
        .filter((p: any) => /^\d{4}-\d{2}$/.test(String(p)));
      const hasil = await bandingPayroll(sql, sa, gtok, periodes);
      return new Response(JSON.stringify({ ok: true, hasil }), { headers: { "content-type": "application/json" } });
    }

    if (body.mode === "foto") {
      const hasil = await salinFoto(sql, Math.min(Math.max(Number(body.batas_detik) || 100, 10), 300));
      return new Response(JSON.stringify({ ok: true, hasil }), { headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify({ ok: false, error: "mode tidak dikenal" }), { status: 400 });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message || e).slice(0, 300) }), { status: 500 });
  } finally {
    await sql.end({ timeout: 5 });
  }
});
