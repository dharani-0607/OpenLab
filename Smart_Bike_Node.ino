/*
  =============================================================================
  SMART BIKE NODE - ESP32 (CIRKIT SIMULATOR & HARDWARE READY)
  =============================================================================
  Sensors connected:
    1. Left Ultrasonic Sensor   -> TRIG: GPIO 18, ECHO: GPIO 19
    2. Right Ultrasonic Sensor  -> TRIG: GPIO 25, ECHO: GPIO 33
    3. Simulated GPS Pots       -> LAT: GPIO 34, LON: GPIO 35
  Features:
    - Measures left & right blind-spot distance in centimeters
    - Detects obstacles under 100cm (rear blind-spot zone)
    - Reads simulated GPS coordinates from potentiometers
    - Connects to Wi-Fi ("CirkitWifi" in simulator or your home network)
    - Multi-Channel Telemetry: WebSocket (Gateway/Localhost/ngrok) + HTTP fallback
  =============================================================================
*/

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ==================== CONFIGURATION ====================

// Cirkit Designer virtual WiFi:
const char* WIFI_SSID     = "CirkitWifi";
const char* WIFI_PASSWORD = "";

// Multi-Channel Telemetry Endpoints:
const char* RENDER_HOST   = "openlab-ayc4.onrender.com";
const char* GATEWAY_HOST  = "10.0.0.1";
const char* LOCAL_HOST    = "127.0.0.1";

// ==================== PIN DEFINITIONS ====================

#define LEFT_TRIG   18
#define LEFT_ECHO   19
#define RIGHT_TRIG  25
#define RIGHT_ECHO  33

#define LAT_PIN     34
#define LON_PIN     35

#define USE_POTENTIOMETERS 1

const float OBSTACLE_LIMIT_CM    = 100.0;
const unsigned long POST_INTERVAL= 1000;

// ==================== GLOBALS ====================

unsigned long lastPostTime = 0;
float leftDistance = 100.0;
float rightDistance = 100.0;
bool leftObstacle = false;
bool rightObstacle = false;
bool blindSpotAlert = false;
float latitude = 10.045714;
float longitude = 76.045714;
float speedKmh = 38.5;
bool bikeStopped = false;

// ==================== SENSOR LOGIC ====================

float readDistanceCM(int trigPin, int echoPin) {
  digitalWrite(trigPin, LOW);
  delayMicroseconds(3);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  unsigned long duration = pulseIn(echoPin, HIGH, 25000UL);
  if (duration == 0) return -1;
  return duration * 0.0343 / 2.0;
}

void printDistance(const char *label, float distance) {
  Serial.print(label);
  if (distance < 0) {
    Serial.println("No echo");
  } else {
    Serial.print(distance, 1);
    Serial.println(" cm");
  }
}

// ==================== MULTI-CHANNEL TELEMETRY ENGINE ====================

WiFiClientSecure secureClient;
WiFiClient       plainClient;
Client*          activeClient = nullptr;

bool wsConnected = false;
unsigned long lastWsConnectAttempt = 0;
String connectedEndpoint = "";

bool connectWS() {
  if (WiFi.status() != WL_CONNECTED) return false;

  wsConnected = false;
  activeClient = nullptr;

  Serial.println("\n[Net Engine] Probing telemetry channel routes...");

  // Channel 1: Virtual Host Gateway (10.0.0.1:5000)
  plainClient.stop();
  plainClient.setTimeout(1200);
  if (plainClient.connect(GATEWAY_HOST, 5000)) {
    Serial.println(">>> CHANNEL 1 CONNECTED: Host Gateway (10.0.0.1:5000) <<<");
    activeClient = &plainClient;
    connectedEndpoint = "10.0.0.1:5000";
  }
  // Channel 2: Localhost Loopback (127.0.0.1:5000)
  else if (plainClient.connect(LOCAL_HOST, 5000)) {
    Serial.println(">>> CHANNEL 2 CONNECTED: Localhost (127.0.0.1:5000) <<<");
    activeClient = &plainClient;
    connectedEndpoint = "127.0.0.1:5000";
  }
  // Channel 3: Public Render Cloud (openlab-ayc4.onrender.com:443 via TLS)
  else {
    Serial.println("[Net Engine] Testing Channel 3: Render Cloud (port 443)...");
    secureClient.stop();
    secureClient.setInsecure();
    secureClient.setTimeout(3500);
    if (secureClient.connect(RENDER_HOST, 443)) {
      Serial.println(">>> CHANNEL 3 CONNECTED: Render Cloud (port 443) <<<");
      activeClient = &secureClient;
      connectedEndpoint = String(RENDER_HOST);
    } else {
      Serial.println("[Net Engine] Direct socket link bypassed. Using HTTP Engine.");
      return false;
    }
  }

  // Perform RFC 6455 Handshake
  activeClient->println("GET / HTTP/1.1");
  activeClient->println("Host: " + connectedEndpoint);
  activeClient->println("Upgrade: websocket");
  activeClient->println("Connection: Upgrade");
  activeClient->println("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==");
  activeClient->println("Sec-WebSocket-Version: 13");
  activeClient->println("ngrok-skip-browser-warning: 1");
  activeClient->println();

  unsigned long t0 = millis();
  while (activeClient->connected() && millis() - t0 < 3000) {
    String line = activeClient->readStringUntil('\n');
    if (line.indexOf("101") >= 0) {
      wsConnected = true;
    }
    if (line == "\r" || line.length() == 0) break;
  }

  if (wsConnected) {
    Serial.println("=========================================");
    Serial.println(">>> BIKE WEBSOCKET STREAM ESTABLISHED! <<<");
    Serial.println("Route: " + connectedEndpoint);
    Serial.println("=========================================");
  } else {
    Serial.println("[WS] Upgrade rejected. Switching to HTTP fallback.");
    activeClient->stop();
    activeClient = nullptr;
  }

  return wsConnected;
}

// Send standard RFC 6455 masked WebSocket frame
void sendWS(const String& payload) {
  if (activeClient == nullptr || !activeClient->connected()) {
    wsConnected = false;
    return;
  }

  size_t len = payload.length();
  activeClient->write((uint8_t)0x81); // Text frame FIN

  if (len <= 125) {
    activeClient->write((uint8_t)(0x80 | len));
  } else if (len <= 65535) {
    activeClient->write((uint8_t)(0x80 | 126));
    activeClient->write((uint8_t)((len >> 8) & 0xFF));
    activeClient->write((uint8_t)(len & 0xFF));
  }

  uint8_t mask[4] = { 0x4A, 0x1F, 0x82, 0x93 };
  activeClient->write(mask, 4);

  for (size_t i = 0; i < len; i++) {
    activeClient->write((uint8_t)(payload[i] ^ mask[i % 4]));
  }
  Serial.printf(">> [WS STREAM] Sent %d bytes to Dashboard via %s\n", len, connectedEndpoint.c_str());
}

// Send Bike telemetry frame
void sendBikeData() {
  DynamicJsonDocument doc(512);

  doc["node"]              = "bike";
  doc["left_distance_cm"]  = leftDistance;
  doc["right_distance_cm"] = rightDistance;
  doc["left_obstacle"]     = leftObstacle;
  doc["right_obstacle"]    = rightObstacle;
  doc["blind_spot_alert"]  = blindSpotAlert;
  doc["latitude"]          = latitude;
  doc["longitude"]         = longitude;
  doc["speed_kmh"]         = speedKmh;
  doc["bike_stopped"]      = bikeStopped;

  String body;
  serializeJson(doc, body);

  // 1. Preferred: High-speed WebSocket stream
  if (activeClient != nullptr && activeClient->connected() && wsConnected) {
    sendWS(body);
    return;
  }

  // Periodic WS reconnection attempt
  if (millis() - lastWsConnectAttempt > 5000) {
    lastWsConnectAttempt = millis();
    if (connectWS()) {
      sendWS(body);
      return;
    }
  }

  // 2. Fallback: HTTP Dispatch across probed endpoints
  HTTPClient http;
  http.setTimeout(2500);

  const char* urls[] = {
    "http://10.0.0.1:5000/api/bike",
    "http://127.0.0.1:5000/api/bike",
    "https://openlab-ayc4.onrender.com/api/bike"
  };

  bool sent = false;
  for (int i = 0; i < 3; i++) {
    WiFiClient c;
    WiFiClientSecure sc;
    sc.setInsecure();

    if (String(urls[i]).startsWith("https")) {
      http.begin(sc, urls[i]);
    } else {
      http.begin(c, urls[i]);
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("ngrok-skip-browser-warning", "1");

    int code = http.POST(body);
    if (code >= 200 && code < 300) {
      Serial.printf(">> [TELEMETRY SENT] %s (HTTP %d OK)\n", urls[i], code);
      sent = true;
      http.end();
      break;
    }
    http.end();
  }

  if (!sent) {
    Serial.println(">> [TELEMETRY] Probing available channels...");
  }
}

// ==================== SETUP ====================

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n==================================");
  Serial.println(" SMART HELMET - BIKE NODE");
  Serial.println("==================================");

  pinMode(LEFT_TRIG, OUTPUT);
  pinMode(LEFT_ECHO, INPUT);
  pinMode(RIGHT_TRIG, OUTPUT);
  pinMode(RIGHT_ECHO, INPUT);

  digitalWrite(LEFT_TRIG, LOW);
  digitalWrite(RIGHT_TRIG, LOW);

#if USE_POTENTIOMETERS
  pinMode(LAT_PIN, INPUT);
  pinMode(LON_PIN, INPUT);
#endif

  // Connect to Cirkit virtual Wi-Fi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.println("\n[WiFi] Connecting to CirkitWifi...");

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 60) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("=========================================");
    Serial.println(">>> BIKE CIRKIT WIFI CONNECTED! <<<");
    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());
    Serial.println("=========================================");
    connectWS();
  } else {
    Serial.printf("[WiFi] Status code: %d. Will retry in loop.\n", WiFi.status());
  }
}

// ==================== MAIN LOOP ====================

void loop() {
  leftDistance = readDistanceCM(LEFT_TRIG, LEFT_ECHO);
  delay(60);
  rightDistance = readDistanceCM(RIGHT_TRIG, RIGHT_ECHO);

  leftObstacle = (leftDistance >= 0 && leftDistance < OBSTACLE_LIMIT_CM);
  rightObstacle = (rightDistance >= 0 && rightDistance < OBSTACLE_LIMIT_CM);
  blindSpotAlert = (leftObstacle || rightObstacle);

  latitude = 10.045714;
  longitude = 76.045714;

#if USE_POTENTIOMETERS
  int latRaw = analogRead(LAT_PIN);
  int lonRaw = analogRead(LON_PIN);
  latitude = 10.0 + (latRaw / 4095.0) * 0.1;
  longitude = 76.0 + (lonRaw / 4095.0) * 0.1;
#endif

  speedKmh = 38.5;
  bikeStopped = (speedKmh < 1.0);

  // Send to dashboard every 1s
  if (millis() - lastPostTime >= POST_INTERVAL) {
    lastPostTime = millis();

    Serial.println("\n--- BIKE NODE STATUS ---");
    printDistance("Left distance: ", leftDistance);
    printDistance("Right distance: ", rightDistance);
    Serial.print("Left obstacle: ");
    Serial.println(leftObstacle ? "YES" : "NO");
    Serial.print("Right obstacle: ");
    Serial.println(rightObstacle ? "YES" : "NO");
    Serial.print("Blind-spot alert: ");
    Serial.println(blindSpotAlert ? "ON" : "OFF");
    Serial.printf("Latitude: %.6f | Longitude: %.6f\n", latitude, longitude);
    Serial.printf("Speed: %.1f km/h | Stopped: %s\n", speedKmh, bikeStopped ? "YES" : "NO");
    Serial.println("------------------------");

    sendBikeData();
  }

  delay(40);
}
