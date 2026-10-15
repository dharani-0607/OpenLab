const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== IN-MEMORY TELEMETRY STATE ====================

let systemState = {
  helmet: {
    online: false,
    lastSeen: null,
    packetCount: 0,
    alcohol_raw: 250,
    alcohol_safe: true,
    buckle_fastened: true,
    rfid_authorized: true,
    rfid_uid: "DE AD BE EF",
    rfid_authorized_time: Date.now(),
    start_allowed: true,
    temperature_c: 28.4,
    acceleration_m_s2: 9.81,
    accel_x: 0.12,
    accel_y: -0.05,
    accel_z: 9.81,
    gyro_x: 0.002,
    gyro_y: -0.001,
    gyro_z: 0.004,
    crash_detected: false,
    last_crash_time: null,
    blind_spot_alert: false,
    left_obstacle: false,
    right_obstacle: false,
    heart_rate_bpm: 76.0,
    spo2_percent: 98.2,
    max30105_red_raw: 142500,
    max30105_ir_raw: 168200,
    camera_status: "disabled"
  },
  bike: {
    online: false,
    lastSeen: null,
    packetCount: 0,
    left_distance_cm: 120.0,
    right_distance_cm: 145.0,
    left_obstacle: false,
    right_obstacle: false,
    blind_spot_alert: false,
    latitude: 10.045714,
    longitude: 76.045714,
    speed_kmh: 38.5,
    bike_stopped: false,
    gps_status: "SIMULATED"
  },
  events: []
};

// Active Server-Sent Events (SSE) client subscribers
const sseClients = new Set();

function broadcastSSE(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

function broadcastWS(type, data) {
  const payload = JSON.stringify({ type, data });
  for (const client of wss.clients) {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

// Log max 50 recent system events
function logSystemEvent(category, message, severity = 'info') {
  const event = {
    id: Date.now() + '-' + Math.random().toString(36).substr(2, 4),
    timestamp: new Date().toISOString(),
    category,
    message,
    severity
  };
  systemState.events.unshift(event);
  if (systemState.events.length > 50) {
    systemState.events.pop();
  }
  broadcastSSE('event', event);
  broadcastWS('event', event);
}

// Initial boot event
logSystemEvent('SYSTEM', 'Telemetry Server initialized with WebSocket & REST support', 'success');

// Periodic check for node online status
setInterval(() => {
  const now = Date.now();
  let changed = false;

  if (systemState.helmet.lastSeen && (now - systemState.helmet.lastSeen > 6000)) {
    if (systemState.helmet.online) {
      systemState.helmet.online = false;
      logSystemEvent('HELMET', 'Helmet node link timed out (>6s)', 'warning');
      changed = true;
    }
  }

  if (systemState.bike.lastSeen && (now - systemState.bike.lastSeen > 6000)) {
    if (systemState.bike.online) {
      systemState.bike.online = false;
      logSystemEvent('BIKE', 'Bike node link timed out (>6s)', 'warning');
      changed = true;
    }
  }

  if (changed) {
    const combined = getCombinedTelemetry();
    broadcastSSE('telemetry', combined);
    broadcastWS('telemetry', combined);
  }
}, 2000);

function getCombinedTelemetry() {
  const helmet = systemState.helmet;
  const bike = systemState.bike;

  const startAllowed = Boolean(helmet.alcohol_safe && helmet.buckle_fastened && helmet.rfid_authorized);
  const blindSpotAlert = Boolean(bike.left_obstacle || bike.right_obstacle);
  helmet.blind_spot_alert = blindSpotAlert;
  helmet.left_obstacle = bike.left_obstacle;
  helmet.right_obstacle = bike.right_obstacle;
  helmet.start_allowed = startAllowed;

  return {
    timestamp: Date.now(),
    serverTime: new Date().toISOString(),
    helmet: {
      ...helmet,
      online: Boolean(helmet.lastSeen && (Date.now() - helmet.lastSeen < 6000))
    },
    bike: {
      ...bike,
      blind_spot_alert: blindSpotAlert,
      online: Boolean(bike.lastSeen && (Date.now() - bike.lastSeen < 6000))
    },
    interlock: {
      start_allowed: startAllowed,
      alcohol_safe: helmet.alcohol_safe,
      buckle_fastened: helmet.buckle_fastened,
      rfid_authorized: helmet.rfid_authorized,
      rfid_uid: helmet.rfid_uid
    },
    events: systemState.events.slice(0, 15)
  };
}

// ==================== TELEMETRY PROCESSING LOGIC ====================

function handleHelmetData(data) {
  const h = systemState.helmet;
  h.online = true;
  h.lastSeen = Date.now();
  h.packetCount++;

  if (data.alcohol_raw !== undefined) h.alcohol_raw = Number(data.alcohol_raw);
  if (data.alcohol_safe !== undefined) {
    h.alcohol_safe = Boolean(data.alcohol_safe);
  } else {
    h.alcohol_safe = h.alcohol_raw < 750;
  }

  if (data.buckle_fastened !== undefined) {
    const prev = h.buckle_fastened;
    h.buckle_fastened = Boolean(data.buckle_fastened);
    if (prev !== h.buckle_fastened) {
      logSystemEvent('BUCKLE', h.buckle_fastened ? 'Helmet buckle FASTENED (secure)' : 'Helmet buckle UNLATCHED (hazard)', h.buckle_fastened ? 'success' : 'danger');
    }
  }

  if (data.rfid_authorized !== undefined) {
    const prev = h.rfid_authorized;
    h.rfid_authorized = Boolean(data.rfid_authorized);
    if (data.rfid_uid) h.rfid_uid = String(data.rfid_uid);
    if (h.rfid_authorized && !prev) {
      logSystemEvent('RFID', `Rider Authorized [UID: ${h.rfid_uid || 'AUTHORIZED'}]`, 'success');
    }
  }

  if (data.temperature_c !== undefined) h.temperature_c = Number(data.temperature_c);
  if (data.acceleration_m_s2 !== undefined) h.acceleration_m_s2 = Number(data.acceleration_m_s2);

  if (data.accel_x !== undefined) h.accel_x = Number(data.accel_x);
  if (data.accel_y !== undefined) h.accel_y = Number(data.accel_y);
  if (data.accel_z !== undefined) h.accel_z = Number(data.accel_z);

  if (data.gyro_x !== undefined) h.gyro_x = Number(data.gyro_x);
  if (data.gyro_y !== undefined) h.gyro_y = Number(data.gyro_y);
  if (data.gyro_z !== undefined) h.gyro_z = Number(data.gyro_z);

  if (data.crash_detected !== undefined) {
    const isCrash = Boolean(data.crash_detected);
    if (isCrash && !h.crash_detected) {
      h.last_crash_time = new Date().toISOString();
      logSystemEvent('CRASH', `HIGH-G IMPACT DETECTED! (${h.acceleration_m_s2.toFixed(1)} m/s²)`, 'danger');
    }
    h.crash_detected = isCrash;
  }

  if (data.heart_rate_bpm !== undefined) {
    h.heart_rate_bpm = data.heart_rate_bpm === null ? null : Number(data.heart_rate_bpm);
  }
  if (data.spo2_percent !== undefined) {
    h.spo2_percent = data.spo2_percent === null ? null : Number(data.spo2_percent);
  }

  if (data.max30105_red_raw !== undefined) h.max30105_red_raw = Number(data.max30105_red_raw);
  if (data.max30105_ir_raw !== undefined) h.max30105_ir_raw = Number(data.max30105_ir_raw);

  h.start_allowed = Boolean(h.alcohol_safe && h.buckle_fastened && h.rfid_authorized);

  const payload = getCombinedTelemetry();
  broadcastSSE('telemetry', payload);
  broadcastWS('telemetry', payload);
  return payload;
}

function handleBikeData(data) {
  const b = systemState.bike;
  b.online = true;
  b.lastSeen = Date.now();
  b.packetCount++;

  if (data.left_distance_cm !== undefined) b.left_distance_cm = Number(data.left_distance_cm);
  if (data.right_distance_cm !== undefined) b.right_distance_cm = Number(data.right_distance_cm);

  if (data.left_obstacle !== undefined) {
    b.left_obstacle = Boolean(data.left_obstacle);
  } else {
    b.left_obstacle = b.left_distance_cm >= 0 && b.left_distance_cm < 100.0;
  }

  if (data.right_obstacle !== undefined) {
    b.right_obstacle = Boolean(data.right_obstacle);
  } else {
    b.right_obstacle = b.right_distance_cm >= 0 && b.right_distance_cm < 100.0;
  }

  b.blind_spot_alert = b.left_obstacle || b.right_obstacle;

  if (data.latitude !== undefined) b.latitude = Number(data.latitude);
  if (data.longitude !== undefined) b.longitude = Number(data.longitude);
  if (data.speed_kmh !== undefined) b.speed_kmh = Number(data.speed_kmh);
  if (data.bike_stopped !== undefined) {
    b.bike_stopped = Boolean(data.bike_stopped);
  } else {
    b.bike_stopped = b.speed_kmh < 1.0;
  }

  const payload = getCombinedTelemetry();
  broadcastSSE('telemetry', payload);
  broadcastWS('telemetry', payload);
  return payload;
}

// ==================== WEBSOCKET DISPATCHER ====================

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`>>> [WEBSOCKET CONNECTED] Client: ${ip}`);

  // Send current state on connection
  ws.send(JSON.stringify({ type: 'telemetry', data: getCombinedTelemetry() }));

  ws.on('message', (rawMessage) => {
    try {
      const msg = JSON.parse(rawMessage.toString());
      console.log(`>>> [WS MESSAGE]`, msg.node || msg.type || 'unknown');

      if (msg.node === 'helmet' || msg.type === 'helmet') {
        handleHelmetData(msg.data || msg);
        // Instant response with bike blind-spot state
        ws.send(JSON.stringify({
          type: 'helmet_ack',
          blind_spot_alert: systemState.bike.blind_spot_alert,
          left_obstacle: systemState.bike.left_obstacle,
          right_obstacle: systemState.bike.right_obstacle,
          start_allowed: systemState.helmet.start_allowed
        }));
      } else if (msg.node === 'bike' || msg.type === 'bike') {
        handleBikeData(msg.data || msg);
        ws.send(JSON.stringify({
          type: 'bike_ack',
          start_allowed: systemState.helmet.start_allowed
        }));
      }
    } catch (err) {
      console.error("[WS PARSE ERROR]:", err.message);
    }
  });

  ws.on('close', () => {
    // console.log(`[WEBSOCKET DISCONNECTED] Client: ${ip}`);
  });
});

// ==================== REST API ENDPOINTS ====================

app.get('/api/helmet', (req, res) => {
  res.json({
    node: "helmet",
    ...systemState.helmet,
    online: Boolean(systemState.helmet.lastSeen && (Date.now() - systemState.helmet.lastSeen < 6000))
  });
});

app.post('/api/helmet', (req, res) => {
  console.log(`>>> [HTTP PACKET] POST /api/helmet from ${req.ip}`);
  const payload = handleHelmetData(req.body || {});
  res.json({
    success: true,
    message: "Helmet telemetry logged",
    start_allowed: systemState.helmet.start_allowed,
    blind_spot_alert: systemState.bike.blind_spot_alert
  });
});

app.get('/api/bike', (req, res) => {
  res.json({
    node: "bike",
    ...systemState.bike,
    online: Boolean(systemState.bike.lastSeen && (Date.now() - systemState.bike.lastSeen < 6000))
  });
});

app.post('/api/bike', (req, res) => {
  console.log(`>>> [HTTP PACKET] POST /api/bike from ${req.ip}`);
  const payload = handleBikeData(req.body || {});
  res.json({
    success: true,
    message: "Bike telemetry logged",
    blind_spot_alert: systemState.bike.blind_spot_alert,
    start_allowed: systemState.helmet.start_allowed
  });
});

app.get('/api/status', (req, res) => {
  res.json(getCombinedTelemetry());
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`event: telemetry\ndata: ${JSON.stringify(getCombinedTelemetry())}\n\n`);
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.post('/api/inject', (req, res) => {
  const { node, payload } = req.body || {};
  if (node === 'helmet') handleHelmetData(payload);
  else if (node === 'bike') handleBikeData(payload);
  res.json({ success: true, telemetry: getCombinedTelemetry() });
});

// Start unified Server (HTTP + WebSockets)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(` SMART HELMET & BIKE DUAL-PROTOCOL SERVER (HTTP + WS)`);
  console.log(` Web Dashboard:    http://localhost:${PORT}`);
  console.log(` WebSocket Server: ws://localhost:${PORT}`);
  console.log(` Helmet Endpoints: POST /api/helmet | WS {node:"helmet"}`);
  console.log(` Bike Endpoints:   POST /api/bike   | WS {node:"bike"}`);
  console.log(`=======================================================`);
});
