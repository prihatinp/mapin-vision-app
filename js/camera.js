/* ==================================================================
   MAP-IN Vision V1.0 - camera.js
   Akses Webcam PC & Kamera Smartphone via browser (WebRTC getUserMedia)
   ================================================================== */

let currentStream = null;

function initCameraCenter() {
  populateCameraList();
  document.getElementById('btnCapture').addEventListener('click', captureSingleShot);
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

  initDatasetCapture();
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
    if (!currentStream) {
      alert('Kamera sedang mati. Klik "Nyalakan Kamera" terlebih dahulu.');
      return;
    }
    let label = labelSelect.value;
    if (label === 'NG_lainnya') {
      const custom = (customInput.value || '').trim();
      if (!custom) { alert('Isi kolom "Label Manual" terlebih dahulu untuk label "Lainnya".'); return; }
      label = 'NG_' + custom.replace(/\s+/g, '_');
    }

    const base64 = captureSingleShot();
    const statusEl = document.getElementById('datasetCaptureStatus');
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
      } else {
        statusEl.className = 'small mt-2 text-danger';
        statusEl.innerText = 'Gagal menyimpan: ' + res.error;
      }
    }).catch(function (err) {
      btnCaptureDataset.disabled = false;
      statusEl.className = 'small mt-2 text-danger';
      statusEl.innerText = 'Gagal menyimpan: ' + err.message;
    });
  };
}

/**
 * Mematikan kamera secara eksplisit: hentikan semua track stream (lampu
 * indikator kamera fisik ikut padam) dan lepas video.srcObject. Sebelumnya
 * tidak ada cara mematikan kamera selain pindah sumber/resolusi atau
 * menutup tab browser - kamera bisa tetap menyala di belakang layar walau
 * pengguna sudah pindah ke menu lain.
 */
function stopCamera() {
  if (continuousInterval) { toggleContinuousMonitoring(); } // hentikan juga continuous monitoring jika aktif
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
  canvas.getContext('2d').drawImage(video, 0, 0);
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
