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
      closeMobileSidebar();
    });
  });
  bindMobileSidebarToggle();
}

/**
 * Sidebar di layar HP/tablet sempit (<=900px, lihat @media di style.css)
 * disembunyikan sebagai drawer yang muncul dari kiri saat tombol hamburger
 * (#navToggleBtn) di topbar diklik, supaya tampilan tidak "kacau" (menu
 * memenuhi layar) saat dibuka dari browser HP.
 */
function bindMobileSidebarToggle() {
  const toggleBtn = document.getElementById('navToggleBtn');
  const sidebar = document.getElementById('sidebarNav');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (!toggleBtn || !sidebar || !backdrop) return;
  toggleBtn.addEventListener('click', function () {
    sidebar.classList.toggle('open');
    backdrop.classList.toggle('show');
  });
  backdrop.addEventListener('click', closeMobileSidebar);
}

function closeMobileSidebar() {
  const sidebar = document.getElementById('sidebarNav');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (sidebar) sidebar.classList.remove('open');
  if (backdrop) backdrop.classList.remove('show');
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
  if (_currentViewName === 'dashboard' && viewName !== 'dashboard') {
    stopDashboardPolling();
  }
  if (_currentViewName === 'ioMonitor' && viewName !== 'ioMonitor') {
    stopIoStatusPolling();
  }
  _currentViewName = viewName;

  document.querySelectorAll('.view').forEach(function (v) { v.classList.add('d-none'); });
  document.getElementById('view-' + viewName).classList.remove('d-none');
  // Ambil teks label menu SAJA (span.nav-label), bukan seluruh isi <li> - sebelumnya
  // innerText <li> ikut menyertakan nama ligature ikon Material Icons (mis. "receipt_long")
  // sehingga judul halaman di topbar sempat tertulis 2 baris "receipt_long\nRecipe Management".
  const navLi = document.querySelector('.nav-menu li[data-view="' + viewName + '"]');
  const navLabel = navLi.querySelector('.nav-label');
  document.getElementById('viewTitle').innerText = (navLabel ? navLabel.innerText : navLi.innerText).trim();

  if (viewName === 'dashboard') loadDashboard();
  if (viewName === 'camera') initCameraCenter();
  if (viewName === 'recipe') loadRecipeList();
  if (viewName === 'roiEditor') initRoiEditor();
  if (viewName === 'run') initRunMode();
  if (viewName === 'history') loadHistory();
  if (viewName === 'ioMonitor') startIoStatusPolling();
  if (viewName === 'aiCenter') loadAiModelList();
  if (viewName === 'settings') loadBackupHistory();
}

/* ---------------- DASHBOARD ---------------- */
let dailyTrendChartInstance = null;
let resultSummaryChartInstance = null;
const DASH_TARGET_FPY = 95; // target FPY statis - sesuaikan kalau perlu dibuat configurable dari Settings nanti

function loadDashboard() {
  callApi('apiGetDashboardStats', [{}, CURRENT_SESSION]).then(function (res) {
    if (!res.success) { console.warn('Gagal memuat dashboard:', res.error); return; }

    document.getElementById('statProdToday').innerText = res.totalInspections;
    document.getElementById('statOk').innerText = res.okCount;
    document.getElementById('statNg').innerText = res.ngCount;
    document.getElementById('statYield').innerText = res.yieldPct + '%';
    document.getElementById('statCycleTime').innerText = res.avgCycleTimeMs ? (res.avgCycleTimeMs / 1000).toFixed(1) + 's' : '-';
    document.getElementById('statUph').innerText = res.avgCycleTimeMs ? Math.round(3600000 / res.avgCycleTimeMs) : '-';

    // Delta dibandingkan dengan hari sebelumnya, dihitung dari 2 entri terakhir
    // dailyTrend (bukan simulasi - kalau datanya belum cukup 2 hari, tampilkan "-").
    _renderDashDeltas(res.dailyTrend);

    // ---- Top 5 Defect (bar list dengan persentase dari total NG) ----
    const topNgList = document.getElementById('topNgList');
    topNgList.innerHTML = '';
    const ngTotal = res.ngCount || 1;
    (res.topNg || []).slice(0, 5).forEach(function (item) {
      const pct = Math.round((item.count / ngTotal) * 100);
      const li = document.createElement('li');
      li.innerHTML =
        '<div class="dash-defect-row"><span>' + item.reason + '</span><span>' + item.count + ' (' + pct + '%)</span></div>' +
        '<div class="dash-defect-bar-bg"><div class="dash-defect-bar-fill" style="width:' + pct + '%;"></div></div>';
      topNgList.appendChild(li);
    });
    if (!(res.topNg || []).length) {
      topNgList.innerHTML = '<li class="text-muted small">Belum ada data NG.</li>';
    }

    // ---- Inspection Trend (bar OK/NG + garis FPY%) ----
    const ctx = document.getElementById('dailyTrendChart');
    if (dailyTrendChartInstance) dailyTrendChartInstance.destroy();
    const fpySeries = res.dailyTrend.map(function (d) {
      const total = d.ok + d.ng;
      return total > 0 ? Math.round((d.ok / total) * 1000) / 10 : null;
    });
    dailyTrendChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: res.dailyTrend.map(function (d) { return d.date; }),
        datasets: [
          { type: 'bar', label: 'OK', data: res.dailyTrend.map(function (d) { return d.ok; }), backgroundColor: '#37e28c', yAxisID: 'y' },
          { type: 'bar', label: 'NG', data: res.dailyTrend.map(function (d) { return d.ng; }), backgroundColor: '#ff6b6b', yAxisID: 'y' },
          { type: 'line', label: 'FPY (%)', data: fpySeries, borderColor: '#4dabf7', backgroundColor: '#4dabf7', yAxisID: 'y1', tension: .3 }
        ]
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { color: '#cdd3ea' } } },
        scales: {
          x: { ticks: { color: '#98a2c0' }, grid: { color: 'rgba(255,255,255,.06)' } },
          y: { position: 'left', ticks: { color: '#98a2c0' }, grid: { color: 'rgba(255,255,255,.06)' } },
          y1: { position: 'right', min: 0, max: 100, ticks: { color: '#98a2c0' }, grid: { display: false } }
        }
      }
    });

    // ---- Result Summary (donut OK vs NG) ----
    const rctx = document.getElementById('resultSummaryChart');
    if (resultSummaryChartInstance) resultSummaryChartInstance.destroy();
    resultSummaryChartInstance = new Chart(rctx, {
      type: 'doughnut',
      data: {
        labels: ['OK', 'NG'],
        datasets: [{ data: [res.okCount, res.ngCount], backgroundColor: ['#37e28c', '#ff6b6b'], borderWidth: 0 }]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { color: '#cdd3ea' } } } }
    });
    document.getElementById('dashTargetFpy').innerText = DASH_TARGET_FPY + '%';
    document.getElementById('dashAchievementFpy').innerText = res.yieldPct + '%';

    // ---- Hasil Inspeksi Terakhir ----
    _renderDashLastResult(res.lastResult);

    // ---- Hasil Terbaru (5 item) ----
    const recentList = document.getElementById('recentResultsList');
    recentList.innerHTML = '';
    (res.recentResults || []).forEach(function (r) {
      const li = document.createElement('li');
      const timeStr = r.timestamp ? new Date(r.timestamp).toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '-';
      li.innerHTML =
        '<span class="dash-recent-decision ' + (r.decision === 'OK' ? 'ok' : 'ng') + '">' + r.decision + '</span>' +
        '<span class="flex-fill mx-2 text-truncate">' + (r.recipeName || '-') + '</span>' +
        '<span class="text-muted">' + timeStr + '</span>';
      recentList.appendChild(li);
    });
    if (!(res.recentResults || []).length) {
      recentList.innerHTML = '<li class="text-muted small">Belum ada data.</li>';
    }
  }).catch(function (err) { console.warn('Gagal memuat dashboard:', err.message); });

  // ---- Status Sistem: Model AI aktif (data asli dari AI Detection Center, bukan simulasi) ----
  callApi('apiGetActiveAiModel', ['detection', CURRENT_SESSION]).then(function (res) {
    const dot = document.getElementById('dashModelDot');
    const statusEl = document.getElementById('dashModelStatus');
    if (res.success && res.model) {
      dot.classList.add('dash-dot-online');
      statusEl.innerText = res.model.name ? (res.model.name + ' (aktif)') : 'Aktif';
    } else {
      dot.classList.add('dash-dot-offline');
      statusEl.innerText = 'Belum ada model aktif';
    }
  }).catch(function () {
    document.getElementById('dashModelStatus').innerText = 'Gagal memuat';
  });

  const userNameEl = document.getElementById('dashUserName');
  if (userNameEl) userNameEl.innerText = (CURRENT_USER && CURRENT_USER.fullName) ? CURRENT_USER.fullName : '-';

  startDashboardPolling();
}

function _renderDashDeltas(dailyTrend) {
  const ids = { total: 'deltaTotal', ok: 'deltaOk', ng: 'deltaNg', yield: 'deltaYield' };
  if (!dailyTrend || dailyTrend.length < 2) {
    Object.values(ids).forEach(function (id) { document.getElementById(id).innerText = 'vs hari sblm: data blm cukup'; });
    return;
  }
  const today = dailyTrend[dailyTrend.length - 1];
  const prev = dailyTrend[dailyTrend.length - 2];
  const todayTotal = today.ok + today.ng, prevTotal = prev.ok + prev.ng;
  const todayFpy = todayTotal ? (today.ok / todayTotal * 100) : 0;
  const prevFpy = prevTotal ? (prev.ok / prevTotal * 100) : 0;

  function fmt(id, delta, suffix) {
    suffix = suffix || '';
    const sign = delta > 0 ? '+' : '';
    const el = document.getElementById(id);
    el.innerText = sign + delta.toFixed(1) + suffix + ' vs hari sblm';
    el.style.color = delta > 0 ? '#37e28c' : (delta < 0 ? '#ff6b6b' : '#7c8bb5');
  }
  fmt(ids.total, todayTotal - prevTotal);
  fmt(ids.ok, today.ok - prev.ok);
  fmt(ids.ng, today.ng - prev.ng);
  fmt(ids.yield, todayFpy - prevFpy, '%');
}

// Simpan fileId foto yang gambarnya SEDANG ditampilkan, supaya polling
// tiap beberapa detik tidak berulang kali minta ulang gambar yang sama
// ke Drive (baru fetch ulang kalau memang ada hasil baru/fileId berubah).
let _lastDashImageFileId = null;

function _renderDashLastResult(last) {
  const empty = document.getElementById('lastResultEmpty');
  const meta = document.getElementById('lastResultMeta');
  const badge = document.getElementById('lastResultBadge');
  if (!last) {
    empty.classList.remove('d-none');
    meta.classList.add('d-none');
    badge.innerText = '-';
    return;
  }
  empty.classList.add('d-none');
  meta.classList.remove('d-none');
  badge.innerText = last.decision;
  badge.style.background = last.decision === 'OK' ? 'rgba(0,200,83,.25)' : 'rgba(255,0,0,.25)';
  badge.style.color = last.decision === 'OK' ? '#37e28c' : '#ff6b6b';
  document.getElementById('lastResultRecipe').innerText = last.recipeName || '-';
  document.getElementById('lastResultTime').innerText = last.timestamp ? new Date(last.timestamp).toLocaleString('id-ID') : '-';
  document.getElementById('lastResultCycle').innerText = last.cycleTimeMs ? (last.cycleTimeMs / 1000).toFixed(1) + 's' : '-';
  document.getElementById('lastResultNgReason').innerText = last.ngReasonType || '-';
  const imgLink = document.getElementById('lastResultImgLink');
  if (last.imagePath) {
    imgLink.href = last.imagePath;
    imgLink.classList.remove('d-none');
  } else {
    imgLink.classList.add('d-none');
  }

  // Foto berganti mengikuti hasil cycle inspeksi terbaru (bukan live stream
  // kamera), otomatis ter-refresh tiap kali loadDashboard() dipanggil ulang
  // lewat polling di bawah. Ada 2 sumber foto:
  //  1. imageFileId terisi -> foto tersimpan PERMANEN di Drive (mis. NG,
  //     atau recipe dengan policy OK_AND_NG) -> apiGetDriveImageBase64.
  //  2. imageFileId kosong TAPI decision OK & recordId ada -> foto TIDAK
  //     disimpan ke Drive (hemat storage - policy default NG_ONLY), tapi
  //     masih ada di cache sementara Apps Script (berlaku ~6 jam) ->
  //     apiGetTempInspectionImage. Kalau sudah kadaluarsa, tampilkan pesan
  //     placeholder alih-alih foto kosong membingungkan.
  const img = document.getElementById('lastResultImg');
  const loading = document.getElementById('lastResultImgLoading');
  const dashKey = last.imageFileId ? ('drive:' + last.imageFileId) : (last.recordId ? ('temp:' + last.recordId) : null);

  if (!dashKey) {
    img.classList.add('d-none');
    loading.classList.add('d-none');
    _lastDashImageFileId = null;
    return;
  }
  if (dashKey === _lastDashImageFileId) return; // gambar sama, tidak perlu fetch ulang

  _lastDashImageFileId = dashKey;
  img.classList.add('d-none');
  loading.classList.remove('d-none');
  loading.innerText = 'Memuat foto...';

  const fetchCall = last.imageFileId
    ? callApi('apiGetDriveImageBase64', [last.imageFileId, CURRENT_SESSION])
    : callApi('apiGetTempInspectionImage', [last.recordId, CURRENT_SESSION]);

  fetchCall.then(function (res) {
    if (res.success) {
      loading.classList.add('d-none');
      img.src = res.dataUri;
      img.classList.remove('d-none');
    } else if (!last.imageFileId) {
      // Foto sementara (bukan Drive) sudah kadaluarsa/tidak ter-cache -
      // ini normal untuk hasil OK lama, bukan error, jadi pesannya netral.
      loading.classList.remove('d-none');
      loading.innerText = 'Foto tidak disimpan permanen untuk hasil OK ini (hemat storage), dan cache sementaranya sudah kadaluarsa.';
    } else {
      loading.classList.add('d-none');
    }
  }).catch(function () { loading.classList.add('d-none'); });
}

/* Auto-refresh Dashboard tiap beberapa detik supaya kartu "Hasil Inspeksi
   Terakhir" & "Hasil Terbaru" ikut berganti mengikuti cycle proses inspeksi
   yang baru masuk (dari Run Mode), tanpa pengguna harus manual refresh
   halaman. Dihentikan otomatis saat pindah dari menu Dashboard supaya tidak
   terus polling di belakang layar. */
let dashboardPollIntervalId = null;
const DASHBOARD_POLL_INTERVAL_MS = 5000;

function startDashboardPolling() {
  stopDashboardPolling();
  dashboardPollIntervalId = setInterval(loadDashboard, DASHBOARD_POLL_INTERVAL_MS);
}

function stopDashboardPolling() {
  if (dashboardPollIntervalId) { clearInterval(dashboardPollIntervalId); dashboardPollIntervalId = null; }
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
        '<td>' + (r.cycleTimeMs ? (r.cycleTimeMs / 1000).toFixed(1) + ' s' : '-') + '</td>' +
        '<td>' + (r.imagePath ? '<a href="' + r.imagePath + '" target="_blank">Lihat</a>' : '-') + '</td>';
      tbody.appendChild(tr);
    });
  }).catch(function (err) { console.warn('Gagal memuat history:', err.message); });
}

/* ---------------- IO MONITOR / EXTERNAL I/O ---------------- */

/**
 * Pemetaan pin per jenis perangkat, sesuai dokumentasi pin mapping di
 * firmware masing-masing (MAPIN_Arduino_Uno.ino / MAPIN_ESP8266.ino).
 * PLC tidak punya nomor pin baku (tergantung merk/tipe PLC), jadi
 * ditampilkan sebagai placeholder yang harus dipetakan sendiri oleh
 * teknisi PLC di lapangan - lihat penjelasan di panel "PLC (Ethernet)".
 */
const IO_PIN_MAPS = {
  arduino: [
    { key: 'TRIGGER', label: 'D2 - Trigger IN', dir: 'in' },
    { key: 'OK', label: 'D5 - OK OUT', dir: 'out' },
    { key: 'NG', label: 'D6 - NG OUT', dir: 'out' },
    { key: 'BUSY', label: 'D7 - BUSY OUT', dir: 'out' },
    { key: 'ERROR', label: 'D8 - ERROR OUT', dir: 'out' }
  ],
  esp8266: [
    { key: 'TRIGGER', label: 'D2 (GPIO4) - Trigger IN', dir: 'in' },
    { key: 'OK', label: 'D5 (GPIO14) - OK OUT', dir: 'out' },
    { key: 'NG', label: 'D6 (GPIO12) - NG OUT', dir: 'out' },
    { key: 'BUSY', label: 'D7 (GPIO13) - BUSY OUT', dir: 'out' },
    { key: 'ERROR', label: 'D8 (GPIO15) - ERROR OUT', dir: 'out' }
  ],
  plc: [
    { key: 'TRIGGER', label: 'Trigger IN (alamat sesuai PLC, mis. %I0.0/X0)', dir: 'in' },
    { key: 'OK', label: 'OK OUT (mis. %Q0.0/Y0)', dir: 'out' },
    { key: 'NG', label: 'NG OUT (mis. %Q0.1/Y1)', dir: 'out' },
    { key: 'BUSY', label: 'BUSY OUT (mis. %Q0.2/Y2)', dir: 'out' },
    { key: 'ERROR', label: 'ERROR OUT (mis. %Q0.3/Y3)', dir: 'out' }
  ]
};

let ioSelectedDeviceType = 'arduino';
let ioLastStatus = 'IDLE';

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

  document.querySelectorAll('input[name="ioDeviceType"]').forEach(function (radio) {
    radio.onchange = function () {
      ioSelectedDeviceType = radio.value;
      document.getElementById('ioPanelArduino').classList.toggle('d-none', ioSelectedDeviceType !== 'arduino');
      document.getElementById('ioPanelEsp8266').classList.toggle('d-none', ioSelectedDeviceType !== 'esp8266');
      document.getElementById('ioPanelPlc').classList.toggle('d-none', ioSelectedDeviceType !== 'plc');
      renderIoSimGrid();
    };
  });

  renderIoSimGrid();
}

/**
 * Menggambar "lampu" indikator (lingkaran ON/OFF) untuk tiap pin sesuai
 * jenis perangkat yang dipilih. Pin OUTPUT menyala mengikuti status IO
 * terkini (ioLastStatus, di-update oleh refreshIoStatus()); pin INPUT
 * (Trigger) diberi tombol "Simulasi Trigger" supaya alur lengkap bisa
 * diuji dari browser saja, tanpa menunggu wiring/hardware fisik selesai.
 */
function renderIoSimGrid() {
  const grid = document.getElementById('ioSimGrid');
  if (!grid) return;
  const pins = IO_PIN_MAPS[ioSelectedDeviceType] || IO_PIN_MAPS.arduino;

  grid.innerHTML = pins.map(function (p) {
    const isOn = p.dir === 'out' && ioLastStatus === p.key;
    const lampClass = 'io-lamp' + (isOn ? ' on io-lamp-' + p.key.toLowerCase() : '');
    const actionHtml = p.dir === 'in'
      ? '<button class="btn btn-sm btn-outline-info mt-2" id="btnSimulateTrigger">Simulasi Trigger</button>'
      : '<span class="small text-muted mt-2">' + (isOn ? 'AKTIF' : 'Mati') + '</span>';
    return '<div class="io-pin-card text-center">' +
      '<div class="' + lampClass + '" id="ioLamp_' + p.key + '"></div>' +
      '<div class="small mt-2">' + p.label + '</div>' +
      actionHtml +
      '</div>';
  }).join('');

  const btnSim = document.getElementById('btnSimulateTrigger');
  if (btnSim) {
    btnSim.onclick = function () {
      btnSim.disabled = true;
      callApi('apiSimulateDeviceTrigger', [CURRENT_SESSION]).then(function (res) {
        btnSim.disabled = false;
        if (res && res.success === false) { alert(res.error); return; }
        logSignal('TRIGGER (simulasi)');
        refreshIoStatus();
      }).catch(function (err) {
        btnSim.disabled = false;
        alert('Gagal mengirim simulasi trigger: ' + err.message);
      });
    };
  }
}

let ioStatusPollId = null;

/**
 * Status ESP8266/Arduino di halaman ini dulunya cuma diambil SEKALI saat
 * halaman dibuka (tidak update lagi setelahnya) - padahal halaman ini
 * justru dipakai untuk MENGUJI/DEBUG koneksi perangkat secara langsung
 * (mis. menekan tombol trigger fisik lalu melihat status berubah ke BUSY).
 * Sekarang di-polling tiap 1 detik selama operator berada di halaman ini,
 * dan otomatis berhenti saat pindah menu (lihat showView()/stopIoStatusPolling()).
 */
function startIoStatusPolling() {
  refreshIoStatus();
  stopIoStatusPolling();
  ioStatusPollId = setInterval(refreshIoStatus, 1000);
}

function stopIoStatusPolling() {
  if (ioStatusPollId) { clearInterval(ioStatusPollId); ioStatusPollId = null; }
}

function refreshIoStatus() {
  callApi('apiGetIoStatusForUi', [CURRENT_SESSION]).then(function (res) {
    if (res.error) { console.warn('Gagal memuat status IO:', res.error); return; }
    document.getElementById('deviceStatusList').innerHTML =
      '<div class="d-flex justify-content-between"><span>Status Saat Ini</span><strong>' + res.status + '</strong></div>' +
      '<div class="text-muted small">Update: ' + (res.updatedAt || '-') + '</div>';

    if (res.status !== ioLastStatus) {
      ioLastStatus = res.status;
      renderIoSimGrid(); // status berubah -> gambar ulang supaya lampu OUTPUT yang sesuai menyala
    }
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
