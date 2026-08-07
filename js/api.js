/* ==================================================================
   MAP-IN Vision V1.0 - api.js
   Jembatan komunikasi ke backend Apps Script (Code.gs), MENGGANTIKAN
   google.script.run karena frontend sekarang di-hosting terpisah (mis.
   Firebase Hosting) dan TIDAK LAGI disajikan di dalam Apps Script
   HtmlService.

   ALASAN PERUBAHAN ARSITEKTUR (baca juga PANDUAN_MIGRASI_FIREBASE.md):
   Apps Script HtmlService SELALU membungkus halaman web app dalam iframe
   sandbox tersembunyi ("sandboxFrame") yang dibuat otomatis oleh Google,
   dan iframe itu TIDAK menyertakan izin kamera dalam atribut allow-nya.
   Akibatnya getUserMedia() (akses kamera browser) selalu gagal dengan
   "Permission denied", walau browser sudah memberi izin kamera - ini
   keterbatasan platform Apps Script, bukan bug di kode aplikasi ini, dan
   TIDAK bisa diperbaiki selama frontend tetap disajikan lewat Apps Script.
   Solusinya: frontend (file-file di folder ini) dipindah ke hosting statis
   biasa (di luar Apps Script) sehingga tidak lagi terjebak di iframe
   tersebut, sementara backend (semua file .gs) TETAP di Apps Script,
   diakses lewat HTTP biasa (fetch) alih-alih google.script.run.
   ================================================================== */

// >>> WAJIB DIISI: URL Web App Apps Script Anda <<<
// Ambil dari: Apps Script Editor -> Deploy -> Manage deployments -> salin
// URL yang diakhiri "/exec" (BUKAN URL /dev, BUKAN URL editor).
const API_BASE_URL = '//script.google.com/macros/s/AKfycby3ce2UMM4qQT2MTHl0Cm7X6Fxvg09459sHu612Cmk90fd9JncOyqnHw_pWsqXZl120KA/exec';

/**
 * Memanggil salah satu fungsi apiXxx() di Code.gs lewat HTTP POST.
 *
 * CATATAN TEKNIS - kenapa Content-Type-nya "text/plain" padahal isinya JSON:
 * Apps Script Web App tidak mendukung preflight request (OPTIONS) untuk
 * CORS. Kalau kita memakai Content-Type: application/json, browser akan
 * mengirim preflight OPTIONS dulu sebelum POST, dan Apps Script akan
 * menolaknya sehingga request gagal total. Dengan memakai Content-Type:
 * text/plain (salah satu "safelisted" content-type di spesifikasi CORS),
 * browser mengirim POST secara langsung tanpa preflight. Isi body tetap
 * teks JSON biasa, dan di sisi server (Code.gs doPost) kita parse manual
 * dengan JSON.parse(e.postData.contents) seperti biasa.
 */
function callApi(fnName, args) {
  return fetch(API_BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn: fnName, args: args || [] })
  }).then(function (res) {
    if (!res.ok) {
      throw new Error('Server merespons HTTP ' + res.status + '. Periksa apakah API_BASE_URL di js/api.js sudah benar dan deployment Apps Script masih aktif.');
    }
    return res.json();
  });
}

/* ---------------- PENYIMPANAN SESI DI BROWSER ----------------
   Karena sekarang halaman ini adalah halaman web statis biasa (bukan lagi
   di dalam shell Apps Script yang mempertahankan state SPA tanpa reload),
   sessionToken disimpan di localStorage supaya login tidak hilang kalau
   pengguna tidak sengaja me-refresh halaman. Token ini SAMA SEKALI TIDAK
   memberi akses langsung ke Spreadsheet/Drive - ia hanya kunci sesi
   sementara (kadaluarsa otomatis, lihat AuthService.gs) yang divalidasi
   ulang oleh server di setiap pemanggilan API. */
const SESSION_STORAGE_KEY = 'mapinVisionSessionToken';

function saveSessionToken(token) {
  try { localStorage.setItem(SESSION_STORAGE_KEY, token); } catch (e) { /* localStorage tidak tersedia, abaikan */ }
}
function loadSessionToken() {
  try { return localStorage.getItem(SESSION_STORAGE_KEY); } catch (e) { return null; }
}
function clearSessionToken() {
  try { localStorage.removeItem(SESSION_STORAGE_KEY); } catch (e) { /* abaikan */ }
}
