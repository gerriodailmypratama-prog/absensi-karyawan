import { auth, db, OWNER_EMAILS } from './firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, query, where, orderBy, getDocs, Timestamp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const $ = id => document.getElementById(id);
const TIPE = { clock_in:'Clock In', clock_out:'Clock Out', overtime_in:'Overtime In', overtime_out:'Overtime Out' };
let cachedRows = [];

onAuthStateChanged(auth, user => {
  if (!user) return location.href = 'index.html';
  if (!OWNER_EMAILS.includes(user.email)) { alert('Akses ditolak'); return location.href = 'karyawan.html'; }
  $('ownerEmail').textContent = user.email;
  const today = new Date().toISOString().slice(0, 10);
  $('dateFrom').value = today;
  $('dateTo').value = today;
  loadData();
});

$('btnLogout').onclick = () => signOut(auth).then(() => location.href = 'index.html');
$('btnFilter').onclick = loadData;
$('btnExport').onclick = exportCSV;

async function loadData() {
  const from = new Date($('dateFrom').value); from.setHours(0, 0, 0, 0);
  const to = new Date($('dateTo').value); to.setHours(23, 59, 59, 999);

  const q = query(collection(db, 'absensi'),
    where('timestamp', '>=', Timestamp.fromDate(from)),
    where('timestamp', '<=', Timestamp.fromDate(to)),
    orderBy('timestamp', 'desc'));

  const snap = await getDocs(q);
  const rows = []; const karyawanSet = new Set();
  snap.forEach(d => { const x = d.data(); rows.push(x); karyawanSet.add(x.email); });

  const sel = $('selKaryawan'); const prev = sel.value;
  sel.innerHTML = '<option value="">Semua</option>';
  [...karyawanSet].sort().forEach(e => {
    const o = document.createElement('option'); o.value = e; o.textContent = e; sel.appendChild(o);
  });
  sel.value = prev;

  const fEmail = $('selKaryawan').value, fType = $('selType').value;
  const filtered = rows.filter(r => (!fEmail || r.email === fEmail) && (!fType || r.type === fType));
  cachedRows = filtered;

  renderStats(filtered);
  renderTable(filtered);
}

function renderStats(rows) {
  const stat = { clock_in: 0, clock_out: 0, overtime_in: 0, overtime_out: 0 };
  rows.forEach(r => { stat[r.type] = (stat[r.type] || 0) + 1; });
  $('stats').innerHTML =
    '<div class="stat"><b>'+stat.clock_in+'</b><small>Clock In</small></div>'+
    '<div class="stat"><b>'+stat.clock_out+'</b><small>Clock Out</small></div>'+
    '<div class="stat"><b>'+stat.overtime_in+'</b><small>Overtime In</small></div>'+
    '<div class="stat"><b>'+stat.overtime_out+'</b><small>Overtime Out</small></div>'+
    '<div class="stat"><b>'+rows.length+'</b><small>Total Record</small></div>';
}

function renderTable(rows) {
  const tb = document.querySelector('#tblAbsen tbody');
  tb.innerHTML = '';
  if (!rows.length) { $('emptyMsg').textContent = 'Tidak ada data pada rentang tersebut'; return; }
  $('emptyMsg').textContent = '';
  rows.forEach(r => {
    const t = r.timestamp.toDate();
    const loc = r.location
      ? '<a href="https://www.google.com/maps?q='+r.location.lat+','+r.location.lng+'" target="_blank">Map</a>'
      : '<span class="muted">-</span>';
    const img = r.photoUrl
      ? '<img src="'+r.photoUrl+'" onclick="document.getElementById(\'modalImg\').src=this.src;document.getElementById(\'photoModal\').classList.remove(\'hidden\')">'
      : '-';
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>'+t.toLocaleDateString('id-ID')+'</td>'+
      '<td>'+t.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})+'</td>'+
      '<td>'+(r.name || r.email)+'</td>'+
      '<td><span class="badge '+r.type+'">'+TIPE[r.type]+'</span></td>'+
      '<td>'+loc+'</td>'+
      '<td>'+img+'</td>';
    tb.appendChild(tr);
  });
}

function exportCSV() {
  if (!cachedRows.length) return alert('Tidak ada data untuk diexport');
  const header = ['Tanggal','Jam','Nama','Email','Tipe','Latitude','Longitude','Akurasi(m)','Foto URL'];
  const lines = [header.join(',')];
  cachedRows.forEach(r => {
    const t = r.timestamp.toDate();
    lines.push([
      t.toLocaleDateString('id-ID'),
      t.toLocaleTimeString('id-ID'),
      '"'+(r.name || '')+'"',
      r.email,
      TIPE[r.type],
      r.location?.lat || '',
      r.location?.lng || '',
      r.location?.acc || '',
      r.photoUrl || ''
    ].join(','));
  });
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'absensi_'+$('dateFrom').value+'_'+$('dateTo').value+'.csv';
  a.click();
}
