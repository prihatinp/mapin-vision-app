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

function initRunMode() {
  navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } }).then(function (stream) {
    const runVideoEl = document.getElementById('runVideo');
    runVideoEl.muted = true; // wajib agar autoplay tidak diblokir browser
    runVideoEl.srcObject = stream;
    runVideoEl.play().catch(function (playErr) { console.warn('video.play() gagal:', playErr); });
  }).catch(function (err) {
    alert('Gagal mengakses kamera untuk Run Mode: ' + err.message);
  });

  callApi('apiGetRecipe', [window.ACTIVE_RECIPE_ID, CURRENT_SESSION]).then(function (res) {
    ACTIVE_RECIPE = res.recipe;
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
  }).catch(function (err) { console.warn('Gagal memuat recipe untuk Run Mode:', err.message); });

  document.getElementById('btnPause').addEventListener('click', function () {
    runPollingActive = !runPollingActive;
    this.innerText = runPollingActive ? 'Pause' : 'Resume';
  });
  document.getElementById('btnRecapture').addEventListener('click', runInspectionCycle);

  runPollingActive = true;
  pollTriggerLoop();
}

let runPollingActive = false;
function pollTriggerLoop() {
  setInterval(function () {
    if (!runPollingActive) return;
    callApi('apiGetIoStatusForUi', [CURRENT_SESSION]).then(function (status) {
      if (status.status === 'BUSY') {
        runInspectionCycle();
      }
    }).catch(function () { /* biarkan polling berikutnya coba lagi */ });
  }, 300); // simulasi WebSocket via polling ringan
}

async function runInspectionCycle() {
  if (!ACTIVE_RECIPE) return;
  const startMs = performance.now();

  const video = document.getElementById('runVideo');
  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = video.videoWidth;
  fullCanvas.height = video.videoHeight;
  fullCanvas.getContext('2d').drawImage(video, 0, 0);

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

  callApi('apiRunInspection', [{
    imageBase64: fullCanvas.toDataURL('image/jpeg', 0.85),
    recipeId: ACTIVE_RECIPE.id,
    toolResults: toolResults,
    clientProcessingMs: clientProcessingMs
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
}
