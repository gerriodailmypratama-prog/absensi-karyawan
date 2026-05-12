import { auth, OWNER_EMAILS } from './firebase-config.js';

import {
  signInWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, sendPasswordResetEmail,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const $ = id => document.getElementById(id);
const msg = (t, ok=false) => { const m=$('loginMsg'); m.textContent=t; m.className='msg'+(ok?' ok':''); };

function redirect(user){
  if (OWNER_EMAILS.includes(user.email)) location.href = 'owner.html';
  else location.href = 'karyawan.html';
}

onAuthStateChanged(auth, user => { if (user) redirect(user); });

$('btnLoginEmail').onclick = async () => {
  const e = $('email').value.trim(), p = $('password').value;
  if (!e || !p) return msg('Isi email & password');
  try { await signInWithEmailAndPassword(auth, e, p); }
  catch(err){ msg('Login gagal: '+err.code); }
};

$('btnLoginGoogle').onclick = async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch(err){ msg('Google login gagal: '+err.code); }
};


$('btnForgotPwd').onclick = async () => {
  const e = $('email').value.trim();
  if (!e) return msg('Masukkan email dulu, lalu klik Lupa Password lagi');
  if (!confirm('Kirim link reset password ke ' + e + ' ?')) return;
  try {
    await sendPasswordResetEmail(auth, e);
    msg('Link reset password sudah dikirim ke ' + e + '. Cek inbox/spam ya', true);
  } catch(err) {
    msg('Gagal kirim reset: ' + err.message);
  }
};
