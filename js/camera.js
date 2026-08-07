/* ==================================================================
   MAP-IN Vision V1.0 - camera.js
   Akses Webcam PC & Kamera Smartphone via browser (WebRTC getUserMedia)
   ================================================================== */

let currentStream = null;

function initCameraCenter() {
  populateCameraList();
  document.getElementById('btnCapture').addEventListener('click', handleSingleShotClick);
  document.getElementById('btnContinuous').addEventListener('click', toggleContinuousMonitoring);
  document.getElementById('cameraSourceSelect').addEventListener('change', startSelectedCamera);
  document.getElementById('resolutionSelect').addEventListener('change', startSelectedCamera);

  const btnStop = document.getElementById('btnStopCamera');
  if (btnStop) {
    btnStop.onclick = function () {
      if (currentStream) {
        stopCamera();
      } else {
        startSelectedCamera(); // kamera sedang mati -> tombol ini jadi "Nyalakan Kamera"
      }
    };
  }

  document.getElementById('btnSaveFrozenFrame').onclick = handleSaveFrozenFrame;
  document.getElementById('btnResumeLive').onclick = resumeLiveView;

  initDatasetCapture();
  initCameraAdjustments();
  initDigitalZoom();
  initGridOverlay();
  initReferenceImage();
}

/* ==================================================================
   FREEZE FRAME - Single Shot
   Sebelumnya klik "Single Shot" cuma mengambil gambar diam-diam ke
   memori tanpa efek apa pun di layar (video tetap jalan terus, tidak ada
   cara meninjau/menyimpan hasilnya). Sekarang klik "Single Shot"
   MEMBEKUKAN tampilan (video di-pause, diganti gambar hasil capture),
   supaya operator bisa meninjau hasilnya dulu sebelum memutuskan Simpan
   (ke Drive/Dataset, pakai label dari panel di bawah) atau Lanjutkan
   Monitoring (batal, kembali ke live tanpa menyimpan apa pun).
   ================================================================== */
let frozenFrameBase64 = null;

function handleSingleShotClick() {
  if (!currentStream) {
    alert('Kamera sedang mati. Klik "Nyalakan Kamera" terlebih dahulu.');
    return;
  }
  freezeFrame(captureSingleShot());
}

function freezeFrame(base64) {
  frozenFrameBase64 = base64;
  const video = document.getElementById('cameraPreview');
  const img = document.getElementById('frozenFrameImg');
  video.pause();
  img.src = base64;
  img.classList.remove('d-none');
  video.classList.add('d-none');
  document.getElementById('frozenFrameBadge').classList.remove('d-none');
  document.getElementById('cameraLiveControls').classList.add('d-none');
  document.getElementById('cameraFrozenControls').classList.remove('d-none');
  const statusText = document.getElementById('cameraStatusText');
  if (statusText) statusText.innerText = 'Frame dibekukan untuk ditinjau. Pilih label di panel bawah lalu klik "Simpan Frame Ini", atau klik "Lanjutkan Monitoring" untuk batal.';
}

function resumeLiveView() {
  frozenFrameBase64 = null;
  const video = document.getElementById('cameraPreview');
  const img = document.getElementById('frozenFrameImg');
  img.classList.add('d-none');
  video.classList.remove('d-none');
  document.getElementById('frozenFrameBadge').classList.add('d-none');
  document.getElementById('cameraLiveControls').classList.remove('d-none');
  document.getElementById('cameraFrozenControls').classList.add('d-none');
  if (currentStream) {
    video.play().catch(function (playErr) { console.warn('video.play() gagal:', playErr); });
    document.getElementById('cameraStatusText').innerText = 'Kamera aktif.';
  }
}

function handleSaveFrozenFrame() {
  if (!frozenFrameBase64) return;
  saveFrameToDataset(frozenFrameBase64, function (ok) {
    if (ok) resumeLiveView(); // otomatis kembali live setelah berhasil tersimpan
  });
}

/* ==================================================================
   PENGATURAN KAMERA - Exposure / Brightness / Contrast
   Sebelumnya slider ini murni dekoratif (tidak ada JS yang mendengarkan
   perubahannya sama sekali, jadi geser slider tidak berefek apa pun).
   Sekarang setiap slider diterapkan LANGSUNG ke preview video lewat CSS
   filter, dan filter YANG SAMA juga dipakai saat capture (Single Shot,
   Continuous Monitoring, dataset sample) supaya hasil foto yang tersimpan
   benar-benar mencerminkan tampilan preview, bukan gambar mentah kamera.
   Tombol "Set" menyimpan kombinasi nilai saat ini sebagai default (lewat
   localStorage) yang otomatis dipakai lagi lain kali Camera Center
   dibuka; "Reset" mengembalikan ke netral (0/0/0) tanpa filter.
   ================================================================== */
const CAMERA_ADJUST_STORAGE_KEY = 'mapinCameraAdjustDefaults';

function _getCameraAdjustValues() {
  return {
    exposure: parseFloat(document.getElementById('exposureRange').value) || 0,
    brightness: parseFloat(document.getElementById('brightnessRange').value) || 0,
    contrast: parseFloat(document.getElementById('contrastRange').value) || 0
  };
}

/** Membangun string CSS/Canvas filter dari nilai exposure/brightness/contrast. */
function buildCameraFilterString(values) {
  // Exposure & Brightness sama-sama mengatur skala kecerahan, dikombinasikan
  // secara multiplikatif; Exposure diberi bobot lebih kecil (mensimulasikan
  // rentang stop kamera yang lebih halus dibanding slider Brightness).
  const exposureFactor = 1 + (values.exposure / 10) * 0.5;   // -10..10 -> 0.5..1.5
  const brightnessFactor = 1 + (values.brightness / 100);    // -100..100 -> 0..2
  const combinedBrightness = Math.max(0, exposureFactor * brightnessFactor);
  const contrastFactor = Math.max(0, 1 + (values.contrast / 100)); // -100..100 -> 0..2
  return 'brightness(' + combinedBrightness.toFixed(3) + ') contrast(' + contrastFactor.toFixed(3) + ')';
}

function applyCameraAdjustments() {
  const values = _getCameraAdjustValues();
  document.getElementById('exposureValue').innerText = values.exposure;
  document.getElementById('brightnessValue').innerText = values.brightness;
  document.getElementById('contrastValue').innerText = values.contrast;

  const filterStr = buildCameraFilterString(values);
  const video = document.getElementById('cameraPreview');
  if (video) video.style.filter = filterStr;
}

function initCameraAdjustments() {
  ['exposureRange', 'brightnessRange', 'contrastRange'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', applyCameraAdjustments);
  });

  // Muat default tersimpan (jika ada) dan langsung terapkan ke slider + preview
  try {
    const saved = JSON.parse(localStorage.getItem(CAMERA_ADJUST_STORAGE_KEY) || 'null');
    if (saved) {
      document.getElementById('exposureRange').value = saved.exposure;
      document.getElementById('brightnessRange').value = saved.brightness;
      document.getElementById('contrastRange').value = saved.contrast;
    }
  } catch (e) { /* abaikan kalau data tersimpan rusak */ }
  applyCameraAdjustments();

  document.getElementById('btnSetCameraAdjust').onclick = function () {
    const values = _getCameraAdjustValues();
    try {
      localStorage.setItem(CAMERA_ADJUST_STORAGE_KEY, JSON.stringify(values));
      alert('Pengaturan Exposure/Brightness/Contrast saat ini disimpan sebagai default. Akan otomatis dipakai lagi setiap kali Camera Center dibuka.');
    } catch (e) {
      alert('Gagal menyimpan default (localStorage tidak tersedia di browser ini).');
    }
  };

  document.getElementById('btnResetCameraAdjust').onclick = function () {
    document.getElementById('exposureRange').value = 0;
    document.getElementById('brightnessRange').value = 0;
    document.getElementById('contrastRange').value = 0;
    applyCameraAdjustments();
  };
}

/* ==================================================================
   KUMPULKAN SAMPLE UNTUK DATASET AI (Labeling)
   Berbeda dari Single Shot (hanya preview) dan Run Mode (butuh recipe
   aktif) - fitur ini menyimpan foto ke Drive/Dataset/<label>/ dengan
   label yang dipilih manual, untuk dipakai sebagai bahan labeling
   bounding box di Roboflow/CVAT sebelum recipe/AI model dibuat.
   ================================================================== */
let datasetCaptureCount = 0;

function initDatasetCapture() {
  const labelSelect = document.getElementById('datasetLabelSelect');
  const customInput = document.getElementById('datasetCustomLabel');
  const btnCaptureDataset = document.getElementById('btnCaptureDataset');
  if (!labelSelect || !btnCaptureDataset) return;

  labelSelect.onchange = function () {
    customInput.classList.toggle('d-none', labelSelect.value !== 'NG_lainnya');
  };

  btnCaptureDataset.onclick = function () {
    if (frozenFrameBase64) {
      // Sedang meninjau hasil Single Shot -> pakai frame yang dibekukan itu,
      // bukan ambil frame baru dari live video (yang sudah di-pause).
      saveFrameToDataset(frozenFrameBase64, function (ok) { if (ok) resumeLiveView(); });
      return;
    }
    if (!currentStream) {
      alert('Kamera sedang mati. Klik "Nyalakan Kamera" terlebih dahulu.');
      return;
    }
    saveFrameToDataset(captureSingleShot());
  };
}

/**
 * Logika simpan 1 foto ke Drive/Dataset/<label>/ - dipakai bersama oleh
 * tombol "Ambil & Simpan Sample" (capture langsung dari live video) DAN
 * tombol "Simpan Frame Ini" di alur freeze-frame Single Shot (base64 sudah
 * ada, tidak capture ulang). onDone(true/false) dipanggil setelah selesai
 * supaya pemanggil bisa mengambil aksi lanjutan (mis. resumeLiveView()).
 */
function saveFrameToDataset(base64, onDone) {
  const labelSelect = document.getElementById('datasetLabelSelect');
  const customInput = document.getElementById('datasetCustomLabel');
  const btnCaptureDataset = document.getElementById('btnCaptureDataset');
  const statusEl = document.getElementById('datasetCaptureStatus');

  let label = labelSelect.value;
  if (label === 'NG_lainnya') {
    const custom = (customInput.value || '').trim();
    if (!custom) { alert('Isi kolom "Label Manual" terlebih dahulu untuk label "Lainnya".'); if (onDone) onDone(false); return; }
    label = 'NG_' + custom.replace(/\s+/g, '_');
  }

  btnCaptureDataset.disabled = true;
  statusEl.className = 'small mt-2 text-muted';
  statusEl.innerText = 'Menyimpan sample...';

  callApi('apiSaveDatasetImage', [base64, label, CURRENT_SESSION]).then(function (res) {
    btnCaptureDataset.disabled = false;
    if (res.success) {
      datasetCaptureCount++;
      statusEl.className = 'small mt-2 text-success';
      statusEl.innerText = 'Tersimpan sebagai "' + res.label + '".';
      document.getElementById('datasetCaptureCounter').innerText =
        'Total sample diambil sesi ini: ' + datasetCaptureCount + ' (tersimpan di Drive/Dataset/' + res.label + '/).';
      if (onDone) onDone(true);
    } else {
      statusEl.className = 'small mt-2 text-danger';
      statusEl.innerText = 'Gagal menyimpan: ' + res.error;
      if (onDone) onDone(false);
    }
  }).catch(function (err) {
    btnCaptureDataset.disabled = false;
    statusEl.className = 'small mt-2 text-danger';
    statusEl.innerText = 'Gagal menyimpan: ' + err.message;
    if (onDone) onDone(false);
  });
}

/**
 * Mematikan kamera secara eksplisit: hentikan semua track stream (lampu
 * indikator kamera fisik ikut padam) dan lepas video.srcObject. Sebelumnya
 * tidak ada cara mematikan kamera selain pindah sumber/resolusi atau
 * menutup tab browser - kamera bisa tetap menyala di belakang layar walau
 * pengguna sudah pindah ke menu lain.
 */
function stopCamera() {
  if (frozenFrameBase64) { resumeLiveView(); } // kembalikan UI ke tampilan live dulu sebelum kamera dimatikan
  if (continuousInterval) { toggleContinuousMonitoring(); } // hentikan juga continuous monitoring jika aktif
  if (typeof stopAuxiliaryLoops === 'function') stopAuxiliaryLoops();
  if (currentStream) {
    currentStream.getTracks().forEach(function (t) { t.stop(); });
    currentStream = null;
  }
  const video = document.getElementById('cameraPreview');
  if (video) video.srcObject = null;

  const btnStop = document.getElementById('btnStopCamera');
  if (btnStop) { btnStop.innerText = 'Nyalakan Kamera'; btnStop.classList.replace('btn-outline-danger', 'btn-outline-success'); }
  const statusText = document.getElementById('cameraStatusText');
  if (statusText) statusText.innerText = 'Kamera dimatikan. Klik "Nyalakan Kamera" untuk mengaktifkan lagi.';
  const infoBadge = document.getElementById('cameraInfoBadge');
  if (infoBadge) infoBadge.innerText = '-- FPS · -- x --';
}

/**
 * Enumerasi device kamera yang tersedia (webcam PC / kamera smartphone
 * jika diakses dari browser mobile - environment.facingMode 'environment').
 */
function populateCameraList() {
  navigator.mediaDevices.enumerateDevices().then(function (devices) {
    const select = document.getElementById('cameraSourceSelect');
    select.innerHTML = '';
    const videoInputs = devices.filter(function (d) { return d.kind === 'videoinput'; });
    videoInputs.forEach(function (d, idx) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.text = d.label || ('Kamera ' + (idx + 1));
      select.appendChild(opt);
    });
    startSelectedCamera();
  });
}

function startSelectedCamera() {
  const deviceId = document.getElementById('cameraSourceSelect').value;
  const [w, h] = document.getElementById('resolutionSelect').value.split('x').map(Number);

  const constraints = {
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: w },
      height: { ideal: h },
      facingMode: deviceId ? undefined : { ideal: 'environment' } // fallback kamera belakang HP
    },
    audio: false
  };

  if (currentStream) {
    currentStream.getTracks().forEach(function (t) { t.stop(); });
  }

  navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
    currentStream = stream;
    const video = document.getElementById('cameraPreview');
    video.muted = true; // wajib agar autoplay tidak diblokir browser
    video.srcObject = stream;
    // Beberapa browser tetap butuh play() eksplisit walau ada atribut autoplay/muted di HTML.
    video.play().catch(function (playErr) { console.warn('video.play() gagal:', playErr); });

    const overlay = document.getElementById('cameraOverlay');
    overlay.width = w;
    overlay.height = h;

    if (typeof applyCameraAdjustments === 'function') applyCameraAdjustments(); // pastikan filter Exposure/Brightness/Contrast tetap terpasang
    if (typeof redrawGridOverlay === 'function') redrawGridOverlay(); // gambar ulang grid sesuai resolusi baru
    if (typeof startAuxiliaryLoops === 'function') startAuxiliaryLoops(); // mulai/lanjutkan histogram + indikator FPS

    const btnStop = document.getElementById('btnStopCamera');
    if (btnStop) { btnStop.innerText = 'Matikan Kamera'; btnStop.classList.replace('btn-outline-success', 'btn-outline-danger'); }
    const statusText = document.getElementById('cameraStatusText');
    if (statusText) statusText.innerText = 'Kamera aktif.';
  }).catch(function (err) {
    alert('Gagal mengakses kamera: ' + err.message);
  });
}

function captureSingleShot() {
  const video = document.getElementById('cameraPreview');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  // Terapkan filter Exposure/Brightness/Contrast yang sama seperti di
  // preview, supaya hasil capture konsisten dengan yang terlihat di layar
  // (sebelumnya capture selalu mengambil gambar mentah kamera, mengabaikan
  // pengaturan slider walau slider-nya sudah digeser).
  ctx.filter = buildCameraFilterString(_getCameraAdjustValues());
  ctx.drawImage(video, 0, 0);
  const base64 = canvas.toDataURL('image/jpeg', 0.9);
  return base64;
}

let continuousInterval = null;
function toggleContinuousMonitoring() {
  const btn = document.getElementById('btnContinuous');
  if (continuousInterval) {
    clearInterval(continuousInterval);
    continuousInterval = null;
    btn.innerText = 'Continuous Monitoring';
  } else {
    continuousInterval = setInterval(function () {
      const img = captureSingleShot();
      // Di Run Mode, gambar ini akan diproses via runInspectionCycle(img)
    }, 1000);
    btn.innerText = 'Stop Monitoring';
  }
}

/* ==================================================================
   DIGITAL ZOOM
   Slider 100-300% men-scale #cameraZoomWrapper (berisi video + canvas
   overlay + gambar referensi/frozen sebagai satu kesatuan) via CSS
   transform, sehingga grid/referensi ikut ter-zoom secara konsisten
   dengan video, bukan cuma videonya saja yang membesar.
   ================================================================== */
function initDigitalZoom() {
  const zoomRange = document.getElementById('zoomRange');
  const zoomValue = document.getElementById('zoomValue');
  const wrapper = document.getElementById('cameraZoomWrapper');
  if (!zoomRange) return;

  zoomRange.addEventListener('input', function () {
    const pct = parseInt(zoomRange.value, 10);
    zoomValue.innerText = pct + '%';
    wrapper.style.transform = 'scale(' + (pct / 100) + ')';
  });
}

/* ==================================================================
   GRID OVERLAY & CROSSHAIR
   Bantuan visual untuk memposisikan part secara konsisten setiap kali
   diletakkan di bawah kamera (repeatability), digambar di atas canvas
   #cameraOverlay yang sudah ada (sebelumnya canvas ini tidak pernah
   dipakai sama sekali di Camera Center).
   ================================================================== */
function initGridOverlay() {
  const toggle = document.getElementById('gridOverlayToggle');
  if (!toggle) return;
  toggle.addEventListener('change', redrawGridOverlay);
}

function redrawGridOverlay() {
  const overlay = document.getElementById('cameraOverlay');
  if (!overlay) return;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  const toggle = document.getElementById('gridOverlayToggle');
  if (!toggle || !toggle.checked) return;

  const w = overlay.width, h = overlay.height;
  ctx.strokeStyle = 'rgba(0,255,0,0.5)';
  ctx.lineWidth = 1;

  // Garis grid 3x3 (rule-of-thirds, memudahkan memposisikan part di tengah/sepertiga)
  for (let i = 1; i <= 2; i++) {
    const x = (w / 3) * i;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    const y = (h / 3) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Crosshair di tengah-tengah
  ctx.strokeStyle = 'rgba(255,0,0,0.7)';
  ctx.lineWidth = 1.5;
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.04;
  ctx.beginPath(); ctx.moveTo(cx - r * 2, cy); ctx.lineTo(cx + r * 2, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy - r * 2); ctx.lineTo(cx, cy + r * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
}

/* ==================================================================
   GAMBAR REFERENSI (master image overlay untuk cek alignment part)
   Simpan 1 frame sebagai "referensi", lalu tampilkan menimpa video
   dengan mix-blend-mode:difference (lihat css/style.css) - area yang
   HITAM berarti sama persis dengan referensi (part sejajar), area
   berwarna terang berarti ada pergeseran posisi dari referensi.
   ================================================================== */
function initReferenceImage() {
  const btnSave = document.getElementById('btnSaveReference');
  const btnClear = document.getElementById('btnClearReference');
  const toggle = document.getElementById('referenceGhostToggle');
  if (!btnSave) return;

  btnSave.onclick = function () {
    if (!currentStream) { alert('Kamera sedang mati. Klik "Nyalakan Kamera" terlebih dahulu.'); return; }
    const base64 = frozenFrameBase64 || captureSingleShot();
    document.getElementById('referenceGhostImg').src = base64;
    toggle.disabled = false;
    btnClear.disabled = false;
    toggle.checked = true;
    updateReferenceVisibility();
  };

  btnClear.onclick = function () {
    document.getElementById('referenceGhostImg').src = '';
    document.getElementById('referenceGhostImg').classList.add('d-none');
    toggle.checked = false;
    toggle.disabled = true;
    btnClear.disabled = true;
  };

  toggle.addEventListener('change', updateReferenceVisibility);
}

function updateReferenceVisibility() {
  const toggle = document.getElementById('referenceGhostToggle');
  const img = document.getElementById('referenceGhostImg');
  img.classList.toggle('d-none', !toggle.checked);
}

/* ==================================================================
   INDIKATOR FPS + RESOLUSI, DAN HISTOGRAM KECERAHAN LIVE
   Sebelumnya tidak ada indikator performa/kualitas gambar sama sekali.
   FPS dihitung pakai requestVideoFrameCallback (didukung Chrome/Edge -
   browser yang sama yang dipakai untuk fitur lain di aplikasi ini);
   kalau browser tidak mendukung, FPS ditampilkan "-" tapi resolusi tetap
   tampil. Histogram dihitung dari sampel kecil (down-scaled) frame video
   supaya ringan, diperbarui ~4x/detik.
   ================================================================== */
let _fpsFrameCount = 0;
let _fpsLastUpdate = 0;
let _fpsLoopActive = false;
let _histogramIntervalId = null;

function startAuxiliaryLoops() {
  stopAuxiliaryLoops(); // pastikan tidak dobel kalau dipanggil berkali-kali (ganti sumber/resolusi kamera)
  _fpsLoopActive = true;
  _fpsFrameCount = 0;
  _fpsLastUpdate = 0;

  const video = document.getElementById('cameraPreview');
  if ('requestVideoFrameCallback' in video) {
    video.requestVideoFrameCallback(_onVideoFrame);
  } else {
    updateCameraInfoBadge('-'); // browser tidak mendukung penghitungan FPS presisi
  }

  _histogramIntervalId = setInterval(drawHistogram, 250);
}

function stopAuxiliaryLoops() {
  _fpsLoopActive = false;
  if (_histogramIntervalId) { clearInterval(_histogramIntervalId); _histogramIntervalId = null; }
}

function _onVideoFrame(now, metadata) {
  if (!_fpsLoopActive) return;
  _fpsFrameCount++;
  if (!_fpsLastUpdate) _fpsLastUpdate = now;
  if (now - _fpsLastUpdate >= 1000) {
    updateCameraInfoBadge(Math.round(_fpsFrameCount * 1000 / (now - _fpsLastUpdate)));
    _fpsFrameCount = 0;
    _fpsLastUpdate = now;
  }
  const video = document.getElementById('cameraPreview');
  if (_fpsLoopActive && video) video.requestVideoFrameCallback(_onVideoFrame);
}

function updateCameraInfoBadge(fpsText) {
  const video = document.getElementById('cameraPreview');
  const badge = document.getElementById('cameraInfoBadge');
  if (!badge || !video) return;
  const w = video.videoWidth || 0, h = video.videoHeight || 0;
  badge.innerText = fpsText + ' FPS · ' + w + ' x ' + h;
}

function drawHistogram() {
  if (!currentStream) return;
  const video = document.getElementById('cameraPreview');
  if (!video.videoWidth) return;

  // Downscale ke ukuran kecil supaya perhitungan histogram ringan (tidak
  // perlu resolusi penuh untuk mendapat gambaran distribusi kecerahan).
  const sampleW = 160, sampleH = 90;
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = sampleW; sampleCanvas.height = sampleH;
  const sctx = sampleCanvas.getContext('2d');
  sctx.filter = buildCameraFilterString(_getCameraAdjustValues()); // ikutkan penyesuaian Exposure/Brightness/Contrast
  sctx.drawImage(video, 0, 0, sampleW, sampleH);

  let pixels;
  try {
    pixels = sctx.getImageData(0, 0, sampleW, sampleH).data;
  } catch (e) {
    return; // beberapa browser bisa melempar error keamanan di kondisi tertentu - abaikan saja, coba lagi interval berikutnya
  }

  const bins = new Array(32).fill(0); // 32 bin dari 0-255
  for (let i = 0; i < pixels.length; i += 4) {
    const luminance = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    bins[Math.min(31, Math.floor(luminance / 8))]++;
  }
  const maxBin = Math.max.apply(null, bins) || 1;

  const histCanvas = document.getElementById('histogramCanvas');
  const hctx = histCanvas.getContext('2d');
  const hw = histCanvas.width, hh = histCanvas.height;
  hctx.clearRect(0, 0, hw, hh);
  const barWidth = hw / bins.length;
  bins.forEach(function (count, i) {
    const barHeight = (count / maxBin) * (hh - 4);
    hctx.fillStyle = i < 4 ? '#FF5252' : (i > 27 ? '#FF5252' : '#00e676'); // merah = area gelap/terang ekstrem
    hctx.fillRect(i * barWidth, hh - barHeight, barWidth - 1, barHeight);
  });
}
