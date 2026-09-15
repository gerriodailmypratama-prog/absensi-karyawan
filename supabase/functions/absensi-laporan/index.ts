// absensi-laporan — laporan Telegram absensi GoodGems dari skema `absensi` (PR-CL114).
//
// Pengganti bot/daily.js + bot/payroll.js (GitHub Actions + Firestore). Rumus & format pesan
// dijiplak dari sana; yang beda cuma jalannya:
//   * jalan di project Supabase ini (pg_cron -> absensi.panggil_laporan), jadi TIDAK butuh
//     service role key / token bot di GitHub;
//   * pesan dititip ke kotak surat bot WMS (wms.bot_enqueue channel 'absen' = grup Absen
//     Goodgems), dedup_key per laporan -> cron jalan dua kali pun tidak dobel.
// Dipanggil dengan header x-laporan-token (Vault absensi_laporan_token), body:
//   {"jenis":"harian"}  -> hari kerja yang baru kelar (04:00 WIB kemarin s/d 04:00 WIB tadi pagi)
//   {"jenis":"gajian"}  -> periode 26 bulan lalu s/d 25 bulan ini (dijadwalkan tgl 26 pagi)
//   {"uji":true}        -> teks dikembalikan, TIDAK dikirim.
import postgres from "npm:postgres@3.4.5";

const WIB_MS = 7 * 3600 * 1000;
const CUTOFF_H = 4;
const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

function wibParts(date: Date) {
  const w = new Date(date.getTime() + WIB_MS);
  return { y: w.getUTCFullYear(), mo: w.getUTCMonth(), d: w.getUTCDate(), h: w.getUTCHours(), mi: w.getUTCMinutes(), wd: w.getUTCDay() };
}
const pad2 = (n: number) => String(n).padStart(2, "0");
const wibHHMM = (d: Date) => { const p = wibParts(d); return pad2(p.h) + ":" + pad2(p.mi); };
const wibDayKey = (d: Date) => { const p = wibParts(d); return p.y + "-" + pad2(p.mo + 1) + "-" + pad2(p.d); };
function wibDayRange(y: number, mo: number, d: number) {
  const startUtc = Date.UTC(y, mo, d, 0, 0, 0) - WIB_MS;
  return { start: new Date(startUtc), end: new Date(startUtc + 24 * 3600 * 1000) };
}
function wibShiftWindow(now: Date, cutoffH: number) {
  const t = new Date(now.getTime() - cutoffH * 3600 * 1000);
  const p = wibParts(t);
  const dayStartUtc = Date.UTC(p.y, p.mo, p.d, 0, 0, 0) - WIB_MS;
  return {
    start: new Date(dayStartUtc - 24 * 3600 * 1000 + cutoffH * 3600 * 1000),
    end: new Date(dayStartUtc + cutoffH * 3600 * 1000),
    tanggal: new Date(dayStartUtc - 24 * 3600 * 1000 + 12 * 3600 * 1000),
  };
}
const wibTanggalPanjang = (d: Date) => { const p = wibParts(d); return HARI[p.wd] + " " + p.d + " " + BULAN[p.mo] + " " + p.y; };
const wibTanggalPendek = (d: Date) => { const p = wibParts(d); return p.d + " " + BULAN[p.mo]; };
function fmtDur(ms: number) {
  if (!(ms > 0)) return "0m";
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  if (h === 0) return m + "m";
  if (m === 0) return h + "j";
  return h + "j " + m + "m";
}

type Ev = { tipe: string; ts: Date };
function computeDay(events: Ev[], jamKerja: number, endFallbackMs: number) {
  const ev = events.slice().sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const ci = ev.find((e) => e.tipe === "clock_in") || ev.find((e) => e.tipe === "overtime_in");
  if (!ci) return null;
  const ciMs = ci.ts.getTime();
  let coMs = 0, ooMs = 0;
  for (const e of ev) {
    const t = e.ts.getTime();
    if (e.tipe === "clock_out" && t > coMs) coMs = t;
    else if (e.tipe === "overtime_out" && t > ooMs) ooMs = t;
  }
  const outMs = coMs || ooMs;
  const stillIn = !outMs;
  const endMs = outMs || endFallbackMs || ciMs;
  let spanMs = endMs - ciMs;
  if (spanMs < 0) spanMs += 24 * 3600 * 1000;
  const sumPairs = (inT: string, outT: string) => {
    let tot = 0, open: number | null = null;
    for (const e of ev) {
      const t = e.ts.getTime();
      if (e.tipe === inT) open = t;
      else if (e.tipe === outT && open != null) {
        const s = Math.max(open, ciMs), en = Math.min(t, endMs);
        if (en > s) tot += en - s;
        open = null;
      }
    }
    if (open != null) { const s = Math.max(open, ciMs); if (endMs > s) tot += endMs - s; }
    return tot;
  };
  const brk = sumPairs("break_in", "break_out");
  const pse = sumPairs("pause_in", "pause_out");
  let efektifMs = spanMs - brk - pse;
  if (efektifMs < 0) efektifMs = 0;
  const durJam = spanMs / 3600000;
  let hadir = false;
  if (stillIn) hadir = true;
  else if (durJam >= jamKerja * 0.75) hadir = true;
  return { ci: ci.ts, ciMs, out: outMs ? new Date(outMs) : null, stillIn, efektifMs, hadir };
}

type Info = { nama: string; jamKerja: number; nonaktif: boolean; liburHari: number | null; tanggalLahir: string };
async function bacaData(sql: any, start: Date, end: Date) {
  const kary = new Map<string, Info>();
  // Owner & baris yatim pindahan tidak ikut laporan (di Firebase dua-duanya tidak punya dokumen karyawan).
  for (const k of await sql`
      select id, nama, jam_kerja, nonaktif, libur_hari, tanggal_lahir::text as tanggal_lahir
        from absensi.karyawan
       where peran <> 'owner' and not (ekstra ? 'yatim_firebase') and not (ekstra ? 'dihapus_owner_at')`) {
    kary.set(k.id, {
      nama: String(k.nama || "(tanpa nama)").trim(), jamKerja: Number(k.jam_kerja) || 9,
      nonaktif: k.nonaktif === true, liburHari: k.libur_hari == null ? null : Number(k.libur_hari),
      tanggalLahir: k.tanggal_lahir || "",
    });
  }
  const byKar = new Map<string, Ev[]>();
  for (const r of await sql`
      select karyawan_id, tipe::text as tipe, ts from absensi.absensi
       where ts >= ${start.toISOString()} and ts < ${end.toISOString()} order by ts, id`) {
    if (!byKar.has(r.karyawan_id)) byKar.set(r.karyawan_id, []);
    byKar.get(r.karyawan_id)!.push({ tipe: r.tipe, ts: new Date(r.ts) });
  }
  return { kary, byKar };
}

async function laporanHarian(sql: any, now: Date) {
  const win = wibShiftWindow(now, CUTOFF_H);
  const p = wibParts(win.tanggal);
  const pKirim = wibParts(now);
  const endMs = win.end.getTime();
  const { kary, byKar } = await bacaData(sql, win.start, win.end);

  const hadirRows: { ciMs: number; line: string }[] = [];
  const lupaOut: string[] = [];
  const presentIds = new Set<string>();
  let totalEfektif = 0;
  for (const [id, events] of byKar) {
    const info = kary.get(id);
    if (!info) continue;
    const d = computeDay(events, info.jamKerja, endMs);
    if (!d) continue;
    presentIds.add(id);
    totalEfektif += d.efektifMs;
    const pulang = d.stillIn ? "(ga ada clock-out)" : wibHHMM(d.out!);
    hadirRows.push({ ciMs: d.ciMs, line: "• " + info.nama + " — " + wibHHMM(d.ci) + "→" + pulang + " · " + fmtDur(d.efektifMs) + " efektif" });
    if (d.stillIn) lupaOut.push(info.nama);
  }
  hadirRows.sort((a, b) => a.ciMs - b.ciMs);

  const gaMasuk: string[] = [], liburHariItu: string[] = [], ultah: string[] = [];
  for (const [id, info] of kary) {
    if (info.nonaktif) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(info.tanggalLahir || "");
    if (m && Number(m[2]) === pKirim.mo + 1 && Number(m[3]) === pKirim.d) ultah.push(info.nama + " (" + (pKirim.y - Number(m[1])) + " th)");
    if (presentIds.has(id)) continue;
    if (info.liburHari === p.wd) liburHariItu.push(info.nama);
    else gaMasuk.push(info.nama);
  }
  for (const a of [gaMasuk, liburHariItu, ultah]) a.sort((x, y) => x.localeCompare(y, "id"));

  const lines: string[] = [];
  lines.push("🕐 ABSENSI — " + wibTanggalPanjang(win.tanggal));
  if (ultah.length) lines.push("🎂 Ulang tahun hari ini: " + ultah.join(", "));
  lines.push("Hadir: " + hadirRows.length + " orang");
  for (const r of hadirRows) lines.push(r.line);
  if (lupaOut.length) lines.push("📵 Lupa clock-out: " + lupaOut.join(", "));
  if (liburHariItu.length) lines.push("🌴 Libur: " + liburHariItu.join(", "));
  if (gaMasuk.length) lines.push("❌ Ga masuk: " + gaMasuk.join(", "));
  lines.push("📊 Total tim: " + fmtDur(totalEfektif) + " efektif");
  return { kunci: "harian:" + wibDayKey(win.tanggal), teks: lines.join("\n") };
}

async function laporanGajian(sql: any, now: Date) {
  const p = wibParts(now);
  const end = wibDayRange(p.y, p.mo, 26).start;
  let py = p.y, pm = p.mo - 1; if (pm < 0) { pm = 11; py--; }
  const start = wibDayRange(py, pm, 26).start;
  const endDisp = new Date(end.getTime() - 1000);
  const label = wibTanggalPendek(start) + " – " + wibTanggalPendek(endDisp) + " " + wibParts(endDisp).y;
  const { kary, byKar } = await bacaData(sql, start, end);

  const rows: { nama: string; hariHadir: number; totalEf: number; lupaHari: number }[] = [];
  for (const [id, events] of byKar) {
    const info = kary.get(id);
    if (!info) continue;
    const netMs = Math.max(0, info.jamKerja - 1) * 3600000;
    const byDay = new Map<string, Ev[]>();
    for (const e of events) {
      const k = wibDayKey(e.ts);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k)!.push(e);
    }
    let hariHadir = 0, totalEf = 0, lupaHari = 0;
    for (const [, evs] of byDay) {
      const d = computeDay(evs, info.jamKerja, 0);
      if (!d) continue;
      if (d.hadir) hariHadir++;
      if (d.stillIn) { totalEf += netMs; lupaHari++; } else totalEf += d.efektifMs;
    }
    if (hariHadir > 0 || totalEf > 0) rows.push({ nama: info.nama, hariHadir, totalEf, lupaHari });
  }
  rows.sort((a, b) => b.totalEf - a.totalEf || b.hariHadir - a.hariHadir);

  const lines: string[] = [];
  lines.push("💰 REKAP GAJIAN — " + label);
  lines.push("Periode tutup buku tgl 25. Jam efektif = buat lo kaliin tarif sendiri.");
  lines.push("");
  if (!rows.length) lines.push("(Belum ada data absensi di periode ini.)");
  else {
    let totalTimEf = 0, totalTimHari = 0;
    for (const r of rows) {
      totalTimEf += r.totalEf; totalTimHari += r.hariHadir;
      lines.push("• " + r.nama + " — " + r.hariHadir + " hari · " + fmtDur(r.totalEf) + " efektif"
        + (r.lupaHari ? " (⚠ " + r.lupaHari + " hr lupa clock-out, diestimasi)" : ""));
    }
    lines.push("");
    lines.push("📊 Total tim: " + totalTimHari + " hari-orang · " + fmtDur(totalTimEf) + " efektif");
  }
  lines.push("");
  lines.push("Catatan: hari \"lupa clock-out\" diestimasi = jam efektif kontrak; cek manual di dashboard kalau ragu.");
  return { kunci: "gajian:" + wibDayKey(endDisp), teks: lines.join("\n") };
}

// Pecah di batas baris; wms.bot_enqueue memotong di 3900 karakter.
function chunk(text: string, max = 3800) {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let buf = "";
  for (const ln of text.split("\n")) {
    if ((buf + "\n" + ln).length > max && buf) { out.push(buf); buf = ln; }
    else buf = buf ? buf + "\n" + ln : ln;
  }
  if (buf) out.push(buf);
  return out;
}

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const token = req.headers.get("x-laporan-token") || "";
    const [{ ok }] = await sql`select coalesce(length(${token}) = 64 and ${token} = (select decrypted_secret from vault.decrypted_secrets where name = 'absensi_laporan_token'), false) as ok`;
    if (!ok) return new Response(JSON.stringify({ ok: false, error: "forbidden" }), { status: 403 });

    const body = await req.json().catch(() => ({}));
    const now = body.waktu ? new Date(body.waktu) : new Date();
    const lap = body.jenis === "gajian" ? await laporanGajian(sql, now) : await laporanHarian(sql, now);
    const bagian = chunk(lap.teks);
    if (body.uji === true) {
      return new Response(JSON.stringify({ ok: true, uji: true, kunci: lap.kunci, bagian: bagian.length, teks: lap.teks }), { headers: { "content-type": "application/json" } });
    }

    for (let i = 0; i < bagian.length; i++) {
      await sql`select wms.bot_enqueue('absen', ${bagian[i]}, ${"absensi:" + lap.kunci + ":" + (i + 1)})`;
    }
    // Catatan jejak di skema absensi (teksnya aman walau pengiriman tertunda).
    await sql`
      insert into absensi.telegram_outbox (jenis, kunci, teks, status, attempts)
      values (${lap.kunci.split(":")[0]}, ${lap.kunci}, ${lap.teks}, 'sent', 1)
      on conflict (jenis, kunci) do update set teks = excluded.teks, attempts = absensi.telegram_outbox.attempts + 1, updated_at = now()`;
    await sql`select wms.bot_flush_outbox()`.catch(() => null);   // cron flush per menit = jaring
    return new Response(JSON.stringify({ ok: true, kunci: lap.kunci, bagian: bagian.length }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message || e).slice(0, 300) }), { status: 500 });
  } finally {
    await sql.end({ timeout: 5 });
  }
});
