/* ====================================================================
   PR-CL109 — Inventaris Firebase untuk migrasi ke Supabase (Langkah 0).
   Baca-saja. Repo ini PUBLIK, jadi log GitHub Action bisa dibaca siapa pun:
   skrip ini SENGAJA cuma mencetak ANGKA HITUNGAN — tidak ada nama, email,
   nomor rekening, URL KTP/selfie, UID, atau isi dokumen apa pun.
   ==================================================================== */
'use strict';
const admin = require('firebase-admin');

const WIB_MS = 7 * 3600 * 1000;
const bulanWib = ms => { const d = new Date(ms + WIB_MS); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };

async function main() {
  const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (!svc.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT kosong');
  admin.initializeApp({ credential: admin.credential.cert(svc), storageBucket: svc.project_id + '.firebasestorage.app' });
  const db = admin.firestore();
  const out = { project: svc.project_id, dibuat: new Date().toISOString() };

  // 1) koleksi tingkat atas + jumlah dokumen
  const cols = await db.listCollections();
  out.koleksi = {};
  for (const c of cols) out.koleksi[c.id] = (await c.count().get()).data().count;

  // 2) karyawan: aktif/nonaktif + kelengkapan field penting (hitungan saja)
  const ks = await db.collection('karyawan').get();
  const k = { total: ks.size, aktif: 0, nonaktif: 0, adaEmail: 0, adaTanggalLahir: 0, adaRekening: 0, adaKtp: 0,
              adaLiburHari: 0, kasbonAktif: 0, spvAkses: 0, adaTunjangan: 0, noShiftBarrier: 0, wajibKode: 0, kodeAdmin: 0,
              panggilanKosong: 0, panggilanDuplikat: 0, jamKerja: {}, fieldUnik: {} };
  const seenPg = new Map();
  ks.forEach(d => {
    const x = d.data() || {};
    if (x.nonaktif === true) k.nonaktif++; else k.aktif++;
    if ((x.email || '').trim()) k.adaEmail++;
    if ((x.tanggalLahir || '').trim()) k.adaTanggalLahir++;
    if ((x.nomorRekening || '').trim()) k.adaRekening++;
    if ((x.ktpUrl || '').trim()) k.adaKtp++;
    if (x.liburHari != null) k.adaLiburHari++;
    if (x.kasbonAktif === true) k.kasbonAktif++;
    if (x.spvAkses === true) k.spvAkses++;
    if ((parseInt(x.tunjanganBulanan, 10) || 0) > 0) k.adaTunjangan++;
    if (x.noShiftBarrier === true) k.noShiftBarrier++;
    if (x.wajibKodeClockout === true) k.wajibKode++;
    if (x.kodeAdmin === true) k.kodeAdmin++;
    const pg = String(x.namaPanggilan || x.nama || '').trim().toLowerCase();
    if (!pg) k.panggilanKosong++; else seenPg.set(pg, (seenPg.get(pg) || 0) + 1);
    const jk = String(x.jamKerja == null ? 'kosong' : x.jamKerja); k.jamKerja[jk] = (k.jamKerja[jk] || 0) + 1;
    Object.keys(x).forEach(f => { k.fieldUnik[f] = (k.fieldUnik[f] || 0) + 1; });
  });
  for (const v of seenPg.values()) if (v > 1) k.panggilanDuplikat++;
  out.karyawan = k;

  // 3) absensi: per tipe, per bulan, rentang waktu, field penanda
  const as = await db.collection('absensi').get();
  const a = { total: as.size, perTipe: {}, perBulan: {}, tanpaTs: 0, tanpaUid: 0, uidTakAdaDiKaryawan: 0, adaSelfie: 0,
              manualEdit: 0, editedByOwner: 0, auto: 0, flag: {}, kodeVerif: {}, lemburOverride: 0, breakOverride: 0,
              tsTerlama: null, tsTerbaru: null, fieldUnik: {} };
  const karyIds = new Set(ks.docs.map(d => d.id));
  let minMs = Infinity, maxMs = 0;
  as.forEach(d => {
    const x = d.data() || {};
    a.perTipe[x.tipe || 'kosong'] = (a.perTipe[x.tipe || 'kosong'] || 0) + 1;
    const ms = x.ts && x.ts.toMillis ? x.ts.toMillis() : 0;
    if (!ms) a.tanpaTs++; else { a.perBulan[bulanWib(ms)] = (a.perBulan[bulanWib(ms)] || 0) + 1; minMs = Math.min(minMs, ms); maxMs = Math.max(maxMs, ms); }
    if (!x.uid) a.tanpaUid++; else if (!karyIds.has(x.uid)) a.uidTakAdaDiKaryawan++;
    if ((x.fotoSelfie || '').trim()) a.adaSelfie++;
    if (x.manualEdit) a.manualEdit++;
    if (x.editedByOwner) a.editedByOwner++;
    if (x.auto) a.auto++;
    if (x.flag) a.flag[x.flag] = (a.flag[x.flag] || 0) + 1;
    if (x.kodeVerif) a.kodeVerif[x.kodeVerif] = (a.kodeVerif[x.kodeVerif] || 0) + 1;
    if (x.lemburOverrideMin != null) a.lemburOverride++;
    if (x.breakOverrideMin != null) a.breakOverride++;
    Object.keys(x).forEach(f => { a.fieldUnik[f] = (a.fieldUnik[f] || 0) + 1; });
  });
  if (maxMs) { a.tsTerlama = new Date(minMs).toISOString(); a.tsTerbaru = new Date(maxMs).toISOString(); }
  out.absensi = a;

  // 4) koleksi lain: nama field + jumlah saja
  for (const nm of Object.keys(out.koleksi)) {
    if (nm === 'karyawan' || nm === 'absensi') continue;
    const s = await db.collection(nm).get();
    const f = {}; s.forEach(d => Object.keys(d.data() || {}).forEach(x => { f[x] = (f[x] || 0) + 1; }));
    out['field_' + nm] = f;
  }

  // 5) Firebase Auth: jumlah per penyedia login (tanpa email)
  const auth = { total: 0, google: 0, password: 0, lain: 0, disabled: 0, tidakAdaDiKaryawan: 0,
                 aktif_googleSaja: 0, aktif_passwordSaja: 0, aktif_keduanya: 0, aktif_tanpaAkunAuth: 0,
                 aktif_passwordSaja_loginTerakhir30hari: 0 };
  const aktifIds = new Set(ks.docs.filter(d => (d.data() || {}).nonaktif !== true).map(d => d.id));
  const punyaAuth = new Set();
  let token;
  do {
    const r = await admin.auth().listUsers(1000, token);
    r.users.forEach(u => {
      auth.total++;
      const p = (u.providerData || []).map(x => x.providerId);
      if (p.includes('google.com')) auth.google++;
      if (p.includes('password')) auth.password++;
      if (!p.includes('google.com') && !p.includes('password')) auth.lain++;
      if (u.disabled) auth.disabled++;
      if (!karyIds.has(u.uid)) auth.tidakAdaDiKaryawan++;
      if (aktifIds.has(u.uid)) {
        punyaAuth.add(u.uid);
        const g = p.includes('google.com'), pw = p.includes('password');
        if (g && pw) auth.aktif_keduanya++; else if (g) auth.aktif_googleSaja++; else if (pw) auth.aktif_passwordSaja++;
        const last = Date.parse((u.metadata && u.metadata.lastSignInTime) || '') || 0;
        if (pw && !g && last && (Date.now() - last) < 30 * 86400000) auth.aktif_passwordSaja_loginTerakhir30hari++;
      }
    });
    token = r.pageToken;
  } while (token);
  auth.aktif_tanpaAkunAuth = [...aktifIds].filter(id => !punyaAuth.has(id)).length;
  out.authFirebase = auth;

  // 6) Storage: jumlah & ukuran per folder teratas (tanpa nama file)
  try {
    const [files] = await admin.storage().bucket().getFiles();
    const st = {};
    files.forEach(f => { const top = (f.name.split('/')[0] || '(root)'); st[top] = st[top] || { file: 0, MB: 0 }; st[top].file++; st[top].MB += Number(f.metadata.size || 0) / 1048576; });
    Object.values(st).forEach(v => { v.MB = Math.round(v.MB * 10) / 10; });
    out.storage = st;
  } catch (e) { out.storage = 'gagal: ' + (e.code || '') + ' ' + String(e.message).slice(0, 80); }

  console.log('===== INVENTARIS FIREBASE (angka saja) =====');
  console.log(JSON.stringify(out, null, 2));
}
main().catch(e => { console.error('GAGAL:', e.message); process.exit(1); });
