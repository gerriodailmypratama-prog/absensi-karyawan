import { auth, db, OWNER_EMAILS, normalizePanggilan } from './firebase-config.js';

import {
  signInWithEmailAndPassword, GoogleAuthProvider,
  signInWithPopup, signInWithRedirect, getRedirectResult,
  sendPasswordResetEmail, onAuthStateChanged,
  createUserWithEmailAndPassword, updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, setDoc, serverTimestamp, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Kode rahasia pendaftaran karyawan. Ganti nilai ini kapan saja kalau mau ganti kode.
const REGISTRATION_CODE = 'GOODGEMS2026';

const $ = id => document.getElementById(id);
const msg = (t, ok=false) => {
  const m = $('loginMsg');
  if (!m) { if (t) alert(t); return; }
  m.textContent = t || '';
  m.className = 'msg' + (ok ? ' ok' : '');
};

// Map error code Firebase -> pesan Bahasa Indonesia yg manusiawi
const ERR_MAP = {
  'auth/invalid-credential'      : 'Email atau password salah.',
  'auth/invalid-email'           : 'Format email tidak valid.',
  'auth/user-not-found'          : 'Akun belum terdaftar. Hubungi admin.',
  'auth/wrong-password'          : 'Password salah.',
  'auth/user-disabled'           : 'Akun dinonaktifkan. Hubungi admin.',
  'auth/too-many-requests'       : 'Terlalu banyak percobaan. Tunggu ~5 menit, lalu coba lagi.',
  'auth/network-request-failed'  : 'Koneksi internet bermasalah. Cek WiFi/data lalu coba lagi.',
  'auth/popup-blocked'           : 'Popup login diblokir browser. Coba pakai email/password.',
  'auth/popup-closed-by-user'    : 'Jendela login Google ditutup sebelum selesai.',
  'auth/operation-not-supported-in-this-environment':
                                   'Login Google tidak didukung di browser ini. Buka di Chrome/Safari biasa.',
  'auth/unauthorized-domain'     : 'Domain belum diizinkan untuk login Google.',
  'auth/missing-password'        : 'Password belum diisi.',
  'auth/email-already-in-use'    : 'Email ini sudah terdaftar. Silakan Login.',
  'auth/weak-password'           : 'Password terlalu lemah (minimal 6 karakter).'
};

const friendlyErr = (err) => ERR_MAP[err.code] || ('Login gagal: ' + (err.code || err.message || 'unknown'));

// Normalisasi nomor HP ke format WhatsApp (62xxx, tanpa spasi/simbol) supaya wa.me langsung jalan.
function waPhone(raw){
  let p = String(raw || '').replace(/[^\d+]/g, '');
  p = p.replace(/^\+/, '');
  if (p.startsWith('0')) p = '62' + p.slice(1);
  else if (p.startsWith('8')) p = '62' + p; // orang sering ketik 8xxx tanpa 0
  return p;
}

// Deteksi in-app browser (FB/IG/Line/WA) - popup Google sering gagal di sini
const UA = navigator.userAgent || '';
const isInApp  = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|; wv\)|Twitter/i.test(UA);
const isMobile = /Mobi|Android|iPhone|iPad/i.test(UA);

if (isInApp) {
  setTimeout(() => {
    msg('Tip: kalau login Google gagal, buka di Chrome/Safari (bukan dari app sosial media).');
  }, 400);
}

function redirect(user){
  if (OWNER_EMAILS.includes(user.email)) location.href = 'owner.html';
  else location.href = 'karyawan.html';
}

onAuthStateChanged(auth, user => { if (user && !window.__registering) redirect(user); });

// Tangkap hasil redirect (signInWithRedirect)
getRedirectResult(auth).catch(err => {
  if (err && err.code) msg(friendlyErr(err));
});

// ---------- LOGIN EMAIL ----------
const btnEmail = $('btnLoginEmail');
if (btnEmail) {
  const doLoginEmail = async () => {
    const e = ($('email').value || '').trim();
    const p = $('password').value || '';
    if (!e || !p) return msg('Isi email & password dulu ya.');

    const orig = btnEmail.textContent;
    btnEmail.disabled = true;
    btnEmail.textContent = 'Loading...';
    msg('');

    try {
      await signInWithEmailAndPassword(auth, e, p);
    } catch (err) {
      msg(friendlyErr(err));
    } finally {
      btnEmail.disabled = false;
      btnEmail.textContent = orig || 'Login';
    }
  };
  btnEmail.onclick = doLoginEmail;

  ['email','password'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('keydown', ev => { if (ev.key === 'Enter') doLoginEmail(); });
  });
}

// ---------- LOGIN GOOGLE ----------
const btnGoogle = $('btnLoginGoogle');
if (btnGoogle) {
  btnGoogle.onclick = async () => {
    const orig = btnGoogle.textContent;
    btnGoogle.disabled = true;
    btnGoogle.textContent = 'Membuka Google...';
    msg('');

    try {
      const provider = new GoogleAuthProvider();
      if (isInApp) {
        await signInWithRedirect(auth, provider);
      } else {
        await signInWithPopup(auth, provider);
      }
    } catch (err) {
      if (err.code === 'auth/popup-blocked' || err.code === 'auth/popup-closed-by-user') {
        try { await signInWithRedirect(auth, new GoogleAuthProvider()); return; }
        catch(e2){ msg(friendlyErr(e2)); }
      } else {
        msg(friendlyErr(err));
      }
    } finally {
      btnGoogle.disabled = false;
      btnGoogle.textContent = orig || 'Login dengan Google';
    }
  };
}

// ---------- LUPA PASSWORD ----------
const btnForgot = $('btnForgotPwd');
if (btnForgot) {
  btnForgot.onclick = async () => {
    const e = ($('email').value || '').trim();
    if (!e) return msg('Masukkan email dulu, lalu klik Lupa Password lagi.');

    const ok = window.confirm
      ? window.confirm('Kirim link reset password ke ' + e + ' ?')
      : true;
    if (!ok) return;

    const orig = btnForgot.textContent;
    btnForgot.style.pointerEvents = 'none';
    btnForgot.textContent = 'Mengirim...';

    try {
      await sendPasswordResetEmail(auth, e);
      msg('Link reset password sudah dikirim ke ' + e + '. Cek inbox/spam ya.', true);
    } catch (err) {
      msg('Gagal kirim reset: ' + friendlyErr(err));
    } finally {
      btnForgot.style.pointerEvents = '';
      btnForgot.textContent = orig || 'Lupa Password?';
    }
  };
}

// ---------- TOGGLE LOGIN <-> DAFTAR ----------
const linkShowRegister = $('linkShowRegister');
const linkShowLogin = $('linkShowLogin');
if (linkShowRegister) linkShowRegister.onclick = (e) => {
  e.preventDefault();
  const lf = $('loginForm'), rf = $('registerForm');
  if (lf) lf.classList.add('hidden');
  if (rf) rf.classList.remove('hidden');
};
if (linkShowLogin) linkShowLogin.onclick = (e) => {
  e.preventDefault();
  const lf = $('loginForm'), rf = $('registerForm');
  if (rf) rf.classList.add('hidden');
  if (lf) lf.classList.remove('hidden');
};

// ---------- DAFTAR (SELF-REGISTER) ----------
const regMsg = (t, ok=false) => {
  const m = $('registerMsg');
  if (!m) { if (t) alert(t); return; }
  m.textContent = t || '';
  m.className = 'msg' + (ok ? ' ok' : '');
};
const btnRegister = $('btnRegister');
if (btnRegister) {
  const doRegister = async () => {
    const fullName = ($('regNama').value || '').trim();
    const email = ($('regEmail').value || '').trim();
    const pass = $('regPassword').value || '';
    const code = ($('regCode').value || '').trim();
    const pgRaw = $('regPanggilan') ? ($('regPanggilan').value || '') : '';
    const phone = $('regPhone') ? waPhone($('regPhone').value || '') : '';
    if (!fullName || !email || !pass) return regMsg('Lengkapi nama, email, dan password dulu ya.');
    // Nama panggilan: satu kata huruf kecil, dipakai sebagai identitas sync WMS.
    const pg = normalizePanggilan(pgRaw);
    if (!pg.ok) return regMsg(pg.error);
    if (phone.length < 8) return regMsg('No. HP (WhatsApp) wajib diisi dengan benar — buat kirim slip gaji & notifikasi.');
    if (pass.length < 6) return regMsg('Password minimal 6 karakter.');
    if (code.toUpperCase() !== REGISTRATION_CODE.toUpperCase()) {
      return regMsg('Kode pendaftaran salah. Minta kode yang benar ke admin/owner.');
    }
    const orig = btnRegister.textContent;
    btnRegister.disabled = true;
    btnRegister.textContent = 'Mendaftar...';
    regMsg('');
    window.__registering = true; // cegah auto-redirect sebelum dokumen karyawan dibuat
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      // Validasi UNIK panggilan (butuh sesi login -> dilakukan setelah akun dibuat).
      // Kalau bentrok, rollback akun yang baru dibuat biar bisa daftar ulang.
      try {
        const snap = await getDocs(collection(db, 'karyawan'));
        let taken = false;
        snap.forEach(docSnap => {
          if (docSnap.id === cred.user.uid) return;
          const dd = docSnap.data() || {};
          const other = String(dd.nama || dd.namaPanggilan || '').trim().toLowerCase();
          if (other && other === pg.value) taken = true;
        });
        if (taken) {
          try { await cred.user.delete(); } catch (_) {}
          window.__registering = false;
          btnRegister.disabled = false;
          btnRegister.textContent = orig || 'Daftar';
          return regMsg('Nama panggilan "' + pg.value + '" sudah dipakai karyawan lain. Pilih panggilan lain ya.');
        }
      } catch (permErr) {
        // Rules mungkin melarang baca semua karyawan -> keunikan tak bisa dicek di sini.
        // Lanjut simpan; owner tetap bisa cek/koreksi lewat panel karyawan.
        console.warn('Cek unik panggilan dilewati:', permErr && permErr.code);
      }
      try { await updateProfile(cred.user, { displayName: fullName }); } catch (_) {}
      await setDoc(doc(db, 'karyawan', cred.user.uid), {
        nama: pg.value, namaPanggilan: pg.value, full_name: fullName,
        email, phone, selfRegistered: true,
        createdAt: serverTimestamp(), tanggalJoin: serverTimestamp()
      }, { merge: true });
      window.__registering = false;
      redirect(cred.user);
    } catch (err) {
      window.__registering = false;
      regMsg(friendlyErr(err));
      btnRegister.disabled = false;
      btnRegister.textContent = orig || 'Daftar';
    }
  };
  btnRegister.onclick = doRegister;
  // Biar user boleh ketik huruf besar (mis. "Andi") — case dibiarkan apa adanya di layar,
  // sistem yang huruf-kecilin otomatis saat simpan (normalizePanggilan). Di sini cuma buang
  // spasi/simbol biar tetap satu kata.
  const pgInput = $('regPanggilan');
  if (pgInput) pgInput.addEventListener('input', () => {
    const cleaned = (pgInput.value || '').replace(/[^a-zA-Z0-9]/g, '');
    if (cleaned !== pgInput.value) pgInput.value = cleaned;
  });
  ['regNama','regPanggilan','regPhone','regEmail','regPassword','regCode'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('keydown', ev => { if (ev.key === 'Enter') doRegister(); });
  });
}
