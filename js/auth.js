import { auth, OWNER_EMAILS } from './firebase-config.js';

import {
  signInWithEmailAndPassword, GoogleAuthProvider,
  signInWithPopup, signInWithRedirect, getRedirectResult,
  sendPasswordResetEmail, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

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
  'auth/missing-password'        : 'Password belum diisi.'
};

const friendlyErr = (err) => ERR_MAP[err.code] || ('Login gagal: ' + (err.code || err.message || 'unknown'));

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

onAuthStateChanged(auth, user => { if (user) redirect(user); });

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
