# Smart Helmet & Bike Telemetry Cockpit (Dual-Node IoT)

Industrial-grade, high-density telemetry platform for the ESP32 Smart Helmet & Bike Radar system.

---

## 1. Quick Start (Running Locally)

Your local telemetry server is already installed and runnable:

```bash
# Start the telemetry server
npm start
```

Open your browser to:
**[http://localhost:5000](http://localhost:5000)**

---

## 2. Real-Time Telemetry Protocol: WebSocket (RFC 6455 over Port 443)

### Why WebSockets Instead of HTTP?
1. **Persistent Duplex Stream**: Instead of establishing a new TCP connection and TLS handshake for every single sensor reading, WebSockets maintains an open, continuous bidirectional stream.
2. **Instant Blind-Spot Alerts**: When the Bike radar detects an obstacle (<100cm), the server immediately pushes a `blind_spot_alert` packet over the open WebSocket frame to the Helmet node, turning on the **GPIO 26 HUD LED** with zero polling delay.
3. **Zero External Arduino Libraries**: Built directly using standard ESP32 core `<WiFiClientSecure.h>` and RFC 6455 masked framing, ensuring 100% compatibility with Cirkit Designer's WebAssembly compiler.
4. **Campus Firewall Bypass**: Communicates over standard TLS port 443 (`wss://`), traversing university firewalls without requiring custom ports like MQTT (1883).

---

## 3. How to Run in Cirkit Designer (3-Step Quick Guide)

1. **Stop Simulation**:
   - In Cirkit Designer (`cirkitdesigner.com`), click the **Stop button (■)** first.
2. **Paste Firmware Sketches**:
   - In your **Helmet ESP32** code tab, replace all code with `Smart_Helmet_Node.ino`.
   - In your **Bike ESP32** code tab, replace all code with `Smart_Bike_Node.ino`.
   *(Both sketches already have `WIFI_SSID = "CirkitWifi"` and the live ngrok WSS tunnel configured).*
3. **Click Simulate (▶)**:
   - Click **Simulate** in Cirkit Designer.
   - Look at the Cirkit Serial Monitor:
     ```
     >>> CIRKIT WIFI CONNECTED! <<<
     >>> WEBSOCKET DUPLEX STREAM CONNECTED! <<<
     >> [WS SENT] 320 bytes of Helmet telemetry
     ```
   - Open your dashboard at **[http://localhost:5000](http://localhost:5000)**. Both the **Smart Helmet Node** and **Smart Bike Radar** badges will turn **ONLINE (GREEN)** with live telemetry updating in real time!

---

## 4. Dual Protocol Server Reference

| Protocol | Address / Endpoint | Purpose |
|---|---|---|
| **WebSocket (WSS)** | `wss://colorably-starchless-collen.ngrok-free.dev` | Real-time duplex telemetry streaming for ESP32 nodes |
| **WebSocket (Local)** | `ws://localhost:5000` | Real-time browser telemetry updates |
| **HTTP Web UI** | `http://localhost:5000` | Cockpit dashboard interface |
| **REST Fallback** | `POST /api/helmet`, `POST /api/bike` | Legacy HTTP endpoints for manual testing |
| **SSE Stream** | `GET /api/stream` | Browser Server-Sent Events fallback |

---

## 5. Built-in Hardware Test Bench

Click the **"Hardware Test Bench"** button on the top-right of the dashboard at any time to:
- Toggle the Helmet Buckle switch
- Scan or revoke RFID access
- Move the Alcohol Sensor slider
- Trigger high-G impact collisions
- Slide Left and Right ultrasonic distances to watch the radar cones and helmet HUD LED respond in real time!
