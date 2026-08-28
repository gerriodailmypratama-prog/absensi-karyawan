/* Laporan harian absensi -> Telegram. Dijadwalkan 05:30 WIB (22:30 UTC),
   ngelaporin HARI KERJA YANG BARU KELAR: jendela 04:00 WIB kemarin s/d
   04:00 WIB tadi pagi (PR-CL100).

   Kenapa dirombak dari versi "21:00 WIB ngelaporin hari ini":
   1. Tim sekarang rutin lembur lewat tengah malam (pulang 23:48, 00:16,
      01:15, 02:28). Rekap jam 21:00 motong hari sebelum selesai — shift
      malam kecap "Ga masuk" (kejadian nyata: 26 Agu, mila clock-in 21:36,
      rekap kekirim 21:31 -> mila "Ga masuk").
   2. GitHub cron bisa ngaret berjam-jam (27 Agu ngaret 9 jam, jalan 06:15
      pagi 28 Agu). Versi lama ngelaporin "hari pas dia jalan", jadi yang
      kekirim rekap subuh isi 5 orang + belasan "Ga masuk" palsu. Sekarang
      targetnya = jendela yang paling baru KELAR — telat pun tetap
      ngelaporin hari yang bener.
   Baca-saja; ga pernah nyentuh flow absen. Idempotent per tanggal WIB
   (jenis 'harian' — namespace baru biar ga ketabrak dedup 'daily' lama). */
'use strict';
const L = require('./lib');

const CUTOFF_H = 4; // batas hari kerja: jam 4 pagi WIB (clock-in paling pagi ~05:55)

async function main() {
  if (!L.secretsReady()) {
    console.warn('Secret belum lengkap (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / FIREBASE_SERVICE_ACCOUNT). Laporan harian di-skip.');
    return;
  }
  const now = new Date();
  const win = L.wibShiftWindow(now, CUTOFF_H);
  const p = L.wibParts(win.tanggal);          // hari TARGET (buat libur/label)
  const pKirim = L.wibParts(now);             // hari KIRIM (buat ultah pagi ini)
  const dayKey = L.wibDayKey(win.tanggal);
  // Jendelanya udah kelar, jadi penutup buat yang ga clock-out = ujung jendela
  // (bukan "sekarang" — kalau pakai now, orang yang lupa clock-out kehitung
  // kerja sampai subuh dan jam efektifnya menggelembung).
  const endMs = win.end.getTime();

  const kary = await L.fetchKaryawan();
  const byUid = await L.fetchEventsByUid(win.start, win.end);

  const hadirRows = [];
  const telat = [];
  const lupaOut = [];
  const presentUids = new Set();
  let totalEfektif = 0;

  for (const [uid, events] of byUid) {
    const info = kary.get(uid);
    if (!info) continue; // event tanpa karyawan aktif -> lewati
    const d = L.computeDay(events, info.jamKerja, endMs);
    if (!d) continue;
    presentUids.add(uid);
    totalEfektif += d.efektifMs;
    const masuk = L.wibHHMM(d.ci);
    const pulang = d.stillIn ? '(ga ada clock-out)' : L.wibHHMM(d.out);
    hadirRows.push({
      nama: info.nama, ciMs: d.ciMs,
      line: '• ' + info.nama + ' — ' + masuk + '→' + pulang + ' · ' + L.fmtDur(d.efektifMs) + ' efektif'
    });
    if (d.lateMinute > 15) telat.push(info.nama + ' (' + masuk + ')');
    if (d.stillIn) lupaOut.push(info.nama);
  }

  hadirRows.sort((a, b) => a.ciMs - b.ciMs);

  const gaMasuk = [];
  const liburHariItu = [];
  for (const [uid, info] of kary) {
    if (presentUids.has(uid) || info.nonaktif) continue;
    if (info.liburHari === p.wd) liburHariItu.push(info.nama); // dijadwalkan libur hari target -> bukan mangkir
    else gaMasuk.push(info.nama);
  }
  gaMasuk.sort((a, b) => a.localeCompare(b, 'id'));
  liburHariItu.sort((a, b) => a.localeCompare(b, 'id'));

  // Ulang tahun: pakai hari PENGIRIMAN (laporan nyampe pagi -> ucapannya
  // buat hari ini, bukan kemarin).
  const ultah = [];
  for (const [, info] of kary) {
    if (info.nonaktif) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(info.tanggalLahir || '');
    if (!m) continue;
    if (Number(m[2]) === pKirim.mo + 1 && Number(m[3]) === pKirim.d) ultah.push(info.nama + ' (' + (pKirim.y - Number(m[1])) + ' th)');
  }
  ultah.sort((a, b) => a.localeCompare(b, 'id'));

  const lines = [];
  lines.push('🕐 ABSENSI — ' + L.wibTanggalPanjang(win.tanggal));
  if (ultah.length) lines.push('🎂 Ulang tahun hari ini: ' + ultah.join(', '));
  lines.push('Hadir: ' + hadirRows.length + ' orang');
  for (const r of hadirRows) lines.push(r.line);
  if (telat.length) lines.push('⏰ Telat: ' + telat.join(', '));
  if (lupaOut.length) lines.push('📵 Lupa clock-out: ' + lupaOut.join(', '));
  if (liburHariItu.length) lines.push('🌴 Libur: ' + liburHariItu.join(', '));
  if (gaMasuk.length) lines.push('❌ Ga masuk: ' + gaMasuk.join(', '));
  lines.push('📊 Total tim: ' + L.fmtDur(totalEfektif) + ' efektif');

  await L.sendReport('harian', dayKey, lines.join('\n'));
}
main().catch(e => { console.error(e); process.exit(1); });
