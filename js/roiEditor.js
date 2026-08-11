/* ==================================================================
   MAP-IN Vision V1.0 - roiEditor.js
   Module 4: ROI Editor (Polygon, Drag & Drop Point, Multiple ROI)
   ================================================================== */

let roiCanvasCtx = null;
let roiList = [];
let selectedRoiIndex = -1;
let draggingPointIndex = -1;
let backgroundImage = null;
let capturedTemplateBase64 = null;
let editToolModalInstance = null;
let editingToolId = null;

function initRoiEditor() {
  const canvas = document.getElementById('roiCanvas');
  roiCanvasCtx = canvas.getContext('2d');

  const recipe = window.EDITING_RECIPE || { rois: [], tools: [] };
  window.EDITING_RECIPE = recipe;
  recipe.tools = recipe.tools || [];
  roiList = recipe.rois || [];
  recipe.rois = roiList;
  capturedTemplateBase64 = null;

  // ---------- Nama recipe & Simpan Recipe ----------
  const recipeNameInput = document.getElementById('recipeNameInput');
  if (recipeNameInput) {
    recipeNameInput.value = recipe.name || '';
    recipeNameInput.oninput = function () { recipe.name = recipeNameInput.value; };
  }
  const btnSaveRecipe = document.getElementById('btnSaveRecipe');
  if (btnSaveRecipe) {
    btnSaveRecipe.onclick = function () {
      if (!recipe.name || !recipe.name.trim()) {
        alert('Isi nama recipe terlebih dahulu sebelum menyimpan.');
        return;
      }
      recipe.rois = roiList;
      btnSaveRecipe.disabled = true;
      callApi('apiSaveRecipe', [recipe, (typeof CURRENT_SESSION !== 'undefined') ? CURRENT_SESSION : null])
        .then(function (res) {
          btnSaveRecipe.disabled = false;
          if (res.success) {
            // Mutasi in-place agar closure `recipe` & window.EDITING_RECIPE tetap
            // merujuk objek yang sama (id/version baru dari server ikut terbawa),
            // supaya klik "Simpan" berikutnya meng-UPDATE recipe ini, bukan bikin baru.
            Object.assign(recipe, res.recipe);
            window.EDITING_RECIPE = recipe;
            alert('Recipe "' + recipe.name + '" berhasil disimpan (versi ' + recipe.version + ').');
          } else {
            alert('Gagal menyimpan recipe: ' + res.error);
          }
        })
        .catch(function (err) {
          btnSaveRecipe.disabled = false;
          alert('Gagal menyimpan recipe: ' + err.message);
        });
    };
  }

  // ---------- Modal edit parameter tool ----------
  const editToolModalEl = document.getElementById('editToolModal');
  if (editToolModalEl) editToolModalInstance = new bootstrap.Modal(editToolModalEl);
  const btnSaveToolParams = document.getElementById('btnSaveToolParams');
  if (btnSaveToolParams) btnSaveToolParams.onclick = saveToolParamsFromModal;

  // Tampilkan status kalibrasi recipe ini (jika sudah pernah dikalibrasi)
  const calibStatusEl = document.getElementById('calibrationStatus');
  if (calibStatusEl) {
    if (recipe.calibration && recipe.calibration.scaleFactorPxPerMm) {
      calibStatusEl.innerHTML = '<span class="text-success">Terkalibrasi: ' + recipe.calibration.scaleFactorPxPerMm.toFixed(3) + ' px/mm (media: ' + recipe.calibration.referenceType + ')</span>';
    } else {
      calibStatusEl.innerHTML = '<span class="text-muted">Belum dikalibrasi untuk recipe ini.</span>';
    }
  }

  // Toggle tombol "Ambil Template" hanya untuk tipe PatternMatch
  const toolTypeSelectEl = document.getElementById('toolTypeSelect');
  const captureTemplateBtn = document.getElementById('btnCaptureTemplate');
  function toggleTemplateBtn() {
    captureTemplateBtn.classList.toggle('d-none', toolTypeSelectEl.value !== 'PatternMatch');
  }
  toolTypeSelectEl.removeEventListener('change', toggleTemplateBtn);
  toolTypeSelectEl.addEventListener('change', toggleTemplateBtn);
  toggleTemplateBtn();

  captureTemplateBtn.onclick = function () {
    if (selectedRoiIndex === -1) { alert('Pilih ROI terlebih dahulu.'); return; }
    if (!backgroundImage) { alert('Tidak ada gambar referensi. Buka Camera Center/Run Mode dulu agar ada frame kamera.'); return; }
    const roi = roiList[selectedRoiIndex];
    const templateCanvas = VisionTools.cropRoi(backgroundImage, roi);
    capturedTemplateBase64 = _encodeTemplateForStorage(templateCanvas);
    if (!capturedTemplateBase64) return; // sudah alert di dalam _encodeTemplateForStorage
    alert('Template referensi diambil dari ' + roi.name + '. Klik "+ Tambah Tool ke ROI" untuk menyimpannya sebagai Pattern Match tool.');
  };

  // Ambil 1 frame terbaru dari kamera Camera Center/Run Mode (kalau sedang
  // aktif) sebagai referensi background. Kalau tidak ada (mis. user langsung
  // buka ROI Editor dari Recipe Baru tanpa lewat Camera Center dulu),
  // tampilkan empty-state + tombol "Ambil Gambar dari Kamera" di bawah,
  // bukan kanvas kosong/hitam yang membingungkan seperti sebelumnya.
  const previewVideo = document.getElementById('runVideo') || document.getElementById('cameraPreview');
  if (previewVideo && previewVideo.videoWidth) {
    const tmp = document.createElement('canvas');
    tmp.width = previewVideo.videoWidth;
    tmp.height = previewVideo.videoHeight;
    tmp.getContext('2d').drawImage(previewVideo, 0, 0);
    backgroundImage = tmp;
    canvas.width = tmp.width;
    canvas.height = tmp.height;
  }
  _updateRoiEmptyState();

  renderRoiList();
  redrawCanvas();

  canvas.addEventListener('mousedown', onCanvasMouseDown);
  canvas.addEventListener('mousemove', onCanvasMouseMove);
  canvas.addEventListener('mouseup', function () { draggingPointIndex = -1; });
  canvas.addEventListener('dblclick', onCanvasDoubleClick);

  const btnRoiCaptureCamera = document.getElementById('btnRoiCaptureCamera');
  if (btnRoiCaptureCamera) btnRoiCaptureCamera.onclick = captureRoiReferenceFromCamera;

  const btnRoiOpenTestImage = document.getElementById('btnRoiOpenTestImage');
  if (btnRoiOpenTestImage) btnRoiOpenTestImage.onclick = openTestImagePicker;

  const btnRoiUploadDevice = document.getElementById('btnRoiUploadDevice');
  const roiUploadDeviceInput = document.getElementById('roiUploadDeviceInput');
  if (btnRoiUploadDevice && roiUploadDeviceInput) {
    btnRoiUploadDevice.onclick = function () { roiUploadDeviceInput.click(); };
    roiUploadDeviceInput.onchange = function (e) {
      const file = e.target.files && e.target.files[0];
      if (file) loadRoiImageFromDeviceFile(file);
      roiUploadDeviceInput.value = '';
    };
  }

  document.getElementById('btnAddRoi').onclick = function () {
    if (!backgroundImage) {
      alert('Ambil gambar referensi dulu (tombol "Ambil Gambar dari Kamera" di atas) sebelum menambah ROI, supaya ROI-nya bisa digambar di atas gambar part yang benar.');
      return;
    }
    const name = 'ROI-' + (roiList.length + 1);
    roiList.push({ id: 'roi_' + Date.now(), name: name, points: [
      { x: 50, y: 50 }, { x: 200, y: 50 }, { x: 200, y: 200 }, { x: 50, y: 200 }
    ]});
    selectedRoiIndex = roiList.length - 1;
    renderRoiList();
    renderToolList();
    redrawCanvas();
  };

  document.getElementById('btnAddTool').onclick = function () {
    if (selectedRoiIndex === -1) { alert('Pilih ROI terlebih dahulu'); return; }
    const type = document.getElementById('toolTypeSelect').value;

    if (type === 'PatternMatch' && !capturedTemplateBase64) {
      alert('Untuk Pattern Match, ambil template referensi terlebih dahulu dengan tombol "Ambil Template dari ROI" sebelum menambah tool.');
      return;
    }

    recipe.tools = recipe.tools || [];
    const params = getDefaultParamsForTool(type);
    if (type === 'PatternMatch') {
      params.templateImageBase64 = capturedTemplateBase64;
    }
    recipe.tools.push({
      id: 'tool_' + Date.now(),
      type: type,
      roiId: roiList[selectedRoiIndex].id,
      params: params
    });
    capturedTemplateBase64 = null;
    renderToolList();
    alert('Tool ' + toolTypeLabel(type) + ' ditambahkan ke ' + roiList[selectedRoiIndex].name + '. Klik tombol "Edit" pada daftar tool di bawah untuk mengubah parameternya, lalu jangan lupa klik "Simpan Recipe".');
  };

  renderToolList();
}

/** Toggle antara empty-state ("Belum ada gambar referensi") dan kanvas ROI. */
function _updateRoiEmptyState() {
  const emptyState = document.getElementById('roiEmptyState');
  const canvas = document.getElementById('roiCanvas');
  if (!emptyState || !canvas) return;
  if (backgroundImage) {
    emptyState.classList.add('d-none');
    canvas.classList.remove('d-none');
  } else {
    emptyState.classList.remove('d-none');
    canvas.classList.add('d-none');
  }
}

/**
 * Nyalakan kamera default browser sebentar SAAT DIBUTUHKAN saja, ambil 1
 * frame sebagai gambar referensi untuk digambar ROI-nya, lalu langsung
 * matikan lagi kameranya (tidak perlu tetap menyala di ROI Editor). Ini
 * jalur alternatif kalau user membuka ROI Editor langsung (mis. dari
 * "Recipe Baru") tanpa lewat Camera Center/Run Mode dulu, supaya tidak
 * perlu bolak-balik menu hanya untuk dapat 1 gambar acuan.
 */
function captureRoiReferenceFromCamera() {
  const btn = document.getElementById('btnRoiCaptureCamera');
  const statusEl = document.getElementById('roiCaptureStatus');
  const video = document.getElementById('roiCaptureVideo');
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.innerText = 'Menyalakan kamera...';

  navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
    .then(function (stream) {
      video.srcObject = stream;
      video.muted = true;
      return video.play().catch(function () { /* abaikan, browser tertentu tetap render walau play() ditolak */ });
    })
    .then(function () {
      // Beri jeda singkat supaya frame video sempat ter-render sebelum di-capture
      // (langsung capture di frame pertama kadang masih hitam/belum siap).
      return new Promise(function (resolve) { setTimeout(resolve, 400); });
    })
    .then(function () {
      const canvasEl = document.getElementById('roiCanvas');
      const tmp = document.createElement('canvas');
      tmp.width = video.videoWidth;
      tmp.height = video.videoHeight;
      tmp.getContext('2d').drawImage(video, 0, 0);
      backgroundImage = tmp;
      canvasEl.width = tmp.width;
      canvasEl.height = tmp.height;

      // Matikan kamera lagi - ROI Editor hanya butuh 1 foto diam, bukan live stream.
      const stream = video.srcObject;
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      video.srcObject = null;

      _updateRoiEmptyState();
      redrawCanvas();
      if (btn) btn.disabled = false;
      if (statusEl) statusEl.innerText = 'Gambar referensi berhasil diambil.';
    })
    .catch(function (err) {
      if (btn) btn.disabled = false;
      if (statusEl) statusEl.innerText = 'Gagal mengakses kamera: ' + err.message;
    });
}

/**
 * Sumber gambar acuan ROI ke-3: unggah foto dari file di komputer/HP
 * (bukan dari kamera live atau folder Test Images) - berguna kalau
 * kamera belum tersedia/rusak saat menyiapkan recipe, atau operator
 * cuma punya foto contoh part dalam bentuk file.
 */
function loadRoiImageFromDeviceFile(file) {
  const statusEl = document.getElementById('roiCaptureStatus');
  if (statusEl) statusEl.innerText = 'Memuat foto...';
  const reader = new FileReader();
  reader.onload = function (e) {
    const imgEl = new Image();
    imgEl.onload = function () {
      const canvasEl = document.getElementById('roiCanvas');
      const tmp = document.createElement('canvas');
      tmp.width = imgEl.naturalWidth;
      tmp.height = imgEl.naturalHeight;
      tmp.getContext('2d').drawImage(imgEl, 0, 0);
      backgroundImage = tmp;
      canvasEl.width = tmp.width;
      canvasEl.height = tmp.height;

      _updateRoiEmptyState();
      redrawCanvas();
      if (statusEl) statusEl.innerText = 'Foto dari device berhasil dimuat sebagai gambar referensi.';
    };
    imgEl.onerror = function () {
      if (statusEl) statusEl.innerText = 'Gagal membaca file gambar. Coba file lain (JPG/PNG).';
    };
    imgEl.src = e.target.result;
  };
  reader.onerror = function () {
    if (statusEl) statusEl.innerText = 'Gagal membaca file.';
  };
  reader.readAsDataURL(file);
}

/* ==================================================================
   BUKA GAMBAR DARI TEST IMAGES
   Menu "Buka dari Test Images" - alternatif dari "Ambil Gambar dari
   Kamera", supaya Engineer bisa MEMILIH foto test terbaik (sudah pernah
   diambil sebelumnya lewat Camera Center - "Simpan Frame Ini") untuk
   dijadikan acuan menggambar ROI & set up tool, alih-alih harus selalu
   ambil frame baru langsung dari kamera saat itu juga. Gambar yang
   dipilih dipakai APA ADANYA (dimensi mengikuti ukuran asli file saat
   disimpan, tidak dipaksa ke ukuran tertentu).
   ================================================================== */
let testImageModalInstance = null;
let _testImageBase64Cache = {}; // fileId -> data URI, supaya klik pilih tidak fetch ulang dari yang sudah dimuat sbg thumbnail
const TEST_IMAGE_PICKER_LIMIT = 12; // batasi jumlah thumbnail yang dimuat sekaligus, supaya modal tidak lambat

function openTestImagePicker() {
  const modalEl = document.getElementById('openTestImageModal');
  if (!testImageModalInstance) testImageModalInstance = new bootstrap.Modal(modalEl);
  testImageModalInstance.show();

  const grid = document.getElementById('testImageGrid');
  const loadingMsg = document.getElementById('testImageLoadingMsg');
  const emptyMsg = document.getElementById('testImageEmptyMsg');
  grid.innerHTML = '';
  emptyMsg.classList.add('d-none');
  loadingMsg.classList.remove('d-none');
  _testImageBase64Cache = {};

  callApi('apiListTestImages', [TEST_IMAGE_PICKER_LIMIT, CURRENT_SESSION]).then(function (res) {
    loadingMsg.classList.add('d-none');
    if (!res.success) { alert('Gagal memuat daftar Test Images: ' + res.error); return; }
    if (!res.images || !res.images.length) { emptyMsg.classList.remove('d-none'); return; }

    res.images.forEach(function (img) {
      const col = document.createElement('div');
      col.className = 'col-4 col-md-3';
      col.innerHTML =
        '<div class="text-center">' +
          '<div class="roi-thumb-wrap" style="background:rgba(255,255,255,.05); border-radius:8px; height:110px; display:flex; align-items:center; justify-content:center; cursor:pointer; overflow:hidden;" data-file-id="' + img.fileId + '">' +
            '<span class="small text-muted">Memuat...</span>' +
          '</div>' +
          '<div class="small text-muted mt-1">' + img.dateFolder + '</div>' +
        '</div>';
      grid.appendChild(col);

      const wrap = col.querySelector('.roi-thumb-wrap');
      callApi('apiGetDriveImageBase64', [img.fileId, CURRENT_SESSION]).then(function (imgRes) {
        if (!imgRes.success) { wrap.innerHTML = '<span class="small text-danger">Gagal memuat</span>'; return; }
        _testImageBase64Cache[img.fileId] = imgRes.dataUri;
        wrap.innerHTML = '<img src="' + imgRes.dataUri + '" style="max-width:100%; max-height:100%;">';
        wrap.onclick = function () { selectTestImage(img.fileId); };
      }).catch(function () { wrap.innerHTML = '<span class="small text-danger">Gagal memuat</span>'; });
    });
  }).catch(function (err) {
    loadingMsg.classList.add('d-none');
    alert('Gagal memuat daftar Test Images: ' + err.message);
  });
}

function selectTestImage(fileId) {
  const dataUri = _testImageBase64Cache[fileId];
  if (!dataUri) return;

  const img = new Image();
  img.onload = function () {
    // Dimensi kanvas ROI mengikuti ukuran ASLI gambar yang dipilih (bukan
    // dipaksa 1280x720 atau ukuran lain) - sesuai permintaan: "dimensi
    // image-nya menyesuaikan saat di simpan".
    const canvasEl = document.getElementById('roiCanvas');
    const tmp = document.createElement('canvas');
    tmp.width = img.naturalWidth;
    tmp.height = img.naturalHeight;
    tmp.getContext('2d').drawImage(img, 0, 0);
    backgroundImage = tmp;
    canvasEl.width = tmp.width;
    canvasEl.height = tmp.height;

    _updateRoiEmptyState();
    redrawCanvas();
    if (testImageModalInstance) testImageModalInstance.hide();
    const statusEl = document.getElementById('roiCaptureStatus');
    if (statusEl) statusEl.innerText = 'Gambar referensi dimuat dari Test Images (' + tmp.width + 'x' + tmp.height + ').';
  };
  img.src = dataUri;
}

/**
 * Encode template Pattern Match jadi base64 sekecil mungkin sebelum
 * disimpan ke recipe (yang akhirnya ditulis ke 1 sel Google Sheets,
 * batas keras 50.000 karakter/sel). PNG lossless dari foto kamera resolusi
 * tinggi gampang tembus batas itu, apalagi kalau recipe punya beberapa
 * tool Pattern Match sekaligus. Strategi: turunkan resolusi template (toh
 * cuma dipakai untuk template matching, bukan ditampilkan besar-besar) lalu
 * encode JPEG, coba beberapa kombinasi ukuran/kualitas sampai muat aman
 * (target < 30.000 karakter, sisakan ruang utk data ROI/tool lain di recipe
 * yang sama).
 */
function _encodeTemplateForStorage(templateCanvas) {
  const MAX_CHARS = 30000;
  const attempts = [
    { maxDim: 260, quality: 0.80 },
    { maxDim: 260, quality: 0.60 },
    { maxDim: 180, quality: 0.60 },
    { maxDim: 180, quality: 0.40 },
    { maxDim: 120, quality: 0.40 }
  ];

  let best = null;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const scale = Math.min(1, a.maxDim / Math.max(templateCanvas.width, templateCanvas.height));
    const w = Math.max(1, Math.round(templateCanvas.width * scale));
    const h = Math.max(1, Math.round(templateCanvas.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(templateCanvas, 0, 0, w, h);
    const dataUri = c.toDataURL('image/jpeg', a.quality);
    best = dataUri;
    if (dataUri.length < MAX_CHARS) return dataUri;
  }

  alert('ROI yang dipilih terlalu besar/detail sehingga template masih melebihi batas 50.000 karakter per sel Google Sheets walau sudah dikompres maksimal. Coba perkecil area ROI-nya (fokus hanya ke bagian yang benar-benar mau dicocokkan, contoh: cincin tulisan bearing saja) lalu ambil template ulang.');
  return null;
}

function getDefaultParamsForTool(type) {
  switch (type) {
    // searchMarginPct = "Position Adjustment": ROI yang dipakai untuk MENCARI
    // template saat inspeksi diperbesar sekian % dari ukuran ROI/template asli
    // ke segala arah, supaya matchTemplate (OpenCV) punya ruang geser mencari
    // posisi terbaik ala fitur Position Correction Keyence IV4 - bukan cuma
    // membandingkan 1 posisi piksel yang persis sama seperti sebelumnya.
    case 'PatternMatch': return { threshold: 0.80, searchMarginPct: 30 };
    case 'Blob': return { minAreaMm2: 1.0 };
    case 'EdgeDimension': return { toleranceMm: 5.0, nominalMm: 0, axis: 'x' };
    case 'Presence': return { expectPresent: true, pixelThresholdPct: 5 };
    case 'Color': return { targetMean: 128, threshold: 20 };
    case 'QR': case 'Barcode': case 'OCR': return { rule: { mode: 'prefix', value: '' } };
    case 'Counting': return { minAreaMm2: 0.5, expectedMin: 1, expectedMax: 1 };
    case 'AIDetection': return { mode: 'defect', confidenceThreshold: 0.5, classFilter: [] };
    case 'AIClassification': return { expectedClass: '', confidenceThreshold: 0.5 };
    default: return {};
  }
}

function renderRoiList() {
  const ul = document.getElementById('roiList');
  ul.innerHTML = '';
  roiList.forEach(function (roi, idx) {
    const li = document.createElement('li');
    li.className = 'list-group-item d-flex justify-content-between align-items-center' + (idx === selectedRoiIndex ? ' active' : '');
    li.innerHTML = '<span>' + roi.name + '</span>';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-outline-danger';
    delBtn.innerText = 'x';
    delBtn.onclick = function (e) {
      e.stopPropagation();
      if (!confirm('Hapus ROI "' + roi.name + '"? Semua tool yang terpasang di ROI ini juga akan dihapus.')) return;
      const recipe = window.EDITING_RECIPE;
      if (recipe && recipe.tools) {
        recipe.tools = recipe.tools.filter(function (t) { return t.roiId !== roi.id; });
      }
      roiList.splice(idx, 1);
      if (selectedRoiIndex === idx) selectedRoiIndex = -1;
      else if (selectedRoiIndex > idx) selectedRoiIndex--;
      renderRoiList();
      renderToolList();
      redrawCanvas();
    };
    li.appendChild(delBtn);
    li.onclick = function () { selectedRoiIndex = idx; renderRoiList(); renderToolList(); redrawCanvas(); };
    ul.appendChild(li);
  });
}

/* ==================================================================
   DAFTAR TOOL PER ROI + EDIT PARAMETER / HAPUS TOOL
   ================================================================== */
function toolTypeLabel(type) {
  const labels = {
    PatternMatch: 'Pattern Matching', Blob: 'Blob / Defect Area', EdgeDimension: 'Edge / Dimension',
    Presence: 'Presence / Absence', Color: 'Color Inspection', QR: 'QR Reader',
    Barcode: 'Barcode Reader (1D)', OCR: 'OCR (Baca Teks)', Counting: 'Counting',
    AIDetection: 'AI Object Detection', AIClassification: 'AI Classification'
  };
  return labels[type] || type;
}

function renderToolList() {
  const listEl = document.getElementById('roiToolList');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (selectedRoiIndex === -1) {
    listEl.innerHTML = '<li class="list-group-item small text-muted">Pilih ROI untuk melihat tool-nya.</li>';
    return;
  }
  const roi = roiList[selectedRoiIndex];
  const recipe = window.EDITING_RECIPE || {};
  const tools = (recipe.tools || []).filter(function (t) { return t.roiId === roi.id; });

  if (tools.length === 0) {
    listEl.innerHTML = '<li class="list-group-item small text-muted">Belum ada tool di ROI ini.</li>';
    return;
  }

  tools.forEach(function (tool) {
    const li = document.createElement('li');
    li.className = 'list-group-item d-flex justify-content-between align-items-center py-1';

    const label = document.createElement('span');
    label.className = 'small';
    label.innerText = toolTypeLabel(tool.type);
    li.appendChild(label);

    const btnGroup = document.createElement('span');
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-sm btn-outline-primary me-1';
    editBtn.innerText = 'Edit';
    editBtn.onclick = function () { openEditToolModal(tool.id); };
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-outline-danger';
    delBtn.innerText = 'Hapus';
    delBtn.onclick = function () {
      if (!confirm('Hapus tool ' + toolTypeLabel(tool.type) + ' ini dari ' + roi.name + '?')) return;
      recipe.tools = (recipe.tools || []).filter(function (t) { return t.id !== tool.id; });
      renderToolList();
    };
    btnGroup.appendChild(editBtn);
    btnGroup.appendChild(delBtn);
    li.appendChild(btnGroup);

    listEl.appendChild(li);
  });
}

function openEditToolModal(toolId) {
  const recipe = window.EDITING_RECIPE || {};
  const tool = (recipe.tools || []).find(function (t) { return t.id === toolId; });
  if (!tool) return;
  editingToolId = toolId;

  const titleEl = document.getElementById('editToolModalTitle');
  if (titleEl) titleEl.innerText = 'Edit Parameter: ' + toolTypeLabel(tool.type);
  document.getElementById('editToolParamsBody').innerHTML = buildParamsFormHtml(tool.type, tool.params || {});

  if (!editToolModalInstance) {
    const modalEl = document.getElementById('editToolModal');
    if (modalEl) editToolModalInstance = new bootstrap.Modal(modalEl);
  }
  if (editToolModalInstance) editToolModalInstance.show();
}

function saveToolParamsFromModal() {
  const recipe = window.EDITING_RECIPE || {};
  const tool = (recipe.tools || []).find(function (t) { return t.id === editingToolId; });
  if (!tool) return;
  tool.params = readParamsFromForm(tool.type, tool.params || {});
  if (editToolModalInstance) editToolModalInstance.hide();
  renderToolList();
}

/** Helper pembuat elemen form HTML untuk modal edit parameter. */
function _field(label, type, id, value, attrs) {
  attrs = attrs || {};
  const attrStr = Object.keys(attrs).map(function (k) { return k + '="' + attrs[k] + '"'; }).join(' ');
  const safeValue = (value === null || value === undefined) ? '' : value;
  return '<div class="mb-2"><label class="form-label small">' + label + '</label>' +
    '<input type="' + type + '" id="' + id + '" class="form-control form-control-sm" value="' + safeValue + '" ' + attrStr + '></div>';
}
function _selectField(label, id, options, selected) {
  const opts = options.map(function (o) {
    return '<option value="' + o[0] + '"' + (o[0] === selected ? ' selected' : '') + '>' + o[1] + '</option>';
  }).join('');
  return '<div class="mb-2"><label class="form-label small">' + label + '</label>' +
    '<select id="' + id + '" class="form-select form-select-sm">' + opts + '</select></div>';
}
function _checkboxField(label, id, checked) {
  return '<div class="form-check mb-2"><input type="checkbox" id="' + id + '" class="form-check-input"' + (checked ? ' checked' : '') + '>' +
    '<label class="form-check-label small" for="' + id + '">' + label + '</label></div>';
}

/**
 * Membangun form HTML untuk mengedit parameter sesuai tipe tool. Daftar
 * parameter di sini HARUS sinkron dengan getDefaultParamsForTool() di atas
 * dan dengan validasi threshold di VisionToolsEngine.gs (server).
 */
function buildParamsFormHtml(type, params) {
  switch (type) {
    case 'PatternMatch':
      return _field('Threshold Similarity (0-1)', 'number', 'p_threshold', params.threshold, { step: 0.01, min: 0, max: 1 }) +
        _field('Margin Pencarian Posisi / Position Adjustment (%)', 'number', 'p_searchMarginPct', (params.searchMarginPct != null ? params.searchMarginPct : 30), { step: 5, min: 0, max: 200 }) +
        '<p class="small text-muted mb-0">Margin pencarian = seberapa jauh sistem boleh mencari template di sekitar ROI kalau posisi part sedikit bergeser dari saat template diambil (seperti Position Correction di Keyence IV4). Makin besar % = makin toleran pergeseran, tapi proses makin berat & berisiko "salah nemu" pola mirip di sekitarnya. Template referensi diambil lewat tombol "Ambil Template dari ROI", bukan dari form ini.</p>';
    case 'Blob':
      return _field('Min Area Defect (mm²)', 'number', 'p_minAreaMm2', params.minAreaMm2, { step: 0.01, min: 0 });
    case 'EdgeDimension':
      return _field('Toleransi (mm)', 'number', 'p_toleranceMm', params.toleranceMm, { step: 0.01, min: 0 }) +
        _field('Nominal (mm)', 'number', 'p_nominalMm', params.nominalMm, { step: 0.01 }) +
        _selectField('Sumbu (axis)', 'p_axis', [['x', 'X'], ['y', 'Y']], params.axis || 'x');
    case 'Presence':
      return _checkboxField('Objek harus ADA (expect present)', 'p_expectPresent', params.expectPresent) +
        _field('Threshold Piksel (%)', 'number', 'p_pixelThresholdPct', params.pixelThresholdPct, { step: 0.1, min: 0, max: 100 });
    case 'Color':
      return _field('Target Mean (0-255)', 'number', 'p_targetMean', params.targetMean, { step: 1, min: 0, max: 255 }) +
        _field('Toleransi (+/-)', 'number', 'p_threshold', params.threshold, { step: 1, min: 0 });
    case 'QR':
    case 'Barcode':
    case 'OCR':
      return _selectField('Mode Rule', 'p_ruleMode', [['prefix', 'Prefix'], ['exact', 'Exact'], ['regex', 'Regex']], (params.rule || {}).mode || 'prefix') +
        _field('Nilai Rule', 'text', 'p_ruleValue', (params.rule || {}).value || '');
    case 'Counting':
      return _field('Min Area per Objek (mm²)', 'number', 'p_minAreaMm2', params.minAreaMm2, { step: 0.01, min: 0 }) +
        _field('Jumlah Minimum', 'number', 'p_expectedMin', params.expectedMin, { step: 1, min: 0 }) +
        _field('Jumlah Maksimum', 'number', 'p_expectedMax', params.expectedMax, { step: 1, min: 0 });
    case 'AIDetection':
      return _selectField('Mode', 'p_mode', [['defect', 'Defect (NG jika ADA deteksi)'], ['presence', 'Presence (OK jika ADA deteksi)']], params.mode || 'defect') +
        _field('Confidence Threshold (0-1)', 'number', 'p_confidenceThreshold', params.confidenceThreshold, { step: 0.01, min: 0, max: 1 }) +
        _field('Filter Kelas (pisahkan koma, kosongkan = semua kelas)', 'text', 'p_classFilter', (params.classFilter || []).join(', '));
    case 'AIClassification':
      return _field('Kelas yang Diharapkan (kosongkan = kelas apapun)', 'text', 'p_expectedClass', params.expectedClass || '') +
        _field('Confidence Threshold (0-1)', 'number', 'p_confidenceThreshold', params.confidenceThreshold, { step: 0.01, min: 0, max: 1 });
    default:
      return '<p class="small text-muted mb-0">Tidak ada parameter yang bisa diedit untuk tipe tool ini.</p>';
  }
}

/** Membaca nilai form modal kembali menjadi objek params sesuai tipe tool. */
function readParamsFromForm(type, existingParams) {
  function num(id) { const el = document.getElementById(id); return el ? parseFloat(el.value) : undefined; }
  function str(id) { const el = document.getElementById(id); return el ? el.value : undefined; }
  function bool(id) { const el = document.getElementById(id); return el ? el.checked : undefined; }

  switch (type) {
    case 'PatternMatch':
      return Object.assign({}, existingParams, { threshold: num('p_threshold'), searchMarginPct: num('p_searchMarginPct') });
    case 'Blob':
      return Object.assign({}, existingParams, { minAreaMm2: num('p_minAreaMm2') });
    case 'EdgeDimension':
      return Object.assign({}, existingParams, { toleranceMm: num('p_toleranceMm'), nominalMm: num('p_nominalMm'), axis: str('p_axis') });
    case 'Presence':
      return Object.assign({}, existingParams, { expectPresent: bool('p_expectPresent'), pixelThresholdPct: num('p_pixelThresholdPct') });
    case 'Color':
      return Object.assign({}, existingParams, { targetMean: num('p_targetMean'), threshold: num('p_threshold') });
    case 'QR':
    case 'Barcode':
    case 'OCR':
      return Object.assign({}, existingParams, { rule: { mode: str('p_ruleMode'), value: str('p_ruleValue') } });
    case 'Counting':
      return Object.assign({}, existingParams, { minAreaMm2: num('p_minAreaMm2'), expectedMin: num('p_expectedMin'), expectedMax: num('p_expectedMax') });
    case 'AIDetection': {
      const cf = str('p_classFilter') || '';
      return Object.assign({}, existingParams, {
        mode: str('p_mode'),
        confidenceThreshold: num('p_confidenceThreshold'),
        classFilter: cf.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
      });
    }
    case 'AIClassification':
      return Object.assign({}, existingParams, { expectedClass: str('p_expectedClass'), confidenceThreshold: num('p_confidenceThreshold') });
    default:
      return existingParams;
  }
}

function redrawCanvas() {
  const canvas = document.getElementById('roiCanvas');
  roiCanvasCtx.clearRect(0, 0, canvas.width, canvas.height);
  if (backgroundImage) roiCanvasCtx.drawImage(backgroundImage, 0, 0);

  roiList.forEach(function (roi, idx) {
    roiCanvasCtx.beginPath();
    roi.points.forEach(function (p, i) {
      if (i === 0) roiCanvasCtx.moveTo(p.x, p.y); else roiCanvasCtx.lineTo(p.x, p.y);
    });
    roiCanvasCtx.closePath();
    roiCanvasCtx.strokeStyle = idx === selectedRoiIndex ? '#FF0000' : '#0055A4';
    roiCanvasCtx.lineWidth = 2;
    roiCanvasCtx.stroke();
    roiCanvasCtx.fillStyle = idx === selectedRoiIndex ? 'rgba(255,0,0,0.15)' : 'rgba(0,85,164,0.10)';
    roiCanvasCtx.fill();

    // titik-titik polygon (draggable)
    roi.points.forEach(function (p) {
      roiCanvasCtx.beginPath();
      roiCanvasCtx.arc(p.x, p.y, 5, 0, 2 * Math.PI);
      roiCanvasCtx.fillStyle = '#003366';
      roiCanvasCtx.fill();
    });

    roiCanvasCtx.fillStyle = '#003366';
    roiCanvasCtx.font = '12px sans-serif';
    roiCanvasCtx.fillText(roi.name, roi.points[0].x, roi.points[0].y - 8);
  });
}

/**
 * Konversi posisi klik mouse (koordinat CSS/layar, karena #roiCanvas
 * sekarang di-scale via CSS width:100% supaya sama seperti monitor Camera
 * Center - lihat style.css) balik ke koordinat PIKSEL ASLI kanvas (tempat
 * roi.points sebenarnya disimpan/digambar). Tanpa ini, titik ROI akan
 * meleset dari posisi klik begitu kanvas ditampilkan mengecil dari ukuran
 * aslinya (mis. gambar 1920x1080 ditampilkan lebar 800px di layar).
 */
function _getCanvasPoint(e) {
  const canvas = e.target;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY
  };
}

function onCanvasMouseDown(e) {
  if (selectedRoiIndex === -1) return;
  const p0 = _getCanvasPoint(e);
  const roi = roiList[selectedRoiIndex];

  // Toleransi jangkauan klik dijaga tetap ~8 piksel LAYAR (bukan piksel
  // kanvas asli) supaya titik ROI tetap mudah diklik walau gambar aslinya
  // besar dan ditampilkan mengecil (mis. 1920px ditampilkan di layar 800px).
  const canvas = e.target;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const hitToleranceCanvasPx = 8 * scaleX;

  draggingPointIndex = roi.points.findIndex(function (p) {
    return Math.hypot(p.x - p0.x, p.y - p0.y) < hitToleranceCanvasPx;
  });
}

function onCanvasMouseMove(e) {
  if (draggingPointIndex === -1 || selectedRoiIndex === -1) return;
  const p = _getCanvasPoint(e);
  roiList[selectedRoiIndex].points[draggingPointIndex] = p;
  redrawCanvas();
}

/** Double-click di dalam polygon = tambah titik baru di tengah edge terdekat */
function onCanvasDoubleClick(e) {
  if (selectedRoiIndex === -1) return;
  const p = _getCanvasPoint(e);
  const roi = roiList[selectedRoiIndex];
  roi.points.push(p);
  redrawCanvas();
}
