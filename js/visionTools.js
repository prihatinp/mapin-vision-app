/* ==================================================================
   MAP-IN Vision V1.0 - visionTools.js
   Module 5: Vision Tools Engine (client-side, memakai OpenCV.js)
   ==================================================================
   Setiap fungsi menerima ImageData (dari ROI crop) dan parameter
   tool, mengembalikan { rawScore } atau { rawText } yang akan dikirim
   ke server (VisionToolsEngine.gs) untuk divalidasi terhadap
   threshold resmi recipe.
   ================================================================== */

const VisionTools = {

  /**
   * Crop area ROI (polygon) dari canvas sumber -> canvas baru.
   */
  cropRoi: function (sourceCanvas, roi) {
    const xs = roi.points.map(function (p) { return p.x; });
    const ys = roi.points.map(function (p) { return p.y; });
    const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = maxX - minX;
    cropCanvas.height = maxY - minY;
    const ctx = cropCanvas.getContext('2d');

    // Mask polygon agar area di luar ROI tidak ikut terhitung
    ctx.save();
    ctx.beginPath();
    roi.points.forEach(function (p, i) {
      const x = p.x - minX, y = p.y - minY;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(sourceCanvas, minX, minY, cropCanvas.width, cropCanvas.height, 0, 0, cropCanvas.width, cropCanvas.height);
    ctx.restore();

    return cropCanvas;
  },

  /**
   * 1. PATTERN MATCHING - Template Matching (OpenCV.js matchTemplate)
   *    Mengembalikan similarity score 0..1. templateCanvas didapat dari
   *    TemplateCache (template referensi yang diambil Engineer di ROI
   *    Editor lewat tombol "Ambil Template dari ROI", lihat roiEditor.js).
   */
  patternMatch: function (roiCanvas, templateCanvas) {
    if (!templateCanvas) return { rawScore: 0 }; // tidak ada template -> otomatis dianggap tidak match (fail-safe)

    const src = cv.imread(roiCanvas);
    const templ = cv.imread(templateCanvas);
    const dst = new cv.Mat();
    const mask = new cv.Mat();

    // Guard: template tidak boleh lebih besar dari ROI (syarat matchTemplate OpenCV)
    if (templ.cols > src.cols || templ.rows > src.rows) {
      src.delete(); templ.delete(); dst.delete(); mask.delete();
      return { rawScore: 0 };
    }

    cv.matchTemplate(src, templ, dst, cv.TM_CCOEFF_NORMED, mask);
    const result = cv.minMaxLoc(dst);
    const score = result.maxVal; // 0..1

    src.delete(); templ.delete(); dst.delete(); mask.delete();
    return { rawScore: score };
  },

  /**
   * 2. BLOB / DEFECT AREA - threshold gelap/terang lalu hitung luas
   *    kontur terbesar, dikonversi ke mm^2 memakai scaleFactor kalibrasi.
   */
  blobDefectArea: function (roiCanvas, scaleFactorPxPerMm) {
    const src = cv.imread(roiCanvas);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    const thresh = new cv.Mat();
    cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let maxAreaPx = 0;
    let maxContourIdx = -1;
    for (let i = 0; i < contours.size(); i++) {
      const area = cv.contourArea(contours.get(i));
      if (area > maxAreaPx) { maxAreaPx = area; maxContourIdx = i; }
    }

    // Bounding box kontur cacat terbesar (dalam piksel ROI) - dipakai
    // drawNgOverlayForResults() di Run Mode untuk menggambar kotak merah
    // TEPAT di lokasi penyebab NG (gaya Keyence IV/VS Series), bukan cuma
    // menandai seluruh ROI.
    let bboxPx = null;
    if (maxContourIdx >= 0) {
      const rect = cv.boundingRect(contours.get(maxContourIdx));
      bboxPx = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }

    const scale = scaleFactorPxPerMm || 1;
    const areaMm2 = maxAreaPx / (scale * scale);

    src.delete(); gray.delete(); thresh.delete(); contours.delete(); hierarchy.delete();
    return { rawScore: areaMm2, bboxPx: bboxPx };
  },

  /**
   * 3. EDGE / DIMENSION - deteksi tepi (Canny) lalu ukur jarak antar
   *    titik ekstrem pada sumbu tertentu, konversi ke mm.
   */
  edgeDimension: function (roiCanvas, scaleFactorPxPerMm, axis) {
    const src = cv.imread(roiCanvas);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const edges = new cv.Mat();
    cv.Canny(gray, edges, 50, 150);

    let minVal = null, maxVal = null;
    for (let y = 0; y < edges.rows; y++) {
      for (let x = 0; x < edges.cols; x++) {
        if (edges.ucharPtr(y, x)[0] > 0) {
          const val = axis === 'y' ? y : x;
          if (minVal === null || val < minVal) minVal = val;
          if (maxVal === null || val > maxVal) maxVal = val;
        }
      }
    }

    const distancePx = (maxVal !== null && minVal !== null) ? (maxVal - minVal) : 0;
    const scale = scaleFactorPxPerMm || 1;
    const distanceMm = distancePx / scale;

    src.delete(); gray.delete(); edges.delete();
    // edgeMinPx/edgeMaxPx/axis dipakai drawNgOverlayForResults() untuk
    // menggambar garis merah tepat di tepi yang di luar toleransi.
    return { rawScore: distanceMm, edgeMinPx: minVal || 0, edgeMaxPx: maxVal || 0, axis: axis || 'x' };
  },

  /**
   * 4. PRESENCE / ABSENCE - deteksi ada/tidaknya fitur berdasarkan
   *    perbandingan jumlah piksel non-background terhadap threshold.
   */
  presenceAbsence: function (roiCanvas, pixelThresholdPct) {
    const src = cv.imread(roiCanvas);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const thresh = new cv.Mat();
    cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

    const nonZero = cv.countNonZero(thresh);
    const totalPx = thresh.rows * thresh.cols;
    const pct = (nonZero / totalPx) * 100;
    const present = pct >= (pixelThresholdPct || 5) ? 1 : 0;

    src.delete(); gray.delete(); thresh.delete();
    return { rawScore: present };
  },

  /**
   * 5. COLOR / INTENSITY CHECK - rata-rata nilai channel warna/gray
   */
  colorInspection: function (roiCanvas) {
    const src = cv.imread(roiCanvas);
    const meanVal = cv.mean(src); // [R,G,B,A]
    src.delete();
    const grayMean = (meanVal[0] + meanVal[1] + meanVal[2]) / 3;
    return { rawScore: grayMean };
  },

  /**
   * 6. QR READER (memakai jsQR - ringan, khusus format QR Code)
   */
  readQrCode: function (roiCanvas) {
    const ctx = roiCanvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, roiCanvas.width, roiCanvas.height);
    const result = jsQR(imageData.data, imageData.width, imageData.height);
    return { rawText: result ? result.data : '' };
  },

  /**
   * 7. BARCODE READER (memakai ZXing-js — mendukung format 1D seperti
   *    Code128, EAN-13/8, UPC-A/E, Code39, ITF, Codabar, DAN QR/DataMatrix).
   */
  readBarcode: async function (roiCanvas) {
    if (typeof ZXing === 'undefined') {
      console.warn('Pustaka ZXing belum termuat.');
      return { rawText: '' };
    }
    try {
      const reader = new ZXing.BrowserMultiFormatReader();
      const dataUrl = roiCanvas.toDataURL('image/png');
      const img = await new Promise(function (resolve, reject) {
        const el = new Image();
        el.onload = function () { resolve(el); };
        el.onerror = reject;
        el.src = dataUrl;
      });
      const result = await reader.decodeFromImageElement(img);
      return { rawText: result ? result.getText() : '' };
    } catch (err) {
      // ZXing melempar NotFoundException jika tidak ada barcode terbaca di gambar - ini normal, bukan error fatal
      return { rawText: '' };
    }
  },

  /**
   * 8. OCR (Optical Character Recognition) - memakai Tesseract.js.
   *    CATATAN PERFORMA: OCR jauh lebih lambat (bisa >1 detik per ROI)
   *    dibanding tool rule-based lain, sehingga bisa melanggar target
   *    cycle time PRD (<=200ms/part). Gunakan hanya jika benar-benar
   *    diperlukan.
   */
  readOcr: async function (roiCanvas) {
    if (typeof Tesseract === 'undefined') {
      console.warn('Pustaka Tesseract.js belum termuat.');
      return { rawText: '' };
    }
    try {
      const result = await Tesseract.recognize(roiCanvas, 'eng', { logger: function () {} });
      return { rawText: (result.data.text || '').trim() };
    } catch (err) {
      console.error('OCR gagal:', err);
      return { rawText: '' };
    }
  },

  /**
   * 9. COUNTING - menghitung jumlah objek/blob (bukan hanya area terbesar
   *    seperti tool Blob) di dalam ROI, untuk verifikasi kuantitas/
   *    kelengkapan (mis. jumlah baut, jumlah lubang, jumlah pin).
   */
  countingBlobs: function (roiCanvas, scaleFactorPxPerMm, minAreaMm2) {
    const src = cv.imread(roiCanvas);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const thresh = new cv.Mat();
    cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const scale = scaleFactorPxPerMm || 1;
    const minAreaPx = (minAreaMm2 || 0.5) * scale * scale;

    let count = 0;
    for (let i = 0; i < contours.size(); i++) {
      if (cv.contourArea(contours.get(i)) >= minAreaPx) count++;
    }

    src.delete(); gray.delete(); thresh.delete(); contours.delete(); hierarchy.delete();
    return { rawScore: count };
  },

  /**
   * 10. AI IMAGE CLASSIFICATION (ONNX classifier via onnxruntime-web).
   */
  aiClassification: async function (roiCanvas, session, classNames) {
    const inputSize = 224; // ukuran umum model klasifikasi (mis. MobileNet/ResNet)
    const pre = document.createElement('canvas');
    pre.width = inputSize; pre.height = inputSize;
    const pctx = pre.getContext('2d');
    pctx.drawImage(roiCanvas, 0, 0, inputSize, inputSize);
    const imgData = pctx.getImageData(0, 0, inputSize, inputSize).data;

    const floatData = new Float32Array(3 * inputSize * inputSize);
    for (let i = 0; i < inputSize * inputSize; i++) {
      floatData[i] = imgData[i * 4] / 255;
      floatData[inputSize * inputSize + i] = imgData[i * 4 + 1] / 255;
      floatData[2 * inputSize * inputSize + i] = imgData[i * 4 + 2] / 255;
    }

    const inputTensor = new ort.Tensor('float32', floatData, [1, 3, inputSize, inputSize]);
    const inputName = session.inputNames[0];
    const outputMap = await session.run({ [inputName]: inputTensor });
    const outputName = session.outputNames[0];
    const logits = Array.from(outputMap[outputName].data);

    // Softmax agar bisa dibaca sebagai probabilitas/confidence
    const maxLogit = Math.max.apply(null, logits);
    const exps = logits.map(function (v) { return Math.exp(v - maxLogit); });
    const sumExps = exps.reduce(function (a, b) { return a + b; }, 0);
    const probs = exps.map(function (v) { return v / sumExps; });

    let bestIdx = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[bestIdx]) bestIdx = i;

    return {
      predictedClass: (classNames && classNames[bestIdx]) || ('class_' + bestIdx),
      confidence: probs[bestIdx]
    };
  },

  /**
   * 11. AI OBJECT DETECTION (YOLOv8/v11 ONNX, via onnxruntime-web, CPU-only)
   */
  aiDetection: async function (roiCanvas, session, classNames, confidenceThresholdForNms) {
    const inputSize = 640;
    const pre = document.createElement('canvas');
    pre.width = inputSize; pre.height = inputSize;
    const pctx = pre.getContext('2d');
    pctx.drawImage(roiCanvas, 0, 0, inputSize, inputSize);
    const imgData = pctx.getImageData(0, 0, inputSize, inputSize).data;

    // HWC RGBA -> CHW RGB float32 normalized [0,1]
    const floatData = new Float32Array(3 * inputSize * inputSize);
    for (let i = 0; i < inputSize * inputSize; i++) {
      floatData[i] = imgData[i * 4] / 255;                                   // R
      floatData[inputSize * inputSize + i] = imgData[i * 4 + 1] / 255;       // G
      floatData[2 * inputSize * inputSize + i] = imgData[i * 4 + 2] / 255;   // B
    }

    const inputTensor = new ort.Tensor('float32', floatData, [1, 3, inputSize, inputSize]);
    const inputName = session.inputNames[0];
    const outputMap = await session.run({ [inputName]: inputTensor });
    const outputName = session.outputNames[0];
    const output = outputMap[outputName]; // shape [1, 4+numClasses, 8400]

    const numChannels = output.dims[1];
    const numBoxes = output.dims[2];
    const numClasses = numChannels - 4;
    const data = output.data;

    const candidates = [];
    const scaleX = roiCanvas.width / inputSize;
    const scaleY = roiCanvas.height / inputSize;

    for (let i = 0; i < numBoxes; i++) {
      let bestClass = -1, bestScore = 0;
      for (let c = 0; c < numClasses; c++) {
        const score = data[(4 + c) * numBoxes + i];
        if (score > bestScore) { bestScore = score; bestClass = c; }
      }
      if (bestScore < (confidenceThresholdForNms || 0.25)) continue;

      const cx = data[0 * numBoxes + i], cy = data[1 * numBoxes + i];
      const w = data[2 * numBoxes + i], h = data[3 * numBoxes + i];

      candidates.push({
        classId: bestClass,
        className: (classNames && classNames[bestClass]) || ('class_' + bestClass),
        confidence: bestScore,
        bbox: [(cx - w / 2) * scaleX, (cy - h / 2) * scaleY, w * scaleX, h * scaleY]
      });
    }

    return VisionTools._nonMaxSuppression(candidates, 0.45);
  },

  _nonMaxSuppression: function (boxes, iouThreshold) {
    boxes.sort(function (a, b) { return b.confidence - a.confidence; });
    const kept = [];
    boxes.forEach(function (box) {
      const overlaps = kept.some(function (k) { return VisionTools._iou(box.bbox, k.bbox) > iouThreshold; });
      if (!overlaps) kept.push(box);
    });
    return kept;
  },

  _iou: function (a, b) {
    const [ax, ay, aw, ah] = a, [bx, by, bw, bh] = b;
    const x1 = Math.max(ax, bx), y1 = Math.max(ay, by);
    const x2 = Math.min(ax + aw, bx + bw), y2 = Math.min(ay + ah, by + bh);
    const interArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const unionArea = aw * ah + bw * bh - interArea;
    return unionArea > 0 ? interArea / unionArea : 0;
  }
};

/* ==================================================================
   TEMPLATE CACHE - Pra-muat template referensi Pattern Match (base64
   PNG yang tersimpan di recipe.tools[].params.templateImageBase64)
   menjadi elemen <canvas> siap pakai, agar tidak perlu decode gambar
   berulang setiap siklus inspeksi.
   ================================================================== */
const TemplateCache = {
  cache: {}, // toolId -> canvas

  ensureLoaded: function (recipe) {
    const patternMatchTools = (recipe.tools || []).filter(function (t) {
      return t.type === 'PatternMatch' && t.params && t.params.templateImageBase64;
    });

    return Promise.all(patternMatchTools.map(function (tool) {
      return new Promise(function (resolve) {
        const img = new Image();
        img.onload = function () {
          const c = document.createElement('canvas');
          c.width = img.width; c.height = img.height;
          c.getContext('2d').drawImage(img, 0, 0);
          TemplateCache.cache[tool.id] = c;
          resolve();
        };
        img.onerror = function () { console.warn('Gagal memuat template untuk tool', tool.id); resolve(); };
        img.src = tool.params.templateImageBase64;
      });
    }));
  }
};

/* ==================================================================
   AI INFERENCE RUNTIME - Memuat model ONNX aktif via onnxruntime-web
   ================================================================== */
const AIInference = {
  /**
   * Slot per modelType ('detection' | 'classification') agar sebuah recipe
   * bisa memakai tool AIDetection DAN AIClassification sekaligus, masing-
   * masing dengan modelnya sendiri, dimuat & disimpan secara terpisah.
   */
  sessions: {
    detection: { session: null, classNames: [], loadedModelId: null },
    classification: { session: null, classNames: [], loadedModelId: null }
  },

  /**
   * Dipanggil sekali saat Run Mode dibuka untuk tiap modelType yang
   * dipakai oleh recipe aktif (dideteksi dari daftar tipe tool). Mengambil
   * model aktif dari server (base64), decode ke ArrayBuffer, lalu membuat
   * InferenceSession (CPU/wasm) dan menyimpannya di slot modelType terkait.
   */
  ensureLoaded: async function (modelType) {
    modelType = modelType || 'detection';
    const slot = AIInference.sessions[modelType];

    const activeRes = await callApi('apiGetActiveAiModel', [modelType, CURRENT_SESSION]).catch(function () { return { success: false }; });
    if (!activeRes.success || !activeRes.model) {
      return false; // tidak ada model aktif untuk tipe ini - tool terkait akan gagal graceful
    }
    const model = activeRes.model;
    if (slot.loadedModelId === model.id && slot.session) {
      return true;
    }

    const fileRes = await callApi('apiGetModelFileForInference', [model.id, CURRENT_SESSION]).catch(function () { return { success: false }; });
    if (!fileRes.success) return false;

    const binary = atob(fileRes.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    ort.env.wasm.numThreads = 1; // CPU-only, sesuai target hardware PRD 14.10
    slot.session = await ort.InferenceSession.create(bytes.buffer, { executionProviders: ['wasm'] });
    try { slot.classNames = JSON.parse(model.classes); } catch (e) { slot.classNames = []; }
    slot.loadedModelId = model.id;
    return true;
  }
};

/* ==================================================================
   RUN MODE - Orkestrasi Siklus Inspeksi Penuh (client-side)
   ================================================================== */
let runOkCount = 0, runNgCount = 0;
let runStream = null;
let pollIntervalId = null; // trigger EXTERNAL (polling status IO)
let runStaticTestImage = null; // canvas hasil upload foto dari device (dipakai kalau kamera tidak aktif)
let lastToolVisualData = {}; // data posisi ROI/bbox per tool - dipakai drawNgOverlayForResults()

function initRunMode() {
  // TIDAK auto-menyalakan kamera lagi - operator memilih sendiri "Nyalakan
  // Kamera (Live)" atau "Upload Foto dari Device", supaya Run Mode bisa
  // dipakai walau tidak ada kamera terpasang saat itu.
  runStaticTestImage = null;

  const resSelect = document.getElementById('runResolutionSelect');
  if (resSelect) resSelect.onchange = function () { if (runStream) startRunCamera(); }; // ganti resolusi hanya restart stream kalau kamera memang sedang live

  const btnRunStopCamera = document.getElementById('btnRunStopCamera');
  if (btnRunStopCamera) btnRunStopCamera.onclick = toggleRunCamera;

  initRunUploadImageControls();

  // Muat recipe yang sedang AKTIF (ditandai "Aktifkan" di Recipe Management) -
  // SEBELUMNYA Run Mode memakai window.ACTIVE_RECIPE_ID yang tidak pernah
  // diisi sama sekali di kode manapun, sehingga Run Mode selalu gagal
  // memuat recipe apapun (bug ini yang menyebabkan pertanyaan "ambil
  // program dari recipe yang mana?" - jawabannya dulu: TIDAK ADA/gagal).
  const nameEl = document.getElementById('runActiveRecipeName');
  if (nameEl) nameEl.innerText = 'Memuat...';
  callApi('apiGetActiveRecipe', [CURRENT_SESSION]).then(function (res) {
    if (!res.success) {
      if (nameEl) nameEl.innerText = 'Tidak ada recipe aktif';
      alert(res.error || 'Belum ada recipe yang diaktifkan.');
      return;
    }
    ACTIVE_RECIPE = res.recipe;
    if (nameEl) nameEl.innerText = ACTIVE_RECIPE.name + ' (v' + ACTIVE_RECIPE.version + ')';

    const hasDetectionTool = (ACTIVE_RECIPE.tools || []).some(function (t) { return t.type === 'AIDetection'; });
    const hasClassificationTool = (ACTIVE_RECIPE.tools || []).some(function (t) { return t.type === 'AIClassification'; });
    if (hasDetectionTool) {
      AIInference.ensureLoaded('detection').then(function (ok) {
        if (!ok) console.warn('Recipe memakai AI Object Detection tapi tidak ada model AI (detection) aktif / gagal dimuat.');
      });
    }
    if (hasClassificationTool) {
      AIInference.ensureLoaded('classification').then(function (ok) {
        if (!ok) console.warn('Recipe memakai AI Classification tapi tidak ada model AI (classification) aktif / gagal dimuat.');
      });
    }
    TemplateCache.ensureLoaded(ACTIVE_RECIPE);
    renderJudgeAdjustList();
  }).catch(function (err) {
    if (nameEl) nameEl.innerText = 'Gagal memuat recipe';
    console.warn('Gagal memuat recipe untuk Run Mode:', err.message);
  });

  document.getElementById('btnPause').onclick = function () {
    runPollingActive = !runPollingActive;
    this.innerText = runPollingActive ? 'Pause Trigger' : 'Resume Trigger';
  };
  document.getElementById('btnRecapture').onclick = function () { runInspectionCycle(true); };

  initTriggerModeControls();
  initJudgeAdjustPanel();

  runPollingActive = true;
  startSelectedTriggerLoop();
}

/**
 * Sumber gambar Run Mode ke-2: unggah foto dari file di komputer/HP,
 * dipakai kalau kamera fisik tidak tersedia/rusak saat itu. Mematikan
 * kamera live kalau sedang menyala (supaya jelas sumber mana yang aktif),
 * lalu menampilkan foto yang diunggah sebagai gambar siap-ukur - tombol
 * "Measure (Trigger 1x)" akan memakai foto ini, bukan frame kamera.
 */
function initRunUploadImageControls() {
  const btn = document.getElementById('btnRunUploadImage');
  const input = document.getElementById('runUploadImageInput');
  const statusEl = document.getElementById('runUploadImageStatus');
  if (!btn || !input) return;

  btn.onclick = function () { input.click(); };
  input.onchange = function (e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (statusEl) statusEl.innerText = 'Memuat foto...';

    // Matikan kamera live dulu kalau sedang menyala, supaya tidak ambigu
    // sumber gambar mana yang benar-benar dipakai saat Measure ditekan.
    if (runStream) {
      runStream.getTracks().forEach(function (t) { t.stop(); });
      runStream = null;
      document.getElementById('runVideo').srcObject = null;
      const stopBtn = document.getElementById('btnRunStopCamera');
      if (stopBtn) { stopBtn.innerText = 'Nyalakan Kamera (Live)'; stopBtn.classList.remove('btn-outline-danger'); stopBtn.classList.add('btn-outline-success'); }
    }

    const reader = new FileReader();
    reader.onload = function (ev) {
      const imgEl = new Image();
      imgEl.onload = function () {
        const tmp = document.createElement('canvas');
        tmp.width = imgEl.naturalWidth;
        tmp.height = imgEl.naturalHeight;
        tmp.getContext('2d').drawImage(imgEl, 0, 0);
        runStaticTestImage = tmp;

        document.getElementById('runVideo').classList.add('d-none');
        const previewImg = document.getElementById('runTestImagePreview');
        previewImg.src = ev.target.result;
        previewImg.classList.remove('d-none');
        document.getElementById('runCameraOffOverlay').classList.add('d-none');

        const badge = document.getElementById('runDecisionBadge');
        badge.innerText = 'READY';
        badge.className = 'run-decision-badge';

        if (statusEl) statusEl.innerText = 'Foto siap. Tekan "Measure (Trigger 1x)" untuk mengukur.';
      };
      imgEl.onerror = function () { if (statusEl) statusEl.innerText = 'Gagal membaca file gambar.'; };
      imgEl.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    input.value = '';
  };
}

/**
 * Nyalakan (atau nyalakan ULANG, kalau dipanggil karena ganti resolusi)
 * kamera Run Mode sesuai resolusi yang dipilih di dropdown
 * #runResolutionSelect - sebelumnya resolusi Run Mode selalu di-hardcode
 * 1280x720 dan tidak bisa diubah operator.
 */
function startRunCamera() {
  if (runStream) {
    runStream.getTracks().forEach(function (t) { t.stop(); });
    runStream = null;
  }
  // Kalau sebelumnya pakai foto upload, itu dibersihkan begitu kamera live dinyalakan.
  runStaticTestImage = null;
  const previewImg = document.getElementById('runTestImagePreview');
  if (previewImg) previewImg.classList.add('d-none');

  const resSelect = document.getElementById('runResolutionSelect');
  const resValue = (resSelect && resSelect.value) || '1280x720';
  const [w, h] = resValue.split('x').map(Number);

  navigator.mediaDevices.getUserMedia({ video: { width: { ideal: w }, height: { ideal: h } } }).then(function (stream) {
    runStream = stream;
    const runVideoEl = document.getElementById('runVideo');
    runVideoEl.muted = true; // wajib agar autoplay tidak diblokir browser
    runVideoEl.srcObject = stream;
    runVideoEl.classList.remove('d-none');
    runVideoEl.play().catch(function (playErr) { console.warn('video.play() gagal:', playErr); });
    document.getElementById('runCameraOffOverlay').classList.add('d-none');
    const btn = document.getElementById('btnRunStopCamera');
    if (btn) { btn.innerText = 'Matikan Kamera'; btn.classList.remove('btn-outline-success'); btn.classList.add('btn-outline-danger'); }

    runPollingActive = true;
    startSelectedTriggerLoop();
  }).catch(function (err) {
    alert('Gagal mengakses kamera untuk Run Mode: ' + err.message);
  });
}

/**
 * Tombol "Matikan Kamera" di Run Mode - SEBELUMNYA tidak ada cara mematikan
 * kamera sama sekali selain pindah menu (tombol "Pause" cuma menghentikan
 * TRIGGER inspeksi, kameranya sendiri tetap menyala terus). Sekarang kamera
 * betul-betul bisa dimatikan (lampu indikator kamera fisik ikut padam),
 * trigger juga otomatis di-pause supaya tidak coba capture dari kamera mati.
 */
function toggleRunCamera() {
  const btn = document.getElementById('btnRunStopCamera');
  const overlay = document.getElementById('runCameraOffOverlay');
  if (runStream) {
    runStream.getTracks().forEach(function (t) { t.stop(); });
    runStream = null;
    document.getElementById('runVideo').srcObject = null;
    document.getElementById('runVideo').classList.add('d-none');
    overlay.classList.remove('d-none');
    if (btn) { btn.innerText = 'Nyalakan Kamera (Live)'; btn.classList.remove('btn-outline-danger'); btn.classList.add('btn-outline-success'); }
    runPollingActive = false; // tidak ada gunanya trigger jalan kalau kamera mati
    stopTriggerLoops();
    const btnPause = document.getElementById('btnPause');
    if (btnPause) btnPause.innerText = 'Resume Trigger';
  } else {
    startRunCamera();
  }
}

/* ==================================================================
   MODE TRIGGER - hanya 2 mode, TIDAK ADA auto-repeat otomatis di mode
   manapun (permintaan eksplisit: operator selalu tahu persis kapan 1
   siklus pengukuran terjadi, tidak ada kejutan capture berulang):
   - INTERNAL: operator menekan tombol "Measure (Trigger 1x)" sendiri,
     1 klik = 1 kali ukur. Tidak ada timer sama sekali.
   - EXTERNAL: menunggu sinyal dari Arduino/ESP8266/PLC lewat status IO
     (polling ringan tiap 300ms ke apiGetIoStatusForUi). Trigger dideteksi
     dari TEPI naik (edge) status BUSY, jadi 1 sinyal fisik = 1 kali ukur,
     bukan berulang selama sinyal tertahan HIGH/BUSY.
   ================================================================== */
let runTriggerMode = 'external';
let externalIoWasBusy = false;

function initTriggerModeControls() {
  document.querySelectorAll('input[name="runTriggerMode"]').forEach(function (radio) {
    radio.onchange = function () {
      runTriggerMode = radio.value;
      document.getElementById('internalTriggerHint').classList.toggle('d-none', runTriggerMode !== 'internal');
      document.getElementById('externalTriggerHint').classList.toggle('d-none', runTriggerMode !== 'external');
      startSelectedTriggerLoop();
    };
  });
}

function startSelectedTriggerLoop() {
  stopTriggerLoops();
  if (runTriggerMode === 'external') startExternalTriggerLoop();
  // mode 'internal': sengaja tidak memulai loop apa pun - murni menunggu klik tombol Measure.
}

function stopTriggerLoops() {
  if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; }
  externalIoWasBusy = false;
}

/** Trigger EXTERNAL - menunggu sinyal Arduino/ESP8266/PLC (status IO = BUSY), 1x per tepi naik. */
function startExternalTriggerLoop() {
  externalIoWasBusy = false;
  pollIntervalId = setInterval(function () {
    if (!runPollingActive) return;
    callApi('apiGetIoStatusForUi', [CURRENT_SESSION]).then(function (status) {
      const isBusy = status.status === 'BUSY';
      if (isBusy && !externalIoWasBusy) {
        runInspectionCycle(); // tepi naik terdeteksi -> 1 kali ukur
      }
      externalIoWasBusy = isBusy;
    }).catch(function () { /* biarkan polling berikutnya coba lagi */ });
  }, 300); // simulasi WebSocket via polling ringan
}

/**
 * Mematikan kamera & polling Run Mode secara eksplisit - dipanggil saat
 * pengguna pindah ke menu lain (lihat showView() di app.js) agar kamera
 * tidak tetap menyala dan polling tidak tetap berjalan di belakang layar.
 */
function stopRunMode() {
  runPollingActive = false;
  stopTriggerLoops();
  if (runStream) {
    runStream.getTracks().forEach(function (t) { t.stop(); });
    runStream = null;
  }
  const runVideoEl = document.getElementById('runVideo');
  if (runVideoEl) runVideoEl.srcObject = null;
  runStaticTestImage = null;
}

/* ==================================================================
   ADJUSTING JUDGE OK/NG (live threshold tuning, ala Keyence VS Series)
   Menampilkan parameter utama tiap tool di recipe aktif supaya bisa
   di-fine-tune langsung dari Run Mode tanpa perlu bolak-balik ke ROI
   Editor. "Terapkan" = berlaku langsung (in-memory) utk siklus berikutnya;
   "Simpan ke Recipe" = dipersist ke server lewat apiSaveRecipe.
   ================================================================== */
function initJudgeAdjustPanel() {
  const btnToggle = document.getElementById('btnToggleJudgeAdjust');
  const panel = document.getElementById('judgeAdjustPanel');
  // Panel ditampilkan TERBUKA secara default (bukan disembunyikan) supaya
  // operator langsung melihat & bisa fine-tune threshold tanpa perlu klik
  // "Buka" dulu setiap kali membuka Run Mode.
  if (btnToggle) {
    btnToggle.onclick = function () {
      const nowHidden = panel.classList.toggle('d-none');
      btnToggle.innerText = nowHidden ? 'Buka' : 'Tutup';
      if (!nowHidden) renderJudgeAdjustList();
    };
  }
  const btnApply = document.getElementById('btnApplyJudgeAdjust');
  if (btnApply) btnApply.onclick = applyJudgeAdjustments;

  const btnSave = document.getElementById('btnSaveJudgeAdjust');
  if (btnSave) {
    btnSave.onclick = function () {
      applyJudgeAdjustments();
      if (!ACTIVE_RECIPE) return;
      btnSave.disabled = true;
      callApi('apiSaveRecipe', [ACTIVE_RECIPE, CURRENT_SESSION]).then(function (res) {
        btnSave.disabled = false;
        if (res.success) {
          Object.assign(ACTIVE_RECIPE, res.recipe);
          alert('Perubahan parameter judge berhasil disimpan ke recipe "' + ACTIVE_RECIPE.name + '".');
        } else {
          alert('Gagal menyimpan: ' + res.error);
        }
      }).catch(function (err) {
        btnSave.disabled = false;
        alert('Gagal menyimpan: ' + err.message);
      });
    };
  }
}

/** Daftar field parameter utama yang bisa di-adjust per tipe tool (input id -> params key). */
function _judgeAdjustFieldsForType(type) {
  switch (type) {
    case 'PatternMatch': return [{ key: 'threshold', label: 'Threshold Similarity (0-1)', step: 0.01, min: 0, max: 1 }];
    case 'Blob': return [{ key: 'minAreaMm2', label: 'Min Area Defect (mm²)', step: 0.01, min: 0, max: 50 }];
    case 'EdgeDimension': return [{ key: 'toleranceMm', label: 'Toleransi (mm)', step: 0.01, min: 0, max: 10 }, { key: 'nominalMm', label: 'Nominal (mm)', step: 0.01, min: 0, max: 200 }];
    case 'Presence': return [{ key: 'pixelThresholdPct', label: 'Threshold Piksel (%)', step: 0.1, min: 0, max: 100 }];
    case 'Color': return [{ key: 'threshold', label: 'Toleransi (+/-)', step: 1, min: 0, max: 100 }, { key: 'targetMean', label: 'Target Mean (0-255)', step: 1, min: 0, max: 255 }];
    case 'Counting': return [{ key: 'expectedMin', label: 'Jumlah Minimum', step: 1, min: 0, max: 100 }, { key: 'expectedMax', label: 'Jumlah Maksimum', step: 1, min: 0, max: 100 }];
    case 'AIClassification': return [{ key: 'confidenceThreshold', label: 'Confidence Threshold (0-1)', step: 0.01, min: 0, max: 1 }];
    case 'AIDetection': return [{ key: 'confidenceThreshold', label: 'Confidence Threshold (0-1)', step: 0.01, min: 0, max: 1 }];
    default: return []; // QR/Barcode/OCR: berbasis rule teks, bukan angka - tidak ada quick-adjust di sini
  }
}

function renderJudgeAdjustList() {
  const listEl = document.getElementById('judgeAdjustList');
  if (!listEl || !ACTIVE_RECIPE) return;
  listEl.innerHTML = '';

  const tools = ACTIVE_RECIPE.tools || [];
  if (!tools.length) { listEl.innerHTML = '<p class="text-muted mb-0">Recipe ini belum punya tool.</p>'; return; }

  tools.forEach(function (tool) {
    const fields = _judgeAdjustFieldsForType(tool.type);
    if (!fields.length) return;
    const roi = (ACTIVE_RECIPE.rois || []).find(function (r) { return r.id === tool.roiId; });

    const wrap = document.createElement('div');
    wrap.className = 'judge-adjust-row mb-2 pb-2 border-bottom';
    let html = '<div class="fw-bold">' + toolTypeLabel(tool.type) + (roi ? ' &middot; ' + roi.name : '') + '</div>';
    fields.forEach(function (f) {
      const val = tool.params && tool.params[f.key] != null ? tool.params[f.key] : (f.min != null ? f.min : 0);
      html +=
        '<label class="form-label small mb-0 mt-1">' + f.label + '</label>' +
        '<div class="d-flex align-items-center gap-2">' +
          '<input type="range" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" class="judge-adjust-slider" ' +
            'data-tool-id="' + tool.id + '" data-param-key="' + f.key + '" data-min="' + f.min + '" data-max="' + f.max + '" value="' + val + '">' +
          '<input type="number" step="' + f.step + '" class="form-control form-control-sm judge-adjust-input" style="width:90px;" ' +
            'data-tool-id="' + tool.id + '" data-param-key="' + f.key + '" value="' + val + '">' +
        '</div>' +
        '<div class="judge-value-bar-track"><div class="judge-value-bar-fill" data-bar-for-tool="' + tool.id + '" data-bar-for-key="' + f.key + '" style="width:0%;"></div></div>' +
        '<div class="judge-value-bar-label"><span>Nilai hasil ukur terakhir:</span><span data-bar-label-for-tool="' + tool.id + '" data-bar-label-for-key="' + f.key + '">-</span></div>';
    });
    wrap.innerHTML = html;
    listEl.appendChild(wrap);
  });

  attachJudgeInputSync();
}

/**
 * Sinkronisasi 2 arah antara slider (.judge-adjust-slider) dan kotak angka
 * (.judge-adjust-input) yang berpasangan (sama data-tool-id + data-param-key),
 * supaya operator bisa geser slider ATAU ketik angka langsung - keduanya
 * saling meng-update, dan ACTIVE_RECIPE.tools[].params ikut ter-update live
 * (baru benar-benar dipakai saat "Terapkan (Live)" ditekan, lewat
 * applyJudgeAdjustments() yang membaca .judge-adjust-input).
 */
function attachJudgeInputSync() {
  document.querySelectorAll('.judge-adjust-slider').forEach(function (slider) {
    const toolId = slider.getAttribute('data-tool-id');
    const paramKey = slider.getAttribute('data-param-key');
    const pairedInput = document.querySelector('.judge-adjust-input[data-tool-id="' + toolId + '"][data-param-key="' + paramKey + '"]');
    if (!pairedInput) return;

    slider.addEventListener('input', function () {
      pairedInput.value = slider.value;
    });
    pairedInput.addEventListener('input', function () {
      slider.value = pairedInput.value;
    });
  });
}

/** toolTypeLabel() sudah ada di roiEditor.js (dimuat sebelum visionTools.js) - dipakai ulang di sini. */

function applyJudgeAdjustments() {
  if (!ACTIVE_RECIPE) return;
  document.querySelectorAll('.judge-adjust-input').forEach(function (input) {
    const toolId = input.getAttribute('data-tool-id');
    const paramKey = input.getAttribute('data-param-key');
    const tool = (ACTIVE_RECIPE.tools || []).find(function (t) { return t.id === toolId; });
    if (!tool) return;
    tool.params = tool.params || {};
    tool.params[paramKey] = parseFloat(input.value);
  });
  const statusMsg = document.getElementById('runNgDetail');
  if (statusMsg) {
    const prev = statusMsg.innerHTML;
    statusMsg.innerHTML = '<span class="text-success">Parameter judge diterapkan untuk siklus berikutnya.</span>';
    setTimeout(function () { statusMsg.innerHTML = prev; }, 2500);
  }
}

/**
 * @param {boolean} [isManualTrigger] - true kalau dipanggil dari klik tombol
 *   "Measure (Trigger 1x)" secara langsung oleh operator (dipakai untuk
 *   menampilkan pesan status yang lebih jelas kalau gagal, mis. belum ada
 *   sumber gambar sama sekali - berbeda dengan trigger External otomatis
 *   yang gagal diam-diam kalau memang belum siap).
 */
async function runInspectionCycle(isManualTrigger) {
  if (!ACTIVE_RECIPE) return;

  const video = document.getElementById('runVideo');
  const hasLiveCamera = !!runStream && video.videoWidth > 0;
  const hasStaticImage = !!runStaticTestImage;
  if (!hasLiveCamera && !hasStaticImage) {
    if (isManualTrigger) {
      const detailDiv = document.getElementById('runNgDetail');
      if (detailDiv) detailDiv.innerHTML = '<span class="text-warning">Belum ada sumber gambar - nyalakan kamera atau upload foto dari device dulu.</span>';
    }
    return; // trigger External otomatis: diam saja, tunggu sumber gambar siap
  }

  // Pastikan opencv.js sudah selesai dimuat sebelum dipakai (lihat catatan di
  // index.html soal window.openCvReadyPromise) - kalau siklus pertama terpicu
  // terlalu cepat (mis. koneksi lambat), tool berbasis cv.* akan error kalau
  // tidak menunggu ini dulu. Await pada promise yang sudah resolve = instan,
  // jadi aman dipanggil di setiap siklus, tidak cuma yang pertama.
  if (window.openCvReadyPromise) await window.openCvReadyPromise;

  // ---- Indikator "MENGUKUR..." supaya operator tahu proses sedang berjalan ----
  const badgeEl = document.getElementById('runDecisionBadge');
  const btnRecapture = document.getElementById('btnRecapture');
  badgeEl.innerText = 'MENGUKUR...';
  badgeEl.className = 'run-decision-badge measuring';
  if (btnRecapture) btnRecapture.disabled = true;
  lastToolVisualData = {};

  try {
    const startMs = performance.now();

    const fullCanvas = document.createElement('canvas');
    if (hasLiveCamera) {
      fullCanvas.width = video.videoWidth;
      fullCanvas.height = video.videoHeight;
      fullCanvas.getContext('2d').drawImage(video, 0, 0);
    } else {
      fullCanvas.width = runStaticTestImage.width;
      fullCanvas.height = runStaticTestImage.height;
      fullCanvas.getContext('2d').drawImage(runStaticTestImage, 0, 0);
    }

    const overlay = document.getElementById('runOverlay');
    overlay.width = fullCanvas.width;
    overlay.height = fullCanvas.height;
    const overlayCtx = overlay.getContext('2d');
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

    const toolResults = [];
    for (const tool of ACTIVE_RECIPE.tools) {
      const roi = ACTIVE_RECIPE.rois.find(function (r) { return r.id === tool.roiId; });
      const roiCanvas = roi ? VisionTools.cropRoi(fullCanvas, roi) : fullCanvas;
      const roiOffsetX = roi ? Math.min.apply(null, roi.points.map(function (p) { return p.x; })) : 0;
      const roiOffsetY = roi ? Math.min.apply(null, roi.points.map(function (p) { return p.y; })) : 0;
      const scale = (ACTIVE_RECIPE.calibration || {}).scaleFactorPxPerMm || 1;

      // Simpan posisi ROI (& nanti bbox/edge spesifik) tiap tool - dipakai
      // drawNgOverlayForResults() untuk menggambar lokasi penyebab NG persis
      // di titiknya (gaya Keyence IV/VS Series), bukan cuma teks keterangan.
      lastToolVisualData[tool.id] = {
        roiOffsetX: roiOffsetX, roiOffsetY: roiOffsetY,
        roiWidth: roiCanvas.width, roiHeight: roiCanvas.height
      };

      let output;
      switch (tool.type) {
        case 'PatternMatch': output = VisionTools.patternMatch(roiCanvas, TemplateCache.cache[tool.id]); break;
        case 'Blob':
          output = VisionTools.blobDefectArea(roiCanvas, scale);
          if (output.bboxPx) lastToolVisualData[tool.id].bboxPx = output.bboxPx;
          break;
        case 'EdgeDimension':
          output = VisionTools.edgeDimension(roiCanvas, scale, tool.params.axis);
          lastToolVisualData[tool.id].edgeMinPx = output.edgeMinPx;
          lastToolVisualData[tool.id].edgeMaxPx = output.edgeMaxPx;
          lastToolVisualData[tool.id].axis = output.axis;
          break;
        case 'Presence': output = VisionTools.presenceAbsence(roiCanvas, tool.params.pixelThresholdPct); break;
        case 'Color': output = VisionTools.colorInspection(roiCanvas); break;
        case 'QR': output = VisionTools.readQrCode(roiCanvas); break;
        case 'Barcode': output = await VisionTools.readBarcode(roiCanvas); break;
        case 'OCR': output = await VisionTools.readOcr(roiCanvas); break;
        case 'Counting': output = VisionTools.countingBlobs(roiCanvas, scale, tool.params.minAreaMm2); break;
        case 'AIClassification': {
          const clsSlot = AIInference.sessions.classification;
          if (clsSlot.session) {
            output = await VisionTools.aiClassification(roiCanvas, clsSlot.session, clsSlot.classNames);
          } else {
            output = { predictedClass: null, confidence: 0 }; // model belum dimuat -> gagal graceful
          }
          break;
        }
        case 'AIDetection':
          if (AIInference.sessions.detection.session) {
            const detections = await VisionTools.aiDetection(roiCanvas, AIInference.sessions.detection.session, AIInference.sessions.detection.classNames, 0.25);
            drawAiOverlay(overlayCtx, detections, roiOffsetX, roiOffsetY);
            output = { detections: detections };
          } else {
            output = { detections: [] }; // model belum dimuat -> tool ini otomatis dianggap tidak ada temuan
          }
          break;
        default: output = { rawScore: null };
      }
      toolResults.push(Object.assign({ toolId: tool.id, type: tool.type }, output));
    }

    const clientProcessingMs = performance.now() - startMs;

    const res = await callApi('apiRunInspection', [{
      imageBase64: fullCanvas.toDataURL('image/jpeg', 0.85),
      recipeId: ACTIVE_RECIPE.id,
      toolResults: toolResults,
      clientProcessingMs: clientProcessingMs,
      // Kirim parameter tool yang SEDANG di-live-adjust (panel "Adjusting
      // Judge OK/NG") supaya slider/threshold yang baru digeser benar-benar
      // mempengaruhi keputusan OK/NG server, bukan cuma tampilan di browser.
      toolsOverride: ACTIVE_RECIPE.tools
    }, CURRENT_SESSION]);

    if (res.success === false) {
      console.warn('Inspeksi gagal:', res.error);
      badgeEl.innerText = 'ERROR';
      badgeEl.className = 'run-decision-badge ng';
      if (btnRecapture) btnRecapture.disabled = false;
      return;
    }
    updateRunModeUi(res);
    if (btnRecapture) btnRecapture.disabled = false;
  } catch (err) {
    console.warn('Inspeksi gagal:', err.message);
    badgeEl.innerText = 'ERROR';
    badgeEl.className = 'run-decision-badge ng';
    if (btnRecapture) btnRecapture.disabled = false;
  }
}

/**
 * Explainability (PRD 14.7): gambar bounding box + label + confidence
 * pada overlay canvas Run Mode agar operator/engineer bisa melihat area
 * yang menyebabkan keputusan NG dari AI, bukan hanya angka confidence.
 */
function drawAiOverlay(ctx, detections, offsetX, offsetY) {
  detections.forEach(function (d) {
    const [x, y, w, h] = d.bbox;
    ctx.strokeStyle = '#FF0000';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + offsetX, y + offsetY, w, h);
    ctx.fillStyle = '#FF0000';
    ctx.font = '14px sans-serif';
    ctx.fillText(d.className + ' ' + (d.confidence * 100).toFixed(0) + '%', x + offsetX, y + offsetY - 4);
  });
}

/**
 * Visualisasi lokasi penyebab NG langsung di atas foto hasil, gaya Keyence
 * IV/VS Series: kotak merah solid TEPAT di bbox cacat (tool Blob), garis
 * merah di tepi yang di luar toleransi (tool EdgeDimension), atau kotak
 * putus-putus di sekeliling ROI untuk tool lain (Presence/Color/Counting/
 * AI, dst - yang belum punya lokasi presisi sedetail itu). Operator jadi
 * langsung tahu DI MANA & KENAPA hasilnya NG, tidak perlu menebak-nebak.
 */
function drawNgOverlayForResults(toolResults) {
  const overlay = document.getElementById('runOverlay');
  if (!overlay) return;
  const ctx = overlay.getContext('2d');

  (toolResults || []).forEach(function (tr) {
    if (tr.passFail !== false) return; // hanya gambar untuk tool yang NG
    const vis = lastToolVisualData[tr.toolId];
    if (!vis) return;

    ctx.lineWidth = 3;
    ctx.strokeStyle = '#FF0000';
    ctx.fillStyle = '#FF0000';
    ctx.font = 'bold 13px sans-serif';

    if (vis.bboxPx) {
      // Blob/Defect Area: kotak solid tepat di lokasi cacat
      const x = vis.roiOffsetX + vis.bboxPx.x, y = vis.roiOffsetY + vis.bboxPx.y;
      ctx.strokeRect(x, y, vis.bboxPx.width, vis.bboxPx.height);
      ctx.fillText('DEFECT', x, Math.max(12, y - 6));
    } else if (vis.edgeMinPx != null && vis.edgeMaxPx != null) {
      // Edge/Dimension: garis di 2 tepi yang diukur
      ctx.beginPath();
      if (vis.axis === 'y') {
        ctx.moveTo(vis.roiOffsetX, vis.roiOffsetY + vis.edgeMinPx);
        ctx.lineTo(vis.roiOffsetX + vis.roiWidth, vis.roiOffsetY + vis.edgeMinPx);
        ctx.moveTo(vis.roiOffsetX, vis.roiOffsetY + vis.edgeMaxPx);
        ctx.lineTo(vis.roiOffsetX + vis.roiWidth, vis.roiOffsetY + vis.edgeMaxPx);
      } else {
        ctx.moveTo(vis.roiOffsetX + vis.edgeMinPx, vis.roiOffsetY);
        ctx.lineTo(vis.roiOffsetX + vis.edgeMinPx, vis.roiOffsetY + vis.roiHeight);
        ctx.moveTo(vis.roiOffsetX + vis.edgeMaxPx, vis.roiOffsetY);
        ctx.lineTo(vis.roiOffsetX + vis.edgeMaxPx, vis.roiOffsetY + vis.roiHeight);
      }
      ctx.stroke();
      ctx.fillText('OUT OF TOLERANCE', vis.roiOffsetX, Math.max(12, vis.roiOffsetY - 6));
    } else {
      // Tool lain: kotak putus-putus di sekeliling ROI + label tipe tool
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(vis.roiOffsetX, vis.roiOffsetY, vis.roiWidth, vis.roiHeight);
      ctx.setLineDash([]);
      ctx.fillText('NG: ' + toolTypeLabel(tr.type), vis.roiOffsetX, Math.max(12, vis.roiOffsetY - 6));
    }
  });
}

/**
 * Update bar nilai live di panel "Adjusting Judge OK/NG" - menunjukkan di
 * mana posisi nilai hasil ukur TERAKHIR relatif terhadap rentang slider
 * (min/max), berwarna hijau kalau tool itu PASS dan merah kalau NG, supaya
 * operator langsung lihat seberapa dekat/jauh dari batas ambang.
 */
function updateJudgeValueBars(toolResults) {
  document.querySelectorAll('.judge-adjust-slider').forEach(function (slider) {
    const toolId = slider.getAttribute('data-tool-id');
    const paramKey = slider.getAttribute('data-param-key');
    const min = parseFloat(slider.getAttribute('data-min'));
    const max = parseFloat(slider.getAttribute('data-max'));
    const tr = (toolResults || []).find(function (r) { return r.toolId === toolId; });
    const fill = document.querySelector('.judge-value-bar-fill[data-bar-for-tool="' + toolId + '"][data-bar-for-key="' + paramKey + '"]');
    const label = document.querySelector('[data-bar-label-for-tool="' + toolId + '"][data-bar-label-for-key="' + paramKey + '"]');
    // Server (VisionToolsEngine.evaluateToolResults) mengembalikan nilai
    // hasil ukur di field "value" (bukan "rawScore" - itu nama field yang
    // dikirim KE server dari client sebelum dievaluasi).
    if (!tr || tr.value == null || typeof tr.value !== 'number' || !fill) return;

    const pct = Math.max(0, Math.min(100, ((tr.value - min) / (max - min || 1)) * 100));
    fill.style.width = pct + '%';
    fill.classList.remove('ok', 'ng');
    fill.classList.add(tr.passFail === false ? 'ng' : 'ok');
    if (label) label.innerText = tr.value.toFixed(2);
  });
}

function updateRunModeUi(res) {
  const badge = document.getElementById('runDecisionBadge');
  const cycleTimeSec = ((res.cycleTimeMs || 0) / 1000).toFixed(1);
  badge.innerText = res.decision + ' (' + cycleTimeSec + ' s)';
  badge.className = 'run-decision-badge ' + (res.decision === 'OK' ? 'ok' : 'ng');

  if (typeof sendDecisionToArduino === 'function') sendDecisionToArduino(res.decision);

  if (res.decision === 'OK') runOkCount++; else runNgCount++;
  document.getElementById('runOkCount').innerText = runOkCount;
  document.getElementById('runNgCount').innerText = runNgCount;
  const total = runOkCount + runNgCount;
  document.getElementById('runYield').innerText = total ? Math.round(runOkCount / total * 100) + '%' : '0%';

  const detailDiv = document.getElementById('runNgDetail');
  detailDiv.innerHTML = (res.ngReasons || []).map(function (r) {
    return r.type + ': ' + r.reason;
  }).join('<br>');

  updateJudgeValueBars(res.toolResults);
  drawNgOverlayForResults(res.toolResults);
}
