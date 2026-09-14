/* ====================================================================
   Kopikiri Absensi — Telegram Bot, shared library
   Baca-saja dari Postgres (Supabase) pakai service role key, hitung jam
   efektif SAMA PERSIS kayak dashboard (span jam masuk->keluar - istirahat,
   di-clamp ke sesi), lalu kirim plain text ke Telegram.

   Pindahan dari versi Firestore (repo absensi-karyawan). Yang ganti CUMA
   SUMBER DATANYA — rumus, format pesan, jadwal, dan mekanisme anti-gagal
   dijiplak 1:1 dari GoodGems. Kolom cabang_id emang udah ada di tabel, tapi
   SENGAJA dicuekin di sini: datanya belum ada dari klien, dan owner mau
   tahap pertama sama persis dulu. Nanti cabang cuma jadi label + filter.

   Timezone bisnis: WIB = UTC+7 (fixed; Jakarta ga ada DST).
   BACA-SAJA. Bot ga pernah nulis ke tabel absensi/karyawan — kalau bot
   rusak, absen karyawan ga boleh ikut rusak. Satu-satunya tabel yang
   ditulis: telegram_outbox (punya bot sendiri).
   ==================================================================== */
'use strict';
const { createClient } = require('@supabase/supabase-js');

/* ---------- 1) ENV / guard ---------- */
function readEnv() {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    supabaseUrl: process.env.SUPABASE_URL || '',
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    // DRY_RUN=1 -> cetak pesan ke layar, ga kirim ke Telegram, ga nyentuh
    // outbox. Buat ngetes query tanpa ganggu grup.
    dryRun: /^(1|true|yes)$/i.test(process.env.DRY_RUN || '')
  };
}
// true kalau semua secret siap. Kalau belum, caller sebaiknya exit 0 (skip diam).
function secretsReady() {
  const e = readEnv();
  if (!e.supabaseUrl || !e.serviceKey) return false;
  if (e.dryRun) return true;                    // dry-run ga butuh token Telegram
  return Boolean(e.botToken && e.chatId);
}

/* ---------- 2) Supabase client (service role, baca-saja) ---------- */
let _sb = null;
function sb() {
  if (_sb) return _sb;
  const { supabaseUrl, serviceKey } = readEnv();
  if (!supabaseUrl || !serviceKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diisi.');
  _sb = createClient(supabaseUrl, serviceKey, {
    // Job cron, bukan browser: ga usah simpan/refresh sesi.
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-client-info': 'kopikiri-telegram-bot' } }
  });
  return _sb;
}

/* ---------- 3) WIB helpers (fixed UTC+7) ---------- */
const WIB_MS = 7 * 3600 * 1000;
// Date yang field UTC-nya = jam dinding WIB (buat dibaca pakai getUTC*).
function wibParts(date) {
  const w = new Date(date.getTime() + WIB_MS);
  return {
    y: w.getUTCFullYear(), mo: w.getUTCMonth(), d: w.getUTCDate(),
    h: w.getUTCHours(), mi: w.getUTCMinutes(), wd: w.getUTCDay()
  };
}
function pad2(n) { return String(n).padStart(2, '0'); }
function wibHHMM(date) { const p = wibParts(date); return pad2(p.h) + ':' + pad2(p.mi); }
function wibDayKey(date) { const p = wibParts(date); return p.y + '-' + pad2(p.mo + 1) + '-' + pad2(p.d); }
// Rentang epoch-UTC untuk 1 hari kalender WIB.
function wibDayRange(y, moZeroBased, d) {
  const startUtc = Date.UTC(y, moZeroBased, d, 0, 0, 0) - WIB_MS;
  return { start: new Date(startUtc), end: new Date(startUtc + 24 * 3600 * 1000) };
}
// Jendela "hari kerja" = [cutoff 04:00 WIB, 04:00 WIB besoknya] — shift malam
// dan lembur lewat tengah malam tetap milik hari yang sama. Balikin jendela
// yang PALING BARU KELAR, jadi run yang telat berjam-jam (GitHub cron pernah
// ngaret 9 jam, 27->28 Agu 2026) tetap ngelaporin hari yang bener — bukan
// "hari pas dia kebetulan jalan".
function wibShiftWindow(now, cutoffH) {
  const t = new Date(now.getTime() - cutoffH * 3600 * 1000);
  const p = wibParts(t);
  const dayStartUtc = Date.UTC(p.y, p.mo, p.d, 0, 0, 0) - WIB_MS; // 00:00 WIB hari kalender t
  const start = new Date(dayStartUtc - 24 * 3600 * 1000 + cutoffH * 3600 * 1000); // kemarin 04:00
  const end   = new Date(dayStartUtc + cutoffH * 3600 * 1000);                    // hari ini 04:00
  const tanggal = new Date(dayStartUtc - 24 * 3600 * 1000 + 12 * 3600 * 1000);    // tengah hari target (buat label)
  return { start, end, tanggal };
}
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
function wibTanggalPanjang(date) { const p = wibParts(date); return HARI[p.wd] + ' ' + p.d + ' ' + BULAN[p.mo] + ' ' + p.y; }
function wibTanggalPendek(date) { const p = wibParts(date); return p.d + ' ' + BULAN[p.mo]; }

/* ---------- 4) Format durasi (ala "8j 15m") ---------- */
function fmtDur(ms) {
  if (!(ms > 0)) return '0m';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  if (h === 0) return m + 'm';
  if (m === 0) return h + 'j';
  return h + 'j ' + m + 'm';
}

/* ---------- 5) Ambil data (SELECT doang) ----------
   PostgREST motong hasil di 1000 baris. 150 karyawan x 30 hari x 4 pencetan
   ~ 18.000 baris pas rekap gajian — jadi WAJIB dipaging, jangan percaya
   sekali select. Ini jebakan yang ga ada di versi Firestore. */
const PAGE = 1000;
async function fetchAll(label, buildQuery) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildQuery(from, from + PAGE - 1);
    if (error) throw new Error('Gagal baca ' + label + ': ' + error.message);
    const rows = data || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// Semua karyawan (map id -> info). Kolom `nama` di skema Kopikiri udah nama
// panggilan (yang tampil di layar), jadi ga ada lagi namaPanggilan||nama.
async function fetchKaryawan() {
  const rows = await fetchAll('karyawan', (a, b) => sb()
    .from('karyawan')
    .select('id, nama, jam_kerja, nonaktif, libur_hari, tanggal_lahir')
    .order('id').range(a, b));
  const map = new Map();
  for (const k of rows) {
    map.set(k.id, {
      id: k.id,
      nama: String(k.nama || '(tanpa nama)').trim(),
      jamKerja: Number(k.jam_kerja) || 8,
      nonaktif: k.nonaktif === true,
      liburHari: (k.libur_hari != null ? Number(k.libur_hari) : null),
      // kolom date di Postgres balik sebagai 'YYYY-MM-DD' — sama persis kayak
      // string tanggalLahir di Firestore, jadi regex ultah ga usah diubah.
      tanggalLahir: (typeof k.tanggal_lahir === 'string' ? k.tanggal_lahir.trim() : '')
    });
  }
  return map;
}

// Semua event absensi di rentang [start,end). Group per karyawan_id ->
// array {tipe, ts:Date}. (Pengganti fetchEventsByUid versi Firestore.)
async function fetchEventsByKaryawan(start, end) {
  const rows = await fetchAll('absensi', (a, b) => sb()
    .from('absensi')
    .select('id, karyawan_id, tipe, ts')
    .gte('ts', start.toISOString())
    .lt('ts', end.toISOString())
    // urut ts + id: ts doang bisa seri dan bikin paging loncat/dobel.
    .order('ts', { ascending: true }).order('id', { ascending: true })
    .range(a, b));
  const byKar = new Map();
  for (const r of rows) {
    if (!r.karyawan_id || !r.ts || !r.tipe) continue;
    const ts = new Date(r.ts);
    if (isNaN(ts.getTime())) continue;
    if (!byKar.has(r.karyawan_id)) byKar.set(r.karyawan_id, []);
    byKar.get(r.karyawan_id).push({ tipe: r.tipe, ts });
  }
  return byKar;
}

/* ---------- 6) Perhitungan 1 hari (port dari dashboard) ----------
   efektif = span(jam masuk -> jam keluar) - istirahat, di-clamp ke
   [masuk..keluar]. Jam keluar: utamakan clock_out, fallback overtime_out.
   Untuk "masih in" (belum clock-out), pakai endFallbackMs sebagai penutup.
   Catatan: skema Kopikiri ga punya event pause_in/pause_out (enum tipe_absen
   cuma clock/break/overtime), jadi bagian pause versi lama dibuang — bukan
   kelupaan. Kalau nanti pause dipasang lagi, tinggal tambah sumPairs-nya. */
function computeDay(events, jamKerja, endFallbackMs) {
  const ev = events.slice().sort((a, b) => a.ts - b.ts);
  const ci = ev.find(e => e.tipe === 'clock_in') || ev.find(e => e.tipe === 'overtime_in');
  if (!ci) return null; // ga masuk hari itu
  const ciMs = ci.ts.getTime();

  let coMs = 0, ooMs = 0;
  for (const e of ev) {
    const t = e.ts.getTime();
    if (e.tipe === 'clock_out' && t > coMs) coMs = t;
    else if (e.tipe === 'overtime_out' && t > ooMs) ooMs = t;
  }
  const outMs = coMs || ooMs;         // 0 = belum clock-out
  const stillIn = !outMs;
  const endMs = outMs || endFallbackMs || ciMs;  // fallback aman kalau belum clock-out
  let spanMs = endMs - ciMs;
  if (spanMs < 0) spanMs += 24 * 3600 * 1000; // lintas tengah malam

  function sumPairs(inT, outT) {
    let tot = 0, open = null;
    for (const e of ev) {
      const t = e.ts.getTime();
      if (e.tipe === inT) open = t;
      else if (e.tipe === outT && open != null) {
        const s = Math.max(open, ciMs), en = Math.min(t, endMs);
        if (en > s) tot += en - s;
        open = null;
      }
    }
    // istirahat yang belum ditutup -> dihitung sampai ujung sesi
    if (open != null) { const s = Math.max(open, ciMs); if (endMs > s) tot += endMs - s; }
    return tot;
  }
  const brk = sumPairs('break_in', 'break_out');
  let efektifMs = spanMs - brk;
  if (efektifMs < 0) efektifMs = 0;

  const durJam = spanMs / 3600000;
  let hadir = false, parsial = false;
  if (stillIn) hadir = true;                       // masih in -> dihitung hadir
  else if (durJam >= jamKerja * 0.75) hadir = true;
  else if (durJam > 0) parsial = true;

  return {
    ci: ci.ts, ciMs,
    out: outMs ? new Date(outMs) : null, stillIn,
    spanMs, brkMs: brk, efektifMs,
    hadir, parsial,
    lateMinute: wibParts(ci.ts).mi   // menit clock-in (buat cek telat, sama kayak versi lama)
  };
}

/* ---------- 7) Telegram (plain text, retry, auto-chunk) ---------- */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function tgSendOnce(text) {
  const { botToken, chatId } = readEnv();
  const res = await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // SENGAJA tanpa parse_mode: nama dengan karakter spesial ga bikin gagal kirim.
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const err = new Error('Telegram ' + res.status + ': ' + (data.description || 'unknown'));
    err.retryable = res.status >= 500 || res.status === 429;
    throw err;
  }
  return data.result;
}
// Pecah pesan panjang (>4000) di batas baris biar aman dari limit 4096 Telegram.
// Di Kopikiri (~150 karyawan) rekap harian hampir pasti kepecah — makanya
// bagian ini dipertahanin apa adanya.
function chunk(text, max = 4000) {
  if (text.length <= max) return [text];
  const out = [], lines = text.split('\n');
  let buf = '';
  for (const ln of lines) {
    if ((buf + '\n' + ln).length > max && buf) { out.push(buf); buf = ln; }
    else buf = buf ? buf + '\n' + ln : ln;
  }
  if (buf) out.push(buf);
  return out;
}
async function tgSend(text) {
  const parts = chunk(text);
  let last = null;
  for (const part of parts) {
    let attempt = 0, lastErr = null;
    while (attempt < 4) {
      try { last = await tgSendOnce(part); lastErr = null; break; }
      catch (e) {
        lastErr = e; attempt++;
        if (!e.retryable || attempt >= 4) break;
        await sleep(1500 * attempt);
      }
    }
    if (lastErr) throw lastErr;
    await sleep(400); // jeda antar-chunk
  }
  return last;
}

/* ---------- 8) Outbox / dedup (tabel telegram_outbox di Postgres) ----------
   Pengganti koleksi Firestore yang sama persis. Baris dikunci (jenis, kunci),
   mis. ('harian', '2026-08-29').
   - Kalau sudah 'sent' -> skip (idempotent, ga dobel walau cron jalan 2x).
   - Kalau gagal -> status 'failed' + teks DISIMPAN (ga hilang diam-diam);
     rerun (workflow_dispatch) nyoba kirim ulang.
   Ini SATU-SATUNYA tabel yang ditulis bot. */
async function sendReport(jenis, kunci, text) {
  const { dryRun, chatId } = readEnv();

  if (dryRun) {
    console.log('\n===== [DRY RUN] ' + jenis + ' / ' + kunci + ' =====');
    console.log(text);
    console.log('===== (' + text.length + ' karakter, ' + chunk(text).length + ' pesan) =====\n');
    return { dryRun: true, text };
  }

  const db = sb();
  const { data: existing, error: readErr } = await db
    .from('telegram_outbox')
    .select('id, status, attempts')
    .eq('jenis', jenis).eq('kunci', kunci)
    .maybeSingle();
  if (readErr) throw new Error('Gagal baca outbox: ' + readErr.message);

  if (existing && existing.status === 'sent') {
    console.log('[skip] ' + jenis + ' ' + kunci + ' sudah terkirim sebelumnya.');
    return { skipped: true };
  }

  // Catat DULU sebelum kirim — ini inti anti-gagalnya: teksnya aman duluan.
  const { error: upErr } = await db.from('telegram_outbox').upsert({
    jenis, kunci, chat_id: String(chatId || ''), teks: text,
    status: 'sending',
    attempts: ((existing && Number(existing.attempts)) || 0) + 1,
    error: null,
    updated_at: new Date().toISOString()
  }, { onConflict: 'jenis,kunci' });
  if (upErr) throw new Error('Gagal nulis outbox: ' + upErr.message);

  try {
    const result = await tgSend(text);
    await db.from('telegram_outbox').update({
      status: 'sent', sent_at: new Date().toISOString(), error: null,
      telegram_message_id: (result && result.message_id) || null,
      updated_at: new Date().toISOString()
    }).eq('jenis', jenis).eq('kunci', kunci);
    console.log('[sent] ' + jenis + ' ' + kunci);
    return { sent: true };
  } catch (e) {
    await db.from('telegram_outbox').update({
      status: 'failed', error: String(e.message || e), updated_at: new Date().toISOString()
    }).eq('jenis', jenis).eq('kunci', kunci);
    console.error('[FAILED] ' + jenis + ' ' + kunci + ': ' + (e.message || e));
    throw e; // bikin workflow merah biar keliatan, tapi teks udah kesimpan di outbox
  }
}

module.exports = {
  sb, secretsReady, readEnv,
  wibParts, wibHHMM, wibDayKey, wibDayRange, wibShiftWindow,
  wibTanggalPanjang, wibTanggalPendek, pad2, fmtDur,
  fetchKaryawan, fetchEventsByKaryawan, computeDay,
  tgSend, sendReport
};
