/* ====================================================================
   Absensi Telegram Bot — shared library
   Baca-saja dari Firestore (Firebase Admin), hitung jam efektif SAMA
   PERSIS kayak dashboard (span jam masuk->keluar - istirahat - pause,
   di-clamp ke sesi), lalu kirim plain text ke Telegram.
   Timezone bisnis: WIB = UTC+7 (fixed; Jakarta ga ada DST).
   Tidak pernah menyentuh flow absen karyawan — ini job terpisah.
   ==================================================================== */
'use strict';
const admin = require('firebase-admin');

/* ---------- 1) ENV / guard ---------- */
function readEnv() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  const svcRaw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  return { botToken, chatId, svcRaw };
}
// true kalau semua secret siap. Kalau belum, caller sebaiknya exit 0 (skip diam).
function secretsReady() {
  const { botToken, chatId, svcRaw } = readEnv();
  return Boolean(botToken && chatId && svcRaw);
}

/* ---------- 2) Firebase Admin ---------- */
let _db = null;
function db() {
  if (_db) return _db;
  const { svcRaw } = readEnv();
  let svc;
  try { svc = JSON.parse(svcRaw); }
  catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT bukan JSON valid: ' + e.message); }
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
  _db = admin.firestore();
  return _db;
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
// Rentang epoch-UTC untuk 1 hari kalender WIB (buat query field ts).
function wibDayRange(y, moZeroBased, d) {
  const startUtc = Date.UTC(y, moZeroBased, d, 0, 0, 0) - WIB_MS;
  return { start: new Date(startUtc), end: new Date(startUtc + 24 * 3600 * 1000) };
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

/* ---------- 5) Ambil data ---------- */
// Semua karyawan (map uid -> {nama, jamKerja}). Nama pakai panggilan kalau ada.
async function fetchKaryawan() {
  const snap = await db().collection('karyawan').get();
  const map = new Map();
  snap.forEach(doc => {
    const k = doc.data() || {};
    map.set(doc.id, {
      uid: doc.id,
      nama: (k.namaPanggilan || k.nama || '(tanpa nama)').trim(),
      jamKerja: Number(k.jamKerja) || 9
    });
  });
  return map;
}
// Semua event absensi di rentang [start,end). Group per uid -> array {tipe, ts:Date}.
async function fetchEventsByUid(start, end) {
  const snap = await db().collection('absensi')
    .where('ts', '>=', admin.firestore.Timestamp.fromDate(start))
    .where('ts', '<', admin.firestore.Timestamp.fromDate(end))
    .get();
  const byUid = new Map();
  snap.forEach(doc => {
    const r = doc.data() || {};
    const uid = r.uid || r.email;
    if (!uid || !r.ts || !r.tipe) return;
    const ts = r.ts.toDate ? r.ts.toDate() : new Date(r.ts);
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push({ tipe: r.tipe, ts });
  });
  return byUid;
}

/* ---------- 6) Perhitungan 1 hari (port dari dashboard) ----------
   efektif = span(jam masuk -> jam keluar) - istirahat - pause, di-clamp
   ke [masuk..keluar]. Jam keluar: utamakan clock_out, fallback overtime_out.
   Untuk "masih in" (belum clock-out), pakai endFallbackMs sebagai penutup.  */
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
    if (open != null) { const s = Math.max(open, ciMs), en = Math.min(endMs, endMs); if (en > s) tot += en - s; }
    return tot;
  }
  const brk = sumPairs('break_in', 'break_out');
  const pse = sumPairs('pause_in', 'pause_out');
  let efektifMs = spanMs - brk - pse;
  if (efektifMs < 0) efektifMs = 0;

  const durJam = spanMs / 3600000;
  let hadir = false, parsial = false;
  if (stillIn) hadir = true;                       // masih in -> dihitung hadir
  else if (durJam >= jamKerja * 0.75) hadir = true;
  else if (durJam > 0) parsial = true;

  return {
    ci: ci.ts, ciMs,
    out: outMs ? new Date(outMs) : null, stillIn,
    spanMs, brkMs: brk, pseMs: pse, efektifMs,
    hadir, parsial,
    lateMinute: wibParts(ci.ts).mi   // menit clock-in (buat cek telat)
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

/* ---------- 8) Outbox / dedup (di Firestore) ----------
   Koleksi telegram_outbox, doc id = "<jenis>_<key>" (mis daily_2026-07-05).
   - Kalau sudah 'sent' -> skip (idempotent, ga dobel walau function jalan 2x).
   - Kalau gagal -> status 'failed' + teks DISIMPAN (ga hilang diam-diam);
     rerun (workflow_dispatch) akan nyoba kirim ulang.  */
async function sendReport(jenis, key, text) {
  const ref = db().collection('telegram_outbox').doc(jenis + '_' + key);
  const snap = await ref.get();
  if (snap.exists && snap.data().status === 'sent') {
    console.log('[skip] ' + jenis + ' ' + key + ' sudah terkirim sebelumnya.');
    return { skipped: true };
  }
  const now = admin.firestore.FieldValue.serverTimestamp();
  await ref.set({
    jenis, key, text, status: 'sending',
    attempts: admin.firestore.FieldValue.increment(1), updatedAt: now,
    createdAt: snap.exists ? (snap.data().createdAt || now) : now
  }, { merge: true });
  try {
    const result = await tgSend(text);
    await ref.set({ status: 'sent', sentAt: now, error: null, telegramMessageId: (result && result.message_id) || null }, { merge: true });
    console.log('[sent] ' + jenis + ' ' + key);
    return { sent: true };
  } catch (e) {
    await ref.set({ status: 'failed', error: String(e.message || e), updatedAt: now }, { merge: true });
    console.error('[FAILED] ' + jenis + ' ' + key + ': ' + (e.message || e));
    throw e; // bikin workflow merah biar keliatan, tapi teks udah kesimpan di outbox
  }
}

module.exports = {
  admin, db, secretsReady, readEnv,
  wibParts, wibHHMM, wibDayKey, wibDayRange, wibTanggalPanjang, wibTanggalPendek, pad2, fmtDur,
  fetchKaryawan, fetchEventsByUid, computeDay,
  tgSend, sendReport
};
