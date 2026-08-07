/* ==================================================================
   MAP-IN Vision V1.0 - calibration.js
   Wizard Kalibrasi Checkerboard (pixel -> mm), disimpan per recipe
   (PRD Section 19.2 & Section 23.1: media kalibrasi = checkerboard,
   scope = scale factor px/mm tanpa homography/perspective correction).
   ================================================================== */

const Calibration = {
  lastCapturedCanvas: null,
  lastComputedScaleFactor: null,

  init: function () {
    document.getElementById('btnCalibCapture').addEventListener('click', Calibration.captureFrame);
    document.getElementById('btnCalibDetect').addEventListener('click', Calibration.detectAndCompute);
    document.getElementById('btnCalibSave').addEventListener('click', Calibration.saveToRecipe);
  },

  captureFrame: function () {
    const previewVideo = document.getElementById('runVideo') || document.getElementById('cameraPreview');
    if (!previewVideo || !previewVideo.videoWidth) {
      alert('Tidak ada preview kamera aktif. Buka Camera Center atau Run Mode terlebih dahulu untuk mengaktifkan kamera.');
      return;
    }
    const canvas = document.getElementById('calibCanvas');
    canvas.width = previewVideo.videoWidth;
    canvas.height = previewVideo.videoHeight;
    canvas.getContext('2d').drawImage(previewVideo, 0, 0);
    Calibration.lastCapturedCanvas = canvas;
    document.getElementById('calibResult').innerHTML = '<span class="text-muted">Frame diambil. Klik "Deteksi & Hitung".</span>';
    document.getElementById('btnCalibSave').disabled = true;
  },

  /**
   * Deteksi sudut checkerboard memakai cv.findChessboardCorners, lalu
   * hitung rata-rata jarak piksel antar sudut yang berdekatan secara
   * horizontal, dibagi ukuran kotak (mm) untuk mendapatkan scale factor
   * px/mm. Ini SESUAI scope trial v1.0 (PRD 23.1): scale factor sederhana,
   * belum termasuk koreksi perspektif/homography penuh.
   */
  detectAndCompute: function () {
    if (!Calibration.lastCapturedCanvas) { alert('Capture frame terlebih dahulu.'); return; }
    if (typeof cv === 'undefined' || !cv.findChessboardCorners) {
      alert('OpenCV.js belum selesai dimuat, coba beberapa detik lagi.');
      return;
    }

    const cols = parseInt(document.getElementById('calibCols').value, 10);
    const rows = parseInt(document.getElementById('calibRows').value, 10);
    const squareMm = parseFloat(document.getElementById('calibSquareMm').value);

    const src = cv.imread(Calibration.lastCapturedCanvas);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    const patternSize = new cv.Size(cols - 1, rows - 1); // findChessboardCorners pakai jumlah sudut INTERNAL
    const corners = new cv.Mat();
    const found = cv.findChessboardCorners(gray, patternSize, corners,
      cv.CALIB_CB_ADAPTIVE_THRESH + cv.CALIB_CB_NORMALIZE_IMAGE);

    if (!found) {
      document.getElementById('calibResult').innerHTML =
        '<span class="text-danger">Papan catur tidak terdeteksi. Pastikan pencahayaan cukup, papan rata & terlihat penuh, dan jumlah kotak kolom/baris sesuai papan fisik yang dipakai.</span>';
      src.delete(); gray.delete(); corners.delete();
      return;
    }

    // corners: Nx1x2, row-major mengikuti patternSize (cols-1) x (rows-1)
    const numCornerCols = cols - 1;
    const numCornerRows = rows - 1;
    const points = [];
    for (let i = 0; i < corners.rows; i++) {
      points.push({ x: corners.data32F[i * 2], y: corners.data32F[i * 2 + 1] });
    }

    let totalDist = 0, count = 0;
    for (let r = 0; r < numCornerRows; r++) {
      for (let c = 0; c < numCornerCols - 1; c++) {
        const p1 = points[r * numCornerCols + c];
        const p2 = points[r * numCornerCols + c + 1];
        totalDist += Math.hypot(p2.x - p1.x, p2.y - p1.y);
        count++;
      }
    }
    const avgDistPx = totalDist / count;
    const scaleFactorPxPerMm = avgDistPx / squareMm;

    Calibration.lastComputedScaleFactor = scaleFactorPxPerMm;

    // Gambar overlay titik-titik yang terdeteksi untuk verifikasi visual
    const ctx = Calibration.lastCapturedCanvas.getContext('2d');
    ctx.drawImage(Calibration.lastCapturedCanvas, 0, 0); // no-op refresh
    points.forEach(function (p) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
      ctx.fillStyle = '#00C853';
      ctx.fill();
    });

    document.getElementById('calibResult').innerHTML =
      '<span class="text-success">Checkerboard terdeteksi (' + points.length + ' sudut). ' +
      'Rata-rata jarak antar sudut: ' + avgDistPx.toFixed(2) + ' px = ' + squareMm + ' mm.<br>' +
      '<strong>Scale factor: ' + scaleFactorPxPerMm.toFixed(3) + ' px/mm</strong></span>';
    document.getElementById('btnCalibSave').disabled = false;

    src.delete(); gray.delete(); corners.delete();
  },

  saveToRecipe: function () {
    if (!Calibration.lastComputedScaleFactor) return;
    const recipe = window.EDITING_RECIPE;
    if (!recipe || !recipe.id) {
      alert('Simpan recipe terlebih dahulu (klik tombol Simpan Recipe) sebelum menyimpan kalibrasi, karena kalibrasi tersimpan per recipe.');
      return;
    }

    const calibrationData = {
      scaleFactorPxPerMm: Calibration.lastComputedScaleFactor,
      referenceType: 'checkerboard',
      capturedAt: new Date().toISOString()
    };

    callApi('apiSaveCalibration', [recipe.id, calibrationData, CURRENT_SESSION]).then(function (res) {
      if (res.success) {
        // Mutasi in-place (bukan ganti reference) agar closure `recipe` di
        // roiEditor.js tetap konsisten dengan window.EDITING_RECIPE.
        Object.assign(recipe, res.recipe);
        window.EDITING_RECIPE = recipe;
        document.getElementById('calibrationStatus').innerHTML =
          '<span class="text-success">Terkalibrasi: ' + Calibration.lastComputedScaleFactor.toFixed(3) + ' px/mm</span>';
        alert('Kalibrasi berhasil disimpan ke recipe.');
        const modalEl = document.getElementById('calibrationModal');
        bootstrap.Modal.getInstance(modalEl).hide();
      } else {
        alert('Gagal menyimpan kalibrasi: ' + res.error);
      }
    }).catch(function (err) {
      alert('Gagal menyimpan kalibrasi: ' + err.message);
    });
  }
};

document.addEventListener('DOMContentLoaded', Calibration.init);
