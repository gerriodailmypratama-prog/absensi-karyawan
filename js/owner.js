import { auth, db, OWNER_EMAILS } from './firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, query, where, orderBy, getDocs, Timestamp }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const $ = id => document.getElementById(id);
const TIPE = { clock_in:'Clock In', clock_out:'Clock Out', overtime_in:'Overtime In', overtime_out:'Overtime Out' };
let cachedRows = [];

function localDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
}

onAuthStateChanged(auth, user => {
    if (!user) return location.href = 'index.html';
    if (!OWNER_EMAILS.includes(user.email)) { alert('Akses ditolak'); return location.href = 'karyawan.html'; }
    $('ownerEmail').textContent = user.email;
    const today = new Date();
    const weekAgo = new Date(); weekAgo.setDate(today.getDate() - 6);
    $('dateFrom').value = localDateStr(weekAgo);
    $('dateTo').value = localDateStr(today);
    loadData();
});

$('btnLogout').onclick = () => signOut(auth).then(() => location.href = 'index.html');
$('btnFilter').onclick = loadData;
$('btnExport').onclick = exportCSV;

async function loadData() {
    try {
          const from = new Date($('dateFrom').value + 'T00:00:00');
          const to = new Date($('dateTo').value + 'T23:59:59.999');

      const q = query(collection(db, 'absensi'),
                            where('ts', '>=', Timestamp.fromDate(from)),
                            where('ts', '<=', Timestamp.fromDate(to)),
                            orderBy('ts', 'desc'));

      const snap = await getDocs(q);
          const rows = []; const karyawanSet = new Set();
          snap.forEach(d => { const x = d.data(); rows.push(x); if (x.email) karyawanSet.add(x.email); });

      const sel = $('selKaryawan'); const prev = sel.value;
          sel.innerHTML = '<option value="">Semua</option>';
          [...karyawanSet].sort().forEach(e => {
                  const o = document.createElement('option'); o.value = e; o.textContent = e; sel.appendChild(o);
          });
          sel.value = prev;

      const fEmail = $('selKaryawan').value, fType = $('selType').value;
          const fLoc = $('selLocation') ? $('selLocation').value : '';
          const filtered = rows.filter(r => {
                  if (fEmail && r.email !== fEmail) return false;
                  if (fType && r.tipe !== fType) return false;
                  if (fLoc === 'out' && r.inRadius !== false) return false;
                  if (fLoc === 'in' && r.inRadius !== true) return false;
                  return true;
          });
          cachedRows = filtered;

      renderStats(filtered);
          renderTable(filtered);
    } catch (err) {
          console.error('loadData error:', err);
          alert('Gagal memuat data: ' + (err.message || err));
    }
}

function renderStats(rows) {
    const stat = { clock_in: 0, clock_out: 0, overtime_in: 0, overtime_out: 0 };
    let outCount = 0;
    rows.forEach(r => {
          if (stat[r.tipe] !== undefined) stat[r.tipe]++;
          if (r.inRadius === false) outCount++;
    });
    $('stats').innerHTML =
          '<div class="stat"><b>'+stat.clock_in+'</b><small>Clock In</small></div>'+
          '<div class="stat"><b>'+stat.clock_out+'</b><small>Clock Out</small></div>'+
          '<div class="stat"><b>'+stat.overtime_in+'</b><small>Overtime In</small></div>'+
          '<div class="stat"><b>'+stat.overtime_out+'</b><small>Overtime Out</small></div>'+
          '<div class="stat"><b>'+rows.length+'</b><small>Total Record</small></div>'+
          '<div class="stat" style="background:#fef2f2"><b style="color:#dc2626">'+outCount+'</b><small>Luar Lokasi</small></div>';
}

function renderTable(rows) {
    const tb = document.querySelector('#tblAbsen tbody');
    tb.innerHTML = '';
    if (!rows.length) { $('emptyMsg').textContent = 'Tidak ada data pada rentang tersebut'; return; }
    $('emptyMsg').textContent = '';
    rows.forEach(r => {
          const t = r.ts && r.ts.toDate ? r.ts.toDate() : new Date();
          const tanggal = t.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });
          const jam = t.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const loc = r.lokasi
            ? '<a href="https://www.google.com/maps?q='+r.lokasi.lat+','+r.lokasi.lng+'" target="_blank" rel="noopener">Map</a>'
                  : '<span class="muted">-</span>';
          const img = r.foto
            ? '<img src="'+r.foto+'" alt="foto" style="width:48px;height:48px;object-fit:cover;border-radius:6px;cursor:pointer" onclick="document.getElementById(\'modalImg\').src=this.src;document.getElementById(\'photoModal\').classList.add(\'show\')">'
                  : '<span class="muted">-</span>';
          const tipeLabel = TIPE[r.tipe] || r.tipe || '-';
          const nama = r.nama || (r.email ? r.email.split('@')[0] : '-');
          let badge = '';
          if (r.inRadius === true) {
                  badge = '<span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">🟢 Di Ruko ('+(r.jarak!=null?r.jarak+'m':'')+')</span>';
          } else if (r.inRadius === false) {
                  badge = '<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">🔴 Luar Lokasi ('+(r.jarak!=null?r.jarak+'m':'')+')</span>';
          } else {
                  badge = '<span class="muted" style="font-size:11px">-</span>';
          }
          const tr = document.createElement('tr');
          if (r.inRadius === false) tr.style.background = '#fef2f2';
          tr.innerHTML = '<td>'+tanggal+'</td><td>'+jam+'</td><td>'+nama+'</td><td>'+tipeLabel+'</td><td>'+badge+'</td><td>'+loc+'</td><td>'+img+'</td>';
          tb.appendChild(tr);
    });
}

function exportCSV() {
    if (!cachedRows.length) { alert('Tidak ada data untuk diexport'); return; }
    const header = ['Tanggal','Jam','Nama','Email','Tipe','Status Lokasi','Jarak(m)','Latitude','Longitude','Akurasi(m)','SizeKB','FotoURL'];
    const lines = [header.join(',')];
    cachedRows.forEach(r => {
          const t = r.ts && r.ts.toDate ? r.ts.toDate() : new Date();
          const tanggal = t.toLocaleDateString('id-ID');
          const jam = t.toLocaleTimeString('id-ID');
          const lat = r.lokasi ? r.lokasi.lat : '';
          const lng = r.lokasi ? r.lokasi.lng : '';
          const acc = r.lokasi ? r.lokasi.acc : '';
          const statusLok = r.inRadius === true ? 'Di Ruko' : (r.inRadius === false ? 'Luar Lokasi' : '');
          const jarak = r.jarak != null ? r.jarak : '';
          const cells = [tanggal, jam, r.nama || '', r.email || '', TIPE[r.tipe] || r.tipe || '', statusLok, jarak, lat, lng, acc, r.sizeKB || '', r.foto || ''];
          lines.push(cells.map(c => '"'+String(c).replace(/"/g, '""')+'"').join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'absensi_'+$('dateFrom').value+'_to_'+$('dateTo').value+'.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
