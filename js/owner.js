import { auth, db, OWNER_EMAILS } from './firebase-config.js';

import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, query, where, orderBy, getDocs, onSnapshot, Timestamp }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const $ = id => document.getElementById(id);
const TIPE = { clock_in:'Clock In', clock_out:'Clock Out', overtime_in:'Overtime In', overtime_out:'Overtime Out' };
let cachedRows = [];
let chartHadir = null, chartLokasi = null;
let unsubToday = null;

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
    initSidebar();
    initBeranda();
});

$('btnLogout').onclick = () => signOut(auth).then(() => location.href = 'index.html');
$('btnFilter').onclick = loadData;
$('btnExport').onclick = exportCSV;

function initSidebar(){
    const links = document.querySelectorAll('.nav-link');
    function activate(page){
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const target = document.getElementById('page-' + page);
        if (target) target.classList.add('active');
        links.forEach(l => l.classList.toggle('active', l.dataset.page === page));
        if (page === 'kehadiran' && cachedRows.length === 0) loadData();
        if (page === 'karyawan') loadKaryawanList();
        if (window.innerWidth <= 768) document.body.classList.remove('sidebar-open');
    }
    links.forEach(l => l.onclick = (e) => { e.preventDefault(); activate(l.dataset.page); });
    const initial = (location.hash || '#beranda').replace('#', '');
    activate(['beranda','kehadiran','karyawan'].includes(initial) ? initial : 'beranda');
    $('btnSidebar').onclick = () => document.body.classList.toggle('sidebar-open');
}

function initBeranda(){
    const today = new Date();
    $('berandaDate').textContent = today.toLocaleDateString('id-ID', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

    const start = new Date(); start.setHours(0,0,0,0);
    const end = new Date(); end.setHours(23,59,59,999);
    const q = query(
        collection(db, 'absensi'),
        where('ts', '>=', Timestamp.fromDate(start)),
        where('ts', '<=', Timestamp.fromDate(end)),
        orderBy('ts', 'desc')
    );

    if (unsubToday) unsubToday();
    unsubToday = onSnapshot(q, snap => {
        const rows = [];
        snap.forEach(d => rows.push(d.data()));
        renderBeranda(rows);
    }, err => {
        console.error('Beranda snapshot error:', err);
    });
}

const TOTAL_KARYAWAN_DEFAULT = 8;
async function getTotalKaryawan(){
    try {
        const snap = await getDocs(collection(db, 'karyawan'));
        if (snap.empty) return TOTAL_KARYAWAN_DEFAULT;
        return snap.size;
    } catch (e) {
        return TOTAL_KARYAWAN_DEFAULT;
    }
}

async function renderBeranda(rows){
    const total = await getTotalKaryawan();
    const clockInSet = new Set();
    const stat = { clock_in:0, clock_out:0, overtime_in:0, overtime_out:0 };
    let inRuko = 0, outRuko = 0;

    rows.forEach(r => {
        if (stat[r.tipe] !== undefined) stat[r.tipe]++;
        if (r.tipe === 'clock_in') {
            if (r.uid) clockInSet.add(r.uid);
            else if (r.email) clockInSet.add(r.email);
            if (r.inRadius === true) inRuko++;
            else if (r.inRadius === false) outRuko++;
        }
    });
    const hadir = clockInSet.size;
    const belum = Math.max(total - hadir, 0);

    $('berandaStats').innerHTML =
        '<div class="stat"><b>' + hadir + '/' + total + '</b><small>Sudah Clock In</small></div>' +
        '<div class="stat"><b>' + stat.clock_in + '</b><small>Total Clock In</small></div>' +
        '<div class="stat"><b>' + stat.clock_out + '</b><small>Clock Out</small></div>' +
        '<div class="stat"><b>' + stat.overtime_in + '</b><small>OT In</small></div>' +
        '<div class="stat"><b>' + stat.overtime_out + '</b><small>OT Out</small></div>' +
        '<div class="stat" style="background:#fef2f2"><b style="color:#dc2626">' + outRuko + '</b><small>Luar Lokasi</small></div>';

    const ctx1 = document.getElementById('chartHadir');
    if (ctx1 && window.Chart) {
        if (chartHadir) chartHadir.destroy();
        chartHadir = new Chart(ctx1, {
            type: 'doughnut',
            data: {
                labels: ['Sudah Clock In', 'Belum'],
                datasets: [{ data: [hadir, belum], backgroundColor: ['#10b981', '#e5e7eb'], borderWidth: 0 }]
            },
            options: { plugins:{ legend:{ position:'bottom' } }, cutout:'65%' }
        });
        $('capHadir').textContent = hadir + ' dari ' + total + ' karyawan sudah Clock In hari ini';
    }

    const ctx2 = document.getElementById('chartLokasi');
    if (ctx2 && window.Chart) {
        if (chartLokasi) chartLokasi.destroy();
        chartLokasi = new Chart(ctx2, {
            type: 'doughnut',
            data: {
                labels: ['Di Ruko', 'Luar Lokasi'],
                datasets: [{ data: [inRuko, outRuko], backgroundColor: ['#10b981', '#ef4444'], borderWidth: 0 }]
            },
            options: { plugins:{ legend:{ position:'bottom' } }, cutout:'65%' }
        });
        $('capLokasi').textContent = inRuko + ' di ruko · ' + outRuko + ' luar lokasi';
    }

    const tb = document.querySelector('#tblToday tbody');
    tb.innerHTML = '';
    if (!rows.length) {
        $('emptyToday').textContent = 'Belum ada aktivitas absensi hari ini';
        return;
    }
    $('emptyToday').textContent = '';
    rows.slice(0, 20).forEach(r => {
        const t = r.ts && r.ts.toDate ? r.ts.toDate() : new Date();
        const jam = t.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit' });
        const nama = r.nama || (r.email ? r.email.split('@')[0] : '-');
        let badge = '';
        if (r.inRadius === true) badge = '<span class="badge-loc badge-in">Di Ruko'+(r.jarak!=null?' '+r.jarak+'m':'')+'</span>';
        else if (r.inRadius === false) badge = '<span class="badge-loc badge-out">Luar '+(r.jarak!=null?r.jarak+'m':'')+'</span>';
        else badge = '<span class="muted">-</span>';
        const tr = document.createElement('tr');
        if (r.inRadius === false) tr.style.background = '#fef2f2';
        tr.innerHTML = '<td>'+jam+'</td><td>'+nama+'</td><td>'+(TIPE[r.tipe]||r.tipe)+'</td><td>'+badge+'</td>';
        tb.appendChild(tr);
    });
}

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
    const stat = { clock_in:0, clock_out:0, overtime_in:0, overtime_out:0 };
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
        const tanggal = t.toLocaleDateString('id-ID', { day:'2-digit', month:'2-digit', year:'numeric' });
        const jam = t.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
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
            badge = '<span class="badge-loc badge-in">🟢 Di Ruko ('+(r.jarak!=null?r.jarak+'m':'')+')</span>';
        } else if (r.inRadius === false) {
            badge = '<span class="badge-loc badge-out">🔴 Luar Lokasi ('+(r.jarak!=null?r.jarak+'m':'')+')</span>';
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

async function loadKaryawanList(){
    try {
        const snap = await getDocs(collection(db, 'karyawan'));
        const tb = document.querySelector('#tblKaryawan tbody');
        tb.innerHTML = '';
        if (snap.empty) {
            $('emptyKaryawan').textContent = 'Belum ada data karyawan terdaftar. Tambahkan via form di atas.';
            return;
        }
        $('emptyKaryawan').textContent = '';
        snap.forEach(d => {
            const x = d.data();
            const img = x.photoURL
                ? '<img src="'+x.photoURL+'" alt="foto" style="width:40px;height:40px;border-radius:50%;object-fit:cover">'
                : '<span class="muted">-</span>';
            const tr = document.createElement('tr');
            tr.innerHTML = '<td>'+(x.nama||'-')+'</td><td>'+(x.email||'-')+'</td><td>'+(x.phone||'-')+'</td><td>'+(x.nik||'-')+'</td><td>'+img+'</td>';
            tb.appendChild(tr);
        });
    } catch(e){ console.error('loadKaryawanList:', e); }
}

$('formAddUser').onsubmit = (e) => {
    e.preventDefault();
    alert('Fitur Add User belum aktif. Konfirmasi dulu Cara 1 (Cloud Function) atau Cara 2 (secondary Auth instance).');
};
