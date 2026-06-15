
// === 24h time-text helper (manual entry, no AM/PM) ===
(function(){
  if (window.__time24Installed) return; window.__time24Installed = true;
  function autoFormat(v){
    v = (v||'').replace(/[^0-9]/g,'').slice(0,4);
    if (v.length === 4) return v.slice(0,2) + ':' + v.slice(2);
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
    let v = (el.value||'').trim();
    if (v === '') return;
    let m = v.match(/^(\d):(\d{1,2})$/);
    if (m) v = '0' + m[1] + ':' + (m[2].length === 1 ? '0' + m[2] : m[2]);
    let m2 = v.match(/^(\d{2}):(\d)$/);
    if (m2) v = m2[1] + ':0' + m2[2];
    if (/^\d+$/.test(v)){
      if (v.length === 1) v = '0' + v + ':00';
      else if (v.length === 2) v = v + ':00';
      else if (v.length === 3) v = '0' + v[0] + ':' + v.slice(1);
      else if (v.length === 4) v = v.slice(0,2) + ':' + v.slice(2);
    }
    if (validHM(v)){
      if (el.value !== v){
        el.value = v;
        el.dispatchEvent(new Event('change', {bubbles: true}));
      }
      return;
    }
    const orig = el.dataset.orig || el._origVal || '';
    el.value = orig;
    el.classList.add('kh-save-err');
    setTimeout(()=>el.classList.remove('kh-save-err'), 1500);
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
            // Normalisasi format: pad single-digit hour/minute, atau 3-4 digit raw
        let _nv = newVal;
        let _m1 = _nv.match(/^(\d):(\d{1,2})$/);
        if (_m1) _nv = '0' + _m1[1] + ':' + (_m1[2].length===1 ? '0'+_m1[2] : _m1[2]);
        let _m2 = _nv.match(/^(\d{2}):(\d)$/);
        if (_m2) _nv = _m2[1] + ':0' + _m2[2];
        if (/^\d+$/.test(_nv)){
          if (_nv.length === 1) _nv = '0' + _nv + ':00';
          else if (_nv.length === 2) _nv = _nv + ':00';
          else if (_nv.length === 3) _nv = '0' + _nv[0] + ':' + _nv.slice(1);
          else if (_nv.length === 4) _nv = _nv.slice(0,2) + ':' + _nv.slice(2);
        }
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(_nv)){
          inp.classList.remove('kh-saving');
          inp.classList.add('kh-save-err');
          setTimeout(()=>inp.classList.remove('kh-save-err'), 1500);
          inp.value = origVal;
          return;
        }
        inp.value = _nv;
        const [hh,mm] = _nv.split(':').map(Number);
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
        if (page === 'payroll') { try{ loadPayroll(); }catch(e){ console.error(e); } }
        if (page === 'karyawan') loadKaryawanList();
        if (window.innerWidth <= 768) document.body.classList.remove('sidebar-open');
    }
    links.forEach(l => l.onclick = (e) => { e.preventDefault(); activate(l.dataset.page); });
    const initial = (location.hash || '#beranda').replace('#', '');
    activate(['beranda','kehadiran','rekap','karyawan','payroll'].includes(initial) ? initial : 'beranda');
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
        '<div class="stat" style="background:#3b1d1d"><b style="color:#dc2626">' + outRuko + '</b><small>Out of Radius</small></div>';

    const ctx1 = document.getElementById('chartHadir');
    if (ctx1 && window.Chart) {
        if (chartHadir) chartHadir.destroy();
        chartHadir = new Chart(ctx1, {
            type: 'doughnut',
            data: {
                labels: ['Clocked In', 'Pending'],
                datasets: [{ data: [hadir, belum], backgroundColor: ['#10b981', '#243049'], borderWidth: 0 }]
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
        if (r.inRadius === false) tr.style.background = '#3b1d1d';
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
        '<div class="stat" style="background:#3b1d1d"><b style="color:#dc2626">'+outCount+'</b><small>Out of Radius</small></div>';
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
        if (r.inRadius === false) tr.style.background = '#3b1d1d';
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
              '<td><span class="kry-nama-link" data-uid="'+x.id+'" style="cursor:pointer;color:#3b82f6;text-decoration:underline;">'+(x.nama||'-')+'</span></td>'+
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
        document.querySelectorAll('.kry-nama-link').forEach(s => {
            s.onclick = () => showProfilKaryawan(s.dataset.uid);
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
  const baseHarian = parseInt(($('newBaseHarian')&&$('newBaseHarian').value)||'0', 10) || 0;
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
            baseHarian: baseHarian,
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
      if ($('newBaseHarian')) $('newBaseHarian').value = '';
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
        if ($('editMultiplierLembur')) $('editMultiplierLembur').value = d.multiplierLembur || 1;
        if ($('editNamaBank')) $('editNamaBank').value = d.namaBank || '';
        if ($('editAtasNamaRek')) $('editAtasNamaRek').value = d.atasNamaRek || '';
        if ($('editNomorRekening')) $('editNomorRekening').value = d.nomorRekening || '';
        // Status upload dokumen
        const setStat = (id, url) => { const el = $(id); if (el) el.textContent = url ? '✓ sudah diupload' : '(belum)'; };
        setStat('ktpStatus', d.ktpUrl);
        // Reset file inputs
        ['editKtpFile'].forEach(id=>{ const el=$(id); if(el) el.value=''; });
        // ===== KTP preview + lock status profil =====
        (function(){
          var wrap = $('editKtpPreviewWrap');
          var img = $('editKtpPreview');
          var link = $('editKtpLink');
          if(wrap && img){
            if(d.ktpUrl){ img.src = d.ktpUrl; if(link) link.href = d.ktpUrl; wrap.style.display = 'block'; }
            else { img.src = ''; if(link) link.removeAttribute('href'); wrap.style.display = 'none'; }
          }
          var lockSpan = $('profilLockStatus');
          var resetBtn = $('btnResetLockProfil');
          var locked = !!d.profilLocked;
          if(lockSpan) lockSpan.textContent = locked ? 'Status: TERKUNCI (karyawan sudah isi)' : 'Status: belum dikunci';
          if(resetBtn){
            resetBtn.style.display = locked ? 'inline-block' : 'none';
            resetBtn.onclick = async function(){
              if(!confirm('Reset lock profil karyawan ini? Karyawan akan bisa mengisi ulang data rekening & KTP 1x.')) return;
              resetBtn.disabled = true;
              try{
                await updateDoc(doc(db,'karyawan',uid), { profilLocked: false, profilResetAt: serverTimestamp() });
                if(lockSpan) lockSpan.textContent = 'Status: lock di-reset, karyawan bisa isi ulang';
                resetBtn.style.display = 'none';
                alert('Lock berhasil di-reset.');
              }catch(e){ alert('Gagal reset: ' + (e && e.message ? e.message : e)); }
              finally{ resetBtn.disabled = false; }
            };
          }
        })();
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
    const multiplierLembur = $('editMultiplierLembur') ? (parseFloat($('editMultiplierLembur').value) || 1) : 1;
    const namaBank = $('editNamaBank') ? $('editNamaBank').value.trim() : '';
    const atasNamaRek = $('editAtasNamaRek') ? $('editAtasNamaRek').value.trim() : '';
    const nomorRekening = $('editNomorRekening') ? $('editNomorRekening').value.trim() : '';
    if (!nama) { alert('Nama wajib diisi.'); return; }
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Menyimpan...'; }
    try {
        const tanggalJoinVal = $('editTanggalJoin') ? $('editTanggalJoin').value : '';
        const tjPayload = tanggalJoinVal ? Timestamp.fromDate(new Date(tanggalJoinVal)) : null;
        const ktpFile = $('editKtpFile') ? $('editKtpFile').files[0] : null;
        const payload = {
            nama, phone, idKaryawan, jamKerja, tanggalJoin: tjPayload,
            jabatan, statusKaryawan, baseHarian, multiplierLembur,
            namaBank, atasNamaRek, nomorRekening,
            updatedAt: serverTimestamp()
        };
        if (ktpFile){ try { payload.ktpUrl = await uploadKaryawanFile(uid,'ktp',ktpFile); } catch(ue){ console.error('upload ktp', ue); alert('Upload KTP gagal: '+ue.message); } }
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

        // State machine: prioritas presence-based (selaras dengan Kehadiran Matrix)
        // Cari clock_out & clock_in terakhir; jika clock_out terakhir lebih baru dari clock_in terakhir => Finished
        let lastClockOutMs = 0;
        let lastClockInMs = 0;
        let lastBreakInMs = 0;
        let lastBreakOutMs = 0;
        for (const r of arr){
            const ms = r.ts && r.ts.toMillis ? r.ts.toMillis() : 0;
            if (r.tipe === 'clock_out' || r.tipe === 'overtime_out'){
                if (ms > lastClockOutMs) lastClockOutMs = ms;
            }
            if (r.tipe === 'clock_in' || r.tipe === 'overtime_in'){
                if (ms > lastClockInMs) lastClockInMs = ms;
            }
            if (r.tipe === 'break_in' && ms > lastBreakInMs) lastBreakInMs = ms;
            if (r.tipe === 'break_out' && ms > lastBreakOutMs) lastBreakOutMs = ms;
        }
        if (lastClockOutMs > 0 && lastClockOutMs >= lastClockInMs){
            // hanya tampilkan di 'Finish Working' jika clock_out terjadi dalam 6 jam terakhir
            if (Date.now() - lastClockOutMs <= 6 * 60 * 60 * 1000){
                finishUids.push(uid);
            }
        } else if (lastBreakInMs > 0 && lastBreakInMs > lastBreakOutMs){
            breakUids.push(uid);
        } else {
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
  // Strip berpusat pada tanggal yang dipilih (center index 3 dari 7); geser kiri-kanan ikut. Ring biru = HARI INI.
  const today = new Date(); today.setHours(0,0,0,0);
  const ctr = new Date(refDate); ctr.setHours(0,0,0,0);
  const refStr = dateToInputStr(new Date(refDate));
  const todayStr = dateToInputStr(today);
  const wdNames = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
  for (let i=-3; i<=3; i++){
    const dd = new Date(ctr); dd.setDate(ctr.getDate() + i);
    const ddStr = dateToInputStr(dd);
    const btn = document.createElement('button');
    btn.type = 'button';
    let cls = 'kh-day-btn';
    if (ddStr === refStr) cls += ' active';
    if (ddStr === todayStr) cls += ' kh-day-today';
    btn.className = cls;
    btn.innerHTML = '<span class="kh-day-wd">'+wdNames[dd.getDay()]+'</span><span class="kh-day-num">'+dd.getDate()+'/'+(dd.getMonth()+1)+'</span>';
    btn.onclick = ()=>{ currentKhDate = dd; $('khDate').value = dateToInputStr(dd); loadKehadiranMatrix(); buildWeekNav(dd); };
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
    const lookAhead = new Date(d); lookAhead.setDate(lookAhead.getDate()+1); lookAhead.setHours(11,59,59,999);
    const q = query(collection(db,'absensi'),
      where('ts','>=', Timestamp.fromDate(start)),
      where('ts','<=', Timestamp.fromDate(lookAhead)),
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
          jamKerja: (k.jamKerja!=null ? Number(k.jamKerja) : 9),
          events: [],
          byTipe: {}
        };
      });
    } catch(e){ console.warn('load karyawan master gagal:', e); }
    // 2) Merge events absensi tanggal terpilih ke master list
    const snap = await getDocs(q);
    const _endMs = end.getTime();
    snap.forEach(docSnap => {
      const r = Object.assign({ _id:docSnap.id }, docSnap.data());
      const uid = r.uid || r.email || '';
      if (!uid) return;
      if (!byUid[uid]) byUid[uid] = { uid, nama:r.nama||(r.email||'').split('@')[0]||'-', email:r.email||'', events:[], byTipe:{} };
      if (!byUid[uid].nama || byUid[uid].nama==='-') byUid[uid].nama = r.nama || byUid[uid].nama;
      if (!byUid[uid].email) byUid[uid].email = r.email || '';
      const rTs = r.ts && r.ts.toDate ? r.ts.toDate().getTime() : 0;
      if (rTs > _endMs){
        byUid[uid]._nextDayEvents = byUid[uid]._nextDayEvents || [];
        byUid[uid]._nextDayEvents.push(r);
      } else {
        byUid[uid].events.push(r);
        if (!byUid[uid].byTipe[r.tipe]) byUid[uid].byTipe[r.tipe] = r;
      }
    });
    // Look-ahead: clock_out (atau _out lain) di awal besok yang muncul SEBELUM _in besok pertama -> klaim sebagai overnight shift hari ini
    Object.keys(byUid).forEach(u=>{
      const next = byUid[u]._nextDayEvents || [];
      if (!next.length){ delete byUid[u]._nextDayEvents; return; }
      next.sort((a,b)=>{
        const ta = a.ts && a.ts.toDate ? a.ts.toDate().getTime() : 0;
        const tb = b.ts && b.ts.toDate ? b.ts.toDate().getTime() : 0;
        return ta - tb;
      });
      const OUT_IN = { clock_out:'clock_in', break_out:'break_in', pause_out:'pause_in', overtime_out:'overtime_in' };
      const firstInTs = {};
      for (const e of next){
        if (!e.tipe.endsWith('_in')) continue;
        if (firstInTs[e.tipe] === undefined){
          firstInTs[e.tipe] = e.ts && e.ts.toDate ? e.ts.toDate().getTime() : 0;
        }
      }
      for (const e of next){
        if (!e.tipe.endsWith('_out')) continue;
        const inTipe = OUT_IN[e.tipe];
        const inTsNext = firstInTs[inTipe];
        const eTs = e.ts && e.ts.toDate ? e.ts.toDate().getTime() : 0;
        if (inTsNext === undefined || eTs < inTsNext){
          byUid[u].events.push(e);
          const existing = byUid[u].byTipe[e.tipe];
          if (!existing){
            byUid[u].byTipe[e.tipe] = e;
          } else {
            const inEvToday = byUid[u].byTipe[inTipe];
            if (inEvToday && inEvToday.ts && inEvToday.ts.toDate){
              const inMs = inEvToday.ts.toDate().getTime();
              const existingTs = existing.ts && existing.ts.toDate ? existing.ts.toDate().getTime() : 0;
              if (existingTs < inMs) byUid[u].byTipe[e.tipe] = e;
            }
          }
        }
      }
      delete byUid[u]._nextDayEvents;
    });
    // ===== Normalize byTipe untuk shift overnight =====
    // clock_out yang muncul SEBELUM clock_in pertama = orphan (sisa shift kemaren) -> skip.
    // Pilih _out yang waktunya >= pasangan _in nya.
    const SHIFT_PAIRS = { clock_out:'clock_in', break_out:'break_in', pause_out:'pause_in', overtime_out:'overtime_in' };
    Object.keys(byUid).forEach(u=>{
      const evs = (byUid[u].events||[]).slice().sort((a,b)=>{
        const ta = (a.ts && a.ts.toDate) ? a.ts.toDate().getTime() : 0;
        const tb = (b.ts && b.ts.toDate) ? b.ts.toDate().getTime() : 0;
        return ta - tb;
      });
      const bt = {};
      ['clock_in','break_in','pause_in','overtime_in'].forEach(tIn=>{
        const ev = evs.find(e=>e.tipe===tIn);
        if (ev) bt[tIn] = ev;
      });
      Object.keys(SHIFT_PAIRS).forEach(tOut=>{
        const tIn = SHIFT_PAIRS[tOut];
        const inEv = bt[tIn];
        if (!inEv) return; // no _in -> skip _out (orphan dari shift kemaren)
        const inTs = (inEv.ts && inEv.ts.toDate) ? inEv.ts.toDate().getTime() : 0;
        for (const e of evs){
          if (e.tipe !== tOut) continue;
          const ts = (e.ts && e.ts.toDate) ? e.ts.toDate().getTime() : 0;
          if (ts >= inTs){ bt[tOut] = e; break; }
        }
      });
      // === Fix sesi lintas tengah malam: kalau ada clock_in beneran hari ini,
      // buang sisa lembur/break/pause yang waktunya SEBELUM clock_in (itu sisa shift kemarin yang lupa di-clock out). ===
      if (bt.clock_in) {
        const __ciTs = (bt.clock_in.ts && bt.clock_in.ts.toDate) ? bt.clock_in.ts.toDate().getTime() : 0;
        ['break_in','break_out','pause_in','pause_out','overtime_in','overtime_out'].forEach(function(__k){
          const __e = bt[__k];
          if (!__e) return;
          const __ts = (__e.ts && __e.ts.toDate) ? __e.ts.toDate().getTime() : 0;
          if (__ts < __ciTs) delete bt[__k];
        });
      }
      byUid[u].byTipe = bt;
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
  // Sesi nyangkut: clock_in tanpa clock_out yang umurnya > 14 jam = lupa Clock Out.
  if ((bt.clock_in || bt.overtime_in) && !bt.clock_out && !bt.overtime_out) {
    const ciEv = bt.clock_in || bt.overtime_in;
    const ciMs = (ciEv && ciEv.ts) ? (ciEv.ts.toMillis ? ciEv.ts.toMillis() : (ciEv.ts.toDate ? ciEv.ts.toDate().getTime() : 0)) : 0;
    if (ciMs && (Date.now() - ciMs) > 14 * 60 * 60 * 1000) {
      return '<span class="kh-badge kh-lupa" title="Clock In lebih dari 14 jam tanpa Clock Out. Kemungkinan lupa Clock Out. Isi jam pulang di kolom Clock Out untuk koreksi.">\u26A0 Lupa Clock Out</span>';
    }
  }
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
    // Lupa Clock Out: clock_in > 14 jam tanpa clock_out/overtime_out -> hitung jam keluar otomatis.
    // Rumus: clock_in + (kontrak-1 jam kerja efektif) + min(istirahat aktual, 1 jam). Display-only, tidak tulis DB.
    (function(){
      const _bt = row.byTipe || {};
      const _ciEv = _bt.clock_in || _bt.overtime_in;
      if (!_ciEv || _bt.clock_out || _bt.overtime_out) return;
      if (!_ciEv.ts || !_ciEv.ts.toDate) return;
      const _ciMs = _ciEv.ts.toDate().getTime();
      if ((Date.now() - _ciMs) <= 14*60*60*1000) return;
      const _kontrak = Number(row.jamKerja) || 9;
      let _restMs = 0; const _open = {};
      (row.events||[]).forEach(function(e){
        if (!e.ts || !e.ts.toDate) return;
        const _m = e.ts.toDate().getTime();
        if (e.tipe==='break_in' || e.tipe==='pause_in') _open[e.tipe.replace('_in','')] = _m;
        else if (e.tipe==='break_out' || e.tipe==='pause_out'){ const _b=e.tipe.replace('_out',''); if(_open[_b]!=null){ _restMs += _m-_open[_b]; _open[_b]=null; } }
      });
      const _restCap = Math.min(_restMs, 60*60*1000);
      const _outMs = _ciMs + Math.max(0,(_kontrak-1))*60*60*1000 + _restCap;
      const _d = new Date(_outMs);
      row._autoOut = { ts:{ toDate:function(){ return _d; } }, _autoLupa:true };
    })();
    // === Kerja Efektif + Lembur (rumus, display-only) ===
    (function(){
      const _bt = row.byTipe || {};
      const _ci = _bt.clock_in || _bt.overtime_in;
      let _end = _bt.clock_out || _bt.overtime_out || row._autoOut;
      if (!_ci || !_ci.ts || !_ci.ts.toDate || !_end || !_end.ts || !_end.ts.toDate) return;
      const _ciMs = _ci.ts.toDate().getTime();
      let _spanMs = _end.ts.toDate().getTime() - _ciMs;
      if (_spanMs < 0) _spanMs += 24*60*60*1000;
      function _sumPairs(inT, outT){
        let _tot = 0, _open = null, _maxOne = 0;
        const _list = (row.events||[]).slice().filter(function(e){return e.ts&&e.ts.toDate;}).sort(function(a,b){return a.ts.toDate()-b.ts.toDate();});
        _list.forEach(function(e){
          if (e.tipe===inT) _open = e.ts.toDate().getTime();
          else if (e.tipe===outT && _open!=null){ const _dms = e.ts.toDate().getTime()-_open; if(_dms>0){ _tot+=_dms; if(_dms>_maxOne)_maxOne=_dms; } _open=null; }
        });
        return { tot:_tot, maxOne:_maxOne };
      }
      const _brk = _sumPairs('break_in','break_out');
      const _pse = _sumPairs('pause_in','pause_out');
      const _efektifMs = _spanMs - _brk.tot - _pse.tot;
      const _kontrak = Number(row.jamKerja) || 9;
      const _netMs = Math.max(0, (_kontrak-1)) * 60*60*1000;
      row._efektifMs = _efektifMs;
      row._lemburCalcMs = Math.max(0, _efektifMs - _netMs);
      row._durAnom = (_brk.maxOne > 2*60*60*1000) || (_pse.maxOne > 2*60*60*1000) || (_efektifMs < 0);
    })();
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
      // Jam Keluar: kalau tidak ada clock_out, pakai overtime_out (Selesai Lembur) sebagai jam keluar.
      let ev2 = ev;
      if (col.tipe === 'clock_out' && !ev2 && row.byTipe['overtime_out']) ev2 = row.byTipe['overtime_out'];
      if (col.tipe === 'clock_out' && !ev2 && row._autoOut) ev2 = row._autoOut;
      const val = ev2 && ev2.ts && ev2.ts.toDate ? fmtHM(ev2.ts.toDate()) : '';
      const editedFlag = (ev2 && (ev2._autoLupa||ev2.editedByOwner||ev2.manualEdit)) ? ' kh-edited' : '';
      const autoTitle = (ev2 && ev2._autoLupa) ? ' title="Jam keluar OTOMATIS (lupa Clock Out >14 jam). Dihitung dari durasi kontrak + istirahat. Edit untuk koreksi."' : '';
      if (col.tipe === 'clock_in' || col.tipe === 'clock_out') cells += '<td><input type="text" inputmode="numeric" maxlength="5" placeholder="--:--" class="kh-time'+editedFlag+'" data-tipe="'+col.tipe+'" value="'+val+'" data-orig="'+val+'"'+autoTitle+'></td>';
      const pair = DUR_PAIRS[col.tipe];
      if (pair){
        const evIn = row.byTipe[pair.inTipe];
        // Total Kerja: kalau tidak ada clock_out, pakai overtime_out (Selesai Lembur) sebagai jam keluar.
        let evEnd = ev;
        if (col.tipe === 'clock_out' && !evEnd) evEnd = row.byTipe['overtime_out'];
        if (col.tipe === 'clock_out' && !evEnd && row._autoOut) evEnd = row._autoOut;
        function _fmtMs(ms){ if(ms==null) return '0'; if(ms<0) ms=0; const _m=Math.round(ms/60000); const _h=Math.floor(_m/60); const _mm=_m%60; return _h===0 ? _mm+'mn' : (_mm===0 ? _h+'j' : _h+'j '+_mm+'mn'); }
        let durTxt = (evIn && evEnd) ? fmtDur(evIn, evEnd) : '0';
        // Dur. Lembur: pakai rumus Kerja Efektif - (kontrak-1), bukan selisih overtime_in/out (sering rusak).
        function _lemHHMM(min){ if(min==null) return ''; if(min<0) min=0; const _h=Math.floor(min/60); const _m=Math.round(min%60); return _h+':'+String(_m).padStart(2,'0'); }
        let _lemMin = null, _lemOverridden = false;
        if (col.tipe === 'overtime_out'){
          const _ciDoc = row.byTipe && row.byTipe['clock_in'];
          if (_ciDoc && _ciDoc.lemburOverrideMin !== undefined && _ciDoc.lemburOverrideMin !== null && _ciDoc.lemburOverrideMin !== ''){
            var __ovrN = Math.round(Number(_ciDoc.lemburOverrideMin)); if (Number.isFinite(__ovrN)) { _lemMin = __ovrN; _lemOverridden = true; }
          } else if (Number.isFinite(row._lemburCalcMs)){
            _lemMin = Math.round(row._lemburCalcMs/60000);
          }
          if (!Number.isFinite(_lemMin)) _lemMin = null;
          if (_lemMin !== null) durTxt = _fmtMs(_lemMin*60000);
        }
        const _anomMark = (col.tipe === 'overtime_out' && row._durAnom) ? ' kh-anom' : '';
        const _anomTitle = (col.tipe === 'overtime_out' && row._durAnom) ? ' (DATA PERLU REVIEW: tap istirahat/pause tidak lengkap)' : '';
        if (col.tipe === 'overtime_out'){
          const _lemVal = (_lemMin!==null)? _lemHHMM(_lemMin) : '';
          const _lemShow = _lemVal ? _lemVal : '0:00';
          cells += '<td class="kh-dur kh-lembur-cell'+_anomMark+(_lemOverridden?' kh-lembur-ovr':'')+'" title="'+pair.label+_anomTitle+(_lemOverridden?' (di-set MANUAL oleh owner)':'')+'">'+(_anomMark?'\u26a0 ':'')+'<span class="kh_lembur_disp" title="Klik untuk edit lembur">'+_lemShow+'</span><input type="text" inputmode="numeric" maxlength="5" placeholder="0:00" class="kh_lembur" data-tipe="lembur_override" value="'+_lemVal+'" data-orig="'+_lemVal+'" style="display:none"></td>';
        } else {
          cells += '<td class="kh-dur'+_anomMark+'" title="'+pair.label+_anomTitle+'">'+(_anomMark?'\u26a0 ':'')+durTxt+'</td>';
        }
        // Sisipkan kolom Kerja Efektif tepat setelah Total Kerja.
        if (col.tipe === 'clock_out') { const _ef = (row._efektifMs!=null) ? _fmtMs(row._efektifMs) : '0'; cells += '<td class="kh-dur" title="Kerja Efektif (Total Kerja - istirahat - pause)">'+_ef+'</td>'; }
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
        // === Dur. Lembur: tampil teks bersih, klik buat edit ===
        tb.querySelectorAll('td.kh-lembur-cell').forEach(function(td){
            const disp = td.querySelector('.kh_lembur_disp');
            const inp  = td.querySelector('input.kh_lembur');
            if (!disp || !inp) return;
            function showInput(){ disp.style.display='none'; inp.style.display=''; inp.focus(); inp.select(); }
            function showDisp(){ const v=(inp.value||'').trim(); disp.textContent = v ? v : '0:00'; inp.style.display='none'; disp.style.display=''; }
            disp.addEventListener('click', showInput);
            inp.addEventListener('blur', function(){ showDisp(); });
            inp.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); inp.blur(); } });
        });
        });
}

async function saveKehadiranRow(uid, tr){
  const row = khRowsCache[uid];
  if (!row){ alert('Data karyawan tidak ditemukan.'); return; }
  const inputs = tr.querySelectorAll('input.kh-time, input.kh_lembur');
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
      if (ch.tipe === 'lembur_override'){
        const _ciDoc = row.byTipe && row.byTipe['clock_in'];
        if (!_ciDoc){ alert('Tidak bisa set lembur manual: tidak ada Clock In di hari ini.'); errCount++; continue; }
        let _mins = null;
        const _v = (ch.newVal||'').trim().replace(/[.,]/g, ':');
        if (_v !== ''){
          const _mm = _v.match(/^(\d{1,2}):([0-5]?\d)$/);
          if (_mm){ _mins = parseInt(_mm[1],10)*60 + parseInt(_mm[2],10); }
          else if (/^\d{1,3}$/.test(_v)){ _mins = parseInt(_v,10); }
          else { alert('Format lembur harus H:MM (contoh 0:38).'); errCount++; continue; }
        }
        await updateDoc(doc(db,'absensi', _ciDoc._id), { lemburOverrideMin: (_mins===null? null : _mins), editedByOwner: true, editedAt: serverTimestamp() });
        okCount++; continue;
      }
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
          jamIstirahatMs += pauseSum; // gabung: total Istirahat = break + pause
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


// Click logo brand untuk refresh halaman
(function(){
  const lg = document.getElementById('brandLogo');
  if (lg) lg.addEventListener('click', () => { window.location.reload(); });
})();


// ============================================================
// PAYROLL MODULE — gaji harian, dibayar bulanan
// ============================================================
let __payrollData = null;

function prFormatRp(n){
  if (!n) return 'Rp 0';
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}

function prMonthRange(yyyymm){
  const parts = yyyymm.split('-').map(Number);
  const y = parts[0], m = parts[1];
  const start = new Date(y, m-1, 1, 0, 0, 0, 0);
  const end = new Date(y, m, 0, 23, 59, 59, 999);
  return {start, end, label: start.toLocaleDateString('id-ID', {month:'long', year:'numeric'})};
}

async function loadPayroll(){
  const monthInput = $('prBulan');
  if (monthInput && !monthInput.value){
    const now = new Date();
    monthInput.value = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  }
  if (!monthInput.__wired){
    monthInput.__wired = true;
    monthInput.onchange = calcPayroll;
    $('btnPrRefresh').onclick = calcPayroll;
    $('btnPrExportCSV').onclick = exportPayrollCSV;
    $('btnPrDetailClose').onclick = () => $('payrollDetailModal').classList.add('hidden');
  }
  await calcPayroll();
}

async function calcPayroll(){
const yyyymm = $('prBulan').value;
if (!yyyymm){ alert('Pilih bulan dulu.'); return; }
const range = prMonthRange(yyyymm);
const start = range.start, end = range.end, label = range.label;
const tbody = document.querySelector('#tblPayroll tbody');
if (tbody) tbody.innerHTML = '<tr><td colspan="10" class="muted center">Menghitung...</td></tr>';
$('prEmpty').classList.add('hidden');
const karyMap = new Map();
const karySnap = await getDocs(collection(db, 'karyawan'));
karySnap.forEach(d => { karyMap.set(d.id, Object.assign({uid: d.id}, d.data())); });
const q = query(
collection(db, 'absensi'),
where('ts', '>=', Timestamp.fromDate(start)),
where('ts', '<=', Timestamp.fromDate(end)),
orderBy('ts', 'asc')
);
const snap = await getDocs(q);
const byPerson = new Map();
function _localDay(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return y+'-'+m+'-'+dd;
}
snap.forEach(d => {
const r = d.data();
const key = r.uid || r.email;
if (!key) return;
if (!byPerson.has(key)) byPerson.set(key, new Map());
const personMap = byPerson.get(key);
const ts = r.ts && r.ts.toDate ? r.ts.toDate() : new Date();
const dateStr = _localDay(ts);
if (!personMap.has(dateStr)) personMap.set(dateStr, []);
personMap.get(dateStr).push({tipe: r.tipe, ts: ts, id: d.id, lemburOverrideMin: r.lemburOverrideMin});
});
const rows = [];
let totalBudget = 0, totalHari = 0, totalLemburJam = 0, totalJamKerjaAll = 0;
for (const k of karyMap.values()){
const baseHarian = parseInt(k.baseHarian, 10) || 0;
const jamKerja = parseInt(k.jamKerja, 10) || 8;
const multiplierLembur = parseFloat(k.multiplierLembur) || 1;
const netJamKerja = Math.max(1, jamKerja - 1);
const ratePerJam = netJamKerja > 0 ? (baseHarian / netJamKerja) : 0;
const personMap = byPerson.get(k.uid) || byPerson.get(k.email) || new Map();
let hariHadir = 0, hariParsial = 0, totalJamLembur = 0, totalJamKerja = 0, totalKontribusi = 0;
const dailyDetails = [];
for (const entry of personMap){ entry[1].sort((a,b)=>a.ts - b.ts); }
const sortedDateKeys = Array.from(personMap.keys()).sort();
for (let _di=0; _di<sortedDateKeys.length; _di++){
const dateStr = sortedDateKeys[_di]; const events = personMap.get(dateStr);
  const dayHasNoBreak = events.some(e=> e.tipe === 'clock_out' && e.noBreak === true);
  const dayRatePerJam = ratePerJam;
const ci = events.find(e=>e.tipe==='clock_in');
// Skip orphan-only days (cuma clock_out tanpa clock_in)
if (!ci){
  const onlyCo = events.length > 0 && events.every(e=>e.tipe==='clock_out');
  if (onlyCo) continue;
}
let co = null;
if (ci){
  co = events.find(e=>e.tipe==='clock_out' && e.ts.getTime() >= ci.ts.getTime()) || null;
  if (!co){
    const Dnext = sortedDateKeys[_di+1];
    if (Dnext){
      const dDate = new Date(dateStr+'T00:00:00');
      const nDate = new Date(Dnext+'T00:00:00');
      const diffDays = Math.round((nDate - dDate) / 86400000);
      if (diffDays === 1){
        const nextEvts = personMap.get(Dnext) || [];
        const nextCi = nextEvts.find(e=>e.tipe==='clock_in');
        const nextCoCandidate = nextEvts.find(e=>e.tipe==='clock_out');
        const __cut = nextCi ? nextCi.ts.getTime() : Infinity;
        if (nextCoCandidate && nextCoCandidate.ts.getTime() < __cut){
          co = nextCoCandidate;
          const idxR = nextEvts.indexOf(nextCoCandidate);
          if (idxR>=0) nextEvts.splice(idxR,1);
        }
        ['overtime_out','break_out','pause_out'].forEach(function(__tp){
          for (let __z=0; __z<nextEvts.length; __z++){
            if (nextEvts[__z].tipe===__tp && nextEvts[__z].ts.getTime() < __cut){
              events.push(nextEvts[__z]);
              nextEvts.splice(__z,1); __z--;
            }
          }
        });
        events.sort(function(a,b){return a.ts - b.ts;});
        personMap.set(Dnext, nextEvts);
      }
    }
  }
}
const coArr = events.filter(e=>e.tipe==='clock_out');
const oi = events.find(e=>e.tipe==='overtime_in');
const ooArr = events.filter(e=>e.tipe==='overtime_out');
const oo = ooArr.length ? ooArr[ooArr.length-1] : null;
let durJam = 0;
const __end = co || oo;
if (ci && __end){
durJam = (__end.ts - ci.ts) / 3600000;
if (durJam < 0) durJam += 24;
const breaks = [];
events.forEach(e=>{ if (e.tipe==='break_in' || e.tipe==='break_out') breaks.push(e); });
  const pauses = events.filter(e=>e.tipe==='pause_in' || e.tipe==='pause_out'); for (let pi=0; pi<pauses.length-1; pi++){ if (pauses[pi].tipe==='pause_in' && pauses[pi+1].tipe==='pause_out'){ durJam -= (pauses[pi+1].ts - pauses[pi].ts)/3600000; pi++; } }
for (let i=0; i<breaks.length-1; i++){
if (breaks[i].tipe==='break_in' && breaks[i+1].tipe==='break_out'){
durJam -= (breaks[i+1].ts - breaks[i].ts)/3600000;
i++;
}
}
}
if (durJam < 0) durJam = 0;
const effJam = Math.min(durJam, netJamKerja);
  let effJamFinal = effJam;
let kategori = 'absen', kontribusi = 0;
if (ci && __end){
kontribusi = effJam * dayRatePerJam;
if (durJam >= jamKerja * 0.75){ kategori = 'hadir'; hariHadir++; }
else if (durJam > 0){ kategori = 'parsial'; hariParsial++; }
else { kategori = 'short'; }
} else if (ci && !__end){
kategori = 'tidak-clockout'; var __cut = ci.ts.getTime() + jamKerja*3600000; var __pms=0, __ps=null; for(var __pe=0;__pe<events.length;__pe++){ if(events[__pe].tipe==='pause_in'){__ps=events[__pe].ts.getTime();} else if(events[__pe].tipe==='pause_out'&&__ps!==null){__pms+=Math.min(events[__pe].ts.getTime(),__cut)-__ps;__ps=null;} } if(__ps!==null){__pms+=Math.max(0,__cut-__ps);} effJamFinal = Math.max(0, Math.min(netJamKerja, jamKerja - __pms/3600000)); kontribusi = effJamFinal * dayRatePerJam; hariHadir++;
}
totalJamKerja += effJamFinal;
totalKontribusi += kontribusi;
let lemburJam = 0;
const __ovr = (ci && ci.lemburOverrideMin !== undefined && ci.lemburOverrideMin !== null && ci.lemburOverrideMin !== '') ? (Number(ci.lemburOverrideMin)/60) : null;
if (__ovr !== null){ lemburJam = Math.max(0, __ovr); totalJamLembur += lemburJam; }
else if (oo){ const __netH = Math.max(0, jamKerja - 1); lemburJam = Math.max(0, durJam - __netH); totalJamLembur += lemburJam; }
dailyDetails.push({
date: dateStr,
jamMasuk: ci ? ci.ts.toTimeString().substring(0,5) : '--',
jamKeluar: co ? co.ts.toTimeString().substring(0,5) : '--',
durJam: durJam.toFixed(2),
effJam: effJam.toFixed(2),
lemburJam: lemburJam.toFixed(2),
kategori: kategori,
kontribusi: kontribusi
});
}
const upahPokok = totalKontribusi;
const upahLembur = totalJamLembur * ratePerJam * multiplierLembur;
const total = upahPokok + upahLembur;
rows.push({
uid: k.uid, nama: k.nama || '-', idKaryawan: k.idKaryawan || '-',
baseHarian: baseHarian, jamKerja: jamKerja, multiplierLembur: multiplierLembur,
ratePerJam: ratePerJam,
hariHadir: hariHadir, hariParsial: hariParsial,
totalJamKerja: totalJamKerja, totalJamLembur: totalJamLembur,
upahPokok: upahPokok, upahLembur: upahLembur, total: total,
namaBank: k.namaBank || '', atasNamaRek: k.atasNamaRek || '', nomorRekening: k.nomorRekening || '',
dailyDetails: dailyDetails
});
totalBudget += total;
totalHari += hariHadir + hariParsial;
totalLemburJam += totalJamLembur;
totalJamKerjaAll += totalJamKerja;
}
rows.sort((a,b)=>(a.nama||'').localeCompare(b.nama||''));
__payrollData = {yyyymm: yyyymm, label: label, rows: rows};
await loadPayStatus(yyyymm);
renderPayrollTable();
$('prTotalKaryawan').textContent = rows.length;
$('prTotalBudget').textContent = prFormatRp(totalBudget);
$('prTotalHari').textContent = totalHari.toFixed(1);
$('prTotalLembur').textContent = totalLemburJam.toFixed(1) + ' jam';
$('prLastCalc').textContent = 'Dihitung ' + new Date().toLocaleTimeString('id-ID') + ' \u2014 Bulan: ' + label;
}

// ===== Status pembayaran payroll (Paid/Belum) - tersimpan di Firestore =====
window.__payStatus = window.__payStatus || {};
function __payStatusKey(yyyymm, uid){ return String(yyyymm) + '_' + String(uid); }
async function loadPayStatus(yyyymm){
  window.__payStatus = {};
  try {
    const snap = await getDocs(collection(db, 'payroll_status'));
    snap.forEach(function(d){
      const data = d.data() || {};
      if (String(data.yyyymm) === String(yyyymm) && data.status === 'paid') {
        window.__payStatus[data.uid] = 'paid';
      }
    });
  } catch(e){ console.warn('loadPayStatus gagal:', e); }
}
async function togglePayStatus(uid){
  if (!__payrollData || !__payrollData.yyyymm){ alert('Hitung payroll dulu.'); return; }
  const yyyymm = __payrollData.yyyymm;
  const sudahPaid = window.__payStatus[uid] === 'paid';
  const jadi = sudahPaid ? 'unpaid' : 'paid';
  const row = (__payrollData.rows || []).find(function(x){ return x.uid === uid; });
  const nama = row ? (row.nama || '') : '';
  if (!confirm((jadi === 'paid' ? 'Tandai LUNAS' : 'Batalkan status lunas') + ' untuk ' + nama + ' (' + (__payrollData.label || yyyymm) + ')?')) return;
  try {
    await setDoc(doc(db, 'payroll_status', __payStatusKey(yyyymm, uid)), {
      uid: uid, yyyymm: yyyymm, status: jadi, nama: nama,
      total: row ? row.total : null, updatedAt: serverTimestamp()
    }, { merge: true });
    if (jadi === 'paid') window.__payStatus[uid] = 'paid'; else delete window.__payStatus[uid];
    renderPayrollTable();
  } catch(e){ alert('Gagal simpan status: ' + (e.message || e)); }
}
function __payStatusCell(uid){
  const paid = window.__payStatus[uid] === 'paid';
  const badge = paid
    ? '<span class="badge" style="background:#14321f;color:#86efac">Lunas</span>'
    : '<span class="badge" style="background:#3a2f12;color:#fcd34d">Belum Bayar</span>';
  const btn = '<button class="btn btn-sm ' + (paid ? 'btn-secondary' : 'btn-success') + ' pr-paid-btn" data-uid="' + uid + '">' + (paid ? 'Batalkan' : 'Tandai Lunas') + '</button>';
  return '<td>' + badge + '<br>' + btn + '</td>';
}

function renderPayrollTable(){
const tbody = document.querySelector('#tblPayroll tbody');
if (!tbody || !__payrollData) return;
tbody.innerHTML = '';
if (!__payrollData.rows.length){ $('prEmpty').classList.remove('hidden'); return; }
$('prEmpty').classList.add('hidden');
for (const r of __payrollData.rows){
const tr = document.createElement('tr');
tr.innerHTML = '<td><b>' + r.nama + '</b><br><small class="muted">' + r.idKaryawan + '</small></td>' +
'<td class="num">' + prFormatRp(r.baseHarian) + '</td>' +
'<td class="num">' + r.hariHadir + (r.hariParsial ? ' <small class="muted">(+' + r.hariParsial + ' parsial)</small>' : '') + '</td>' +
'<td class="num">' + r.totalJamKerja.toFixed(1) + ' jam</td>' +
'<td class="num">' + r.totalJamLembur.toFixed(1) + '</td>' +
'<td class="num">' + prFormatRp(r.upahPokok) + '</td>' +
'<td class="num">' + prFormatRp(r.upahLembur) + '</td>' +
'<td class="num"><b>' + prFormatRp(r.total) + '</b></td>' +
__payStatusCell(r.uid) +
'<td><button class="btn btn-sm btn-secondary pr-detail-btn" data-uid="' + r.uid + '">Detail</button><button class="btn btn-sm btn-success pr-slip-btn" data-uid="' + r.uid + '">Slip Gaji</button></td>';
tbody.appendChild(tr);
}
document.querySelectorAll('.pr-detail-btn').forEach(b => { b.onclick = () => showPayrollDetail(b.dataset.uid); });
document.querySelectorAll('.pr-paid-btn').forEach(b => { b.onclick = () => togglePayStatus(b.dataset.uid); });
}

function showPayrollDetail(uid){
if (!__payrollData) return;
const r = __payrollData.rows.find(x => x.uid === uid);
if (!r) return;
$('prDetailTitle').textContent = 'Detail Payroll \u2014 ' + r.nama;
$('prDetailSub').textContent = 'Bulan: ' + __payrollData.label + ' \u2014 Total Jam: ' + r.totalJamKerja.toFixed(1) + ' jam \u2014 Rate: ' + prFormatRp(r.ratePerJam||0) + '/jam \u2014 Total: ' + prFormatRp(r.total);
const tb = document.querySelector('#tblPayrollDetail tbody');
tb.innerHTML = '';
if (!r.dailyDetails.length){
tb.innerHTML = '<tr><td colspan="6" class="muted center">Tidak ada catatan kehadiran bulan ini.</td></tr>';
} else {
for (const d of r.dailyDetails){
const tr = document.createElement('tr');
const kategoriBadge = d.kategori === 'hadir' ? '<span style="color:#16a34a">\u2713 Hadir</span>'
: d.kategori === 'parsial' ? '<span style="color:#ea580c">Parsial</span>'
: d.kategori === 'short' ? '<span style="color:#94a3b8">Short</span>'
: d.kategori === 'tidak-clockout' ? '<span style="color:#dc2626">Belum Clock Out</span>'
: '<span class="muted">' + d.kategori + '</span>';
const jamLabel = d.durJam + ' jam' + (parseFloat(d.effJam) < parseFloat(d.durJam) ? ' <small class="muted">(eff ' + d.effJam + ')</small>' : '');
tr.innerHTML = '<td>' + d.date + '</td><td>' + d.jamMasuk + '</td><td>' + d.jamKeluar + '</td><td>' + jamLabel + '</td><td>' + kategoriBadge + '</td><td class="num">' + prFormatRp(d.kontribusi) + '</td>';
tb.appendChild(tr);
}
}
$('payrollDetailModal').classList.remove('hidden');
}

function exportPayrollCSV(){
if (!__payrollData || !__payrollData.rows.length){ alert('Belum ada data. Hitung dulu.'); return; }
const headers = ['Nama','ID Karyawan','Base Harian','Hari Hadir','Hari Parsial','Total Jam Kerja','Jam Lembur','Upah Pokok','Upah Lembur','Total','Bank','Atas Nama','Nomor Rekening'];
const lines = [headers.join(',')];
for (const r of __payrollData.rows){
const cells = [
r.nama, r.idKaryawan, r.baseHarian, r.hariHadir, r.hariParsial,
r.totalJamKerja.toFixed(2), r.totalJamLembur.toFixed(2),
Math.round(r.upahPokok), Math.round(r.upahLembur), Math.round(r.total),
r.namaBank, r.atasNamaRek, r.nomorRekening
].map(v => '"' + String(v).replace(/"/g, '""') + '"');
lines.push(cells.join(','));
}
const csv = '\ufeff' + lines.join('\n');
const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
const a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = 'payroll-' + __payrollData.yyyymm + '.csv';
a.click();
setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Auto-wire payroll buttons + expose to window for debug
window.loadPayroll = loadPayroll;
window.calcPayroll = calcPayroll;
(function(){
  function wirePayrollOnce(){
    const btn = document.getElementById('btnPrRefresh');
    const exp = document.getElementById('btnPrExportCSV');
    const close = document.getElementById('btnPrDetailClose');
    const mi = document.getElementById('prBulan');
    if (!btn || btn.__wired) return;
    btn.__wired = true;
    btn.onclick = function(){ calcPayroll().catch(e => { console.error('calcPayroll error', e); alert('Error: ' + e.message); }); };
    if (exp) exp.onclick = exportPayrollCSV;
    if (close) close.onclick = function(){ document.getElementById('payrollDetailModal').classList.add('hidden'); };
    if (mi && !mi.value){
      const now = new Date();
      mi.value = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
      mi.onchange = btn.onclick;
    }
  }
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', wirePayrollOnce);
  } else {
    wirePayrollOnce();
  }
  document.addEventListener('click', function(e){
    const t = e.target;
    if (t && t.classList && t.classList.contains('nav-link') && t.dataset.page === 'payroll'){
      setTimeout(wirePayrollOnce, 50);
    }
  }, true);
  window.addEventListener('hashchange', function(){
    if (location.hash === '#payroll') setTimeout(wirePayrollOnce, 100);
  });
  if (location.hash === '#payroll') setTimeout(wirePayrollOnce, 500);
})();


// ===== Download Slip Gaji (detail & transparan) =====
// Slip gaji per karyawan, di-convert otomatis dari hasil payroll.
// Tujuan: transparan — karyawan bisa lihat rincian per hari (full/partial/lembur).
function __slipFmtRp(n) {
  const num = Math.round(Number(n) || 0);
  return 'Rp' + num.toLocaleString('id-ID');
}

function __slipJam(n) {
  const x = Math.round((Number(n) || 0) * 10) / 10;
  return x + ' jam';
}

function __slipPeriode() {
  const el = document.getElementById('prMonth');
  const val = el && el.value ? el.value : '';
  if (/^\d{4}-\d{2}$/.test(val)) {
    const [y, m] = val.split('-');
    const bulan = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
    return bulan[Number(m) - 1] + ' ' + y;
  }
  return val || '-';
}

// Ubah kode kategori internal jadi label yang ramah + warna.
function __slipKategori(kat) {
  switch (kat) {
    case 'hadir':           return { label: 'Hari Penuh', color: '#16a34a' };
    case 'parsial':         return { label: 'Sebagian',   color: '#d97706' };
    case 'short':           return { label: 'Kurang Jam', color: '#d97706' };
    case 'tidak-clockout':  return { label: 'Lupa Clock Out', color: '#dc2626' };
    case 'absen':           return { label: 'Tidak Hadir', color: '#9ca3af' };
    default:                return { label: kat || '-', color: '#374151' };
  }
}

function downloadSlipGaji(uid) {
  const rows = (typeof __payrollData !== 'undefined' && __payrollData && __payrollData.rows) ? __payrollData.rows : [];
  const r = rows.find(x => x.uid === uid);
  if (!r) {
    alert('Data payroll tidak ditemukan untuk karyawan ini. Klik "Hitung Ulang" dulu.');
    return;
  }
  const periode = (typeof __payrollData !== 'undefined' && __payrollData && __payrollData.label) ? __payrollData.label : __slipPeriode();
  const days = Array.isArray(r.dailyDetails) ? r.dailyDetails : [];

  // Baris rincian per hari
  let rowsHtml = '';
  for (const d of days) {
    const k = __slipKategori(d.kategori);
    const lembur = (d.lemburJam && d.lemburJam > 0) ? __slipJam(d.lemburJam) : '-';
    rowsHtml +=
      '<tr>' +
      '<td>' + (d.date || '-') + '</td>' +
      '<td class="c">' + (d.jamMasuk || '-') + '</td>' +
      '<td class="c">' + (d.jamKeluar || '-') + '</td>' +
      '<td class="c">' + __slipJam(d.durJam) + '</td>' +
      '<td class="c">' + __slipJam(d.effJam) + '</td>' +
      '<td class="c">' + lembur + '</td>' +
      '<td class="c"><span style="color:' + k.color + ';font-weight:600">' + k.label + '</span></td>' +
      '<td class="r">' + __slipFmtRp(d.kontribusi) + '</td>' +
      '</tr>';
  }
  if (!rowsHtml) {
    rowsHtml = '<tr><td colspan="8" class="c" style="color:#9ca3af">Tidak ada catatan kehadiran di periode ini.</td></tr>';
  }

  // Info bank (kalau ada)
  let bankHtml = '';
  if (r.namaBank || r.nomorRekening) {
    bankHtml =
      '<tr><td>Bank</td><td class="r">' + (r.namaBank || '-') + '</td></tr>' +
      '<tr><td>No. Rekening</td><td class="r">' + (r.nomorRekening || '-') + '</td></tr>' +
      '<tr><td>Atas Nama</td><td class="r">' + (r.atasNamaRek || '-') + '</td></tr>';
  }

  const rateJam = r.ratePerJam || 0;
  const jamLembur = r.totalJamLembur || 0;

  const html = '<!doctype html><html lang="id"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Slip Gaji - ' + (r.nama || '') + ' - ' + periode + '</title>' +
    '<style>' +
    'body{font-family:Arial,Helvetica,sans-serif;color:#1f2937;margin:0;padding:24px;background:#f3f4f6;}' +
    '.slip{max-width:820px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 32px;}' +
    '.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0ea5e9;padding-bottom:14px;margin-bottom:18px;}' +
    'h1{font-size:22px;margin:0;color:#0ea5e9;}.brand{font-size:13px;color:#6b7280;margin-top:2px;}' +
    '.per{text-align:right;font-size:13px;color:#374151;}' +
    'h2{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin:22px 0 8px;}' +
    'table{width:100%;border-collapse:collapse;font-size:13px;}' +
    '.info td{padding:6px 4px;border-bottom:1px solid #f1f5f9;}' +
    '.info td.r{text-align:right;font-weight:600;}' +
    '.rincian th{background:#f8fafc;color:#475569;padding:8px 6px;border-bottom:2px solid #e2e8f0;text-align:left;font-size:12px;}' +
    '.rincian td{padding:7px 6px;border-bottom:1px solid #f1f5f9;}' +
    '.rincian td.c{text-align:center;}.rincian td.r{text-align:right;}' +
    '.rincian tr:nth-child(even) td{background:#fafafa;}' +
    '.calc td{padding:7px 4px;border-bottom:1px solid #f1f5f9;}.calc td.r{text-align:right;}' +
    '.calc .tot td{border-top:2px solid #111827;font-weight:bold;font-size:17px;padding-top:12px;color:#0ea5e9;}' +
    '.muted{color:#6b7280;font-size:12px;}' +
    '.foot{margin-top:22px;color:#9ca3af;font-size:11px;text-align:center;}' +
    '.kh-matrix td.kh-lembur-cell .kh_lembur_disp{cursor:pointer;display:inline-block;min-width:34px;padding:1px 4px;border-radius:4px;}.kh-matrix td.kh-lembur-cell .kh_lembur_disp:hover{background:rgba(56,189,248,.18);outline:1px dashed rgba(56,189,248,.5);}.kh-matrix td.kh-lembur-ovr .kh_lembur_disp{color:#38bdf8;font-weight:600;}.kh-matrix td.kh-lembur-cell input.kh_lembur{width:48px;text-align:center;}' +
    '@media print{body{background:#fff;padding:0;}.slip{border:none;}}' +
    '</style></head><body><div class="slip">' +
    '<div class="head"><div><h1>Slip Gaji</h1><div class="brand">GoodGems Absensi</div></div>' +
    '<div class="per"><strong>Periode</strong><br>' + periode + '</div></div>' +

    '<h2>Identitas Karyawan</h2>' +
    '<table class="info">' +
    '<tr><td>Nama</td><td class="r">' + (r.nama || '-') + '</td></tr>' +
    '<tr><td>ID Karyawan</td><td class="r">' + (r.idKaryawan || '-') + '</td></tr>' +
    '<tr><td>Upah Harian</td><td class="r">' + __slipFmtRp(r.baseHarian) + ' / ' + (r.jamKerja || '-') + ' jam</td></tr>' +
    '<tr><td>Tarif per Jam</td><td class="r">' + __slipFmtRp(rateJam) + '</td></tr>' +
    '<tr><td>Status Pembayaran</td><td class="r">' + ((typeof __payStatus!=='undefined' && __payStatus[uid]==='paid') ? '<strong style=\"color:#16a34a\">LUNAS / PAID</strong>' : 'Belum Dibayar') + '</td></tr>' +
    bankHtml +
    '</table>' +

    '<h2>Ringkasan Kehadiran</h2>' +
    '<table class="info">' +
    '<tr><td>Hari Hadir Penuh</td><td class="r">' + (r.hariHadir != null ? r.hariHadir : '-') + ' hari</td></tr>' +
    '<tr><td>Hari Sebagian / Kurang Jam</td><td class="r">' + (r.hariParsial != null ? r.hariParsial : 0) + ' hari</td></tr>' +
    '<tr><td>Total Jam Kerja Efektif</td><td class="r">' + __slipJam(r.totalJamKerja) + '</td></tr>' +
    '<tr><td>Total Jam Lembur</td><td class="r">' + __slipJam(jamLembur) + '</td></tr>' +
    '</table>' +

    '<h2>Perhitungan Gaji</h2>' +
    '<table class="calc">' +
    '<tr><td>Upah Pokok <span class="muted">(akumulasi kontribusi harian)</span></td><td class="r">' + __slipFmtRp(r.upahPokok) + '</td></tr>' +
    '<tr><td>Upah Lembur <span class="muted">(' + __slipJam(jamLembur) + ' &times; ' + __slipFmtRp(rateJam) + ')</span></td><td class="r">' + __slipFmtRp(r.upahLembur) + '</td></tr>' +
    '<tr class="tot"><td>Total Diterima</td><td class="r">' + __slipFmtRp(r.total) + '</td></tr>' +
    '</table>' +

    '<div class="foot">Slip ini dibuat otomatis dari sistem absensi GoodGems pada ' + new Date().toLocaleString('id-ID') + '. Perhitungan transparan berdasarkan catatan kehadiran. Bukan bukti pembayaran resmi.</div>' +
    '</div></body></html>';

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = String(r.nama || 'karyawan').replace(/[^a-zA-Z0-9]+/g, '_');
  a.href = url;
  a.download = 'Slip_Gaji_' + safeName + '_' + periode.replace(/\s+/g, '_') + '.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Delegasi klik untuk tombol slip gaji.
document.addEventListener('click', function (e) {
  const b = e.target.closest && e.target.closest('.pr-slip-btn');
  if (b) {
    downloadSlipGaji(b.dataset.uid);
  }
});


// ===== Modal Profil Karyawan (read-only) =====
async function showProfilKaryawan(uid){
  try {
    const snap = await getDoc(doc(db,'karyawan',uid));
    if(!snap.exists()){ alert('Data karyawan tidak ditemukan'); return; }
    const d = snap.data();
    const esc = (v)=>{ if(v===undefined||v===null||v==='') return '-'; return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
    let tj = '-';
    if(d.tanggalJoin){ try { const t = d.tanggalJoin.toDate ? d.tanggalJoin.toDate() : new Date(d.tanggalJoin); tj = t.toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'}); } catch(e){} }
    const baseH = (d.baseHarian!==undefined && d.baseHarian!==null && d.baseHarian!=='') ? ('Rp '+Number(d.baseHarian).toLocaleString('id-ID')) : '-';
    const row = (label,val)=>'<div style="display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.08);"><span style="color:#94a3b8;">'+label+'</span><span style="text-align:right;font-weight:600;">'+val+'</span></div>';
    const sec = (title)=>'<h4 style="margin:14px 0 4px;color:#e2e8f0;">'+title+'</h4>';
    let html = '';
    html += sec('Data Pribadi');
    html += row('Nama', esc(d.nama));
    html += row('No. HP', esc(d.phone));
    html += row('ID Karyawan', esc(d.idKaryawan||d.nik));
    html += row('Jabatan', esc(d.jabatan));
    html += row('Status', esc(d.statusKaryawan));
    html += row('Tanggal Join', tj);
    html += sec('Payroll');
    html += row('Base Harian', baseH);
    html += row('Jam Kerja / hari', esc(d.jamKerja));
    html += row('Multiplier Lembur', esc(d.multiplierLembur));
    html += sec('Rekening Bank');
    html += row('Nama Bank', esc(d.namaBank));
    html += row('Atas Nama', esc(d.atasNamaRek));
    html += row('Nomor Rekening', esc(d.nomorRekening));
    html += sec('Dokumen');
    html += row('Status Profil', d.profilLocked ? 'Terkunci (sudah diisi karyawan)' : 'Belum dikunci');
    if(d.ktpUrl){ html += '<div style="margin-top:8px;"><div style="color:#94a3b8;margin-bottom:4px;">Foto KTP</div><a href="'+d.ktpUrl+'" target="_blank" rel="noopener"><img src="'+d.ktpUrl+'" style="max-width:100%;border-radius:8px;"></a></div>'; }
    else { html += row('Foto KTP', 'Belum diupload'); }
    const body = document.getElementById('profilViewBody');
    if(body) body.innerHTML = html;
    const ttl = document.getElementById('pvTitle');
    if(ttl) ttl.textContent = 'Profil: ' + (d.nama || '-');
    const modal = document.getElementById('profilViewModal');
    if(modal) modal.classList.remove('hidden');
  } catch(e){ console.error('showProfilKaryawan', e); alert('Gagal memuat profil: ' + (e && e.message ? e.message : e)); }
}
(function(){
  var btn = document.getElementById('btnProfilViewClose');
  if(btn) btn.onclick = function(){ var m = document.getElementById('profilViewModal'); if(m) m.classList.add('hidden'); };
})();
