import { auth, db, OWNER_EMAILS, firebaseConfig } from './firebase-config.js';



import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, query, where, orderBy, getDocs, onSnapshot, Timestamp, setDoc, updateDoc, deleteDoc, getDoc, addDoc, doc, serverTimestamp }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signOut as authSignOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const $ = id => document.getElementById(id);
const TIPE = { clock_in:'Clock In', clock_out:'Clock Out', break_in:'Istirahat', break_out:'Selesai Istirahat', pause_in:'Pause Kerja', pause_out:'Lanjut Kerja', overtime_in:'Mulai Lembur', overtime_out:'Selesai Lembur' };
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
    initKehadiranMatrix();
    try{ loadData(); }catch(e){ console.warn('init loadData err', e); }
});

$('btnLogout').onclick = () => signOut(auth).then(() => location.href = 'index.html').catch(()=>location.href='index.html');
$('btnFilter').onclick = loadData;
// Klik Beranda untuk refresh data dashboard
const _btnBeranda = $('berandaTitle');
if (_btnBeranda){
  _btnBeranda.addEventListener('click', ()=>{
    const ic = $('berandaRefreshIcon');
    if (ic){ ic.style.transition='transform .6s'; ic.style.transform='rotate(360deg)'; setTimeout(()=>{ic.style.transform='rotate(0deg)';}, 650); }
    try { loadData(); } catch(e){}
  });
}
$('btnExport').onclick = exportCSV;

function initSidebar(){
    const links = document.querySelectorAll('.nav-link');
    function activate(page){
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const target = document.getElementById('page-' + page);
        if (target) target.classList.add('active');
        links.forEach(l => l.classList.toggle('active', l.dataset.page === page));
        if (page === 'kehadiran') loadKehadiranMatrix();
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

    // Window 48 jam ke belakang supaya shift lintas hari (mis. masuk sore, pulang dini hari) tidak hilang
    const start = new Date(Date.now() - 48 * 60 * 60 * 1000);
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

const TOTAL_KARYAWAN_DEFAULT = 0;
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
    try{ await renderHadirFloating(rows); }catch(e){ console.warn('hadir floating err', e); }
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
        $('capLokasi').textContent = inRuko + ' di ruko \u00B7 ' + outRuko + ' luar lokasi';
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
        snap.forEach(d => { const x = Object.assign({_id:d.id}, d.data()); rows.push(x); if (x.email) karyawanSet.add(x.email); });

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
        const img = (r.fotoSelfie || r.foto)
            ? '<img src="'+(r.fotoSelfie || r.foto)+'" alt="foto" style="width:48px;height:48px;object-fit:cover;border-radius:6px;cursor:pointer" onclick="document.getElementById(\'modalImg\').src=this.src;document.getElementById(\'photoModal\').classList.add(\'show\')">'
            : '<span class="muted">-</span>';
        const tipeLabel = TIPE[r.tipe] || r.tipe || '-';
        const nama = r.nama || (r.email ? r.email.split('@')[0] : '-');
        let badge = '';
        if (r.inRadius === true) {
            badge = '<span class="badge-loc badge-in">\uD83D\uDFE2 In Office ('+(r.jarak!=null?r.jarak+'m':'')+')</span>';
        } else if (r.inRadius === false) {
            badge = '<span class="badge-loc badge-out">\uD83D\uDD34 Out of Radius ('+(r.jarak!=null?r.jarak+'m':'')+')</span>';
        } else {
            badge = '<span class="muted" style="font-size:11px">-</span>';
        }
        const tr = document.createElement('tr');
        if (r.inRadius === false) tr.style.background = '#fef2f2';
        tr.innerHTML = '<td>'+tanggal+'</td><td>'+jam+'</td><td>'+nama+'</td><td>'+tipeLabel+'</td><td>'+badge+'</td><td>'+loc+'</td><td>'+img+'</td>'+
            '<td>'+
              '<button class="btn-link btn-edit-absen" data-id="'+(r._id||'')+'" data-nama="'+nama+'" data-tipe="'+(r.tipe||'')+'" data-ts="'+(r.ts && r.ts.toDate ? r.ts.toDate().toISOString() : '')+'">Edit</button>'+
              ' <button class="btn-link btn-hapus-absen" data-id="'+(r._id||'')+'" data-nama="'+nama+'" data-tipe="'+(r.tipe||'')+'" data-ts="'+(r.ts && r.ts.toDate ? r.ts.toDate().toISOString() : '')+'" style="color:#dc2626">Hapus</button>'+
              '</td>';
        tb.appendChild(tr);
    });
    document.querySelectorAll('.btn-edit-absen').forEach(b=>{
        b.onclick = ()=> openEditAbsen(b.dataset.id, b.dataset.nama, b.dataset.tipe, b.dataset.ts);
    });
    document.querySelectorAll('.btn-hapus-absen').forEach(b=>{
        b.onclick = ()=> openDeleteAbsen(b.dataset.id, b.dataset.nama, b.dataset.tipe, b.dataset.ts);
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
        const cells = [tanggal, jam, r.nama || '', r.email || '', TIPE[r.tipe] || r.tipe || '', statusLok, jarak, lat, lng, acc, r.sizeKB || '', (r.fotoSelfie || r.foto) || '', r.breakFilledAtCheckout ? 'Yes' : '', r.autoCutByCheckout ? 'Yes' : '', r.alasanEarly || ''];
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
        rows.forEach((x, idx) => {
            const img = x.photoURL
                ? '<img src="'+x.photoURL+'" alt="foto" style="width:40px;height:40px;border-radius:50%;object-fit:cover">'
                : '<span class="muted">-</span>';
            const idDisplay = x.idKaryawan || x.nik || '-';
            const jamKerja = x.jamKerja || 8;
            const tr = document.createElement('tr');
            const tj = x.tanggalJoin ? (x.tanggalJoin.toDate ? x.tanggalJoin.toDate() : new Date(x.tanggalJoin)) : null;
            const tjStr = tj ? tj.toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'}) : '-';
            tr.innerHTML = '<td>'+(idx+1)+'</td>'+
              '<td>'+(x.nama||'-')+'</td>'+
              '<td>'+(x.email||'-')+'</td>'+
              '<td>'+(x.phone||'-')+'</td>'+
              '<td>'+idDisplay+'</td>'+
              '<td>'+jamKerja+' jam</td>'+
              '<td>'+tjStr+'</td>'+
              '<td>'+img+'</td>'+
              '<td><button class="btn-link btn-edit-kar" data-uid="'+x.id+'">Edit</button> <button class="btn-link btn-del-kar" data-uid="'+x.id+'" data-nama="'+(x.nama||'')+'" style="color:#dc2626">Hapus</button></td>';
            tb.appendChild(tr);
        });
        document.querySelectorAll('.btn-edit-kar').forEach(b => {
            b.onclick = () => openEditKaryawan(b.dataset.uid);
        });
        document.querySelectorAll('.btn-del-kar').forEach(b => {
            b.onclick = () => deleteKaryawan(b.dataset.uid, b.dataset.nama);
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
        const tanggalJoinVal = $('newTanggalJoin') ? $('newTanggalJoin').value : '';
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
            tanggalJoin: tanggalJoinVal ? Timestamp.fromDate(new Date(tanggalJoinVal)) : null,
            createdAt: serverTimestamp()
        }, {merge:true});
        await authSignOut(secondaryAuth);
        await deleteApp(secondaryApp);
        secondaryApp = null;
        alert('Karyawan ' + nama + ' added successfully.');
        $('formAddUser').reset(); if ($('newTanggalJoin')) $('newTanggalJoin').value='';
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
        if ($('editTanggalJoin')){
            const tj = d.tanggalJoin ? (d.tanggalJoin.toDate ? d.tanggalJoin.toDate() : new Date(d.tanggalJoin)) : null;
            $('editTanggalJoin').value = tj ? tj.toISOString().substring(0,10) : '';
        }
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
        const tanggalJoinVal = $('editTanggalJoin') ? $('editTanggalJoin').value : '';
        const tjPayload = tanggalJoinVal ? Timestamp.fromDate(new Date(tanggalJoinVal)) : null;
        await setDoc(doc(db,'karyawan',uid), { nama, phone, idKaryawan, jamKerja, tanggalJoin: tjPayload }, {merge:true});
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
        return '<div class="working-item">' + avatar + '<div class="working-info"><b>'+nama+'</b><small>'+tipeLabel+' \u00B7 '+jam+'</small></div><span class="badge '+tipeColor+'">'+tipeLabel+'</span></div>';
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


// ===== Hapus Karyawan =====
async function deleteKaryawan(uid, nama){
    if (!uid){ alert('UID karyawan tidak valid.'); return; }
    const ok = confirm('Hapus karyawan "' + (nama||uid) + '"?\n\nIni akan menghapus data karyawan dari Firestore (koleksi karyawan + profil).\n\nCATATAN: Akun login (Firebase Authentication) HARUS dihapus manual lewat Firebase Console > Authentication > Users.');
    if (!ok) return;
    try{
        await deleteDoc(doc(db,'karyawan',uid));
        try{ await deleteDoc(doc(db,'profil',uid)); }catch(e){ console.warn('profil delete err (boleh diabaikan):', e); }
        alert('Karyawan "' + (nama||uid) + '" berhasil dihapus dari Firestore.\n\nJangan lupa hapus akun login lewat Firebase Console > Authentication.');
        loadKaryawanList();
    }catch(e){
        alert('Gagal hapus: ' + (e.message||e));
    }
}

// ===== Edit Absensi (Owner Only) =====
function openEditAbsen(docId, nama, tipe, tsIso){
    if (!docId){ alert('ID absen tidak ditemukan.'); return; }
    $('editAbsenId').value = docId;
    $('editAbsenNama').value = nama || '';
    $('editAbsenTipe').value = tipe || 'clock_in';
    if (tsIso){
        try{
            const d = new Date(tsIso);
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth()+1).padStart(2,'0');
            const dd = String(d.getDate()).padStart(2,'0');
            const hh = String(d.getHours()).padStart(2,'0');
            const mi = String(d.getMinutes()).padStart(2,'0');
            const ss = String(d.getSeconds()).padStart(2,'0');
            $('editAbsenDate').value = yyyy + '-' + mm + '-' + dd;
            $('editAbsenTime').value = hh + ':' + mi + ':' + ss;
        }catch(e){}
    }
    $('editAbsenNote').value = '';
    $('editAbsenModal').classList.remove('hidden');
}
if ($('btnEditAbsenCancel')) $('btnEditAbsenCancel').onclick = ()=> $('editAbsenModal').classList.add('hidden');
if ($('formEditAbsen')) $('formEditAbsen').onsubmit = async (e)=>{
    e.preventDefault();
    const id = $('editAbsenId').value;
    const tipe = $('editAbsenTipe').value;
    const dateStr = $('editAbsenDate').value;
    const timeStr = $('editAbsenTime').value;
    const note = ($('editAbsenNote').value||'').trim();
    if (!id || !dateStr || !timeStr){ alert('Tanggal & Jam wajib diisi.'); return; }
    const newDate = new Date(dateStr + 'T' + timeStr);
    if (isNaN(newDate.getTime())){ alert('Format tanggal/jam tidak valid.'); return; }
    try{
        await updateDoc(doc(db,'absensi', id), {
            tipe: tipe,
            ts: Timestamp.fromDate(newDate),
            editedByOwner: true,
            editedAt: serverTimestamp(),
            editNote: note || null
        });
        $('editAbsenModal').classList.add('hidden');
        alert('Absensi berhasil di-update.');
        if (typeof loadData === 'function') loadData();
    }catch(err){
        alert('Gagal update: ' + (err.message||err));
    }
};

// ===== Hapus Absen (Owner Only) =====
let _pendingDeleteAbsenId = null;
function openDeleteAbsen(id, nama, tipe, tsIso){
    if (!id) return;
    const tipeLabels = {
        clock_in:'Clock In', clock_out:'Clock Out',
        break_in:'Istirahat', break_out:'Selesai Istirahat',
        overtime_in:'Mulai Lembur', overtime_out:'Selesai Lembur'
    };
    const tipeLabel = tipeLabels[tipe] || tipe || '-';
    let tglStr = '-';
    try {
        if (tsIso){
            const d = new Date(tsIso);
            tglStr = d.toLocaleDateString('id-ID',{weekday:'long', day:'2-digit', month:'long', year:'numeric'}) +
                     ' jam ' + d.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',hour12:false});
        }
    }catch(e){}
    _pendingDeleteAbsenId = id;
    $('deleteAbsenId').value = id;
    $('deleteAbsenMsg').innerHTML = 'Yakin hapus absen <strong>' + tipeLabel + '</strong> milik <strong>' + (nama||'-') + '</strong> tanggal <strong>' + tglStr + '</strong>?';
    $('deleteAbsenModal').classList.remove('hidden');
}

// Setup modal handlers (jalan sekali saat file load)
(function setupDeleteAbsenModal(){
    const cancelBtn = $('btnDeleteAbsenCancel');
    const confirmBtn = $('btnDeleteAbsenConfirm');
    const modal = $('deleteAbsenModal');
    if (cancelBtn){
        cancelBtn.onclick = ()=>{ _pendingDeleteAbsenId = null; if (modal) modal.classList.add('hidden'); };
    }
    if (confirmBtn){
        confirmBtn.onclick = async ()=>{
            const id = _pendingDeleteAbsenId || ($('deleteAbsenId') && $('deleteAbsenId').value);
            if (!id){ if (modal) modal.classList.add('hidden'); return; }
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Menghapus...';
            try {
                await deleteDoc(doc(db,'absensi', id));
                console.log('[AUDIT] Absen dihapus oleh', auth.currentUser && auth.currentUser.email, 'docId=', id, 'pada', new Date().toISOString());
                _pendingDeleteAbsenId = null;
                if (modal) modal.classList.add('hidden');
                try { loadData(); } catch(e){}
            } catch(err){
                alert('Gagal hapus absen: ' + (err.message || err));
            } finally {
                confirmBtn.disabled = false;
                confirmBtn.textContent = 'Hapus';
            }
        };
    }
})();

// ===== Floating Bar Kehadiran di Beranda =====
async function renderHadirFloating(rows){
    const total = await getTotalKaryawan();

    // group by uid, get all events sorted by time asc
    const byUid = new Map();
    for (const r of rows){
        const key = r.uid || r.email;
        if (!key) continue;
        if (!byUid.has(key)) byUid.set(key, []);
        byUid.get(key).push(r);
    }
    // sort each user's events by waktu asc
    for (const arr of byUid.values()){
        arr.sort((a,b)=>{
            const ta = a.ts && a.ts.toMillis ? a.ts.toMillis() : (a.ts||0);
            const tb = b.ts && b.ts.toMillis ? b.ts.toMillis() : (b.ts||0);
            return ta - tb;
        });
    }

    const hadirUids = [];
    const workingUids = [];
    const breakUids = [];
    const finishUids = [];

    for (const [uid, arr] of byUid){
        const hasClockIn = arr.some(r=>r.tipe==='clock_in');
        if (!hasClockIn) continue;
        hadirUids.push(uid);

        // State machine: determine current state by LAST event
        const lastEvent = arr[arr.length - 1];
        const lastType = lastEvent ? lastEvent.tipe : '';
        if (lastType === 'clock_out' || lastType === 'overtime_out'){
            // hanya tampilkan di 'Finish Working' jika clock_out terjadi dalam 6 jam terakhir
            // supaya keesokan hari beranda bersih kembali
            const lastMs = (lastEvent && lastEvent.ts && lastEvent.ts.toMillis) ? lastEvent.ts.toMillis() : 0;
            if (Date.now() - lastMs <= 6 * 60 * 60 * 1000){
                finishUids.push(uid);
            }
        } else if (lastType === 'break_in'){
            breakUids.push(uid);
        } else {
            // clock_in, break_out, overtime_in => On Working
            workingUids.push(uid);
        }
    }

    function namaOf(uid){
        const r = rows.find(x=>(x.uid||x.email)===uid);
        return (r && r.nama) ? r.nama : '';
    }

    async function paint(containerId, countId, uids){
        const cnt = $(countId);
        if (cnt) cnt.textContent = '(' + uids.length + ' of ' + total + ')';
        const wrap = $(containerId);
        if (!wrap) return;
        wrap.innerHTML = '';
        const slice = uids.slice(0, 8);
        for (const u of slice){
            let foto = '';
            try{
                const snap = await getDoc(doc(db,'profil', u));
                if (snap.exists()) foto = snap.data().foto || '';
            }catch(e){}
            const initial = (namaOf(u) || '?').charAt(0).toUpperCase();
            if (!foto){
                wrap.insertAdjacentHTML('beforeend', '<span class="hadir-avatar hadir-avatar-ph" title="'+namaOf(u)+'">'+initial+'</span>');
            } else {
                wrap.insertAdjacentHTML('beforeend', '<img class="hadir-avatar" src="'+foto+'" alt="" title="'+namaOf(u)+'" />');
            }
        }
        if (uids.length === 0){
            wrap.insertAdjacentHTML('beforeend', '<span class="hadir-empty muted small">\u2014</span>');
        } else if (uids.length > 8){
            wrap.insertAdjacentHTML('beforeend', '<span class="hadir-avatar hadir-avatar-ph">+'+(uids.length-8)+'</span>');
        }
    }

    await paint('hadirAvatars', 'hadirCount', hadirUids);
    await paint('workingAvatars', 'workingCount', workingUids);
    await paint('breakAvatars', 'breakCount', breakUids);
    await paint('finishAvatars', 'finishCount', finishUids);
}


// ===== KEHADIRAN MATRIX (Hadirr-style) =====
const MATRIX_COLS = [
  { tipe:'clock_in',     label:'Jam Masuk' },
  { tipe:'clock_out',    label:'Jam Keluar' },
  { tipe:'break_in',     label:'Istirahat' },
  { tipe:'break_out',    label:'Selesai Istirahat' },
  { tipe:'pause_in',     label:'Pause' },
  { tipe:'pause_out',    label:'Lanjut' },
  { tipe:'overtime_in',  label:'Lembur Masuk' },
  { tipe:'overtime_out', label:'Lembur Keluar' }
];

let currentKhDate = new Date();
let khRowsCache = {};

function fmtHM(d){
  if (!d) return '';
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}
function pad2(n){ return String(n).padStart(2,'0'); }
function dateToInputStr(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }

function buildWeekNav(refDate){
  const wrap = $('khWeekNav'); if (!wrap) return;
  wrap.innerHTML = '';
  const d = new Date(refDate);
  const day = d.getDay();
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const monday = new Date(d); monday.setDate(d.getDate() + diffToMon);
  for (let i=0; i<7; i++){
    const dd = new Date(monday); dd.setDate(monday.getDate() + i);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kh-day-btn' + (dateToInputStr(dd)===dateToInputStr(refDate) ? ' active':'');
    const wdNames = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
    btn.innerHTML = '<span class="kh-day-wd">'+wdNames[dd.getDay()]+'</span><span class="kh-day-num">'+dd.getDate()+'/'+(dd.getMonth()+1)+'</span>';
    btn.onclick = ()=>{ currentKhDate = dd; $('khDate').value = dateToInputStr(dd); loadKehadiranMatrix(); };
    wrap.appendChild(btn);
  }
}

function initKehadiranMatrix(){
  const inp = $('khDate'); if (!inp) return;
  inp.value = dateToInputStr(currentKhDate);
  inp.onchange = ()=>{
    const v = inp.value;
    if (!v) return;
    const [y,m,dd] = v.split('-').map(Number);
    currentKhDate = new Date(y, m-1, dd);
    loadKehadiranMatrix();
  };
  const prev = $('khPrevDay'); if (prev) prev.onclick = ()=>{ const d=new Date(currentKhDate); d.setDate(d.getDate()-1); currentKhDate=d; inp.value=dateToInputStr(d); loadKehadiranMatrix(); };
  const next = $('khNextDay'); if (next) next.onclick = ()=>{ const d=new Date(currentKhDate); d.setDate(d.getDate()+1); currentKhDate=d; inp.value=dateToInputStr(d); loadKehadiranMatrix(); };
  const tdy  = $('khToday');   if (tdy)  tdy.onclick = ()=>{ currentKhDate=new Date(); inp.value=dateToInputStr(currentKhDate); loadKehadiranMatrix(); };
}

async function loadKehadiranMatrix(){
  try {
    const d = new Date(currentKhDate);
    buildWeekNav(d);
    const titleEl = $('khTitle');
    if (titleEl){
      titleEl.textContent = 'Kehadiran Harian | ' + d.toLocaleDateString('id-ID',{weekday:'long', day:'2-digit', month:'long', year:'numeric'});
    }
    const start = new Date(d); start.setHours(0,0,0,0);
    const end   = new Date(d); end.setHours(23,59,59,999);
    const q = query(collection(db,'absensi'),
      where('ts','>=', Timestamp.fromDate(start)),
      where('ts','<=', Timestamp.fromDate(end)),
      orderBy('ts','asc'));
    const snap = await getDocs(q);
    const byUid = {};
    snap.forEach(docSnap => {
      const r = Object.assign({ _id:docSnap.id }, docSnap.data());
      const uid = r.uid || r.email || '';
      if (!byUid[uid]) byUid[uid] = { uid, nama:r.nama||(r.email||'').split('@')[0]||'-', email:r.email||'', events:[], byTipe:{} };
      byUid[uid].events.push(r);
      if (!byUid[uid].byTipe[r.tipe]) byUid[uid].byTipe[r.tipe] = r;
    });
    khRowsCache = byUid;
    renderKehadiranMatrix();
    renderKhSummary();
  } catch(err){
    console.error('loadKehadiranMatrix error:', err);
    alert('Gagal load kehadiran: ' + (err.message||err));
  }
}

function renderKhSummary(){
  const sum = $('khSummary'); if (!sum) return;
  const uids = Object.keys(khRowsCache);
  let working=0, onBreak=0, paused=0, finish=0;
  uids.forEach(u=>{
    const ev = khRowsCache[u].events;
    const last = ev[ev.length-1];
    if (!last) return;
    if (last.tipe==='clock_out' || last.tipe==='overtime_out') finish++;
    else if (last.tipe==='break_in') onBreak++;
    else if (last.tipe==='pause_in') paused++;
    else working++;
  });
  sum.innerHTML =
    '<div class="kh-stat"><b>'+uids.length+'</b><small>Hadir</small></div>'+
    '<div class="kh-stat"><b>'+working+'</b><small>On Working</small></div>'+
    '<div class="kh-stat"><b>'+onBreak+'</b><small>On Break</small></div>'+
    '<div class="kh-stat"><b>'+paused+'</b><small>Paused</small></div>'+
    '<div class="kh-stat"><b>'+finish+'</b><small>Finish</small></div>';
}

function gpsDotFor(row){
  const ci = row.byTipe['clock_in'];
  if (!ci || ci.inRadius === undefined || ci.inRadius === null) return '<span class="gps-dot gps-na" title="GPS tidak terdeteksi"></span>';
  return ci.inRadius
    ? '<span class="gps-dot gps-in" title="GPS dalam jangkauan ('+ (ci.jarak||0) +'m)"></span>'
    : '<span class="gps-dot gps-out" title="GPS di luar jangkauan ('+ (ci.jarak||0) +'m)"></span>';
}

function statusBadgeFor(row){
  const ev = row.events;
  const last = ev[ev.length-1];
  if (!last) return '<span class="kh-badge kh-na">-</span>';
  if (last.tipe==='clock_out' || last.tipe==='overtime_out') return '<span class="kh-badge kh-finish">Finish</span>';
  if (last.tipe==='break_in') return '<span class="kh-badge kh-break">Break</span>';
  if (last.tipe==='pause_in') return '<span class="kh-badge kh-pause">Paused</span>';
  return '<span class="kh-badge kh-working">Working</span>';
}

function renderKehadiranMatrix(){
  const tb = document.querySelector('#tblKehadiranMatrix tbody');
  if (!tb) return;
  tb.innerHTML = '';
  const uids = Object.keys(khRowsCache).sort((a,b)=>{
    const na = (khRowsCache[a].nama||'').toLowerCase();
    const nb = (khRowsCache[b].nama||'').toLowerCase();
    return na.localeCompare(nb);
  });
  if (!uids.length){
    $('khEmpty').textContent = 'Belum ada record absensi pada tanggal ini.';
    return;
  }
  $('khEmpty').textContent = '';
  uids.forEach(uid=>{
    const row = khRowsCache[uid];
    const tr = document.createElement('tr');
    tr.dataset.uid = uid;
    let cells = '<td class="col-nama">'+ gpsDotFor(row) +' '+ (row.nama||'-') +'</td>';
    cells += '<td>'+ statusBadgeFor(row) +'</td>';
    MATRIX_COLS.forEach(col=>{
      const ev = row.byTipe[col.tipe];
      const val = ev && ev.ts && ev.ts.toDate ? fmtHM(ev.ts.toDate()) : '';
      const editedFlag = ev && (ev.editedByOwner||ev.manualEdit) ? ' kh-edited' : '';
      cells += '<td><input type="time" class="kh-time'+editedFlag+'" data-tipe="'+col.tipe+'" value="'+val+'" data-orig="'+val+'"></td>';
    });
    cells += '<td class="col-aksi">'+
             '<button class="btn btn-sm btn-primary kh-save-row">Simpan</button>'+
             '<button class="btn btn-sm btn-ghost kh-delete-row" title="Hapus semua record karyawan ini di tanggal ini">Hapus</button>'+
             '</td>';
    tr.innerHTML = cells;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.kh-save-row').forEach(btn=>{
    btn.onclick = (e)=>{ const tr = e.target.closest('tr'); saveKehadiranRow(tr.dataset.uid, tr); };
  });
  tb.querySelectorAll('.kh-delete-row').forEach(btn=>{
    btn.onclick = (e)=>{ const tr = e.target.closest('tr'); deleteKehadiranRow(tr.dataset.uid); };
  });
}

async function saveKehadiranRow(uid, tr){
  const row = khRowsCache[uid];
  if (!row){ alert('Data karyawan tidak ditemukan.'); return; }
  const inputs = tr.querySelectorAll('input.kh-time');
  const changes = [];
  inputs.forEach(inp=>{
    const tipe = inp.dataset.tipe;
    const newVal = (inp.value||'').trim();
    const origVal = inp.dataset.orig || '';
    if (newVal === origVal) return;
    changes.push({ tipe, newVal, origVal });
  });
  if (!changes.length){ alert('Tidak ada perubahan.'); return; }
  if (!confirm('Simpan '+changes.length+' perubahan untuk '+(row.nama||uid)+'?')) return;
  const dateBase = new Date(currentKhDate);
  let okCount = 0, errCount = 0;
  for (const ch of changes){
    try{
      const existing = row.byTipe[ch.tipe];
      if (ch.newVal === '' && existing){
        await deleteDoc(doc(db,'absensi', existing._id));
        okCount++;
      } else if (ch.newVal !== ''){
        const [hh,mm] = ch.newVal.split(':').map(Number);
        const newTs = new Date(dateBase); newTs.setHours(hh, mm, 0, 0);
        if (existing){
          await updateDoc(doc(db,'absensi', existing._id), {
            ts: Timestamp.fromDate(newTs),
            editedByOwner: true,
            manualEdit: true,
            editedAt: serverTimestamp()
          });
        } else {
          await addDoc(collection(db,'absensi'), {
            uid: row.uid,
            email: row.email,
            nama: row.nama,
            tipe: ch.tipe,
            ts: Timestamp.fromDate(newTs),
            manualEdit: true,
            editedByOwner: true,
            editedAt: serverTimestamp(),
            lokasi: null,
            jarak: null,
            inRadius: null
          });
        }
        okCount++;
      }
    }catch(e){
      console.error('save change err', ch, e);
      errCount++;
    }
  }
  alert('Selesai. Berhasil: '+okCount+', Gagal: '+errCount);
  await loadKehadiranMatrix();
}

async function deleteKehadiranRow(uid){
  const row = khRowsCache[uid];
  if (!row){ return; }
  if (!confirm('Hapus SEMUA record absensi milik '+(row.nama||uid)+' pada tanggal ini? Aksi ini tidak bisa di-undo.')) return;
  let ok=0,err=0;
  for (const ev of row.events){
    try{ await deleteDoc(doc(db,'absensi', ev._id)); ok++; }catch(e){err++;}
  }
  alert('Selesai. Dihapus: '+ok+', Gagal: '+err);
  await loadKehadiranMatrix();
}
