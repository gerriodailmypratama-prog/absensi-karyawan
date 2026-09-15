// absensi-ping — pergerakan absen realtime dari app absensi -> grup Telegram (PR-CL1053).
//
// Dipanggil fire-and-forget dari karyawan.js (repo absensi-karyawan) SESUDAH absen tersimpan.
// verify_jwt=false; token diverifikasi di sini, dua jenis diterima:
//   1. Firebase ID token (app absensi versi lama): tanda tangan dicek ke kunci publik Google,
//      issuer + audience wajib project absensi-karyawan-207d9.
//   2. Supabase access token (app absensi versi baru, PR-CL114): dicek lewat auth.getUser,
//      lalu dicari baris absensi.karyawan miliknya. uid yang diteruskan = firebase_uid kalau
//      ada (supaya peta wms.user_profiles.absensi_uid lama tetap nyambung), selain itu id karyawan.
// Setelah cutover & Firebase dimatikan, jalur 1 boleh dicabut.
//
// Tipis by design (pola telegram-webhook): verifikasi -> terusin ke RPC
// wms.absensi_ping_terima (aturan pesan/dedup/senyap di SQL) -> dorong flush
// biar nyampe detik itu, bukan nunggu cron menit depan.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "npm:jose@5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FIREBASE_PROJECT = "absensi-karyawan-207d9";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  db: { schema: "wms" },
  auth: { persistSession: false },
});
const adminAbsensi = createClient(SUPABASE_URL, SERVICE_KEY, {
  db: { schema: "absensi" },
  auth: { persistSession: false },
});

// Kunci publik penandatangan Firebase ID token (Google securetoken).
// jose nge-cache + refresh sendiri sesuai header cache-control Google.
const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// Token Firebase -> uid Firebase. null kalau bukan token Firebase yang sah.
async function uidDariFirebase(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT}`,
      audience: FIREBASE_PROJECT,
    });
    return String(payload.sub ?? "") || null;
  } catch (_) {
    return null;
  }
}

// Token Supabase -> uid absensi (firebase_uid kalau ada, selain itu id karyawan).
async function uidDariSupabase(token: string): Promise<string | null> {
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: k, error: e2 } = await adminAbsensi
    .from("karyawan").select("id, firebase_uid, nonaktif").eq("user_id", data.user.id).maybeSingle();
  if (e2 || !k || k.nonaktif) return null;
  return String(k.firebase_uid || k.id);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { ok: false });

  try {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return json(401, { ok: false, error: "tanpa token" });

    let iss = "";
    try { iss = String(decodeJwt(token).iss ?? ""); } catch { /* bukan JWT */ }
    const uid = iss.startsWith("https://securetoken.google.com/")
      ? await uidDariFirebase(token)
      : await uidDariSupabase(token);
    if (!uid) return json(401, { ok: false, error: "token gak sah" });

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* body kosong = biarin RPC yang nolak */ }

    const { data, error } = await admin.rpc("absensi_ping_terima", {
      p: {
        uid,                                   // dari token — bukan dari body
        nama: String(body.nama ?? "").slice(0, 60),
        tipe: String(body.tipe ?? ""),
        in_radius: body.in_radius !== false,   // default true
        gps_exempt: body.gps_exempt === true,
        // PR-CL1058: total menit dari client (istirahat / kerja efektif) —
        // sanity & label di RPC, sini cuma nerusin angka bulat.
        total_menit: Number.isFinite(Number(body.total_menit)) ? Math.round(Number(body.total_menit)) : null,
      },
    });
    if (error) {
      console.error("absensi_ping_terima:", error.message);
      return json(200, { ok: false }); // client fire-and-forget; jangan bikin dia retry
    }

    // Dorong outbox biar realtime beneran (grant flush udah ada, PR-CL983).
    if ((data as Record<string, unknown> | null)?.aksi === "kirim") {
      const { error: fErr } = await admin.rpc("bot_flush_outbox");
      if (fErr) console.error("flush:", fErr.message); // cron per menit = jaring
    }

    return json(200, { ok: true, aksi: (data as Record<string, unknown> | null)?.aksi ?? null });
  } catch (e) {
    console.error("absensi-ping:", String((e as Error)?.message ?? e));
    return json(200, { ok: false });
  }
});
