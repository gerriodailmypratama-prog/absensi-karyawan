// Salinan 1:1 rumus calcPayroll() di js/owner.js (per 14 Sep 2026, setelah PR-CL111) — hanya
// bagian hitung, tanpa DOM. Dipakai mode "banding" untuk membuktikan data Supabase menghasilkan
// gaji yang sama persis dengan data Firebase.
//
// ZONA WAKTU: owner.js jalan di browser WIB dan memakai getDate()/new Date(y,m,d). Edge runtime
// jalan di UTC, jadi SEMUA timestamp digeser +7 jam sebelum masuk sini; di dalam, jam "lokal"
// = jam WIB. Durasi tidak terpengaruh pergeseran.
export const GESER_WIB_MS = 7 * 3600 * 1000;
const PR_CUTOFF_DAY = 25;
const PR_TRANSISI = "2026-07";
const RATE_LEMBUR_FLAT = 12500;

export type Kar = {
  uid: string; email?: string; nama?: string;
  baseHarian?: any; jamKerja?: any; multiplierLembur?: any; tunjanganBulanan?: any;
  potonganBulan?: Record<string, any>; bonusBulan?: Record<string, any>;
};
export type Ev = { uid?: string; email?: string; tipe: string; ts: Date; lemburOverrideMin?: any; istirahatOverrideMin?: any; id: string };

export function prMonthRange(yyyymm: string) {
  const parts = yyyymm.split("-").map(Number);
  const y = parts[0], m = parts[1];
  const cut = PR_CUTOFF_DAY;
  let start: Date, end: Date;
  if (yyyymm < PR_TRANSISI) {
    start = new Date(y, m - 1, 1, 0, 0, 0, 0);
    end = new Date(y, m, 0, 23, 59, 59, 999);
  } else if (yyyymm === PR_TRANSISI) {
    start = new Date(y, m - 1, 1, 0, 0, 0, 0);
    end = new Date(y, m - 1, cut, 23, 59, 59, 999);
  } else {
    start = new Date(y, m - 2, cut + 1, 0, 0, 0, 0);
    end = new Date(y, m - 1, cut, 23, 59, 59, 999);
  }
  return { start, end };
}

export function hitungPayroll(yyyymm: string, karyawan: Kar[], semuaEvent: Ev[]) {
  const { start, end } = prMonthRange(yyyymm);
  const byPerson = new Map<string, Map<string, any[]>>();
  function _localDay(d: Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + dd;
  }
  const evs = semuaEvent.filter((e) => e.ts >= start && e.ts <= end).sort((a, b) => a.ts.getTime() - b.ts.getTime());
  for (const r of evs) {
    const key = r.uid || r.email;
    if (!key) continue;
    if (!byPerson.has(key)) byPerson.set(key, new Map());
    const personMap = byPerson.get(key)!;
    const ts = r.ts;
    const dateStr = _localDay(ts);
    if (!personMap.has(dateStr)) personMap.set(dateStr, []);
    personMap.get(dateStr)!.push({ tipe: r.tipe, ts: ts, id: r.id, lemburOverrideMin: r.lemburOverrideMin, istirahatOverrideMin: r.istirahatOverrideMin });
  }
  const rows: any[] = [];
  for (const k of karyawan) {
    const baseHarian = parseInt(k.baseHarian, 10) || 0;
    const jamKerja = parseInt(k.jamKerja, 10) || 9;
    const multiplierLembur = parseFloat(k.multiplierLembur) || 1;
    const netJamKerja = Math.max(1, jamKerja - 1);
    const ratePerJam = netJamKerja > 0 ? (baseHarian / netJamKerja) : 0;
    const rateLemburPerJam = RATE_LEMBUR_FLAT;
    const personMap = byPerson.get(k.uid) || (k.email ? byPerson.get(k.email) : undefined) || new Map();
    let hariHadir = 0, hariParsial = 0, totalJamLembur = 0, totalJamKerja = 0, totalKontribusi = 0, hariLupaCO = 0;
    for (const entry of personMap) { entry[1].sort((a: any, b: any) => a.ts - b.ts); }
    const sortedDateKeys = Array.from(personMap.keys()).sort();
    for (let _di = 0; _di < sortedDateKeys.length; _di++) {
      const dateStr = sortedDateKeys[_di]; const events = personMap.get(dateStr);
      const dayRatePerJam = ratePerJam;
      const ci = events.find((e: any) => e.tipe === "clock_in");
      if (!ci) {
        const onlyCo = events.length > 0 && events.every((e: any) => e.tipe === "clock_out");
        if (onlyCo) continue;
      }
      let co: any = null;
      if (ci) {
        co = events.find((e: any) => e.tipe === "clock_out" && e.ts.getTime() >= ci.ts.getTime()) || null;
        if (!co) {
          const Dnext = sortedDateKeys[_di + 1];
          if (Dnext) {
            const dDate = new Date(dateStr + "T00:00:00");
            const nDate = new Date(Dnext + "T00:00:00");
            const diffDays = Math.round((nDate.getTime() - dDate.getTime()) / 86400000);
            if (diffDays === 1) {
              const nextEvts = personMap.get(Dnext) || [];
              const nextCi = nextEvts.find((e: any) => e.tipe === "clock_in");
              const nextCoCandidate = nextEvts.find((e: any) => e.tipe === "clock_out");
              const __cut = nextCi ? nextCi.ts.getTime() : Infinity;
              if (nextCoCandidate && nextCoCandidate.ts.getTime() < __cut) {
                co = nextCoCandidate;
                const idxR = nextEvts.indexOf(nextCoCandidate);
                if (idxR >= 0) nextEvts.splice(idxR, 1);
              }
              ["overtime_out", "break_out", "pause_out"].forEach(function (__tp) {
                for (let __z = 0; __z < nextEvts.length; __z++) {
                  if (nextEvts[__z].tipe === __tp && nextEvts[__z].ts.getTime() < __cut) {
                    events.push(nextEvts[__z]);
                    nextEvts.splice(__z, 1); __z--;
                  }
                }
              });
              events.sort(function (a: any, b: any) { return a.ts - b.ts; });
              personMap.set(Dnext, nextEvts);
            }
          }
        }
      }
      const ooArr = events.filter((e: any) => e.tipe === "overtime_out");
      const oo = ooArr.length ? ooArr[ooArr.length - 1] : null;
      let durJam = 0;
      const __end = co || oo;
      if (ci && __end) {
        durJam = (__end.ts - ci.ts) / 3600000;
        if (durJam < 0) durJam += 24;
        const breaks: any[] = [];
        events.forEach((e: any) => { if (e.tipe === "break_in" || e.tipe === "break_out") breaks.push(e); });
        const _ciMsP = ci.ts.getTime(); let _endMsP = __end.ts.getTime(); if (_endMsP < _ciMsP) _endMsP += 24 * 3600000;
        const _clampHrP = (sMs: number, eMs: number) => { const s = Math.max(sMs, _ciMsP); const e = Math.min(eMs, _endMsP); return e > s ? (e - s) / 3600000 : 0; };
        const pauses = events.filter((e: any) => e.tipe === "pause_in" || e.tipe === "pause_out");
        for (let pi = 0; pi < pauses.length - 1; pi++) { if (pauses[pi].tipe === "pause_in" && pauses[pi + 1].tipe === "pause_out") { durJam -= _clampHrP(pauses[pi].ts.getTime(), pauses[pi + 1].ts.getTime()); pi++; } }
        let _brkHrP = 0;
        for (let i = 0; i < breaks.length - 1; i++) {
          if (breaks[i].tipe === "break_in" && breaks[i + 1].tipe === "break_out") {
            _brkHrP += _clampHrP(breaks[i].ts.getTime(), breaks[i + 1].ts.getTime());
            i++;
          }
        }
        const _brkOvrEv = events.find((e: any) => e.istirahatOverrideMin !== undefined && e.istirahatOverrideMin !== null && e.istirahatOverrideMin !== "");
        if (_brkOvrEv) { _brkHrP = Math.max(0, Number(_brkOvrEv.istirahatOverrideMin) / 60); }
        durJam -= _brkHrP;
      }
      if (durJam < 0) durJam = 0;
      const effJam = Math.min(durJam, netJamKerja);
      let effJamFinal = effJam;
      let kontribusi = 0;
      if (ci && __end) {
        kontribusi = effJam * dayRatePerJam;
        if (durJam >= jamKerja * 0.75) { hariHadir++; }
        else if (durJam > 0) { hariParsial++; }
      } else if (ci && !__end) {
        const __cut = ci.ts.getTime() + jamKerja * 3600000; let __pms = 0, __ps: number | null = null;
        for (let __pe = 0; __pe < events.length; __pe++) { if (events[__pe].tipe === "pause_in") { __ps = events[__pe].ts.getTime(); } else if (events[__pe].tipe === "pause_out" && __ps !== null) { __pms += Math.min(events[__pe].ts.getTime(), __cut) - __ps; __ps = null; } }
        if (__ps !== null) { __pms += Math.max(0, __cut - __ps); }
        effJamFinal = Math.max(0, Math.min(netJamKerja, jamKerja - __pms / 3600000)); kontribusi = effJamFinal * dayRatePerJam; hariHadir++; hariLupaCO++;
      }
      totalJamKerja += effJamFinal;
      totalKontribusi += kontribusi;
      const _ovrEv = events.find((e: any) => e.lemburOverrideMin !== undefined && e.lemburOverrideMin !== null && e.lemburOverrideMin !== "");
      const __ovr = _ovrEv ? (Number(_ovrEv.lemburOverrideMin) / 60) : null;
      if (__ovr !== null) { totalJamLembur += Math.max(0, __ovr); }
      else if (oo) { const __netH = Math.max(0, jamKerja - 1); totalJamLembur += Math.max(0, durJam - __netH); }
    }
    const upahPokok = totalKontribusi;
    const upahLembur = totalJamLembur * rateLemburPerJam * multiplierLembur;
    const tunjangan = parseInt(k.tunjanganBulanan, 10) || 0;
    const total = upahPokok + upahLembur + tunjangan;
    const potongan = (k.potonganBulan && k.potonganBulan[yyyymm]) ? (Number(k.potonganBulan[yyyymm]) || 0) : 0;
    const bonus = (k.bonusBulan && k.bonusBulan[yyyymm]) ? (Number(k.bonusBulan[yyyymm]) || 0) : 0;
    const totalBayar = total + bonus - potongan;
    if (hariHadir === 0 && hariParsial === 0 && totalJamLembur === 0) continue;
    rows.push({ uid: k.uid, nama: k.nama || "-", hariHadir, hariParsial, hariLupaCO, totalJamKerja, totalJamLembur, upahPokok, upahLembur, tunjangan, potongan, bonus, totalBayar });
  }
  return rows;
}
