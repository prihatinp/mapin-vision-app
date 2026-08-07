/* ==================================================================
   MAP-IN Vision V1.0 - arduinoBridge.js
   Module 8: Jembatan WebSerial Browser <-> Arduino Uno (via USB)
   ==================================================================
   CATATAN KOMPATIBILITAS:
   - Web Serial API hanya didukung Chrome/Edge (berbasis Chromium)
     versi 89+, TIDAK didukung Firefox/Safari.
   - Wajib berjalan di konteks aman (HTTPS) - hosting statis modern
     (Firebase Hosting dkk.) sudah otomatis HTTPS, jadi ini terpenuhi.
   - Memerlukan user gesture (klik tombol) untuk memunculkan dialog
     pemilihan port - tidak bisa auto-connect tanpa interaksi user
     pada kunjungan pertama.
   - Ini melengkapi arsitektur ESP8266 (WiFi/HTTP) yang sudah tersedia
     sebagai alternatif nirkabel jika WebSerial tidak memungkinkan
     (mis. memakai browser yang tidak didukung, atau PC tanpa akses USB).
   ================================================================== */

const ArduinoBridge = {
  port: null,
  reader: null,
  writer: null,
  connected: false,
  readableStreamClosed: null,
  lineBuffer: '',

  isSupported: function () {
    return 'serial' in navigator;
  },

  connect: async function () {
    if (!this.isSupported()) {
      alert('Browser ini tidak mendukung Web Serial API. Gunakan Chrome/Edge, atau pakai ESP8266 (WiFi) sebagai alternatif.');
      return false;
    }
    try {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: 9600 });

      const textDecoder = new TextDecoderStream();
      this.readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
      this.reader = textDecoder.readable.getReader();

      const textEncoder = new TextEncoderStream();
      textEncoder.readable.pipeTo(this.port.writable);
      this.writer = textEncoder.writable.getWriter();

      this.connected = true;
      updateArduinoStatusUi(true);
      this._readLoop();
      this.sendCommand('PING'); // cek koneksi/heartbeat awal
      return true;
    } catch (err) {
      console.error('Gagal konek Arduino via WebSerial:', err);
      alert('Gagal menghubungkan ke Arduino: ' + err.message);
      return false;
    }
  },

  disconnect: async function () {
    try {
      if (this.reader) { await this.reader.cancel(); this.reader = null; }
      if (this.writer) { await this.writer.close(); this.writer = null; }
      if (this.port) { await this.port.close(); this.port = null; }
    } catch (err) {
      console.warn('Error saat menutup koneksi Arduino:', err);
    }
    this.connected = false;
    updateArduinoStatusUi(false);
  },

  sendCommand: async function (cmd) {
    if (!this.connected || !this.writer) return;
    try {
      await this.writer.write(cmd + '\n');
      logSignal('SERIAL TX -> ' + cmd);
    } catch (err) {
      console.error('Gagal kirim perintah ke Arduino:', err);
    }
  },

  /**
   * Loop membaca data dari Arduino secara terus-menerus. Saat menerima
   * baris "TRIGGER" (dikirim Arduino ketika pin D2 aktif, lihat
   * MAPIN_Arduino_Uno.ino), otomatis memulai siklus inspeksi jika
   * pengguna sedang berada di Run Mode dengan recipe aktif dimuat.
   */
  _readLoop: async function () {
    try {
      while (this.connected) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value) continue;

        this.lineBuffer += value;
        let newlineIdx;
        while ((newlineIdx = this.lineBuffer.indexOf('\n')) !== -1) {
          const line = this.lineBuffer.slice(0, newlineIdx).trim();
          this.lineBuffer = this.lineBuffer.slice(newlineIdx + 1);
          if (line) this._handleLine(line);
        }
      }
    } catch (err) {
      console.error('Serial read loop berhenti:', err);
      this.connected = false;
      updateArduinoStatusUi(false);
    }
  },

  _handleLine: function (line) {
    logSignal('SERIAL RX <- ' + line);

    if (line === 'TRIGGER') {
      const runViewActive = !document.getElementById('view-run').classList.contains('d-none');
      if (runViewActive && typeof ACTIVE_RECIPE !== 'undefined' && ACTIVE_RECIPE) {
        runInspectionCycle();
      } else {
        console.warn('Trigger diterima dari Arduino tapi Run Mode belum dibuka / recipe belum dimuat.');
      }
    } else if (line === 'PONG') {
      console.log('Arduino merespons PING - koneksi sehat.');
    }
  }
};

/**
 * Dipanggil dari updateRunModeUi() (lihat visionTools.js) setelah
 * server mengembalikan keputusan OK/NG, agar Arduino segera menyalakan
 * output D5/D6 tanpa menunggu polling (lebih cepat daripada jalur
 * IoService berbasis Spreadsheet yang dipakai ESP8266).
 */
function sendDecisionToArduino(decision) {
  if (ArduinoBridge.connected) {
    ArduinoBridge.sendCommand(decision); // "OK" atau "NG"
  }
}

function updateArduinoStatusUi(isConnected) {
  const badge = document.getElementById('arduinoConnectionStatus');
  const btn = document.getElementById('btnConnectArduino');
  if (!badge || !btn) return;
  if (isConnected) {
    badge.className = 'badge bg-success';
    badge.innerText = 'Terhubung (USB Serial)';
    btn.innerText = 'Putuskan Koneksi Arduino';
  } else {
    badge.className = 'badge bg-secondary';
    badge.innerText = 'Tidak Terhubung';
    btn.innerText = 'Hubungkan Arduino (USB)';
  }
}

document.addEventListener('DOMContentLoaded', function () {
  const btn = document.getElementById('btnConnectArduino');
  if (!btn) return;
  btn.addEventListener('click', function () {
    if (ArduinoBridge.connected) {
      ArduinoBridge.disconnect();
    } else {
      ArduinoBridge.connect();
    }
  });

  // Manual test output (Module 8) juga mengirim perintah nyata ke Arduino jika terhubung
  document.querySelectorAll('#view-ioMonitor [data-signal]').forEach(function (btn2) {
    btn2.addEventListener('click', function () {
      const signal = btn2.getAttribute('data-signal');
      const cmdMap = { OK: 'OK', NG: 'NG', BUSY: 'BUSY_ON', ERROR: 'ERROR_ON' };
      ArduinoBridge.sendCommand(cmdMap[signal] || signal);
    });
  });
});
