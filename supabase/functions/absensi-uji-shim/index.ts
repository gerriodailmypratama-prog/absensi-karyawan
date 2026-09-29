// absensi-uji-shim — uji otomatis js/firebase-shim.js (PR-CL114).
// Membaca data LEWAT penerjemah (persis seperti owner.js di browser), menjalankan rumus gaji
// owner.js, lalu membandingkan dengan hasil dari data Firebase. Kalau ada nama field yang salah
// terjemah, gajinya ikut beda dan ketahuan di sini. Dijaga token Vault yang sama dengan absensi-pindah.
// firebase-shim.js & supabase-config.js di folder ini = salinan dari js/ (disalin saat deploy).
import postgres from "npm:postgres@3.4.5";
import { createClient } from "npm:@supabase/supabase-js@2";
import { pasangKlien, getDocs, collection, query, where, orderBy, Timestamp, db } from "./firebase-shim.js";
import { GESER_WIB_MS, hitungPayroll, prMonthRange, type Ev, type Kar } from "./payroll-goodgems.ts";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function googleToken(sa: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: sa.token_uri, iat: now, exp: now + 3600,
  })}`;
  const pem = sa.private_key.replace(/-----[A-Z ]+ KEY-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetch(sa.token_uri, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${unsigned}.${b64url(new Uint8Array(sig))}`,
  });
  const j = await res.json();
  if (!j.access_token) throw new Error("google token gagal");
  return j.access_token;
}
function fv(v: any): any {
  if (!v || typeof v !== "object") return null;
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("timestampValue" in v) return new Date(v.timestampValue);
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fv);
  if ("mapValue" in v) {
    const o: any = {};
    for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = fv(x);
    return o;
  }
  return null;
}
async function listAll(sa: any, token: string, koleksi: string) {
  const out: { id: string; x: any }[] = [];
  let pageToken = "";
  do {
    const u = new URL(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${koleksi}`);
    u.searchParams.set("pageSize", "300");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`firestore ${koleksi} ${r.status}`);
    const j = await r.json();
    for (const d of j.documents || []) {
      out.push({ id: String(d.name).split("/").pop()!, x: Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, fv(v)])) });
    }
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [{ ok }] = await sql`select absensi.token_pindah_cocok(${req.headers.get("x-pindah-token") || ""}) as ok`;
    if (!ok) return new Response("forbidden", { status: 403 });
    const body = await req.json().catch(() => ({}));
    const periodes: string[] = body.periode || [];
    const [{ sa_text }] = await sql`select decrypted_secret as sa_text from vault.decrypted_secrets where name = 'absensi_firebase_sa'`;
    const peta = new Map<string, string>();   // id supabase -> firebase uid
    for (const r of await sql`select id, firebase_uid from absensi.karyawan where firebase_uid is not null`) peta.set(r.id, r.firebase_uid);

    pasangKlien(createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      db: { schema: "absensi" }, auth: { persistSession: false, autoRefreshToken: false },
    }));
    const geser = (d: Date) => new Date(d.getTime() + GESER_WIB_MS);

    // Lewat shim: bentuk data persis yang diterima owner.js.
    const kSnap = await getDocs(collection(db, "karyawan"));
    const shimKar: any[] = [];
    kSnap.forEach((d: any) => shimKar.push(Object.assign({ uid: d.id }, d.data())));

    const sa = JSON.parse(sa_text);
    const tok = await googleToken(sa);
    const [fk, fa] = await Promise.all([listAll(sa, tok, "karyawan"), listAll(sa, tok, "absensi")]);
    const fbKar: Kar[] = fk.map((d) => Object.assign({}, d.x, { uid: d.id }));
    const fbEv: Ev[] = fa.filter((d) => d.x.ts instanceof Date).map((d) => ({
      id: d.id, uid: d.x.uid, email: d.x.email, tipe: d.x.tipe, ts: geser(d.x.ts),
      lemburOverrideMin: d.x.lemburOverrideMin, istirahatOverrideMin: d.x.istirahatOverrideMin,
    }));

    const hasil: any[] = [];
    for (const per of periodes) {
      const { start, end } = prMonthRange(per);
      // prMonthRange di runtime UTC menghasilkan jam "WIB palsu"; dikembalikan ke waktu asli untuk filter ts.
      const q = query(collection(db, "absensi"),
        where("ts", ">=", Timestamp.fromDate(new Date(start.getTime() - GESER_WIB_MS))),
        where("ts", "<=", Timestamp.fromDate(new Date(end.getTime() - GESER_WIB_MS))),
        orderBy("ts", "asc"));
      const aSnap = await getDocs(q);
      const shimEv: Ev[] = [];
      aSnap.forEach((d: any) => {
        const r = d.data();
        shimEv.push({ id: d.id, uid: r.uid, email: r.email, tipe: r.tipe, ts: geser(r.ts.toDate()),
          lemburOverrideMin: r.lemburOverrideMin, istirahatOverrideMin: r.istirahatOverrideMin });
      });
      const fb = new Map(hitungPayroll(per, fbKar, fbEv).map((r) => [r.uid, r]));
      const sh = new Map(hitungPayroll(per, shimKar, shimEv).map((r) => [peta.get(r.uid) || ("baru:" + r.uid), r]));
      let cocok = 0;
      const beda: any[] = [];
      for (const u of new Set([...fb.keys(), ...sh.keys()])) {
        const a = fb.get(u), b = sh.get(u);
        const sama = a && b && a.hariHadir === b.hariHadir && a.hariParsial === b.hariParsial
          && Math.abs(a.totalJamKerja - b.totalJamKerja) < 1e-6 && Math.abs(a.totalJamLembur - b.totalJamLembur) < 1e-6
          && Math.round(a.totalBayar) === Math.round(b.totalBayar);
        if (sama) cocok++;
        else beda.push({ nama: (a || b).nama, firebase: a && Math.round(a.totalBayar), shim: b && Math.round(b.totalBayar),
          bonus: [a?.bonus, b?.bonus], potongan: [a?.potongan, b?.potongan], jam: [a?.totalJamKerja, b?.totalJamKerja], lembur: [a?.totalJamLembur, b?.totalJamLembur] });
      }
      hasil.push({ periode: per, event_shim: shimEv.length, cocok, beda });
    }
    const cek_bentuk = {
      karyawan_shim: shimKar.length,
      ada_bayarBulan: shimKar.filter((k) => Object.keys(k.bayarBulan || {}).length).length,
      ada_slipTerakhir: shimKar.filter((k) => k.slipTerakhir).length,
      foto_link: shimKar.filter((k) => String(k.photoURL || "").startsWith("http")).length,
      ktp_link: shimKar.filter((k) => String(k.ktpUrl || "").startsWith("http")).length,
      libur_usulan: shimKar.filter((k) => Array.isArray(k.liburRequest)).length,
    };
    return new Response(JSON.stringify({ ok: true, cek_bentuk, hasil }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.stack || e).slice(0, 600) }), { status: 500 });
  } finally {
    await sql.end({ timeout: 5 });
  }
});
