'use strict';
/* ====================================================================
   Firestore Security Rules admin — baca / deploy pakai service account
   (Firebase Rules REST API). Dipanggil dari GitHub Actions.
     node rules-admin.js get     -> print rules yang aktif sekarang
     node rules-admin.js deploy  -> push isi ../firestore.rules jadi aktif
   Read-only aman; deploy bikin ruleset baru + release (bisa di-rollback
   via git karena firestore.rules ke-track).
   ==================================================================== */
const fs = require('fs');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

async function getToken(svc) {
  const auth = new GoogleAuth({ credentials: svc, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const t = await client.getAccessToken();
  if (!t || !t.token) throw new Error('Gagal ambil access token dari service account.');
  return t.token;
}

async function main() {
  const mode = (process.argv[2] || 'get').trim();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT kosong.');
  const svc = JSON.parse(raw);
  const pid = svc.project_id;
  const tok = await getToken(svc);
  const H = { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' };
  const BASE = 'https://firebaserules.googleapis.com/v1';

  if (mode === 'get') {
    const relRes = await fetch(`${BASE}/projects/${pid}/releases/cloud.firestore`, { headers: H });
    const rel = await relRes.json();
    if (!relRes.ok) throw new Error('GET release gagal (' + relRes.status + '): ' + JSON.stringify(rel));
    const rsRes = await fetch(`${BASE}/${rel.rulesetName}`, { headers: H });
    const rs = await rsRes.json();
    if (!rsRes.ok) throw new Error('GET ruleset gagal (' + rsRes.status + '): ' + JSON.stringify(rs));
    console.log('RULESET_NAME=' + rel.rulesetName);
    console.log('===== BEGIN CURRENT RULES =====');
    for (const f of rs.source.files) console.log(f.content);
    console.log('===== END CURRENT RULES =====');
  } else if (mode === 'deploy') {
    const file = path.join(__dirname, '..', 'firestore.rules');
    const content = fs.readFileSync(file, 'utf8');
    console.log('Deploy firestore.rules (' + content.length + ' bytes)...');
    const createRes = await fetch(`${BASE}/projects/${pid}/rulesets`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ source: { files: [{ name: 'firestore.rules', content }] } })
    });
    const created = await createRes.json();
    if (!createRes.ok || !created.name) throw new Error('Create ruleset gagal (' + createRes.status + '): ' + JSON.stringify(created));
    console.log('Ruleset baru: ' + created.name);
    const relRes = await fetch(`${BASE}/projects/${pid}/releases/cloud.firestore?updateMask=rulesetName`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ release: { name: `projects/${pid}/releases/cloud.firestore`, rulesetName: created.name } })
    });
    const rel = await relRes.json();
    if (!relRes.ok) throw new Error('Update release gagal (' + relRes.status + '): ' + JSON.stringify(rel));
    console.log('DEPLOYED & RELEASED OK.');
  } else {
    throw new Error("mode tidak dikenal: '" + mode + "'. Pakai 'get' atau 'deploy'.");
  }
}
main().catch(e => { console.error('ERROR:', e && e.message ? e.message : e); process.exit(1); });
