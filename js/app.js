/* ==================================================================
   MAP-IN Vision V1.0 - app.js (SPA Router, Auth, Dashboard, History)
   Dikonversi dari app_js.html: seluruh pemanggilan google.script.run
   diganti callApi() (lihat js/api.js) karena frontend kini di-hosting
   terpisah dari backend Apps Script.
   ================================================================== */

let CURRENT_SESSION = null;
let CURRENT_USER = null;
let ACTIVE_RECIPE = null;

document.addEventListener('DOMContentLoaded', function () {
  bindLogin();
  bindNav();
  bindHistory();
  bindIoMonitor();
  bindAiCenter();
  bindSettings();
  tryRestoreSession();
});

/* ---------------- LOGIN ---------------- */
function bindLogin() {
  document.getElementById('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    const u = document.getElementById('loginUsername').value;
    const p = document.getElementById('loginPassword').value;

    callApi('apiLogin', [u, p]).then(function (res) {
      if (res.success) {
        CURRENT_SESSION = res.sessionToken;
        CURRENT_USER = res.user;
        saveSessionToken(res.sessionToken);
        document.getElementById('loginScreen').classList.add('d-none');
        document.getElementById('appShell').classList.remove('d-none');
        document.getElementById('userFullName').innerText = res.user.fullName;
        document.getElementById('userRoleBadge').innerText = res.user.role;
        loadDashboard();
      } else {
        document.getElementById('loginError').innerText = res.error;
      }
    }).catch(function (err) {
      document.getElementById('loginError').innerText = 'Gagal terhubung ke server: ' + err.message;
    });
  });

  document.getElementById('logoutBtn').addEventListener('click', function () {
    callApi('apiLogout', [CURRENT_SESSION]).catch(function () { /* abaikan error saat logout */ });
    clearSessionToken();
    location.reload();
  });
}

/**
 * Memulihkan sesi login dari localStorage (mis. setelah refresh halaman
 * tidak sengaja), tanpa perlu login ulang, selama token belum kadaluarsa
 * di server. Ini pengganti perilaku SPA Apps Script lama yang tidak pernah
 * reload halaman sama sekali - sekarang sebagai halaman statis biasa,
 * refresh browser mungkin terjadi, jadi token session perlu disimpan.
 */
function tryRestoreSession() {
  const token = loadSessionToken();
  if (!token) return;
  callApi('apiGetCurrentUser', [token]).then(function (res) {
    if (res.success) {
      CURRENT_SESSION = token;
      CURRENT_USER = res.user;
      document.getElementById('loginScreen').classList.add('d-none');
      document.getElementById('appShell').classList.remove('d-none');
      document.getElementById('userFullName').innerText = res.user.fullName;
      document.getElementById('userRoleBadge').innerText = res.user.role;
      loadDashboard();
    } else {
      clearSessionToken();
    }
  }).catch(function () { /* server belum bisa dihubungi, biarkan pengguna login manual */ });
}

/* ---------------- NAVIGATION / ROUTER ---------------- */
function bindNav() {
  document.querySelectorAll('.nav-menu li').forEach(function (li) {
    li.addEventListener('click', function () {
      document.querySelectorAll('.nav-menu li').forEach(function (x) { x.classList.remove('active'); });
      li.classList.add('active');
      const view = li.getAttribute('data-view');
      showView(view);
    });
  });
}

let _currentViewName = null;

function showView(viewName) {
  // Matikan kamera/polling dari menu yang sedang ditinggalkan, supaya
  // kamera tidak tetap menyala di belakang layar saat pindah menu.
  if (_currentViewName === 'camera' && viewName !== 'camera' && typeof stopCamera === 'function') {
    stopCamera();
  }
  if (_currentViewName === 'run' && viewName !== 'run' && typeof stopRunMode === 'function') {
    stopRunMode();
  }
  _currentViewName = viewName;

  document.querySelectorAll('.view').forEach(function (v) { v.classList.add('d-none'); });
  document.getElementById('view-' + viewName).classList.remove('d-none');
  document.getElementById('viewTitle').innerText = document.querySelector('.nav-menu li[data-view="' + viewName + '"]').innerText.trim();

  if (viewName === 'dashboard') loadDashboard();
  if (viewName === 'camera') initCameraCenter();
  if (viewName === 'recipe') loadRecipeList();
  if (viewName === 'roiEditor') initRoiEditor();
  if (viewName === 'run') initRunMode();
  if (viewName === 'history') loadHistory();
  if (viewName === 'ioMonitor') refreshIoStatus();
  if (viewName === 'aiCenter') loadAiModelList();
  if (viewName === 'settings') loadBackupHistory();
}

/* ---------------- DASHBOARD ---------------- */
let dailyTrendChartInstance = null;

function loadDashboard() {
  callApi('apiGetDashboardStats', [{}, CURRENT_SESSION]).then(function (res) {
    if (!res.success) { console.warn('Gagal memuat dashboard:', res.error); return; }
    document.getElementById('statProdToday').innerText = res.productionToday;
    document.getElementById('statOk').innerText = res.okCount;
    document.getElementById('statNg').innerText = res.ngCount;
    document.getElementById('statYield').innerText = res.yieldPct + '%';

    const topNgList = document.getElementById('topNgList');
    topNgList.innerHTML = '';
    res.topNg.forEach(function (item) {
      const li = document.createElement('li');
      li.className = 'd-flex justify-content-between border-bottom py-1';
      li.innerHTML = '<span>' + item.reason + '</span><strong>' + item.count + '</strong>';
      topNgList.appendChild(li);
    });

    const ctx = document.getElementById('dailyTrendChart');
    if (dailyTrendChartInstance) dailyTrendChartInstance.destroy();
    dailyTrendChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: res.dailyTrend.map(function (d) { return d.date; }),
        datasets: [
          { label: 'OK', data: res.dailyTrend.map(function (d) { return d.ok; }), backgroundColor: '#00C853' },
          { label: 'NG', data: res.dailyTrend.map(function (d) { return d.ng; }), backgroundColor: '#FF0000' }
        ]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });
  }).catch(function (err) { console.warn('Gagal memuat dashboard:', err.message); });
}

/* ---------------- RECIPE MANAGEMENT ---------------- */
function loadRecipeList() {
  callApi('apiListRecipes', [CURRENT_SESSION]).then(function (res) {
    if (!res.success && res.error) { console.warn('Gagal memuat recipe:', res.error); }
    const tbody = document.querySelector('#recipeTable tbody');
    tbody.innerHTML = '';
    (res.recipes || []).forEach(function (r) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + r.name + '</td>' +
        '<td>v' + r.version + '</td>' +
        '<td>' + (r.isActive ? '<span class="badge bg-success">Aktif</span>' : '<span class="badge bg-secondary">-</span>') + '</td>' +
        '<td>' +
          '<button class="btn btn-sm btn-outline-primary me-1" onclick="editRecipe(\'' + r.id + '\')">Edit</button>' +
          '<button class="btn btn-sm btn-outline-success me-1" onclick="activateRecipe(\'' + r.id + '\')">Aktifkan</button>' +
          '<button class="btn btn-sm btn-outline-secondary me-1" onclick="duplicateRecipe(\'' + r.id + '\')">Duplikat</button>' +
          '<button class="btn btn-sm btn-outline-danger" onclick="deleteRecipe(\'' + r.id + '\')">Hapus</button>' +
        '</td>';
      tbody.appendChild(tr);
    });
  }).catch(function (err) { console.warn('Gagal memuat recipe:', err.message); });
}

function _handleAuthedResult(res, onOk) {
  if (res && res.success === false && res.error) { alert(res.error); return; }
  if (onOk) onOk(res);
}
function activateRecipe(id) {
  callApi('apiActivateRecipe', [id, CURRENT_SESSION]).then(function (res) { _handleAuthedResult(res, loadRecipeList); });
}
function duplicateRecipe(id) {
  callApi('apiDuplicateRecipe', [id, CURRENT_SESSION]).then(function (res) { _handleAuthedResult(res, loadRecipeList); });
}
function deleteRecipe(id) {
  if (!confirm('Hapus recipe ini?')) return;
  callApi('apiDeleteRecipe', [id, CURRENT_SESSION]).then(function (res) { _handleAuthedResult(res, loadRecipeList); });
}
function editRecipe(id) {
  callApi('apiGetRecipe', [id, CURRENT_SESSION]).then(function (res) {
    if (res.success === false && res.error) { alert(res.error); return; }
    window.EDITING_RECIPE = res.recipe;
    document.querySelector('.nav-menu li[data-view="roiEditor"]').click();
  });
}

document.addEventListener('DOMContentLoaded', function () {
  const btn = document.getElementById('btnNewRecipe');
  if (btn) btn.addEventListener('click', function () {
    window.EDITING_RECIPE = { name: 'Recipe Baru', tools: [], rois: [], decisionRule: { template: 'ALL_PASS' } };
    document.querySelector('.nav-menu li[data-view="roiEditor"]').click();
  });
});

/* ---------------- HISTORY & EXPORT ---------------- */
function bindHistory() {
  document.getElementById('btnExportCsv').addEventListener('click', function () {
    const filter = getHistoryFilter();
    callApi('apiExportCsv', [filter, CURRENT_SESSION]).then(function (res) {
      if (res.success === false) { alert(res.error); return; }
      alert('Export selesai: ' + res.fileName + ' (' + res.rowCount + ' baris)\n' + res.fileUrl);
    });
  });
  document.getElementById('btnExportNgPackage').addEventListener('click', function () {
    const filter = getHistoryFilter();
    callApi('apiExportNgPackage', [filter, CURRENT_SESSION]).then(function (res) {
      if (res.success === false) { alert(res.error); return; }
      alert('Paket NG selesai dibuat: ' + res.ngCount + ' record NG.\n' + res.reportUrl);
    });
  });
  ['filterDateFrom','filterDateTo','filterDecision','filterSearch'].forEach(function(id){
    document.getElementById(id).addEventListener('change', loadHistory);
  });
}

function getHistoryFilter() {
  return {
    dateFrom: document.getElementById('filterDateFrom').value,
    dateTo: document.getElementById('filterDateTo').value,
    decision: document.getElementById('filterDecision').value,
    searchText: document.getElementById('filterSearch').value
  };
}

function loadHistory() {
  callApi('apiGetHistory', [getHistoryFilter(), CURRENT_SESSION]).then(function (res) {
    if (res.success === false && res.error) { console.warn('Gagal memuat history:', res.error); }
    const tbody = document.querySelector('#historyTable tbody');
    tbody.innerHTML = '';
    (res.records || []).forEach(function (r) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + new Date(r.timestamp).toLocaleString('id-ID') + '</td>' +
        '<td>' + r.recipeName + '</td>' +
        '<td>' + (r.operator || '-') + '</td>' +
        '<td><span class="badge ' + (r.decision === 'OK' ? 'bg-success' : 'bg-danger') + '">' + r.decision + '</span></td>' +
        '<td class="small text-danger">' + (r.ngReason || '') + '</td>' +
        '<td>' + r.cycleTimeMs + '</td>' +
        '<td>' + (r.imagePath ? '<a href="' + r.imagePath + '" target="_blank">Lihat</a>' : '-') + '</td>';
      tbody.appendChild(tr);
    });
  }).catch(function (err) { console.warn('Gagal memuat history:', err.message); });
}

/* ---------------- IO MONITOR ---------------- */
function bindIoMonitor() {
  document.querySelectorAll('#view-ioMonitor [data-signal]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const signal = btn.getAttribute('data-signal');
      callApi('apiManualTestOutput', [signal, CURRENT_SESSION]).then(function (res) {
        if (res && res.success === false) { alert(res.error); return; }
        logSignal(signal);
      });
    });
  });
}

function refreshIoStatus() {
  callApi('apiGetIoStatusForUi', [CURRENT_SESSION]).then(function (res) {
    if (res.error) { console.warn('Gagal memuat status IO:', res.error); return; }
    document.getElementById('deviceStatusList').innerHTML =
      '<div class="d-flex justify-content-between"><span>Status Saat Ini</span><strong>' + res.status + '</strong></div>' +
      '<div class="text-muted small">Update: ' + (res.updatedAt || '-') + '</div>';
  }).catch(function (err) { console.warn('Gagal memuat status IO:', err.message); });
}

function logSignal(signal) {
  const box = document.getElementById('signalHistoryLog');
  const line = document.createElement('div');
  line.innerText = '[' + new Date().toLocaleTimeString('id-ID') + '] OUTPUT -> ' + signal;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

/* ---------------- AI DETECTION CENTER (Module 6) ---------------- */
function bindAiCenter() {
  document.getElementById('btnGenerateColab').addEventListener('click', function () {
    const recipeName = document.getElementById('colabRecipeName').value || 'UnnamedRecipe';
    const classes = document.getElementById('colabDefectClasses').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);

    callApi('apiGenerateColabNotebook', [recipeName, classes, CURRENT_SESSION]).then(function (res) {
      if (res.success === false) { alert(res.error); return; }
      alert(res.message + (res.configUrl ? '\n\nFile konfigurasi: ' + res.configUrl : ''));
      window.open('https://colab.research.google.com/', '_blank');
    });
  });

  document.getElementById('importModelForm').addEventListener('submit', function (e) {
    e.preventDefault();
    const fileInput = document.getElementById('modelFileInput');
    if (!fileInput.files.length) { alert('Pilih file .onnx terlebih dahulu'); return; }

    const file = fileInput.files[0];
    const reader = new FileReader();
    reader.onload = function () {
      const base64 = reader.result; // data:application/octet-stream;base64,....

      const payload = {
        modelType: document.getElementById('modelTypeInput').value || 'detection',
        modelName: document.getElementById('modelNameInput').value,
        classes: document.getElementById('modelClassesInput').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        baseModel: document.getElementById('modelBaseInput').value,
        mAP50: parseFloat(document.getElementById('modelMapInput').value) || 0,
        fileBase64: base64,
        targetHardware: 'CPU-only'
      };

      callApi('apiRegisterAiModel', [payload, CURRENT_SESSION]).then(function (res) {
        if (res.success) {
          alert('Model berhasil diimpor dan didaftarkan (ID: ' + res.modelId + '). Aktifkan model dari tabel di sebelah kanan agar dipakai saat Run Mode.');
          document.getElementById('importModelForm').reset();
          loadAiModelList();
        } else {
          alert('Gagal import model: ' + res.error);
        }
      });
    };
    reader.readAsDataURL(file);
  });
}

function loadAiModelList() {
  callApi('apiListAiModels', [CURRENT_SESSION]).then(function (res) {
    if (res.success === false && res.error) { console.warn('Gagal memuat daftar model:', res.error); }
    const tbody = document.querySelector('#modelTable tbody');
    tbody.innerHTML = '';
    (res.models || []).forEach(function (m) {
      let classes = [];
      try { classes = JSON.parse(m.classes); } catch (e) { classes = []; }
      const modelType = m.modelType || 'detection';
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + m.modelName + '</td>' +
        '<td><span class="badge ' + (modelType === 'classification' ? 'bg-info' : 'bg-primary') + '">' + (modelType === 'classification' ? 'Classification' : 'Detection') + '</span></td>' +
        '<td class="small">' + classes.join(', ') + '</td>' +
        '<td>' + (m.mAP50 ? (m.mAP50 * 100).toFixed(1) + '%' : '-') + '</td>' +
        '<td>' + (m.isActive ? '<span class="badge bg-success">Aktif</span>' : '<span class="badge bg-secondary">-</span>') + '</td>' +
        '<td><button class="btn btn-sm btn-outline-success" onclick="activateAiModel(\'' + m.id + '\')">Aktifkan</button></td>';
      tbody.appendChild(tr);
    });
  }).catch(function (err) { console.warn('Gagal memuat daftar model:', err.message); });
}

function activateAiModel(modelId) {
  callApi('apiActivateAiModel', [modelId, CURRENT_SESSION]).then(function (res) {
    if (res && res.success === false) { alert(res.error); return; }
    loadAiModelList();
    alert('Model diaktifkan. Model ini akan otomatis dimuat browser saat Run Mode berjalan pada recipe dengan tool AI Object Detection / AI Classification (sesuai tipe model).');
  });
}

/* ---------------- SETTINGS / BACKUP (Module 9) ----------------
   CATATAN: sebelumnya tombol "Backup Sekarang" hanya tampilan statis,
   tidak terhubung ke fungsi apa pun. Sekarang benar-benar memanggil
   BackupService.gs (via apiRunManualBackup) yang menyalin Spreadsheet
   database ke folder Drive/Backups. */
function bindSettings() {
  const btn = document.getElementById('btnBackupNow');
  if (!btn) return;
  btn.addEventListener('click', function () {
    btn.disabled = true;
    const originalText = btn.innerText;
    btn.innerText = 'Membuat backup...';
    callApi('apiRunManualBackup', [CURRENT_SESSION])
      .then(function (res) {
        btn.disabled = false;
        btn.innerText = originalText;
        if (res.success) {
          alert('Backup berhasil dibuat: ' + res.backupName + '\n' + res.backupUrl);
          loadBackupHistory();
        } else {
          alert('Backup gagal: ' + res.error);
        }
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.innerText = originalText;
        alert('Backup gagal: ' + err.message);
      });
  });
}

function loadBackupHistory() {
  const box = document.getElementById('backupHistoryList');
  if (!box) return;
  callApi('apiGetBackupHistory', [CURRENT_SESSION]).then(function (res) {
    if (res.success === false && res.error) { box.innerHTML = '<span class="text-muted small">' + res.error + '</span>'; return; }
    const backups = res.backups || [];
    if (backups.length === 0) {
      box.innerHTML = '<span class="text-muted small">Belum ada backup. Klik "Backup Sekarang" untuk membuat yang pertama.</span>';
      return;
    }
    box.innerHTML = backups.map(function (b) {
      return '<div class="d-flex justify-content-between border-bottom py-1 small">' +
        '<span>' + b.name + '</span>' +
        '<a href="' + b.url + '" target="_blank">Buka</a></div>';
    }).join('');
  }).catch(function (err) { box.innerHTML = '<span class="text-muted small">Gagal memuat: ' + err.message + '</span>'; });
}
