// ============================================================================
// Login & pendaftaran — versi Supabase.
//
// Alur, tombol, dan pesan sengaja dibikin SAMA PERSIS dengan absensi GoodGems.
// Yang berubah cuma mesin di belakangnya (Firebase Auth -> Supabase Auth).
// ============================================================================

import {
  sb, karyawanSaya, halamanUntuk, lupakanCacheSaya,
  rapikanPanggilan, nomorWa, pesanRamah
} from './supabase-config.js';

const $ = id => document.getElementById(id);

const msg = (t, ok = false) => {
  const m = $('loginMsg');
  if (!m) { if (t) alert(t); return; }
  m.textContent = t || '';
  m.className = 'msg' + (ok ? ' ok' : '');
};

const regMsg = (t, ok = false) => {
  const m = $('registerMsg');
  if (!m) { if (t) alert(t); return; }
  m.textContent = t || '';
  m.className = 'msg' + (ok ? ' ok' : '');
};

// Deteksi browser dalam aplikasi (FB/IG/WA/Line) — login Google sering gagal
// di sana karena popup-nya diblokir.
const UA = navigator.userAgent || '';
const dalamAppSosmed = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|; wv\)|Twitter/i.test(UA);

if (dalamAppSosmed) {
  setTimeout(() => {
    msg('Tip: kalau login Google gagal, buka lewat Chrome/Safari (bukan dari aplikasi sosmed).');
  }, 400);
}

// Arahkan ke halaman sesuai peran. Kalau akunnya ada tapi belum didaftarkan
// sebagai karyawan, jangan lempar ke mana-mana — kasih tahu apa adanya,
// biar dia ngerti harus ngapain (bukan layar kosong yang bikin bingung).
async function arahkan() {
  lupakanCacheSaya();
  let saya = null;
  // Sambungkan akun login ke data karyawan yang emailnya cocok (karyawan lama yang
  // baru pertama kali login ke sistem baru). Gagal di sini tidak menghalangi login.
  try { await sb.rpc('klaim_akun_saya'); } catch (e) { console.warn('klaim akun:', e); }
  try { saya = await karyawanSaya({ paksaSegar: true }); }
  catch (e) { msg(pesanRamah(e)); return; }

  if (!saya) {
    msg('Akun kamu belum terdaftar sebagai karyawan. Klik "Daftar di sini" dan isi kode pendaftaran ya.');
    const lf = $('loginForm'), rf = $('registerForm');
    if (lf) lf.classList.add('hidden');
    if (rf) rf.classList.remove('hidden');
    const re = $('regEmail');
    const { data: { user } } = await sb.auth.getUser();
    if (re && user) { re.value = user.email || ''; re.readOnly = true; }
    return;
  }

  // Karyawan nonaktif tetap boleh masuk (lihat slip & profil terakhir); tombol absennya
  // dikunci di halaman karyawan (PR-CL97), sama seperti versi Firebase.
  location.href = halamanUntuk(saya);
}

// Kalau sesi lama masih hidup (atau baru balik dari login Google), langsung masuk.
sb.auth.onAuthStateChange((event, session) => {
  if (session && !window.__sedangDaftar) arahkan();
});

// ------------------------------------------------------------ LOGIN EMAIL
const btnEmail = $('btnLoginEmail');
if (btnEmail) {
  const loginEmail = async () => {
    const email = ($('email').value || '').trim();
    const pass = $('password').value || '';
    if (!email || !pass) return msg('Isi email & password dulu ya.');

    const teksAsli = btnEmail.textContent;
    btnEmail.disabled = true;
    btnEmail.textContent = 'Loading...';
    msg('');

    try {
      const { error } = await sb.auth.signInWithPassword({ email, password: pass });
      if (error) throw error;
      // arahkan() jalan otomatis lewat onAuthStateChange
    } catch (err) {
      msg(pesanRamah(err));
    } finally {
      btnEmail.disabled = false;
      btnEmail.textContent = teksAsli || 'Login';
    }
  };
  btnEmail.onclick = loginEmail;

  ['email', 'password'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('keydown', ev => { if (ev.key === 'Enter') loginEmail(); });
  });
}

// ----------------------------------------------------------- LOGIN GOOGLE
const btnGoogle = $('btnLoginGoogle');
if (btnGoogle) {
  btnGoogle.onclick = async () => {
    const teksAsli = btnGoogle.textContent;
    btnGoogle.disabled = true;
    btnGoogle.textContent = 'Membuka Google...';
    msg('');

    try {
      const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: location.origin + location.pathname }
      });
      if (error) throw error;
      // Browser pindah ke halaman Google; balik lagi ditangkap onAuthStateChange.
    } catch (err) {
      msg(pesanRamah(err));
      btnGoogle.disabled = false;
      btnGoogle.textContent = teksAsli || 'Login dengan Google';
    }
  };
}

// ---------------------------------------------------------- LUPA PASSWORD
const btnLupa = $('btnForgotPwd');
if (btnLupa) {
  btnLupa.onclick = async () => {
    const email = ($('email').value || '').trim();
    if (!email) return msg('Masukkan email dulu, lalu klik Lupa Password lagi.');
    if (!window.confirm('Kirim link reset password ke ' + email + ' ?')) return;

    const teksAsli = btnLupa.textContent;
    btnLupa.style.pointerEvents = 'none';
    btnLupa.textContent = 'Mengirim...';

    try {
      const { error } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: location.origin + location.pathname
      });
      if (error) throw error;
      msg('Link reset password sudah dikirim ke ' + email + '. Cek inbox/spam ya.', true);
    } catch (err) {
      msg('Gagal kirim reset: ' + pesanRamah(err));
    } finally {
      btnLupa.style.pointerEvents = '';
      btnLupa.textContent = teksAsli || 'Lupa Password?';
    }
  };
}

// ------------------------------------------------ TOGGLE LOGIN <-> DAFTAR
const keDaftar = $('linkShowRegister');
const keLogin = $('linkShowLogin');
if (keDaftar) keDaftar.onclick = (e) => {
  e.preventDefault();
  $('loginForm')?.classList.add('hidden');
  $('registerForm')?.classList.remove('hidden');
};
if (keLogin) keLogin.onclick = (e) => {
  e.preventDefault();
  $('registerForm')?.classList.add('hidden');
  $('loginForm')?.classList.remove('hidden');
};

// ------------------------------------------------------------- PENDAFTARAN
const btnDaftar = $('btnRegister');
if (btnDaftar) {
  const daftar = async () => {
    const namaLengkap = ($('regNama').value || '').trim();
    const email = ($('regEmail').value || '').trim();
    const pass = $('regPassword').value || '';
    const kode = ($('regCode').value || '').trim();
    const phone = nomorWa($('regPhone') ? $('regPhone').value : '');
    const pg = rapikanPanggilan($('regPanggilan') ? $('regPanggilan').value : '');

    if (!namaLengkap || !email || !pass) return regMsg('Lengkapi nama, email, dan password dulu ya.');
    if (!pg.ok) return regMsg(pg.error);
    if (phone.length < 8) return regMsg('No. HP (WhatsApp) wajib diisi dengan benar — buat kirim slip gaji & notifikasi.');
    if (pass.length < 6) return regMsg('Password minimal 6 karakter.');
    if (!kode) return regMsg('Kode pendaftaran wajib diisi. Minta ke admin/owner.');

    const teksAsli = btnDaftar.textContent;
    btnDaftar.disabled = true;
    btnDaftar.textContent = 'Mendaftar...';
    regMsg('');
    window.__sedangDaftar = true;   // tahan auto-redirect sampai baris karyawan jadi

    try {
      // Kalau akunnya sudah ada dan tinggal melengkapi data karyawan,
      // pakai sesi yang sudah jalan. Kalau belum ada, bikin akun baru.
      let { data: { session } } = await sb.auth.getSession();

      if (!session) {
        const { data, error } = await sb.auth.signUp({ email, password: pass });
        if (error) throw error;
        session = data.session;

        // Kalau project disetel wajib verifikasi email, session-nya kosong.
        // Jangan bikin orang menunggu layar diam — kasih tahu langkah berikutnya.
        if (!session) {
          window.__sedangDaftar = false;
          btnDaftar.disabled = false;
          btnDaftar.textContent = teksAsli || 'Daftar';
          return regMsg('Akun dibuat. Cek email ' + email +
            ' untuk verifikasi, lalu login ya. (Cek folder spam juga.)', true);
        }
      }

      // Kode pendaftaran, keunikan panggilan, dan penempelan ke data karyawan
      // hasil impor semuanya diperiksa DI DATABASE — tidak bisa dilewati dari
      // browser. Lihat sql/0004_pr_cl04_daftar_karyawan.sql.
      const { error: errDaftar } = await sb.rpc('daftar_karyawan', {
        p_kode: kode,
        p_panggilan: pg.nilai,
        p_nama_lengkap: namaLengkap,
        p_phone: phone
      });
      if (errDaftar) throw errDaftar;

      window.__sedangDaftar = false;
      await arahkan();
    } catch (err) {
      window.__sedangDaftar = false;
      regMsg(pesanRamah(err));
      btnDaftar.disabled = false;
      btnDaftar.textContent = teksAsli || 'Daftar';
    }
  };

  btnDaftar.onclick = daftar;

  // Boleh ngetik huruf besar (mis. "Andi") — yang dibuang cuma spasi & simbol
  // biar tetap satu kata. Huruf kecilnya diurus sistem saat disimpan.
  const inputPg = $('regPanggilan');
  if (inputPg) inputPg.addEventListener('input', () => {
    const bersih = (inputPg.value || '').replace(/[^a-zA-Z0-9]/g, '');
    if (bersih !== inputPg.value) inputPg.value = bersih;
  });

  ['regNama', 'regPanggilan', 'regPhone', 'regEmail', 'regPassword', 'regCode'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('keydown', ev => { if (ev.key === 'Enter') daftar(); });
  });
}
