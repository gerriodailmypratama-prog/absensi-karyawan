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
  const liburHariIni = [];
  for (const [uid, info] of kary) {
    if (presentUids.has(uid) || info.nonaktif) continue;
    if (info.liburHari === p.wd) liburHariIni.push(info.nama); // dijadwalkan libur hari ini -> bukan mangkir
    else gaMasuk.push(info.nama);
  }
  gaMasuk.sort((a, b) => a.localeCompare(b, 'id'));
  liburHariIni.sort((a, b) => a.localeCompare(b, 'id'));

  // Ulang tahun hari ini (pakai tanggal WIB, cocokin tgl+bulan saja).
  const ultah = [];
  for (const [, info] of kary) {
    if (info.nonaktif) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(info.tanggalLahir || '');
    if (!m) continue;
    // p.mo dari wibParts itu 0-based (Januari = 0), makanya dibandingkan dengan p.mo + 1.
    if (Number(m[2]) === p.mo + 1 && Number(m[3]) === p.d) ultah.push(info.nama + ' (' + (p.y - Number(m[1])) + ' th)');
  }
  ultah.sort((a, b) => a.localeCompare(b, 'id'));

  const lines = [];
  lines.push('🕐 ABSENSI — ' + L.wibTanggalPanjang(now));
  if (ultah.length) lines.push('🎂 Ulang tahun hari ini: ' + ultah.join(', '));
  lines.push('Hadir: ' + hadirRows.length + ' orang');
  for (const r of hadirRows) lines.push(r.line);
  if (telat.length) lines.push('⏰ Telat: ' + telat.join(', '));
  if (liburHariIni.length) lines.push('🌴 Libur: ' + liburHariIni.join(', '));
  if (gaMasuk.length) lines.push('❌ Ga masuk: ' + gaMasuk.join(', '));
  lines.push('📊 Total tim: ' + L.fmtDur(totalEfektif) + ' efektif');

  await L.sendReport('daily', dayKey, lines.join('\n'));
}
main().catch(e => { console.error(e); process.exit(1); });
