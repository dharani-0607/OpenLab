/* ========================================================
   VANGUARD-IOT: CLIENT-SIDE TELEMETRY ENGINE & REAL-TIME HUD
   ======================================================== */

// Global telemetry state cache
let currentTelemetry = {
  helmet: {
    online: false,
    alcohol_raw: 250,
    alcohol_safe: true,
    buckle_fastened: true,
    rfid_authorized: true,
    rfid_uid: "DE AD BE EF",
    rfid_authorized_time: Date.now(),
    temperature_c: 28.4,
    acceleration_m_s2: 9.81,
    accel_x: 0.12,
    accel_y: -0.05,
    accel_z: 9.81,
    gyro_x: 0.002,
    gyro_y: -0.001,
    gyro_z: 0.004,
    crash_detected: false,
    blind_spot_alert: false,
    heart_rate_bpm: 76.0,
    spo2_percent: 98.2,
    packetCount: 0
  },
  bike: {
    online: false,
    left_distance_cm: 120.0,
    right_distance_cm: 145.0,
    left_obstacle: false,
    right_obstacle: false,
    blind_spot_alert: false,
    latitude: 10.045714,
    longitude: 76.045714,
    speed_kmh: 0.0,
    bike_stopped: true,
    packetCount: 0
  },
  interlock: {
    start_allowed: true,
    alcohol_safe: true,
    buckle_fastened: true,
    rfid_authorized: true
  }
};

// ==================== INITIALIZE LEAFLET GPS MAP ====================

let map = null;
let bikeMarker = null;
let pathPolyline = null;
const pathCoords = [];

function initMap() {
  const defaultLat = 10.045714;
  const defaultLon = 76.045714;

  try {
    map = L.map('gpsMap', {
      zoomControl: false,
      attributionControl: false
    }).setView([defaultLat, defaultLon], 16);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19
    }).addTo(map);

    // Custom motorcycle SVG marker icon
    const bikeIcon = L.divIcon({
      className: 'custom-bike-marker',
      html: `
        <div style="background:#0ea5e9; border:2px solid #fff; border-radius:50%; width:24px; height:24px; display:flex; align-items:center; justify-content:center; box-shadow:0 0 12px #0ea5e9;">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#fff" stroke-width="2.5">
            <polygon points="12 2 19 21 12 17 5 21 12 2"/>
          </svg>
        </div>
      `,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    bikeMarker = L.marker([defaultLat, defaultLon], { icon: bikeIcon }).addTo(map);

    pathPolyline = L.polyline([], {
      color: '#06b6d4',
      weight: 3,
      opacity: 0.85,
      dashArray: '4, 4'
    }).addTo(map);

  } catch (err) {
    console.warn("Leaflet map initialization skipped or offline:", err);
  }
}

function updateMapPosition(lat, lon) {
  if (!map || !bikeMarker || isNaN(lat) || isNaN(lon)) return;
  
  const newLatLng = new L.LatLng(lat, lon);
  bikeMarker.setLatLng(newLatLng);

  pathCoords.push(newLatLng);
  if (pathCoords.length > 50) pathCoords.shift();
  if (pathPolyline) pathPolyline.setLatLngs(pathCoords);

  map.panTo(newLatLng, { animate: true, duration: 0.5 });
}

// ==================== REAL-TIME ECG / PULSE WAVE CANVAS ====================

const ecgCanvas = document.getElementById('ecgCanvas');
const ecgCtx = ecgCanvas ? ecgCanvas.getContext('2d') : null;
let ecgX = 0;
let lastEcgY = 35;
let beatCycle = 0;

function drawEcgFrame() {
  if (!ecgCtx || !ecgCanvas) return;

  const w = ecgCanvas.width;
  const h = ecgCanvas.height;
  const midY = h / 2;

  // Fade out oldest trace ahead of the cursor
  ecgCtx.fillStyle = 'rgba(9, 14, 24, 0.18)';
  ecgCtx.fillRect(ecgX, 0, 10, h);

  const bpm = currentTelemetry.helmet.heart_rate_bpm;
  let targetY = midY;

  if (bpm && bpm > 40) {
    // Generate cardiac pulse complex P-Q-R-S-T
    beatCycle = (beatCycle + 1) % 40;
    if (beatCycle === 10) targetY = midY - 6;        // P wave
    else if (beatCycle === 15) targetY = midY + 4;   // Q dip
    else if (beatCycle === 17) targetY = midY - 28;  // R spike
    else if (beatCycle === 19) targetY = midY + 14;  // S dip
    else if (beatCycle === 24) targetY = midY - 10;  // T wave
    else targetY = midY + (Math.random() - 0.5) * 2; // Isoelectric baseline noise
  } else {
    // Flatline idle with tiny micro-noise
    targetY = midY + (Math.random() - 0.5) * 2;
  }

  ecgCtx.strokeStyle = (bpm && bpm > 40) ? '#f43f5e' : '#475569';
  ecgCtx.lineWidth = 2;
  ecgCtx.lineCap = 'round';
  ecgCtx.beginPath();
  ecgCtx.moveTo(ecgX === 0 ? 0 : ecgX - 2, lastEcgY);
  ecgCtx.lineTo(ecgX, targetY);
  ecgCtx.stroke();

  lastEcgY = targetY;
  ecgX += 2;
  if (ecgX >= w) {
    ecgX = 0;
  }

  requestAnimationFrame(drawEcgFrame);
}

// ==================== TELEMETRY DATA DOM BINDINGS ====================

function renderTelemetry(data) {
  if (!data) return;
  currentTelemetry = data;

  const h = data.helmet || {};
  const b = data.bike || {};
  const i = data.interlock || {};

  // 1. Top HUD Node Status Pills
  const helmetPill = document.getElementById('helmetNodePill');
  const helmetBadge = document.getElementById('helmetBadge');
  const helmetMeta = document.getElementById('helmetMetaText');

  if (h.online) {
    helmetPill.className = 'node-pill online';
    helmetBadge.textContent = 'ONLINE';
    helmetMeta.textContent = `Pkts: ${h.packetCount || 0} | Temp: ${h.temperature_c ? h.temperature_c.toFixed(1) : '--'}°C`;
  } else {
    helmetPill.className = 'node-pill';
    helmetBadge.textContent = 'OFFLINE';
    helmetMeta.textContent = 'Awaiting ESP32 POST...';
  }

  const bikePill = document.getElementById('bikeNodePill');
  const bikeBadge = document.getElementById('bikeBadge');
  const bikeMeta = document.getElementById('bikeMetaText');

  if (b.online) {
    bikePill.className = 'node-pill online';
    bikeBadge.textContent = 'ONLINE';
    bikeMeta.textContent = `Pkts: ${b.packetCount || 0} | L:${b.left_distance_cm ? b.left_distance_cm.toFixed(0) : '--'} R:${b.right_distance_cm ? b.right_distance_cm.toFixed(0) : '--'}`;
  } else {
    bikePill.className = 'node-pill';
    bikeBadge.textContent = 'OFFLINE';
    bikeMeta.textContent = 'Awaiting ESP32 POST...';
  }

  // 2. Master Ignition Safety Banner
  const masterBanner = document.getElementById('masterSafetyBanner');
  const bannerTitle = document.getElementById('bannerTitle');
  const bannerDesc = document.getElementById('bannerDesc');
  const checkAlcohol = document.getElementById('checkAlcohol');
  const checkBuckle = document.getElementById('checkBuckle');
  const checkRfid = document.getElementById('checkRfid');

  const alcoholSafe = Boolean(h.alcohol_safe !== undefined ? h.alcohol_safe : (h.alcohol_raw < 750));
  const buckleFastened = Boolean(h.buckle_fastened);
  const rfidAuth = Boolean(h.rfid_authorized);
  const startAllowed = Boolean(alcoholSafe && buckleFastened && rfidAuth);

  checkAlcohol.className = 'check-item ' + (alcoholSafe ? 'pass' : '');
  checkBuckle.className = 'check-item ' + (buckleFastened ? 'pass' : '');
  checkRfid.className = 'check-item ' + (rfidAuth ? 'pass' : '');

  if (startAllowed) {
    masterBanner.className = 'master-safety-banner authorized';
    bannerTitle.textContent = 'ENGINE START AUTHORIZED';
    bannerDesc.textContent = 'All 3 safety interlocks verified: Alcohol Clean + Helmet Secured + Rider Validated.';
  } else {
    masterBanner.className = 'master-safety-banner locked';
    bannerTitle.textContent = 'IGNITION INTERLOCK ENGAGED';
    let reasons = [];
    if (!alcoholSafe) reasons.push('Alcohol detected');
    if (!buckleFastened) reasons.push('Helmet unbuckled');
    if (!rfidAuth) reasons.push('RFID card unauthorized');
    bannerDesc.textContent = `Engine ignition disabled. Reason(s): ${reasons.join(', ')}.`;
  }

  // 3. Card 1: Interlock details
  const interlockBadge = document.getElementById('interlockBadge');
  if (interlockBadge) {
    interlockBadge.textContent = startAllowed ? 'PERMITTED' : 'LOCKED';
    interlockBadge.className = 'card-badge ' + (startAllowed ? 'authorized' : 'locked');
  }

  // RFID
  const rfidStatusText = document.getElementById('rfidStatusText');
  const rfidUidText = document.getElementById('rfidUidText');
  const rfidTimerBar = document.getElementById('rfidTimerBar');
  if (rfidStatusText) {
    rfidStatusText.textContent = rfidAuth ? 'AUTHORIZED' : 'DENIED';
    rfidStatusText.className = 'metric-large-text ' + (rfidAuth ? 'safe' : '');
  }
  if (rfidUidText) rfidUidText.textContent = h.rfid_uid || 'DE AD BE EF';
  if (rfidTimerBar) {
    rfidTimerBar.style.width = rfidAuth ? '100%' : '0%';
  }

  // Buckle
  const buckleStatusText = document.getElementById('buckleStatusText');
  const buckleGpioText = document.getElementById('buckleGpioText');
  if (buckleStatusText) {
    buckleStatusText.textContent = buckleFastened ? 'FASTENED' : 'OPEN';
    buckleStatusText.className = 'metric-large-text ' + (buckleFastened ? 'safe' : '');
  }
  if (buckleGpioText) {
    buckleGpioText.textContent = buckleFastened ? 'LOW (LATCHED)' : 'HIGH (OPEN)';
  }

  // Alcohol MQ-3
  const alcoholVal = document.getElementById('alcoholVal');
  const alcoholStatusTag = document.getElementById('alcoholStatusTag');
  const alcoholGaugeFill = document.getElementById('alcoholGaugeFill');
  const rawAlc = h.alcohol_raw || 0;
  if (alcoholVal) alcoholVal.textContent = rawAlc;
  if (alcoholStatusTag) {
    alcoholStatusTag.textContent = alcoholSafe ? 'SAFE' : 'HAZARD';
    alcoholStatusTag.className = 'tag-status ' + (alcoholSafe ? 'safe' : 'hazard');
  }
  if (alcoholGaugeFill) {
    const percent = Math.min(100, Math.max(0, (rawAlc / 2000) * 100));
    alcoholGaugeFill.style.width = percent + '%';
  }

  // 4. Card 2: Biometrics
  const pulseBpmLive = document.getElementById('pulseBpmLive');
  const ecgStatus = document.getElementById('ecgStatus');
  const spo2Num = document.getElementById('spo2Num');
  const tempNum = document.getElementById('tempNum');

  if (pulseBpmLive) {
    pulseBpmLive.textContent = (h.heart_rate_bpm && h.heart_rate_bpm > 0) ? `${h.heart_rate_bpm.toFixed(0)} BPM` : '-- BPM';
  }
  if (ecgStatus) {
    ecgStatus.textContent = (h.heart_rate_bpm && h.heart_rate_bpm > 0) ? 'OPTICAL PULSE DETECTED' : 'AWAITING CONTACT...';
  }
  if (spo2Num) {
    spo2Num.textContent = (h.spo2_percent && h.spo2_percent > 0) ? h.spo2_percent.toFixed(1) : '--';
  }
  if (tempNum) {
    tempNum.textContent = h.temperature_c ? h.temperature_c.toFixed(1) : '--';
  }

  // 5. Card 3: MPU6050 Inertial & Impact
  const accelMagBadge = document.getElementById('accelMagBadge');
  const mag = h.acceleration_m_s2 !== undefined ? h.acceleration_m_s2 : 9.81;
  if (accelMagBadge) {
    accelMagBadge.textContent = `${mag.toFixed(2)} m/s² (${(mag / 9.81).toFixed(1)}G)`;
  }

  updateImuAxis('accelBarX', 'accelValX', h.accel_x || 0);
  updateImuAxis('accelBarY', 'accelValY', h.accel_y || 0);
  updateImuAxis('accelBarZ', 'accelValZ', h.accel_z || 9.81);

  const gyroValX = document.getElementById('gyroValX');
  const gyroValY = document.getElementById('gyroValY');
  const gyroValZ = document.getElementById('gyroValZ');
  if (gyroValX) gyroValX.textContent = `${(h.gyro_x || 0).toFixed(3)} rad/s`;
  if (gyroValY) gyroValY.textContent = `${(h.gyro_y || 0).toFixed(3)} rad/s`;
  if (gyroValZ) gyroValZ.textContent = `${(h.gyro_z || 0).toFixed(3)} rad/s`;

  // Crash Alert Banner
  const crashAlertBar = document.getElementById('crashAlertBar');
  if (crashAlertBar) {
    if (h.crash_detected) {
      crashAlertBar.classList.add('active');
    } else {
      crashAlertBar.classList.remove('active');
    }
  }

  // 6. Column 2: Bike Radar & Ultrasonic
  const leftDist = b.left_distance_cm !== undefined ? b.left_distance_cm : 100.0;
  const rightDist = b.right_distance_cm !== undefined ? b.right_distance_cm : 100.0;

  const leftObstacle = Boolean(b.left_obstacle !== undefined ? b.left_obstacle : (leftDist >= 0 && leftDist < 100.0));
  const rightObstacle = Boolean(b.right_obstacle !== undefined ? b.right_obstacle : (rightDist >= 0 && rightDist < 100.0));
  const blindSpotAlert = Boolean(leftObstacle || rightObstacle);

  const radarLeftSector = document.getElementById('radarLeftSector');
  const leftDistDisplay = document.getElementById('leftDistDisplay');
  const leftStatusBadge = document.getElementById('leftStatusBadge');
  const leftMeterVal = document.getElementById('leftMeterVal');
  const leftDistFill = document.getElementById('leftDistFill');

  if (leftDistDisplay) leftDistDisplay.textContent = leftDist < 0 ? 'NO ECHO' : `${leftDist.toFixed(1)} cm`;
  if (leftMeterVal) leftMeterVal.textContent = leftDist < 0 ? 'No Echo' : `${leftDist.toFixed(1)} cm`;
  if (radarLeftSector) {
    radarLeftSector.className = 'radar-sector radar-left ' + (leftObstacle ? 'alert' : '');
  }
  if (leftStatusBadge) {
    leftStatusBadge.textContent = leftObstacle ? 'OBSTACLE DETECTED' : 'CLEAR';
  }
  if (leftDistFill) {
    const p = Math.min(100, Math.max(5, (leftDist / 200) * 100));
    leftDistFill.style.width = p + '%';
    leftDistFill.className = 'dist-fill ' + (leftObstacle ? 'alert' : '');
  }

  const radarRightSector = document.getElementById('radarRightSector');
  const rightDistDisplay = document.getElementById('rightDistDisplay');
  const rightStatusBadge = document.getElementById('rightStatusBadge');
  const rightMeterVal = document.getElementById('rightMeterVal');
  const rightDistFill = document.getElementById('rightDistFill');

  if (rightDistDisplay) rightDistDisplay.textContent = rightDist < 0 ? 'NO ECHO' : `${rightDist.toFixed(1)} cm`;
  if (rightMeterVal) rightMeterVal.textContent = rightDist < 0 ? 'No Echo' : `${rightDist.toFixed(1)} cm`;
  if (radarRightSector) {
    radarRightSector.className = 'radar-sector radar-right ' + (rightObstacle ? 'alert' : '');
  }
  if (rightStatusBadge) {
    rightStatusBadge.textContent = rightObstacle ? 'OBSTACLE DETECTED' : 'CLEAR';
  }
  if (rightDistFill) {
    const p = Math.min(100, Math.max(5, (rightDist / 200) * 100));
    rightDistFill.style.width = p + '%';
    rightDistFill.className = 'dist-fill ' + (rightObstacle ? 'alert' : '');
  }

  // Helmet HUD LED mirror indicator
  const ledDot = document.getElementById('ledDot');
  if (ledDot) {
    if (blindSpotAlert) {
      ledDot.classList.add('active');
    } else {
      ledDot.classList.remove('active');
    }
  }

  // 7. GPS Telemetry & Map
  const latCoord = document.getElementById('latCoord');
  const lonCoord = document.getElementById('lonCoord');
  const speedDisplay = document.getElementById('speedDisplay');
  const motionTag = document.getElementById('motionTag');

  const lat = b.latitude || 10.045714;
  const lon = b.longitude || 76.045714;
  const speed = b.speed_kmh || 0.0;
  const stopped = b.bike_stopped !== undefined ? b.bike_stopped : (speed < 1.0);

  if (latCoord) latCoord.textContent = `${lat.toFixed(6)}° N`;
  if (lonCoord) lonCoord.textContent = `${lon.toFixed(6)}° E`;
  if (speedDisplay) speedDisplay.textContent = speed.toFixed(1);
  if (motionTag) {
    motionTag.textContent = stopped ? 'STOPPED' : 'CRUISING';
    motionTag.className = 'motion-tag ' + (stopped ? '' : 'cruising');
  }

  updateMapPosition(lat, lon);

  // 8. Event log list
  if (data.events && Array.isArray(data.events)) {
    renderEventLog(data.events);
  }
}

function updateImuAxis(barId, valId, value) {
  const bar = document.getElementById(barId);
  const val = document.getElementById(valId);
  if (val) val.textContent = `${value.toFixed(2)} m/s²`;
  if (bar) {
    // Map -20 to +20 m/s^2 to 0-100% width starting from center 50%
    const max = 20.0;
    const clamped = Math.max(-max, Math.min(max, value));
    const widthPct = Math.abs(clamped / max) * 50;
    bar.style.width = widthPct + '%';
    if (clamped >= 0) {
      bar.style.left = '50%';
      bar.style.right = 'auto';
    } else {
      bar.style.left = 'auto';
      bar.style.right = '50%';
    }
  }
}

function renderEventLog(events) {
  const feed = document.getElementById('eventLogFeed');
  const countEl = document.getElementById('eventCount');
  if (!feed) return;

  if (countEl) countEl.textContent = `${events.length} events logged`;

  feed.innerHTML = events.map(evt => {
    const timeStr = evt.timestamp ? new Date(evt.timestamp).toLocaleTimeString() : 'RECENT';
    return `
      <div class="log-item ${evt.severity || 'info'}">
        <span class="log-time">${timeStr}</span>
        <span class="log-cat">[${evt.category || 'INFO'}]</span>
        <span class="log-msg">${evt.message}</span>
      </div>
    `;
  }).join('');
}

// ==================== REAL-TIME WEBSOCKET & SSE TELEMETRY STREAM ====================

let wsClient = null;

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  try {
    wsClient = new WebSocket(wsUrl);

    wsClient.onopen = () => {
      console.log("[WS] Connected to real-time telemetry stream");
    };

    wsClient.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'telemetry' && msg.data) {
          renderTelemetry(msg.data);
        } else if (msg.type === 'event' && msg.data) {
          if (currentTelemetry.events) {
            currentTelemetry.events.unshift(msg.data);
            renderEventLog(currentTelemetry.events.slice(0, 15));
          }
        }
      } catch (err) {
        console.error("[WS PARSE ERROR]", err);
      }
    };

    wsClient.onclose = () => {
      setTimeout(connectWebSocket, 2000);
    };
  } catch (e) {
    console.warn("WebSocket init error:", e);
  }
}

let sseSource = null;

function connectSSE() {
  if (sseSource) {
    sseSource.close();
  }

  sseSource = new EventSource('/api/stream');

  sseSource.addEventListener('telemetry', (e) => {
    try {
      const data = JSON.parse(e.data);
      renderTelemetry(data);
    } catch (err) {
      console.error("SSE parse error:", err);
    }
  });

  sseSource.addEventListener('event', (e) => {
    try {
      const evt = JSON.parse(e.data);
      if (currentTelemetry.events) {
        currentTelemetry.events.unshift(evt);
        renderEventLog(currentTelemetry.events.slice(0, 15));
      }
    } catch (err) {
      console.error("SSE event error:", err);
    }
  });

  sseSource.onerror = () => {
    setTimeout(connectSSE, 3000);
  };
}

// Backup poll if SSE is unavailable or behind restrictive proxies
setInterval(async () => {
  if (!sseSource || sseSource.readyState !== EventSource.OPEN) {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        renderTelemetry(data);
      }
    } catch (e) {
      // Offline
    }
  }
}, 1500);

// ==================== SYSTEM CLOCK ====================

function startClock() {
  const clockEl = document.getElementById('systemClock');
  setInterval(() => {
    if (clockEl) {
      const now = new Date();
      clockEl.textContent = now.toTimeString().split(' ')[0];
    }
  }, 1000);
}

// ==================== HARDWARE TEST BENCH MODAL & CONTROLS ====================

function initTestBench() {
  const simModal = document.getElementById('simModal');
  const openSimBtn = document.getElementById('openSimBtn');
  const closeSimBtn = document.getElementById('closeSimBtn');
  const dismissCrashBtn = document.getElementById('dismissCrashBtn');

  if (openSimBtn) openSimBtn.addEventListener('click', () => simModal.classList.add('open'));
  if (closeSimBtn) closeSimBtn.addEventListener('click', () => simModal.classList.remove('open'));
  if (simModal) {
    simModal.addEventListener('click', (e) => {
      if (e.target === simModal) simModal.classList.remove('open');
    });
  }

  if (dismissCrashBtn) {
    dismissCrashBtn.addEventListener('click', () => {
      injectData('helmet', { crash_detected: false });
    });
  }

  // Helmet Controls
  const simBuckle = document.getElementById('simBuckle');
  const simBuckleLabel = document.getElementById('simBuckleLabel');
  if (simBuckle) {
    simBuckle.addEventListener('change', () => {
      const val = simBuckle.checked;
      simBuckleLabel.textContent = val ? 'FASTENED' : 'OPEN';
      injectData('helmet', { buckle_fastened: val });
    });
  }

  const simRfidAuth = document.getElementById('simRfidAuth');
  const simRfidDeny = document.getElementById('simRfidDeny');
  if (simRfidAuth) {
    simRfidAuth.addEventListener('click', () => {
      injectData('helmet', { rfid_authorized: true, rfid_uid: "DE AD BE EF" });
    });
  }
  if (simRfidDeny) {
    simRfidDeny.addEventListener('click', () => {
      injectData('helmet', { rfid_authorized: false, rfid_uid: "XX XX XX XX" });
    });
  }

  const simAlcoholSlider = document.getElementById('simAlcoholSlider');
  const simAlcoholVal = document.getElementById('simAlcoholVal');
  if (simAlcoholSlider) {
    simAlcoholSlider.addEventListener('input', () => {
      const v = Number(simAlcoholSlider.value);
      const isSafe = v < 750;
      simAlcoholVal.textContent = `${v} ADC (${isSafe ? 'Safe' : 'HAZARD'})`;
      injectData('helmet', { alcohol_raw: v, alcohol_safe: isSafe });
    });
  }

  const simCrashBtn = document.getElementById('simCrashBtn');
  if (simCrashBtn) {
    simCrashBtn.addEventListener('click', () => {
      injectData('helmet', {
        crash_detected: true,
        acceleration_m_s2: 34.8,
        accel_x: 22.4,
        accel_y: -18.2,
        accel_z: 21.0
      });
      setTimeout(() => {
        injectData('helmet', {
          crash_detected: false,
          acceleration_m_s2: 9.81,
          accel_x: 0.1,
          accel_y: 0.0,
          accel_z: 9.81
        });
      }, 4000);
    });
  }

  const simBpmSlider = document.getElementById('simBpmSlider');
  const simBpmVal = document.getElementById('simBpmVal');
  if (simBpmSlider) {
    simBpmSlider.addEventListener('input', () => {
      const bpm = Number(simBpmSlider.value);
      simBpmVal.textContent = `${bpm} BPM`;
      injectData('helmet', { heart_rate_bpm: bpm, spo2_percent: 98.4 });
    });
  }

  // Bike Controls
  const simLeftSlider = document.getElementById('simLeftSlider');
  const simLeftVal = document.getElementById('simLeftVal');
  if (simLeftSlider) {
    simLeftSlider.addEventListener('input', () => {
      const dist = Number(simLeftSlider.value);
      const obs = dist < 100.0;
      simLeftVal.textContent = `${dist} cm (${obs ? 'OBSTACLE' : 'Clear'})`;
      injectData('bike', { left_distance_cm: dist, left_obstacle: obs });
    });
  }

  const simRightSlider = document.getElementById('simRightSlider');
  const simRightVal = document.getElementById('simRightVal');
  if (simRightSlider) {
    simRightSlider.addEventListener('input', () => {
      const dist = Number(simRightSlider.value);
      const obs = dist < 100.0;
      simRightVal.textContent = `${dist} cm (${obs ? 'OBSTACLE' : 'Clear'})`;
      injectData('bike', { right_distance_cm: dist, right_obstacle: obs });
    });
  }

  const simSpeedSlider = document.getElementById('simSpeedSlider');
  const simSpeedVal = document.getElementById('simSpeedVal');
  if (simSpeedSlider) {
    simSpeedSlider.addEventListener('input', () => {
      const spd = Number(simSpeedSlider.value);
      simSpeedVal.textContent = `${spd} km/h`;
      injectData('bike', { speed_kmh: spd, bike_stopped: spd < 1.0 });
    });
  }

  // Preset Buttons
  const presetSafeRide = document.getElementById('presetSafeRide');
  if (presetSafeRide) {
    presetSafeRide.addEventListener('click', () => {
      injectData('helmet', {
        buckle_fastened: true,
        alcohol_raw: 220,
        alcohol_safe: true,
        rfid_authorized: true,
        heart_rate_bpm: 74.0,
        crash_detected: false
      });
      injectData('bike', {
        left_distance_cm: 180.0,
        right_distance_cm: 195.0,
        left_obstacle: false,
        right_obstacle: false,
        speed_kmh: 45.0,
        bike_stopped: false
      });
    });
  }

  const presetBlindSpotAlert = document.getElementById('presetBlindSpotAlert');
  if (presetBlindSpotAlert) {
    presetBlindSpotAlert.addEventListener('click', () => {
      injectData('bike', {
        left_distance_cm: 38.0,
        right_distance_cm: 150.0,
        left_obstacle: true,
        right_obstacle: false
      });
    });
  }

  const presetDrunkAttempt = document.getElementById('presetDrunkAttempt');
  if (presetDrunkAttempt) {
    presetDrunkAttempt.addEventListener('click', () => {
      injectData('helmet', {
        alcohol_raw: 1450,
        alcohol_safe: false,
        buckle_fastened: true,
        rfid_authorized: true
      });
    });
  }
}

async function injectData(node, payload) {
  try {
    await fetch('/api/inject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node, payload })
    });
  } catch (err) {
    console.warn("Simulation injection error:", err);
  }
}

// ==================== APP BOOTSTRAP ====================

window.addEventListener('DOMContentLoaded', () => {
  initMap();
  drawEcgFrame();
  connectWebSocket();
  connectSSE();
  startClock();
  initTestBench();
});
