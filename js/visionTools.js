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
    for (let i = 0; i < contours.size(); i++) {
      const area = cv.contourArea(contours.get(i));
      if (area > maxAreaPx) maxAreaPx = area;
    }

    const scale = scaleFactorPxPerMm || 1;
    const areaMm2 = maxAreaPx / (scale * scale);

    src.delete(); gray.delete(); thresh.delete(); contours.delete(); hierarchy.delete();
    return { rawScore: areaMm2 };
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
    return { rawScore: distanceMm };
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
let internalTriggerIntervalId = null; // trigger INTERNAL (timer capture otomatis)

/**
 * Gambar uji-coba yang diupload lewat tombol "Upload Gambar Test" -
 * kalau terisi (bukan null), setiap kali tombol "Measure (Trigger 1x)"
 * diklik, sistem MENGUKUR GAMBAR INI (bukan kamera live). Gambar ini
 * SENGAJA TETAP TERSIMPAN (tidak dikosongkan otomatis setelah 1x
 * pakai) supaya operator/engineer bisa klik Measure berkali-kali
 * dengan gambar yang SAMA sambil menggeser slider "Adjusting Judge
 * OK/NG" - untuk melihat efek perubahan parameter terhadap hasil
 * OK/NG tanpa perlu upload ulang tiap kali. Baru dikosongkan saat
 * user upload gambar lain, atau klik "Nyalakan Kamera (Live)" untuk
 * kembali ke mode kamera.
 */
let runStaticTestImage = null;

function initRunUploadImageControls() {
  const btn = document.getElementById('btnRunUploadImage');
  const input = document.getElementById('runUploadImageInput');
  const statusEl = document.getElementById('runUploadImageStatus');
  if (!btn || !input) return;

  btn.onclick = function () { input.click(); };
  input.onchange = function (e) {
    const file = e.target.files && e.target.files[0];
    input.value = ''; // supaya file yang sama bisa dipilih ulang
    if (!file) return;
    if (!file.type || file.type.indexOf('image/') !== 0) {
      if (statusEl) statusEl.innerText = 'File yang dipilih bukan gambar.';
      return;
    }
    if (!ACTIVE_RECIPE) {
      alert('Belum ada recipe aktif. Aktifkan recipe dulu di Recipe Management sebelum uji coba.');
      return;
    }
    if (statusEl) statusEl.innerText = 'Memuat gambar...';

    const reader = new FileReader();
    reader.onload = function (ev) {
      const img = new Image();
      img.onload = function () {
        // Matikan kamera live (kalau sedang menyala) - kita pindah ke mode
        // gambar statis, supaya trigger otomatis tidak diam-diam kembali
        // memotret dari kamera dan menimpa gambar yang mau diuji.
        if (runStream) {
          runStream.getTracks().forEach(function (t) { t.stop(); });
          runStream = null;
          document.getElementById('runVideo').srcObject = null;
        }
        runPollingActive = false; // pause trigger otomatis - Measure sekarang dikontrol manual
        const btnPause = document.getElementById('btnPause');
        if (btnPause) btnPause.innerText = 'Resume Trigger';

        const tmp = document.createElement('canvas');
        tmp.width = img.naturalWidth;
        tmp.height = img.naturalHeight;
        tmp.getContext('2d').drawImage(img, 0, 0);
        runStaticTestImage = tmp;

        // Tampilkan gambar yang diupload di preview (ganti video), SEBELUM
        // diukur - sesuai permintaan: gambar tampil dulu, baru diukur saat
        // tombol Measure diklik, bukan langsung otomatis terukur.
        const previewImg = document.getElementById('runTestImagePreview');
        previewImg.src = ev.target.result;
        previewImg.classList.remove('d-none');
        document.getElementById('runVideo').classList.add('d-none');
        document.getElementById('runCameraOffOverlay').classList.add('d-none');
        const overlayEl = document.getElementById('runOverlay');
        overlayEl.width = img.naturalWidth;
        overlayEl.height = img.naturalHeight;
        overlayEl.getContext('2d').clearRect(0, 0, overlayEl.width, overlayEl.height);
        document.getElementById('runDecisionBadge').innerText = 'READY';
        document.getElementById('runDecisionBadge').className = 'run-decision-badge';

        if (statusEl) statusEl.innerText = 'Gambar "' + file.name + '" siap. Klik "Measure (Trigger 1x)" di bawah untuk mengukur.';
      };
      img.onerror = function () {
        if (statusEl) statusEl.innerText = 'Gagal membaca file gambar tersebut.';
      };
      img.src = ev.target.result;
    };
    reader.onerror = function () {
      if (statusEl) statusEl.innerText = 'Gagal membaca file dari device.';
    };
    reader.readAsDataURL(file);
  };
}

function initRunMode() {
  // SEBELUMNYA kamera langsung menyala otomatis begitu Run Mode dibuka.
  // Sekarang kamera SENGAJA menunggu perintah eksplisit (tombol "Nyalakan
  // Kamera (Live)") - supaya operator bisa memilih dulu mau uji coba pakai
  // gambar upload, atau langsung live, tanpa lampu indikator kamera
  // menyala duluan padahal belum tentu dipakai.
  runStaticTestImage = null;

  const resSelect = document.getElementById('runResolutionSelect');
  if (resSelect) resSelect.onchange = function () { if (runStream) startRunCamera(); }; // ganti resolusi -> nyalakan ulang stream HANYA kalau kamera memang sedang live

  const btnRunStopCamera = document.getElementById('btnRunStopCamera');
  if (btnRunStopCamera) btnRunStopCamera.onclick = toggleRunCamera;

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

  initRunUploadImageControls();
  initTriggerModeControls();
  initJudgeAdjustPanel();

  runPollingActive = true;
  startSelectedTriggerLoop();
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

  const resSelect = document.getElementById('runResolutionSelect');
  const resValue = (resSelect && resSelect.value) || '1280x720';
  const [w, h] = resValue.split('x').map(Number);

  navigator.mediaDevices.getUserMedia({ video: { width: { ideal: w }, height: { ideal: h } } }).then(function (stream) {
    runStream = stream;
    const runVideoEl = document.getElementById('runVideo');
    runVideoEl.muted = true; // wajib agar autoplay tidak diblokir browser
    runVideoEl.srcObject = stream;
    runVideoEl.play().catch(function (playErr) { console.warn('video.play() gagal:', playErr); });

    // Kembali ke mode kamera live - keluar dari mode "gambar statis" kalau
    // sebelumnya sedang menguji gambar upload.
    runStaticTestImage = null;
    document.getElementById('runTestImagePreview').classList.add('d-none');
    runVideoEl.classList.remove('d-none');
    document.getElementById('runCameraOffOverlay').classList.add('d-none');
    const uploadStatusEl = document.getElementById('runUploadImageStatus');
    if (uploadStatusEl) uploadStatusEl.innerText = '';

    const btn = document.getElementById('btnRunStopCamera');
    if (btn) { btn.innerText = 'Matikan Kamera'; btn.classList.remove('btn-outline-success'); btn.classList.add('btn-outline-danger'); }

    // Nyalakan live -> otomatis lanjutkan trigger (kalau sebelumnya di-pause
    // karena mode gambar statis atau kamera mati).
    runPollingActive = true;
    const btnPause = document.getElementById('btnPause');
    if (btnPause) btnPause.innerText = 'Pause Trigger';
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
    overlay.classList.remove('d-none');
    if (btn) { btn.innerText = 'Nyalakan Kamera'; btn.classList.replace('btn-outline-danger', 'btn-outline-success'); }
    runPollingActive = false; // tidak ada gunanya trigger jalan kalau kamera mati
    const btnPause = document.getElementById('btnPause');
    if (btnPause) btnPause.innerText = 'Resume Trigger';
  } else {
    startRunCamera();
  }
}

/* ==================================================================
   MODE TRIGGER: INTERNAL (timer otomatis, seperti Continuous Monitoring)
   vs EXTERNAL (menunggu sinyal dari Arduino/ESP8266/PLC lewat status IO -
   perilaku asli sebelum fitur ini ditambahkan).
   ================================================================== */
let runTriggerMode = 'external';

function initTriggerModeControls() {
  document.querySelectorAll('input[name="runTriggerMode"]').forEach(function (radio) {
    radio.onchange = function () {
      runTriggerMode = radio.value;
      document.getElementById('internalTriggerControls').classList.toggle('d-none', runTriggerMode !== 'internal');
      document.getElementById('externalTriggerHint').classList.toggle('d-none', runTriggerMode !== 'external');
      startSelectedTriggerLoop();
    };
  });
  const intervalInput = document.getElementById('internalTriggerInterval');
  if (intervalInput) intervalInput.onchange = function () { if (runTriggerMode === 'internal') startSelectedTriggerLoop(); };
}

function startSelectedTriggerLoop() {
  stopTriggerLoops();
  if (runTriggerMode === 'internal') startInternalTriggerLoop();
  else startExternalTriggerLoop();
}

function stopTriggerLoops() {
  if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; }
  if (internalTriggerIntervalId) { clearInterval(internalTriggerIntervalId); internalTriggerIntervalId = null; }
}

/** Trigger EXTERNAL - menunggu sinyal Arduino/ESP8266/PLC (status IO = BUSY). */
function startExternalTriggerLoop() {
  pollIntervalId = setInterval(function () {
    if (!runPollingActive) return;
    callApi('apiGetIoStatusForUi', [CURRENT_SESSION]).then(function (status) {
      if (status.status === 'BUSY') {
        runInspectionCycle();
      }
    }).catch(function () { /* biarkan polling berikutnya coba lagi */ });
  }, 300); // simulasi WebSocket via polling ringan
}

/** Trigger INTERNAL - capture & inspeksi otomatis tiap interval yang diset operator. */
function startInternalTriggerLoop() {
  const intervalInput = document.getElementById('internalTriggerInterval');
  const intervalMs = Math.max(100, parseInt((intervalInput && intervalInput.value) || 1000, 10));
  internalTriggerIntervalId = setInterval(function () {
    if (!runPollingActive) return;
    runInspectionCycle();
  }, intervalMs);
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
  runStaticTestImage = null; // keluar dari menu Run Mode -> reset mode gambar statis juga
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

/**
 * Daftar field parameter utama yang bisa di-adjust per tipe tool, LENGKAP
 * dengan min/max - dipakai untuk batas slider ala Keyence VS Series DAN
 * sebagai skala bar hasil pengukuran (lihat updateJudgeValueBars()).
 */
function _judgeAdjustFieldsForType(type) {
  switch (type) {
    case 'PatternMatch': return [{ key: 'threshold', label: 'Threshold Similarity (0-1)', step: 0.01, min: 0, max: 1 }];
    case 'Blob': return [{ key: 'minAreaMm2', label: 'Min Area Defect (mm²)', step: 0.01, min: 0, max: 100 }];
    case 'EdgeDimension': return [
      { key: 'toleranceMm', label: 'Toleransi (mm)', step: 0.01, min: 0, max: 20 },
      { key: 'nominalMm', label: 'Nominal (mm)', step: 0.01, min: 0, max: 500 }
    ];
    case 'Presence': return [{ key: 'pixelThresholdPct', label: 'Threshold Piksel (%)', step: 0.1, min: 0, max: 100 }];
    case 'Color': return [
      { key: 'threshold', label: 'Toleransi (+/-)', step: 1, min: 0, max: 100 },
      { key: 'targetMean', label: 'Target Mean (0-255)', step: 1, min: 0, max: 255 }
    ];
    case 'Counting': return [
      { key: 'expectedMin', label: 'Jumlah Minimum', step: 1, min: 0, max: 50 },
      { key: 'expectedMax', label: 'Jumlah Maksimum', step: 1, min: 0, max: 50 }
    ];
    case 'AIClassification': return [{ key: 'confidenceThreshold', label: 'Confidence Threshold (0-1)', step: 0.01, min: 0, max: 1 }];
    case 'AIDetection': return [{ key: 'confidenceThreshold', label: 'Confidence Threshold (0-1)', step: 0.01, min: 0, max: 1 }];
    default: return []; // QR/Barcode/OCR: berbasis rule teks, bukan angka - tidak ada quick-adjust di sini
  }
}

/**
 * Render panel Adjusting Judge OK/NG - tiap parameter tool ditampilkan
 * sebagai slider (bisa digeser-geser, ala Keyence VS Series) + input
 * angka (sinkron 2 arah dengan slider), PLUS 1 bar "Hasil Ukur" yang
 * nanti diisi live oleh updateJudgeValueBars() setiap selesai 1 siklus
 * inspeksi - bar-nya berubah HIJAU (OK) / MERAH (NG) mengikuti hasil
 * perbandingan ke parameter standar saat itu.
 */
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
    wrap.className = 'mb-3 pb-2 border-bottom';
    let html = '<div class="fw-bold mb-1">' + toolTypeLabel(tool.type) + (roi ? ' &middot; ' + roi.name : '') + '</div>';
    fields.forEach(function (f, fIdx) {
      const val = tool.params && tool.params[f.key] != null ? tool.params[f.key] : f.min;
      const commonAttrs = 'data-tool-id="' + tool.id + '" data-param-key="' + f.key + '" data-field-min="' + f.min + '" data-field-max="' + f.max + '"';
      html +=
        '<label class="form-label small mb-0 mt-1">' + f.label + '</label>' +
        '<div class="d-flex align-items-center gap-2">' +
          '<input type="range" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + val + '" ' +
            'class="form-range judge-adjust-slider" ' + commonAttrs + ' style="flex:1;">' +
          '<input type="number" step="' + f.step + '" class="form-control form-control-sm judge-adjust-input" ' +
            commonAttrs + ' value="' + val + '" style="width:5.5rem;">' +
        '</div>' +
        '<div class="judge-value-bar-track" id="judgeBar_' + tool.id + '_' + f.key + '">' +
          '<div class="judge-value-bar-fill" style="width:0%;"></div>' +
          '<span class="judge-value-bar-label">Belum diukur</span>' +
        '</div>';
    });
    wrap.innerHTML = html;
    listEl.appendChild(wrap);
  });

  attachJudgeInputSync();
}

/** toolTypeLabel() sudah ada di roiEditor.js (dimuat sebelum visionTools.js) - dipakai ulang di sini. */

/**
 * Sinkronkan slider <-> input angka 2 arah (geser slider = angka ikut
 * berubah, dan sebaliknya), lalu langsung terapkan ke ACTIVE_RECIPE
 * in-memory setiap kali digeser - supaya siklus/Measure BERIKUTNYA
 * langsung memakai nilai baru tanpa perlu klik "Terapkan" dulu (mirip
 * kebiasaan geser slider VS Series yang efeknya langsung terasa).
 * Tombol "Terapkan (Live)" & "Simpan ke Recipe" tetap ada untuk
 * memastikan/mem-persist, tapi geser slider sendiri sudah otomatis live.
 */
function attachJudgeInputSync() {
  document.querySelectorAll('.judge-adjust-slider, .judge-adjust-input').forEach(function (el) {
    el.oninput = function () {
      const toolId = el.getAttribute('data-tool-id');
      const key = el.getAttribute('data-param-key');
      const val = el.value;
      // Sinkronkan pasangannya (slider <-> number) yang punya tool-id + key sama
      document.querySelectorAll('[data-tool-id="' + toolId + '"][data-param-key="' + key + '"]').forEach(function (pair) {
        if (pair !== el) pair.value = val;
      });
      const tool = (ACTIVE_RECIPE.tools || []).find(function (t) { return t.id === toolId; });
      if (tool) {
        tool.params = tool.params || {};
        tool.params[key] = parseFloat(val);
      }
    };
  });
}

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
 * Diisi live setiap selesai 1 siklus inspeksi (dipanggil dari
 * updateRunModeUi) - mengisi bar "Hasil Ukur" tiap tool dengan posisi
 * nilai terukur pada skala min-max field-nya, dan warna hijau (OK) /
 * merah (NG) sesuai passFail dari server (VisionToolsEngine - source
 * of truth). Kalau tool punya >1 field (mis. EdgeDimension), field
 * pertama dipakai sebagai representasi bar utama.
 */
function updateJudgeValueBars(toolResults) {
  if (!toolResults) return;
  toolResults.forEach(function (tr) {
    const bars = document.querySelectorAll('[id^="judgeBar_' + tr.toolId + '_"]');
    if (!bars.length) return;
    bars.forEach(function (barTrack) {
      const key = barTrack.id.split('_').slice(2).join('_');
      const sliderEl = document.querySelector('.judge-adjust-slider[data-tool-id="' + tr.toolId + '"][data-param-key="' + key + '"]');
      const min = sliderEl ? parseFloat(sliderEl.min) : 0;
      const max = sliderEl ? parseFloat(sliderEl.max) : 1;
      const numericValue = typeof tr.value === 'number' ? tr.value : parseFloat(tr.value);

      const fill = barTrack.querySelector('.judge-value-bar-fill');
      const label = barTrack.querySelector('.judge-value-bar-label');
      if (!isNaN(numericValue) && max > min) {
        const pct = Math.max(0, Math.min(100, ((numericValue - min) / (max - min)) * 100));
        fill.style.width = pct + '%';
      } else {
        fill.style.width = '100%'; // nilai non-numerik (mis. hasil AI Classification berupa nama kelas) - bar penuh, warna tetap jadi indikator OK/NG
      }
      fill.className = 'judge-value-bar-fill ' + (tr.passFail ? 'ok' : 'ng');
      label.innerText = (typeof tr.value === 'number' ? tr.value.toFixed(2) : tr.value) + ' — ' + (tr.passFail ? 'OK' : 'NG');
    });
  });
}

/**
 * @param {boolean} [isManualTrigger] - true HANYA kalau dipanggil langsung
 *   dari klik tombol "Measure (Trigger 1x)" (aksi user, sekali jalan).
 *   PENTING: nilai ini WAJIB false/kosong untuk semua pemanggilan dari
 *   loop otomatis (startInternalTriggerLoop/startExternalTriggerLoop),
 *   karena fungsi ini dipanggil BERULANG lewat setInterval - kalau guard
 *   di bawah pakai alert() tanpa syarat ini, begitu kamera mati/belum ada
 *   gambar test, alert() akan muncul TERUS-MENERUS setiap tick interval
 *   (blocking dialog di browser), sampai tab harus dipaksa ditutup. Ini
 *   BUG NYATA yang pernah terjadi - makanya sekarang loop otomatis hanya
 *   mencatat ke console (senyap), sedangkan klik manual tetap dapat
 *   feedback jelas tapi lewat teks status (non-blocking), BUKAN alert().
 */
async function runInspectionCycle(isManualTrigger) {
  if (!ACTIVE_RECIPE) return;

  // Pastikan opencv.js sudah selesai dimuat sebelum dipakai (lihat catatan di
  // index.html soal window.openCvReadyPromise) - kalau siklus pertama terpicu
  // terlalu cepat (mis. koneksi lambat), tool berbasis cv.* akan error kalau
  // tidak menunggu ini dulu. Await pada promise yang sudah resolve = instan,
  // jadi aman dipanggil di setiap siklus, tidak cuma yang pertama.
  if (window.openCvReadyPromise) await window.openCvReadyPromise;

  const startMs = performance.now();

  // Sumber frame: kalau ada runStaticTestImage terisi (lewat tombol
  // "Upload Gambar Test"), pakai gambar itu terus-menerus setiap Measure
  // diklik (TIDAK dikosongkan otomatis) - supaya bisa diukur berkali-kali
  // sambil menggeser slider "Adjusting Judge OK/NG" tanpa upload ulang.
  // Kalau tidak ada gambar statis, pakai frame kamera live seperti biasa.
  let fullCanvas;
  if (runStaticTestImage) {
    fullCanvas = runStaticTestImage;
  } else {
    const video = document.getElementById('runVideo');
    if (!video.videoWidth) {
      const msg = 'Kamera belum menyala dan belum ada gambar test yang diupload. Klik "Nyalakan Kamera (Live)" atau "Upload Gambar Test" dulu.';
      if (isManualTrigger) {
        const statusEl = document.getElementById('runUploadImageStatus');
        if (statusEl) statusEl.innerHTML = '<span class="text-danger">' + msg + '</span>';
      } else {
        console.warn('Siklus trigger otomatis dilewati:', msg); // loop otomatis - JANGAN alert(), cukup senyap di console
      }
      return;
    }
    fullCanvas = document.createElement('canvas');
    fullCanvas.width = video.videoWidth;
    fullCanvas.height = video.videoHeight;
    fullCanvas.getContext('2d').drawImage(video, 0, 0);
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

    let output;
    switch (tool.type) {
      case 'PatternMatch': output = VisionTools.patternMatch(roiCanvas, TemplateCache.cache[tool.id]); break;
      case 'Blob': output = VisionTools.blobDefectArea(roiCanvas, scale); break;
      case 'EdgeDimension': output = VisionTools.edgeDimension(roiCanvas, scale, tool.params.axis); break;
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

  return callApi('apiRunInspection', [{
    imageBase64: fullCanvas.toDataURL('image/jpeg', 0.85),
    recipeId: ACTIVE_RECIPE.id,
    toolResults: toolResults,
    clientProcessingMs: clientProcessingMs,
    // Kirim parameter tool TERKINI (termasuk perubahan slider "Adjusting
    // Judge OK/NG" yang belum disimpan) supaya server menjudge pakai nilai
    // yang sedang ditampilkan di layar, bukan nilai lama dari Spreadsheet.
    toolsOverride: ACTIVE_RECIPE.tools
  }, CURRENT_SESSION]).then(function (res) {
    if (res.success === false) { console.warn('Inspeksi gagal:', res.error); return; }
    updateRunModeUi(res);
  }).catch(function (err) { console.warn('Inspeksi gagal:', err.message); });
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

function updateRunModeUi(res) {
  const badge = document.getElementById('runDecisionBadge');
  badge.innerText = res.decision + ' (' + res.cycleTimeMs + ' ms)';
  badge.className = 'run-decision-badge ' + (res.decision === 'OK' ? 'ok' : 'ng');

  if (typeof sendDecisionToArduino === 'function') sendDecisionToArduino(res.decision);

  if (res.decision === 'OK') runOkCount++; else runNgCount++;
  document.getElementById('runOkCount').innerText = runOkCount;
  document.getElementById('runNgCount').innerText = runNgCount;
  const total = runOkCount + runNgCount;
  document.getElementById('runYield').innerText = total ? Math.round(runOkCount / total * 100) + '%' : '0%';

  const detailDiv = document.getElementById('runNgDetail');
  detailDiv.innerHTML = res.ngReasons.map(function (r) {
    return r.type + ': ' + r.reason;
  }).join('<br>');

  updateJudgeValueBars(res.toolResults);
}
