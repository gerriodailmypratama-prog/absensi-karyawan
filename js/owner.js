import { auth, db, OWNER_EMAILS, firebaseConfig } from './firebase-config.js';



import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, query, where, orderBy, getDocs, onSnapshot, Timestamp, setDoc, doc, serverTimestamp }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signOut as authSignOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const $ = id => document.getElementById(id);
const TIPE = { clock_in:'Clock In', clock_out:'Clock Out', break_in:'Break', break_out:'After Break', overtime_in:'Overtime In', overtime_out:'Overtime Out' };
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
    if (!OWNER_EMAILS.includes(user.email)) { alert('Access denied'); return location.href = 'karyawan.html'; }
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
    $('berandaDate').textContent = today.toLocaleDateString('en-US', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

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
    const stat = { clock_in:0, clock_out:0, break_in:0, break_out:0, overtime_in:0, overtime_out:0 };
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
        '<div class="stat"><b>' + hadir + '/' + total + '</b><small>Clocked In</small></div>' +
        '<div class="stat"><b>' + stat.clock_in + '</b><small>Total Clock In</small></div>' +
        '<div class="stat"><b>' + stat.clock_out + '</b><small>Clock Out</small></div>' +
        '<div class="stat"><b>' + stat.overtime_in + '</b><small>OT In</small></div>' +
        '<div class="stat"><b>' + stat.overtime_out + '</b><small>OT Out</small></div>' +
        '<div class="stat" style="background:#fef2f2"><b style="color:#dc2626">' + outRuko + '</b><small>Out of Radius</small></div>';

    const ctx1 = document.getElementById('chartHadir');
    if (ctx1 && window.Chart) {
        if (chartHadir) chartHadir.destroy();
        chartHadir = new Chart(ctx1, {
            type: 'doughnut',
            data: {
                labels: ['Clocked In', 'Pending'],
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
                labels: ['In Office', 'Out of Radius'],
                datasets: [{ data: [inRuko, outRuko], backgroundColor: ['#10b981', '#ef4444'], borderWidth: 0 }]
            },
            options: { plugins:{ legend:{ position:'bottom' } }, cutout:'65%' }
        });
        $('capLokasi').textContent = inRuko + ' di ruko · ' + outRuko + ' luar lokasi';
    }

    const tb = document.querySelector('#tblToday tbody');
    tb.innerHTML = '';
    if (!rows.length) {
        $('emptyToday').textContent = 'No attendance activity today';
        return;
    }
    $('emptyToday').textContent = '';
    rows.slice(0, 20).forEach(r => {
        const t = r.ts && r.ts.toDate ? r.ts.toDate() : new Date();
        const jam = t.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
        const nama = r.nama || (r.email ? r.email.split('@')[0] : '-');
        let badge = '';
        if (r.inRadius === true) badge = '<span class="badge-loc badge-in">In Office'+(r.jarak!=null?' '+r.jarak+'m':'')+'</span>';
        else if (r.inRadius === false) badge = '<span class="badge-loc badge-out">Out '+(r.jarak!=null?r.jarak+'m':'')+'</span>';
        else badge = '<span class="muted">-</span>';
        const tr = document.createElement('tr');
        if (r.inRadius === false) tr.style.background = '#fef2f2';
        tr.innerHTML = '<td>'+jam+'</td><td>'+nama+'</td><td>'+(TIPE[r.tipe]||r.tipe)+'</td><td>'+badge+'</td>';
        tb.appendChild(tr);
    });
    renderWorkingNowWithFetch(rows);
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
        sel.innerHTML = '<option value="">All</option>';
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
        alert('Failed to load data: ' + (err.message || err));
    }
}

function renderStats(rows) {
    const stat = { clock_in:0, clock_out:0, break_in:0, break_out:0, overtime_in:0, overtime_out:0 };
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
        '<div class="stat"><b>'+rows.length+'</b><small>Total Records</small></div>'+
        '<div class="stat" style="background:#fef2f2"><b style="color:#dc2626">'+outCount+'</b><small>Out of Radius</small></div>';
}

function renderTable(rows) {
    const tb = document.querySelector('#tblAbsen tbody');
    tb.innerHTML = '';
    if (!rows.length) { $('emptyMsg').textContent = 'No data in this range'; return; }
    $('emptyMsg').textContent = '';
    rows.forEach(r => {
        const t = r.ts && r.ts.toDate ? r.ts.toDate() : new Date();
        const tanggal = t.toLocaleDateString('en-US', { day:'2-digit', month:'2-digit', year:'numeric' });
        const jam = t.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
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
            badge = '<span class="badge-loc badge-in">🟢 In Office ('+(r.jarak!=null?r.jarak+'m':'')+')</span>';
        } else if (r.inRadius === false) {
            badge = '<span class="badge-loc badge-out">🔴 Out of Radius ('+(r.jarak!=null?r.jarak+'m':'')+')</span>';
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
    if (!cachedRows.length) { alert('No data to export'); return; }
    const header = ['Date','Time','Name','Email','Type','Location Status','Distance(m)','Latitude','Longitude','Accuracy(m)','SizeKB','PhotoURL','BreakFilledAtCheckout','AutoCut1h','EarlyReason'];
    const lines = [header.join(',')];
    cachedRows.forEach(r => {
        const t = r.ts && r.ts.toDate ? r.ts.toDate() : new Date();
        const tanggal = t.toLocaleDateString('en-US');
        const jam = t.toLocaleTimeString('en-US');
        const lat = r.lokasi ? r.lokasi.lat : '';
        const lng = r.lokasi ? r.lokasi.lng : '';
        const acc = r.lokasi ? r.lokasi.acc : '';
        const statusLok = r.inRadius === true ? 'In Office' : (r.inRadius === false ? 'Out of Radius' : '');
        const jarak = r.jarak != null ? r.jarak : '';
        const cells = [tanggal, jam, r.nama || '', r.email || '', TIPE[r.tipe] || r.tipe || '', statusLok, jarak, lat, lng, acc, r.sizeKB || '', r.foto || '', r.breakFilledAtCheckout ? 'Yes' : '', r.autoCutByCheckout ? 'Yes' : '', r.alasanEarly || ''];
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
        const snap = await getDocs(collection(db,'karyawan'));
        const tb = document.querySelector('#tblKaryawan tbody');
        tb.innerHTML = '';
        if (snap.empty) {
            $('emptyKaryawan').textContent = 'Pending ada data karyawan terdaftar. Tambahkan via form di atas.';
            return;
        }
        $('emptyKaryawan').textContent = '';
        const rows = [];
        snap.forEach(d => rows.push({id:d.id, ...d.data()}));
        rows.sort((a,b)=>(a.nama||'').localeCompare(b.nama||''));
        rows.forEach(x => {
            const img = x.photoURL
                ? '<img src="'+x.photoURL+'" alt="foto" style="width:40px;height:40px;border-radius:50%;object-fit:cover">'
                : '<span class="muted">-</span>';
            const idDisplay = x.idKaryawan || x.nik || '-';
            const jamKerja = x.jamKerja || 8;
            const tr = document.createElement('tr');
            tr.innerHTML = '<td>'+(x.nama||'-')+'</td><td>'+(x.email||'-')+'</td><td>'+(x.phone||'-')+'</td><td>'+idDisplay+'</td><td>'+jamKerja+' jam</td><td>'+img+'</td><td><button class="btn-link btn-edit-kar" data-uid="'+x.id+'">Edit</button></td>';
            tb.appendChild(tr);
        });
        document.querySelectorAll('.btn-edit-kar').forEach(b => {
            b.onclick = () => openEditKaryawan(b.dataset.uid);
        });
    } catch(e){ console.error('loadKaryawanList:', e); }
}

$('formAddUser').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('btnAddUser');
    const nama = $('newNama').value.trim();
    const email = $('newEmail').value.trim();
    const phone = $('newPhone').value.trim();
    const idKaryawanRaw = $('newIdKaryawan').value.trim();
    const jamKerja = parseInt($('newJamKerja').value, 10) || 8;
    const password = $('newPassword').value;
    if (!nama || !email || !password) { alert('Name, Email, Password are required.'); return; }
    if (password.length < 6) { alert('Password must be at least 6 characters.'); return; }
    btn.disabled = true;
    btn.textContent = 'Adding...';
    let secondaryApp = null;
    try {
        // Init secondary app supaya session owner tidak terganggu
        secondaryApp = initializeApp(firebaseConfig, 'Secondary_' + Date.now());
        const secondaryAuth = getAuth(secondaryApp);
        const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
        const uid = cred.user.uid;
        // Tulis ke Firestore koleksi 'karyawan'
        await setDoc(doc(db,'karyawan',uid), {
            uid, email, nama,
            phone: phone || '',
            idKaryawan: idKaryawanRaw || ('EMP-' + Math.random().toString(36).slice(2,6).toUpperCase()),
            jamKerja: jamKerja,
            createdAt: serverTimestamp()
        }, {merge:true});
        await authSignOut(secondaryAuth);
        await deleteApp(secondaryApp);
        secondaryApp = null;
        alert('Karyawan ' + nama + ' added successfully.');
        $('formAddUser').reset();
        $('newPassword').value = 'Goodgems2026';
        $('newJamKerja').value = 8;
        loadKaryawanList();
    } catch (err) {
        console.error('Add user error:', err);
        let msg = err.message || String(err);
        if (err.code === 'auth/email-already-in-use') msg = 'Email already registered.';
        else if (err.code === 'auth/invalid-email') msg = 'Invalid email format.';
        else if (err.code === 'auth/weak-password') msg = 'Password too weak.';
        alert('Failed to add employee: ' + msg);
        if (secondaryApp) { try { await deleteApp(secondaryApp); } catch(e){} }
    } finally {
        btn.disabled = false;
        btn.textContent = 'Add Employee';
    }
};


// ============== EDIT KARYAWAN ==============
async function openEditKaryawan(uid){
    try {
        const snap = await getDoc(doc(db,'karyawan',uid));
        if (!snap.exists()) { alert('Employee data not found.'); return; }
        const d = snap.data();
        $('editUid').value = uid;
        $('editNama').value = d.nama || '';
        $('editPhone').value = d.phone || '';
        $('editIdKaryawan').value = d.idKaryawan || d.nik || '';
        $('editJamKerja').value = d.jamKerja || 8;
        $('editKaryawanModal').classList.remove('hidden');
    } catch(e){ alert('Failed to load data: ' + e.message); }
}
$('btnEditCancel').onclick = () => $('editKaryawanModal').classList.add('hidden');
$('formEditKaryawan').onsubmit = async (e) => {
    e.preventDefault();
    const uid = $('editUid').value;
    const nama = $('editNama').value.trim();
    const phone = $('editPhone').value.trim();
    const idKaryawan = $('editIdKaryawan').value.trim();
    const jamKerja = parseInt($('editJamKerja').value, 10) || 8;
    if (!nama) { alert('Name is required.'); return; }
    try {
        await setDoc(doc(db,'karyawan',uid), { nama, phone, idKaryawan, jamKerja }, {merge:true});
        $('editKaryawanModal').classList.add('hidden');
        loadKaryawanList();
    } catch(err){ alert('Failed to save: ' + err.message); }
};

// ============== KARYAWAN SEDANG BEKERJA ==============
function renderWorkingNow(rows, karyawanMap){
    const list = $('workingNowList');
    const empty = $('emptyWorking');
    if (!list || !empty) return;
    const latestByUid = {};
    rows.forEach(r => {
        if (!latestByUid[r.uid] || r.ts.seconds > latestByUid[r.uid].ts.seconds) {
            latestByUid[r.uid] = r;
        }
    });
    const working = Object.values(latestByUid).filter(r => r.tipe === 'clock_in' || r.tipe === 'overtime_in' || r.tipe === 'break_in' || r.tipe === 'break_out');
    if (working.length === 0) {
        list.innerHTML = '';
        empty.textContent = 'No employees currently working.';
        return;
    }
    empty.textContent = '';
    list.innerHTML = working.map(r => {
        const k = karyawanMap[r.uid] || {};
        const photo = k.photoURL || '';
        const nama = k.nama || r.nama || r.uid.slice(0,6);
        let tipeLabel = TIPE[r.tipe] || r.tipe;
let tipeColor = 'badge-green';
if (r.tipe === 'overtime_in') tipeColor = 'badge-orange';
else if (r.tipe === 'break_in') { tipeLabel = 'On Break'; tipeColor = 'badge-yellow'; }
else if (r.tipe === 'break_out') { tipeLabel = 'Working'; tipeColor = 'badge-green'; }
        const avatar = photo
            ? '<img src="'+photo+'" alt="'+nama+'">'
            : '<div class="avatar-init">'+(nama[0]||'?').toUpperCase()+'</div>';
        const jam = r.ts.toDate().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
        return '<div class="working-item">' + avatar + '<div class="working-info"><b>'+nama+'</b><small>'+tipeLabel+' · '+jam+'</small></div><span class="badge '+tipeColor+'">'+tipeLabel+'</span></div>';
    }).join('');
}
async function renderWorkingNowWithFetch(rows){
    try {
        const ksnap = await getDocs(collection(db,'karyawan'));
        const map = {};
        ksnap.forEach(d => map[d.id] = d.data());
        renderWorkingNow(rows, map);
    } catch(e){ console.warn('renderWorkingNowWithFetch:', e.message); }
}
