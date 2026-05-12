import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const firebaseConfig = {
    apiKey: "AIzaSyAtbQWVdMYzIhp0hdtioPaDmULEYQBYvmg",
    authDomain: "absensi-karyawan-207d9.firebaseapp.com",
    projectId: "absensi-karyawan-207d9",
    storageBucket: "absensi-karyawan-207d9.firebasestorage.app",
    messagingSenderId: "819005025283",
    appId: "1:819005025283:web:459c4dba62bb22dcc63236",
    measurementId: "G-35DB38FN9P"
};

// Email OWNER (Dashboard owner access)
export const OWNER_EMAILS = [
    "gerriomail@gmail.com"
  ];

// Lokasi kantor/ruko (Ruko BSM A2/9, Pakulonan, Serpong Utara)
// Hybrid geofence: absen tetap boleh, tapi diberi flag kalau di luar radius.
export const OFFICE_LOCATION = {
    lat: -6.238929,
    lng: 106.6459816,
    radiusMeters: 150
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
