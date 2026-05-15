
// === 24h time-text helper (manual entry, no AM/PM) ===
(function(){
  if (window.__time24Installed) return; window.__time24Installed = true;
  function autoFormat(v){
    v = (v||'').replace(/[^0-9]/g,'').slice(0,4);
    if (v.length >= 3) return v.slice(0,2) + ':' + v.slice(2);
    return v;
  }
  function validHM(v){ return /^([01]\d|2[0-3]):[0-5]\d$/.test(v); }
  document.addEventListener('input', function(e){
    const el = e.target;
    if (!el.matches || !el.matches('input.kh-time, input.kh-edit-jam, input.rd-edit-jam')) return;
    const before = el.value;
    const after = autoFormat(before);
    if (after !== before){
      el.value = after;
      try { el.setSelectionRange(after.length, after.length); } catch(_){}
    }
  });
  document.addEventListener('blur', function(e){
    const el = e.target;
    if (!el.matches || !el.matches('input.kh-time, input.kh-edit-jam, input.rd-edit-jam')) return;
    const v = (el.value||'').trim();
    if (v === '') return;
    if (!validHM(v)){
      const orig = el.dataset.orig || el._origVal || '';
      el.value = orig;
      el.classList.add('kh-save-err');
      setTimeout(()=>el.classList.remove('kh-save-err'), 1500);
    }
  }, true);
})();


// === Auto-save satu cell di matrix Kehadiran Harian (tanpa tombol Simpan) ===
async function saveSingleKehadiranCell(uid, inp){
    const row = khRowsCache[uid];
    if(!row){ console.warn('saveSingleKehadiranCell: row tidak ditemukan', uid); return; }
    const tipe = inp.dataset.tipe;
    const newVal = (inp.value||'').trim();
    const origVal = inp.dataset.orig || '';
    if(newVal === origVal) return;
    inp.classList.remove('kh-saved','kh-save-err');
    inp.classList.add('kh-saving');
    try{
        const existing = row.byTipe && row.byTipe[tipe];
        if(newVal === ''){
            if(existing){
                await deleteDoc(doc(db,'absensi', existing._id));
            }
        } else {
            const [hh,mm] = newVal.split(':').map(Number);
            const dateBase = new Date(currentKhDate);
            const newTs = new Date(dateBase);
            newTs.setHours(hh||0, mm||0, 0, 0);
            // Auto-shift +1 hari untuk shift overnight:
            const OUT_PAIRS = { clock_out:'clock_in', break_out:'break_in', pause_out:'pause_in', overtime_out:'overtime_in' };
            const inTipe = OUT_PAIRS[tipe];
            if (inTipe){
                const inEv = row.byTipe && row.byTipe[inTipe];
                if (inEv && inEv.ts && inEv.ts.toDate){
                    const inMs = inEv.ts.toDate().getTime();
                    if (newTs.getTime() < inMs){
                        newTs.setDate(newTs.getDate() + 1);
                    }
                }
            }
            if(existing){
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
                    tipe: tipe,
                    ts: Timestamp.fromDate(newTs),
                    manualEdit: true,
                    editedByOwner: true,
                    editedAt: serverTimestamp(),
                    lokasi: null,
                    jarak: null,
                    inRadius: null
                });
            }
        }
        inp.classList.remove('kh-saving');
        inp.classList.add('kh-saved');
        inp.dataset.orig = newVal;
        setTimeout(()=>inp.classList.remove('kh-saved'), 1500);
        try{ await loadKehadiranMatrix(); }catch(e){ console.warn('reload matrix after save err', e); }
    }catch(err){
        console.error('saveSingleKehadiranCell err', err);
        inp.classList.remove('kh-saving');
        inp.classList.add('kh-save-err');
        alert('Gagal simpan: '+(err.message||err));
        inp.value = origVal;
        setTimeout(()=>inp.classList.remove('kh-save-err'), 2500);
    }
}

import { auth, db, storage, OWNER_EMAILS, firebaseConfig } from './firebase-config.js';
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";



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
        try{ initRekap(); }catch(e){ console.error('initRekap failed', e); }
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
        if (page === 'rekap') { try{ loadRekap(); }catch(e){ console.error(e); } }
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

    // Hitung "hari ini" saja (events di-load window 48 jam untuk handle shift lintas hari,
    // tapi statistik beranda harus strict tanggal hari ini)
    const _today0 = new Date(); _today0.setHours(0,0,0,0);
    const _todayMs = _today0.getTime();
    function _isToday(r){
        const ms = (r && r.ts && r.ts.toMillis) ? r.ts.toMillis() : 0;
        return ms >= _todayMs;
    }
    rows.forEach(r => {
        if (!_isToday(r)) return;
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
        const isoTs = r.ts && r.ts.toDate ? r.ts.toDate().toISOString() : '';
        const jamHHMMSS = (r.ts && r.ts.toDate) ? (()=>{ const d=r.ts.toDate(); const hh=String(d.getHours()).padStart(2,'0'); const mi=String(d.getMinutes()).padStart(2,'0'); const ss=String(d.getSeconds()).padStart(2,'0'); return hh+':'+mi+':'+ss; })() : '';
        const tanggalYMD = (r.ts && r.ts.toDate) ? (()=>{ const d=r.ts.toDate(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); })() : '';
        const tipeOpts = ['clock_in','clock_out','break_in','break_out','overtime_in','overtime_out']
            .map(v=>'<option value="'+v+'"'+(v===(r.tipe||'')?' selected':'')+'>'+(TIPE[v]||v)+'</option>').join('');
        tr.innerHTML = '<td><input type="date" class="kh-edit-tgl" data-id="'+(r._id||'')+'" value="'+tanggalYMD+'"></td>'+
            '<td><input type="text" inputmode="numeric" maxlength="5" placeholder="--:--" class="kh-edit-jam" data-id="'+(r._id||'')+'" value="'+(jamHHMMSS||'').slice(0,5)+'"></td>'+
            '<td>'+nama+'</td>'+
            '<td><select class="kh-edit-tipe" data-id="'+(r._id||'')+'">'+tipeOpts+'</select></td>'+
            '<td>'+badge+'</td><td>'+loc+'</td><td>'+img+'</td>'+
            '<td class="col-aksi-kh">'+
                '<button class="btn-link btn-hapus-absen" data-id="'+(r._id||'')+'" data-nama="'+nama+'" data-tipe="'+(r.tipe||'')+'" data-ts="'+isoTs+'" style="color:#dc2626">🗑️ Hapus</button>'+
            '</td>';
        tb.appendChild(tr);
    });
    // Inline edit: jam (waktu)
    document.querySelectorAll('.kh-edit-jam').forEach(inp=>{
        inp._origVal = inp.value;
        inp.onchange = async ()=>{
            const id = inp.dataset.id;
            const tglInput = document.querySelector('.kh-edit-tgl[data-id="'+id+'"]');
            const tglVal = tglInput ? tglInput.value : '';
            const jamVal = inp.value;
            if(!id || !tglVal || !jamVal){ alert('Tanggal/Jam tidak valid'); inp.value = inp._origVal; return; }
            try{
                const newDate = new Date(tglVal + 'T' + jamVal);
                if(isNaN(newDate.getTime())){ alert('Format jam tidak valid'); inp.value = inp._origVal; return; }
                inp.classList.add('kh-saving');
                await updateDoc(doc(db,'absensi', id), { ts: Timestamp.fromDate(newDate), editedByOwner: true, editedAt: serverTimestamp() });
                inp.classList.remove('kh-saving'); inp.classList.add('kh-saved');
                setTimeout(()=>inp.classList.remove('kh-saved'), 1200);
                inp._origVal = inp.value;
                try{ const cidx = cachedRows.findIndex(r=>r._id===id); if(cidx>=0) cachedRows[cidx].ts = Timestamp.fromDate(newDate); }catch(e){}
            }catch(err){
                console.error('inline edit jam err', err);
                inp.classList.remove('kh-saving');
                alert('Gagal simpan jam: '+(err.message||err));
                inp.value = inp._origVal;
            }
        };
    });
    document.querySelectorAll('.kh-edit-tgl').forEach(inp=>{
        inp._origVal = inp.value;
        inp.onchange = ()=>{
            const id = inp.dataset.id;
            const jamInput = document.querySelector('.kh-edit-jam[data-id="'+id+'"]');
            if(jamInput) jamInput.dispatchEvent(new Event('change'));
        };
    });
    document.querySelectorAll('.kh-edit-tipe').forEach(sel=>{
        sel._origVal = sel.value;
        sel.onchange = async ()=>{
            const id = sel.dataset.id;
            const newTipe = sel.value;
            if(!id || !newTipe){ sel.value = sel._origVal; return; }
            try{
                sel.classList.add('kh-saving');
                await updateDoc(doc(db,'absensi', id), { tipe: newTipe, editedByOwner: true, editedAt: serverTimestamp() });
                sel.classList.remove('kh-saving'); sel.classList.add('kh-saved');
                setTimeout(()=>sel.classList.remove('kh-saved'), 1200);
                sel._origVal = sel.value;
                try{ const cidx = cachedRows.findIndex(r=>r._id===id); if(cidx>=0) cachedRows[cidx].tipe = newTipe; }catch(e){}
            }catch(err){
                console.error('inline edit tipe err', err);
                sel.classList.remove('kh-saving');
                alert('Gagal simpan tipe: '+(err.message||err));
                sel.value = sel._origVal;
            }
        };
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
        // Field baru: payroll + data pribadi + bank
        if ($('editJabatan')) $('editJabatan').value = d.jabatan || '';
        if ($('editStatusKaryawan')) $('editStatusKaryawan').value = d.statusKaryawan || '';
        if ($('editBaseHarian')) $('editBaseHarian').value = d.baseHarian || '';
        if ($('editMultiplierLembur')) $('editMultiplierLembur').value = d.multiplierLembur || 1.5;
        if ($('editNamaBank')) $('editNamaBank').value = d.namaBank || '';
        if ($('editAtasNamaRek')) $('editAtasNamaRek').value = d.atasNamaRek || '';
        // Status upload dokumen
        const setStat = (id, url) => { const el = $(id); if (el) el.textContent = url ? '✓ sudah diupload' : '(belum)'; };
        setStat('ktpStatus', d.ktpUrl);
        setStat('npwpStatus', d.npwpUrl);
        setStat('bukuTabunganStatus', d.bukuTabunganUrl);
        // Reset file inputs
        ['editKtpFile','editNpwpFile','editBukuTabunganFile'].forEach(id=>{ const el=$(id); if(el) el.value=''; });
        $('editKaryawanModal').classList.remove('hidden');
    } catch(e){ alert('Failed to load data: ' + e.message); }
}
$('btnEditCancel').onclick = () => $('editKaryawanModal').classList.add('hidden');
// Helper upload satu file ke Storage path karyawan-private/{uid}/{slot}.{ext}
async function uploadKaryawanFile(uid, slot, file){
    if (!file) return null;
    const ext = (file.name.split('.').pop()||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'');
    const path = 'karyawan-private/' + uid + '/' + slot + '.' + (ext||'jpg');
    const r = storageRef(storage, path);
    await uploadBytes(r, file, { contentType: file.type || 'image/jpeg' });
    return await getDownloadURL(r);
}

$('formEditKaryawan').onsubmit = async (e) => {
    e.preventDefault();
    const uid = $('editUid').value;
    const nama = $('editNama').value.trim();
    const phone = $('editPhone').value.trim();
    const idKaryawan = $('editIdKaryawan').value.trim();
    const jamKerja = parseInt($('editJamKerja').value, 10) || 8;
    const jabatan = $('editJabatan') ? $('editJabatan').value.trim() : '';
    const statusKaryawan = $('editStatusKaryawan') ? $('editStatusKaryawan').value : '';
    const baseHarian = $('editBaseHarian') ? (parseInt($('editBaseHarian').value, 10) || 0) : 0;
    const multiplierLembur = $('editMultiplierLembur') ? (parseFloat($('editMultiplierLembur').value) || 1.5) : 1.5;
    const namaBank = $('editNamaBank') ? $('editNamaBank').value.trim() : '';
    const atasNamaRek = $('editAtasNamaRek') ? $('editAtasNamaRek').value.trim() : '';
    if (!nama) { alert('Nama wajib diisi.'); return; }
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Menyimpan...'; }
    try {
        const tanggalJoinVal = $('editTanggalJoin') ? $('editTanggalJoin').value : '';
        const tjPayload = tanggalJoinVal ? Timestamp.fromDate(new Date(tanggalJoinVal)) : null;
        const ktpFile = $('editKtpFile') ? $('editKtpFile').files[0] : null;
        const npwpFile = $('editNpwpFile') ? $('editNpwpFile').files[0] : null;
        const bukuTabFile = $('editBukuTabunganFile') ? $('editBukuTabunganFile').files[0] : null;
        const payload = {
            nama, phone, idKaryawan, jamKerja, tanggalJoin: tjPayload,
            jabatan, statusKaryawan, baseHarian, multiplierLembur,
            namaBank, atasNamaRek,
            updatedAt: serverTimestamp()
        };
        if (ktpFile){ try { payload.ktpUrl = await uploadKaryawanFile(uid,'ktp',ktpFile); } catch(ue){ console.error('upload ktp', ue); alert('Upload KTP gagal: '+ue.message); } }
        if (npwpFile){ try { payload.npwpUrl = await uploadKaryawanFile(uid,'npwp',npwpFile); } catch(ue){ console.error('upload npwp', ue); alert('Upload NPWP gagal: '+ue.message); } }
        if (bukuTabFile){ try { payload.bukuTabunganUrl = await uploadKaryawanFile(uid,'buku_tabungan',bukuTabFile); } catch(ue){ console.error('upload bktab', ue); alert('Upload Buku Tabungan gagal: '+ue.message); } }
        await setDoc(doc(db,'karyawan',uid), payload, {merge:true});
        $('editKaryawanModal').classList.add('hidden');
        loadKaryawanList();
    } catch(err){ alert('Gagal simpan: ' + err.message); }
    finally { if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Simpan'; } }
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
    $('deleteAbsenMsg').innerHTML = 'Yakin hapus event <strong>' + tipeLabel + '</strong> milik <strong>' + (nama||'-') + '</strong> pada ' + tglStr + '?<br><small style="color:#6b7280">Hanya event ini yang dihapus. Event lain (clock_in/out/break/lembur) milik karyawan ini tidak terpengaruh.</small>';
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

    // Karyawan "Hadir hari ini" hanya jika punya event clock_in dengan timestamp >= hari ini 00:00
    const _today0HF = new Date(); _today0HF.setHours(0,0,0,0);
    const _todayMsHF = _today0HF.getTime();
    for (const [uid, arr] of byUid){
        const hasClockInToday = arr.some(r=>{
            if (r.tipe!=='clock_in') return false;
            const ms = (r.ts && r.ts.toMillis) ? r.ts.toMillis() : 0;
            return ms >= _todayMsHF;
        });
        if (!hasClockInToday) continue;
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
// Format durasi antara dua event (handle overnight)
function fmtDur(evIn, evOut){
  if (!evIn || !evOut || !evIn.ts || !evOut.ts || !evIn.ts.toDate || !evOut.ts.toDate) return '0';
  let ms = evOut.ts.toDate().getTime() - evIn.ts.toDate().getTime();
  if (ms < 0) ms += 24*60*60*1000;
  if (ms <= 0) return '0';
  const totalMin = Math.floor(ms/60000);
  const h = Math.floor(totalMin/60);
  const m = totalMin % 60;
  if (h === 0) return m + 'mn';
  if (m === 0) return h + 'j';
  return h + 'j ' + m + 'mn';
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
    // 1) Load semua karyawan terdaftar sebagai master list (semua harus muncul, hadir/belum)
    const byUid = {};
    try {
      const kSnap = await getDocs(collection(db,'karyawan'));
      kSnap.forEach(docSnap => {
        const k = docSnap.data() || {};
        const uid = docSnap.id || k.uid || k.email || '';
        if (!uid) return;
        byUid[uid] = {
          uid,
          nama: k.nama || (k.email||'').split('@')[0] || '-',
          email: k.email || '',
          events: [],
          byTipe: {}
        };
      });
    } catch(e){ console.warn('load karyawan master gagal:', e); }
    // 2) Merge events absensi tanggal terpilih ke master list
    const snap = await getDocs(q);
    snap.forEach(docSnap => {
      const r = Object.assign({ _id:docSnap.id }, docSnap.data());
      const uid = r.uid || r.email || '';
      if (!uid) return;
      if (!byUid[uid]) byUid[uid] = { uid, nama:r.nama||(r.email||'').split('@')[0]||'-', email:r.email||'', events:[], byTipe:{} };
      if (!byUid[uid].nama || byUid[uid].nama==='-') byUid[uid].nama = r.nama || byUid[uid].nama;
      if (!byUid[uid].email) byUid[uid].email = r.email || '';
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
  let working=0, onBreak=0, paused=0, finish=0, belum=0, hadir=0;
  uids.forEach(u=>{
    const bt = khRowsCache[u].byTipe || {};
    const hasAny = Object.keys(bt).length > 0;
    if (!hasAny){ belum++; return; }
    hadir++;
    if (bt.clock_out || bt.overtime_out) finish++;
    else if (bt.break_in && !bt.break_out) onBreak++;
    else if (bt.pause_in && !bt.pause_out) paused++;
    else if (bt.clock_in || bt.overtime_in) working++;
  });
  sum.innerHTML =
    '<div class="kh-stat"><b>'+hadir+'</b><small>Hadir</small></div>'+
    '<div class="kh-stat"><b>'+working+'</b><small>On Working</small></div>'+
    '<div class="kh-stat"><b>'+onBreak+'</b><small>On Break</small></div>'+
    '<div class="kh-stat"><b>'+paused+'</b><small>Paused</small></div>'+
    '<div class="kh-stat"><b>'+finish+'</b><small>Finish</small></div>'+
    '<div class="kh-stat"><b>'+belum+'</b><small>Belum Hadir</small></div>';
}

function gpsDotFor(row){
  const ci = row.byTipe['clock_in'];
  if (!ci || ci.inRadius === undefined || ci.inRadius === null) return '<span class="gps-dot gps-na" title="GPS tidak terdeteksi"></span>';
  return ci.inRadius
    ? '<span class="gps-dot gps-in" title="GPS dalam jangkauan ('+ (ci.jarak||0) +'m)"></span>'
    : '<span class="gps-dot gps-out" title="GPS di luar jangkauan ('+ (ci.jarak||0) +'m)"></span>';
}

function statusBadgeFor(row){
  const bt = row.byTipe || {};
  if (!Object.keys(bt).length) return '<span class="kh-badge kh-belum">Belum Hadir</span>';
  // Prioritas state (tidak bergantung urutan timestamp):
  if (bt.clock_out || bt.overtime_out) return '<span class="kh-badge kh-finish">Finished</span>';
  if (bt.break_in && !bt.break_out) return '<span class="kh-badge kh-break">Break</span>';
  if (bt.pause_in && !bt.pause_out) return '<span class="kh-badge kh-pause">Paused</span>';
  if (bt.clock_in || bt.overtime_in) return '<span class="kh-badge kh-working">Working</span>';
  return '<span class="kh-badge kh-belum">Belum Hadir</span>';
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
    // Pairs untuk akumulasi durasi: durasi disisipkan setelah kolom *_out pasangannya
    const DUR_PAIRS = {
      'clock_out':   { inTipe:'clock_in',    label:'Total Kerja' },
      'break_out':   { inTipe:'break_in',    label:'Dur. Istirahat' },
      'pause_out':   { inTipe:'pause_in',    label:'Dur. Pause' },
      'overtime_out':{ inTipe:'overtime_in', label:'Dur. Lembur' }
    };
    MATRIX_COLS.forEach(col=>{
      const ev = row.byTipe[col.tipe];
      const val = ev && ev.ts && ev.ts.toDate ? fmtHM(ev.ts.toDate()) : '';
      const editedFlag = ev && (ev.editedByOwner||ev.manualEdit) ? ' kh-edited' : '';
      cells += '<td><input type="text" inputmode="numeric" maxlength="5" placeholder="--:--" class="kh-time'+editedFlag+'" data-tipe="'+col.tipe+'" value="'+val+'" data-orig="'+val+'"></td>';
      const pair = DUR_PAIRS[col.tipe];
      if (pair){
        const evIn = row.byTipe[pair.inTipe];
        const durTxt = (evIn && ev) ? fmtDur(evIn, ev) : '0';
        cells += '<td class="kh-dur" title="'+pair.label+'">'+durTxt+'</td>';
      }
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
        // === Auto-save per cell on change ===
        tb.querySelectorAll('input.kh-time').forEach(inp=>{
            inp.addEventListener('change', async ()=>{
                const tr = inp.closest('tr');
                if(!tr) return;
                await saveSingleKehadiranCell(tr.dataset.uid, inp);
            });
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


/* ===========================================================
   REKAP KEHADIRAN (Hadirr-style) — date range summary per user
   =========================================================== */
let rekapEventsCache = [];
let rekapRangeFrom = null;
let rekapRangeTo = null;
let rekapDataCache = [];

function initRekap(){
  const elFrom = document.getElementById('rekapFrom');
  const elTo   = document.getElementById('rekapTo');
  const elSearch = document.getElementById('rekapSearch');
  const elLoad = document.getElementById('btnRekapLoad');
  const elExport = document.getElementById('btnRekapExport');
  const elQuickMonth = document.getElementById('btnRekapMonth');
  const elQuickWeek  = document.getElementById('btnRekapWeek');
  const elQuickToday = document.getElementById('btnRekapToday');
  if (!elFrom || !elTo) return;
  const today = new Date();
  const from30 = new Date(today); from30.setDate(from30.getDate()-29);
  if (!elFrom.value) elFrom.value = ymdR(from30);
  if (!elTo.value)   elTo.value   = ymdR(today);
  if (elLoad)   elLoad.onclick   = ()=>loadRekap();
  if (elExport) elExport.onclick = ()=>exportRekapCSV();
  if (elSearch) elSearch.oninput = ()=>renderRekap();
  if (elQuickMonth) elQuickMonth.onclick = ()=>{
    const t = new Date(); const a = new Date(t.getFullYear(),t.getMonth(),1);
    elFrom.value = ymdR(a); elTo.value = ymdR(t); loadRekap();
  };
  if (elQuickWeek) elQuickWeek.onclick = ()=>{
    const t = new Date(); const a = new Date(t); a.setDate(a.getDate()-6);
    elFrom.value = ymdR(a); elTo.value = ymdR(t); loadRekap();
  };
  if (elQuickToday) elQuickToday.onclick = ()=>{
    const t = new Date(); elFrom.value = ymdR(t); elTo.value = ymdR(t); loadRekap();
  };
}

function ymdR(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const dd= String(d.getDate()).padStart(2,'0');
  return y+'-'+m+'-'+dd;
}

function fmtHMr(totalMs){
  if (!totalMs || totalMs < 0) return '0';
  const totalMin = Math.floor(totalMs/60000);
  const h = Math.floor(totalMin/60);
  const m = totalMin % 60;
  return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
}

async function loadRekap(){
  const elFrom = document.getElementById('rekapFrom');
  const elTo   = document.getElementById('rekapTo');
  const elTitle= document.getElementById('rekapTitle');
  const tbody  = document.querySelector('#tblRekap tbody');
  const empty  = document.getElementById('rekapEmpty');
  if (!elFrom || !elTo || !tbody) return;
  const fromStr = elFrom.value;
  const toStr   = elTo.value;
  if (!fromStr || !toStr){ alert('Pilih rentang tanggal'); return; }
  const from = new Date(fromStr+'T00:00:00');
  const to   = new Date(toStr+'T23:59:59');
  if (from > to){ alert('Tanggal "Dari" harus sebelum "Sampai"'); return; }
  rekapRangeFrom = from; rekapRangeTo = to;
  if (elTitle) elTitle.textContent = 'Ringkasan Kehadiran: ' + fromStr + ' s/d ' + toStr;
  tbody.innerHTML = '<tr><td colspan="10" class="muted center">Memuat data...</td></tr>';
  try {
    const qy = query(collection(db,'absensi'),
      where('ts','>=', Timestamp.fromDate(from)),
      where('ts','<=', Timestamp.fromDate(to)),
      orderBy('ts','asc'));
    const snap = await getDocs(qy);
    const events = [];
    snap.forEach(d=>{
      const x = d.data();
      events.push({
        id: d.id,
        uid: x.uid,
        nama: x.nama || '-',
        tipe: x.tipe,
        waktu: x.ts?.toDate ? x.ts.toDate() : new Date(),
        inRadius: x.inRadius,
        terlambat: !!x.terlambat,
        jamKerja: x.jamKerja || 8
      });
    });
    const byUserDay = {};
    const userMeta = {};
    for (const e of events){
      const dk = ymdR(e.waktu);
      if (!byUserDay[e.uid]) byUserDay[e.uid] = {};
      if (!byUserDay[e.uid][dk]) byUserDay[e.uid][dk] = [];
      byUserDay[e.uid][dk].push(e);
      if (!userMeta[e.uid]) userMeta[e.uid] = { nama: e.nama, jamKerja: e.jamKerja };
    }
    const rows = [];
    for (const uid of Object.keys(byUserDay)){
      const meta = userMeta[uid];
      let hariHadir = 0, jamKerjaMs = 0, jamIstirahatMs = 0, jamLemburMs = 0;
      let terlambat = 0, belumLengkap = 0, totalEvents = 0;
      for (const dk of Object.keys(byUserDay[uid])){
        const dayEvents = byUserDay[uid][dk].sort((a,b)=>a.waktu-b.waktu);
        totalEvents += dayEvents.length;
        const byTipe = {};
        for (const ev of dayEvents){
          if (!byTipe[ev.tipe]) byTipe[ev.tipe] = [];
          byTipe[ev.tipe].push(ev);
        }
        const hasCI = byTipe.clock_in && byTipe.clock_in.length;
        const hasCO = byTipe.clock_out && byTipe.clock_out.length;
        if (hasCI) hariHadir++;
        if (hasCI && byTipe.clock_in[0].terlambat) terlambat++;
        if (hasCI && hasCO){
          const ci = byTipe.clock_in[0].waktu;
          const co = byTipe.clock_out[byTipe.clock_out.length-1].waktu;
          let work = co - ci;
          const bIn = byTipe.break_in || [];
          const bOut = byTipe.break_out || [];
          let breakSum = 0;
          for (let i=0;i<bIn.length;i++){
            const s = bIn[i].waktu; const e = bOut[i] ? bOut[i].waktu : null;
            if (s && e && e>s){ breakSum += (e-s); }
          }
          jamIstirahatMs += breakSum;
          work -= breakSum;
          const pIn = byTipe.pause_in || [];
          const pOut = byTipe.pause_out || [];
          let pauseSum = 0;
          for (let i=0;i<pIn.length;i++){
            const s = pIn[i].waktu; const e = pOut[i] ? pOut[i].waktu : null;
            if (s && e && e>s){ pauseSum += (e-s); }
          }
          work -= pauseSum;
          if (work > 0) jamKerjaMs += work;
        } else if (hasCI && !hasCO){
          belumLengkap++;
        }
        const otIn = byTipe.overtime_in || [];
        const otOut = byTipe.overtime_out || [];
        for (let i=0;i<otIn.length;i++){
          const s = otIn[i].waktu; const e = otOut[i] ? otOut[i].waktu : null;
          if (s && e && e>s) jamLemburMs += (e-s);
        }
      }
      rows.push({ uid, nama: meta.nama, hariHadir, jamKerjaMs, jamIstirahatMs, jamLemburMs, terlambat, belumLengkap, totalEvents });
    }
    rows.sort((a,b)=>a.nama.localeCompare(b.nama));
    rekapEventsCache = events;
    rekapDataCache = rows;
    renderRekap();
    renderRekapSummary();
  } catch(e){
    console.error('loadRekap error', e);
    tbody.innerHTML = '<tr><td colspan="9" class="muted center" style="color:#dc2626">Gagal memuat data: '+(e.message||e)+'</td></tr>';
  }
}

function renderRekapSummary(){
  const el = document.getElementById('rekapSummary');
  if (!el) return;
  const rows = rekapDataCache;
  const totalKaryawan = rows.length;
  let totalHari = 0, totalKerja = 0, totalIstirahat = 0, totalLembur = 0, totalTelat = 0;
  for (const r of rows){
    totalHari += r.hariHadir;
    totalKerja += r.jamKerjaMs;
    totalIstirahat += r.jamIstirahatMs;
    totalLembur += r.jamLemburMs;
    totalTelat += r.terlambat;
  }
  el.innerHTML =
    '<div class="kh-stat"><div class="muted small">Karyawan</div><div class="stat-num">'+totalKaryawan+'</div></div>'+
    '<div class="kh-stat"><div class="muted small">Total Hari Hadir</div><div class="stat-num">'+totalHari+'</div></div>'+
    '<div class="kh-stat"><div class="muted small">Total Jam Kerja</div><div class="stat-num">'+fmtHMr(totalKerja)+'</div></div>'+
    '<div class="kh-stat"><div class="muted small">Total Istirahat</div><div class="stat-num">'+fmtHMr(totalIstirahat)+'</div></div>'+
    '<div class="kh-stat"><div class="muted small">Total Lembur</div><div class="stat-num">'+fmtHMr(totalLembur)+'</div></div>'+
    '<div class="kh-stat"><div class="muted small">Telat (hari)</div><div class="stat-num">'+totalTelat+'</div></div>';
}

function renderRekap(){
  const tbody = document.querySelector('#tblRekap tbody');
  const empty = document.getElementById('rekapEmpty');
  const search = (document.getElementById('rekapSearch')?.value || '').toLowerCase().trim();
  if (!tbody) return;
  const rows = rekapDataCache.filter(r => !search || r.nama.toLowerCase().includes(search));
  if (rows.length === 0){
    tbody.innerHTML = '';
    if (empty) empty.textContent = 'Tidak ada data pada rentang ini.';
    return;
  }
  if (empty) empty.textContent = '';
  tbody.innerHTML = rows.map((r,i)=>
      '<tr data-uid="'+(r.uid||'')+'" data-nama="'+((r.nama||'').replace(/"/g,'&quot;'))+'" class="rekap-row-clickable">'+
        '<td>'+(i+1)+'</td>'+
        '<td>'+r.nama+'</td>'+
        '<td class="num">'+r.hariHadir+'</td>'+
        '<td class="num">'+fmtHMr(r.jamKerjaMs)+'</td>'+
        '<td class="num">'+fmtHMr(r.jamIstirahatMs)+'</td>'+
        '<td class="num">'+fmtHMr(r.jamLemburMs)+'</td>'+
        '<td class="num">'+r.terlambat+'</td>'+
        '<td class="num">'+r.belumLengkap+'</td>'+
        '<td class="num">'+r.totalEvents+'</td>'+
        '<td><button class="btn btn-sm btn-primary btn-rekap-detail" data-uid="'+(r.uid||'')+'" data-nama="'+((r.nama||'').replace(/"/g,'&quot;'))+'">Detail</button></td>'+
      '</tr>'
    ).join('');
    tbody.querySelectorAll('.btn-rekap-detail').forEach(b=>{
      b.onclick = (e)=>{ e.stopPropagation(); openRekapDetail(b.dataset.uid, b.dataset.nama); };
    });
    tbody.querySelectorAll('tr.rekap-row-clickable').forEach(tr=>{
      tr.style.cursor='pointer';
      tr.onclick = ()=> openRekapDetail(tr.dataset.uid, tr.dataset.nama);
    });
}

function exportRekapCSV(){
  if (!rekapDataCache.length){ alert('Belum ada data untuk diekspor. Klik Tampilkan terlebih dahulu.'); return; }
  const elFrom = document.getElementById('rekapFrom');
  const elTo   = document.getElementById('rekapTo');
  const headers = ['No','Nama','Hari Hadir','Jam Kerja','Jam Istirahat','Jam Lembur','Terlambat (Hari)','Belum Lengkap','Total Event'];
  const lines = [headers.join(',')];
  rekapDataCache.forEach((r,i)=>{
    const cells = [
      i+1,
      '"'+r.nama.replace(/"/g,'""')+'"',
      r.hariHadir,
      fmtHMr(r.jamKerjaMs),
      fmtHMr(r.jamIstirahatMs),
      fmtHMr(r.jamLemburMs),
      r.terlambat,
      r.belumLengkap,
      r.totalEvents
    ];
    lines.push(cells.join(','));
  });
  const csv = '\uFEFF' + lines.join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'rekap-kehadiran_'+(elFrom?.value||'')+'_'+(elTo?.value||'')+'.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}


// ===== Rekap Detail Modal (drill-down per karyawan) =====
function openRekapDetail(uid, nama){
    const modal = document.getElementById('rekapDetailModal');
    const title = document.getElementById('rekapDetailTitle');
    const tbody = document.querySelector('#tblRekapDetail tbody');
    const empty = document.getElementById('rekapDetailEmpty');
    if(!modal || !tbody) return;
    if(title){
        const from = document.getElementById('rekapFrom')?.value || '';
        const to = document.getElementById('rekapTo')?.value || '';
        title.textContent = 'Detail Kehadiran: ' + (nama||'-') + ' (' + from + ' s/d ' + to + ')';
    }
    const events = (rekapEventsCache||[]).filter(e=>e.uid===uid).sort((a,b)=>{
        const ta = a.waktu instanceof Date ? a.waktu.getTime() : 0;
        const tb = b.waktu instanceof Date ? b.waktu.getTime() : 0;
        return ta - tb;
    });
    if(events.length===0){
        tbody.innerHTML = '';
        if(empty) empty.textContent = 'Tidak ada event untuk karyawan ini pada rentang tanggal.';
    } else {
        if(empty) empty.textContent = '';
        const TIPE_LOCAL = { clock_in:'Clock In', clock_out:'Clock Out', break_in:'Istirahat', break_out:'Selesai Istirahat', overtime_in:'Mulai Lembur', overtime_out:'Selesai Lembur' };
        tbody.innerHTML = events.map(ev=>{
            const d = ev.waktu;
            const tgl = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
            const jam = String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0');
            const opts = ['clock_in','clock_out','break_in','break_out','overtime_in','overtime_out']
                .map(v=>'<option value="'+v+'"'+(v===(ev.tipe||'')?' selected':'')+'>'+(TIPE_LOCAL[v]||v)+'</option>').join('');
            const status = ev.inRadius===true ? '<span class="badge-loc badge-in">In Office</span>' : (ev.inRadius===false ? '<span class="badge-loc badge-out">Out of Radius</span>' : '<span class="muted small">-</span>');
            return '<tr data-id="'+ev.id+'">'+
                '<td><input type="date" class="rd-edit-tgl" data-id="'+ev.id+'" value="'+tgl+'"></td>'+
                '<td><input type="text" inputmode="numeric" maxlength="5" placeholder="--:--" class="rd-edit-jam" data-id="'+ev.id+'" value="'+(jam||'').slice(0,5)+'"></td>'+
                '<td><select class="rd-edit-tipe" data-id="'+ev.id+'">'+opts+'</select></td>'+
                '<td>'+status+'</td>'+
                '<td><button class="btn-link rd-hapus" data-id="'+ev.id+'" data-nama="'+(nama||'').replace(/"/g,'&quot;')+'" data-tipe="'+(ev.tipe||'')+'" style="color:#dc2626">🗑️ Hapus</button></td>'+
            '</tr>';
        }).join('');
        tbody.querySelectorAll('.rd-edit-jam').forEach(inp=>{
            inp._origVal = inp.value;
            inp.onchange = async ()=>{
                const id = inp.dataset.id;
                const tglInput = tbody.querySelector('.rd-edit-tgl[data-id="'+id+'"]');
                const tglVal = tglInput ? tglInput.value : '';
                const jamVal = inp.value;
                if(!id || !tglVal || !jamVal){ alert('Tanggal/Jam tidak valid'); inp.value = inp._origVal; return; }
                try{
                    const newDate = new Date(tglVal + 'T' + jamVal);
                    if(isNaN(newDate.getTime())){ alert('Format jam tidak valid'); inp.value = inp._origVal; return; }
                    inp.classList.add('kh-saving');
                    await updateDoc(doc(db,'absensi', id), { ts: Timestamp.fromDate(newDate), editedByOwner: true, editedAt: serverTimestamp() });
                    inp.classList.remove('kh-saving'); inp.classList.add('kh-saved');
                    setTimeout(()=>inp.classList.remove('kh-saved'), 1200);
                    inp._origVal = inp.value;
                    const cev = rekapEventsCache.find(e=>e.id===id); if(cev) cev.waktu = newDate;
                }catch(err){
                    console.error('rd edit jam err', err);
                    inp.classList.remove('kh-saving');
                    alert('Gagal simpan jam: '+(err.message||err));
                    inp.value = inp._origVal;
                }
            };
        });
        tbody.querySelectorAll('.rd-edit-tgl').forEach(inp=>{
            inp._origVal = inp.value;
            inp.onchange = ()=>{
                const id = inp.dataset.id;
                const j = tbody.querySelector('.rd-edit-jam[data-id="'+id+'"]');
                if(j) j.dispatchEvent(new Event('change'));
            };
        });
        tbody.querySelectorAll('.rd-edit-tipe').forEach(sel=>{
            sel._origVal = sel.value;
            sel.onchange = async ()=>{
                const id = sel.dataset.id;
                const newTipe = sel.value;
                if(!id || !newTipe){ sel.value = sel._origVal; return; }
                try{
                    sel.classList.add('kh-saving');
                    await updateDoc(doc(db,'absensi', id), { tipe: newTipe, editedByOwner: true, editedAt: serverTimestamp() });
                    sel.classList.remove('kh-saving'); sel.classList.add('kh-saved');
                    setTimeout(()=>sel.classList.remove('kh-saved'), 1200);
                    sel._origVal = sel.value;
                    const cev = rekapEventsCache.find(e=>e.id===id); if(cev) cev.tipe = newTipe;
                }catch(err){
                    console.error('rd edit tipe err', err);
                    sel.classList.remove('kh-saving');
                    alert('Gagal simpan tipe: '+(err.message||err));
                    sel.value = sel._origVal;
                }
            };
        });
        tbody.querySelectorAll('.rd-hapus').forEach(b=>{
            b.onclick = async ()=>{
                const id = b.dataset.id;
                const nama = b.dataset.nama;
                const tipe = b.dataset.tipe;
                const TIPE_LBL = { clock_in:'Clock In', clock_out:'Clock Out', break_in:'Istirahat', break_out:'Selesai Istirahat', overtime_in:'Mulai Lembur', overtime_out:'Selesai Lembur' };
                const lbl = TIPE_LBL[tipe] || tipe;
                if(!confirm('Hapus event '+lbl+' milik '+nama+'?\n\nHanya event ini yang dihapus. Event lain tidak terpengaruh.')) return;
                try{
                    b.disabled = true; b.textContent = '...';
                    await deleteDoc(doc(db,'absensi', id));
                    const i = rekapEventsCache.findIndex(e=>e.id===id);
                    if(i>=0) rekapEventsCache.splice(i,1);
                    b.closest('tr').remove();
                    try{ if(typeof loadRekap==='function') loadRekap(); }catch(e){}
                }catch(err){
                    console.error('rd hapus err', err);
                    alert('Gagal hapus: '+(err.message||err));
                    b.disabled = false; b.textContent = '🗑️ Hapus';
                }
            };
        });
    }
    modal.classList.remove('hidden');
}
function closeRekapDetail(){
    document.getElementById('rekapDetailModal')?.classList.add('hidden');
}
document.addEventListener('DOMContentLoaded', ()=>{
    const closeBtn = document.getElementById('btnRekapDetailClose');
    if(closeBtn) closeBtn.onclick = closeRekapDetail;
    const modal = document.getElementById('rekapDetailModal');
    if(modal) modal.addEventListener('click', (e)=>{ if(e.target===modal) closeRekapDetail(); });
});
