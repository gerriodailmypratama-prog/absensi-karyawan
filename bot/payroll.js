/* Rekap periode gajian -> Telegram. Dijadwalkan tiap tanggal 26 pagi WIB.
   Periode: 26 bulan lalu 00:00 WIB s/d 25 bulan ini 23:59 WIB.
   Per karyawan: total HARI hadir + total JAM EFEKTIF, urut terbanyak.
   TANPA estimasi upah (owner kaliin tarif sendiri). Baca-saja, idempotent. */
'use strict';
const L = require('./lib');

function periodRange(now) {
  const p = L.wibParts(now);
  const end = L.wibDayRange(p.y, p.mo, 26).start;        // 26 bulan ini 00:00 WIB (exclusive)
  let py = p.y, pm = p.mo - 1; if (pm < 0) { pm = 11; py--; }
  const start = L.wibDayRange(py, pm, 26).start;         // 26 bulan lalu 00:00 WIB
  const endDisp = new Date(end.getTime() - 1000);        // 25 bulan ini 23:59:59 WIB
  const ep = L.wibParts(endDisp);
  const label = L.wibTanggalPendek(start) + ' – ' + L.wibTanggalPendek(endDisp) + ' ' + ep.y;
  const key = L.wibDayKey(endDisp);                      // mis 2026-07-25
  return { start, end, endDisp, label, key };
}

async function main() {
  if (!L.secretsReady()) {
    console.warn('Secret belum lengkap. Rekap gajian di-skip.');
    return;
  }
  const now = new Date();
  const { start, end, label, key } = periodRange(now);

  const kary = await L.fetchKaryawan();
  const byUid = await L.fetchEventsByUid(start, end);

  const rows = [];
  for (const [uid, events] of byUid) {
    const info = kary.get(uid);
    if (!info) continue;
    const netMs = Math.max(0, (info.jamKerja - 1)) * 3600000;

    const byDay = new Map();
    for (const e of events) {
      const k = L.wibDayKey(e.ts);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(e);
    }
    let hariHadir = 0, totalEf = 0, lupaHari = 0;
    for (const [, evs] of byDay) {
      const d = L.computeDay(evs, info.jamKerja, 0);
      if (!d) continue;
      if (d.hadir) hariHadir++;
      if (d.stillIn) { totalEf += netMs; lupaHari++; }   // lupa clock-out (hari lampau) diestimasi = jam efektif kontrak
      else totalEf += d.efektifMs;
    }
    if (hariHadir > 0 || totalEf > 0) rows.push({ nama: info.nama, hariHadir, totalEf, lupaHari });
  }

  rows.sort((a, b) => b.totalEf - a.totalEf || b.hariHadir - a.hariHadir);

  const lines = [];
  lines.push('💰 REKAP GAJIAN — ' + label);
  lines.push('Periode tutup buku tgl 25. Jam efektif = buat lo kaliin tarif sendiri.');
  lines.push('');
  if (!rows.length) {
    lines.push('(Belum ada data absensi di periode ini.)');
  } else {
    let totalTimEf = 0, totalTimHari = 0;
    for (const r of rows) {
      totalTimEf += r.totalEf; totalTimHari += r.hariHadir;
      lines.push('• ' + r.nama + ' — ' + r.hariHadir + ' hari · ' + L.fmtDur(r.totalEf) + ' efektif'
        + (r.lupaHari ? ' (⚠ ' + r.lupaHari + ' hr lupa clock-out, diestimasi)' : ''));
    }
    lines.push('');
    lines.push('📊 Total tim: ' + totalTimHari + ' hari-orang · ' + L.fmtDur(totalTimEf) + ' efektif');
  }
  lines.push('');
  lines.push('Catatan: hari "lupa clock-out" diestimasi = jam efektif kontrak; cek manual di dashboard kalau ragu.');

  await L.sendReport('gajian', key, lines.join('\n'));
}
main().catch(e => { console.error(e); process.exit(1); });
