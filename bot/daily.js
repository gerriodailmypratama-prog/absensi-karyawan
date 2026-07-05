/* Laporan harian absensi -> Telegram. Dijadwalkan 21:00 WIB (14:00 UTC).
   Baca-saja; ga pernah nyentuh flow absen. Idempotent per tanggal WIB. */
'use strict';
const L = require('./lib');

async function main() {
  if (!L.secretsReady()) {
    console.warn('Secret belum lengkap (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / FIREBASE_SERVICE_ACCOUNT). Laporan harian di-skip.');
    return;
  }
  const now = new Date();
  const p = L.wibParts(now);
  const { start, end } = L.wibDayRange(p.y, p.mo, p.d);
  const dayKey = L.wibDayKey(now);
  const nowMs = now.getTime();

  const kary = await L.fetchKaryawan();
  const byUid = await L.fetchEventsByUid(start, end);

  const hadirRows = [];
  const telat = [];
  const presentUids = new Set();
  let totalEfektif = 0;

  for (const [uid, events] of byUid) {
    const info = kary.get(uid);
    if (!info) continue; // event tanpa karyawan aktif -> lewati
    const d = L.computeDay(events, info.jamKerja, nowMs);
    if (!d) continue;
    presentUids.add(uid);
    totalEfektif += d.efektifMs;
    const masuk = L.wibHHMM(d.ci);
    const pulang = d.stillIn ? '(belum clock-out)' : L.wibHHMM(d.out);
    hadirRows.push({
      nama: info.nama, ciMs: d.ciMs,
      line: '• ' + info.nama + ' — ' + masuk + '→' + pulang + ' · ' + L.fmtDur(d.efektifMs) + ' efektif'
    });
    if (d.lateMinute > 15) telat.push(info.nama + ' (' + masuk + ')');
  }

  hadirRows.sort((a, b) => a.ciMs - b.ciMs);

  const gaMasuk = [];
  for (const [uid, info] of kary) if (!presentUids.has(uid)) gaMasuk.push(info.nama);
  gaMasuk.sort((a, b) => a.localeCompare(b, 'id'));

  const lines = [];
  lines.push('🕐 ABSENSI — ' + L.wibTanggalPanjang(now));
  lines.push('Hadir: ' + hadirRows.length + ' orang');
  for (const r of hadirRows) lines.push(r.line);
  if (telat.length) lines.push('⏰ Telat: ' + telat.join(', '));
  if (gaMasuk.length) lines.push('❌ Ga masuk: ' + gaMasuk.join(', '));
  lines.push('📊 Total tim: ' + L.fmtDur(totalEfektif) + ' efektif');

  await L.sendReport('daily', dayKey, lines.join('\n'));
}
main().catch(e => { console.error(e); process.exit(1); });
