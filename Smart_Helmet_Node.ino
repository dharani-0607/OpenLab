/*
  =============================================================================
  SMART HELMET NODE - ESP32 (CIRKIT SIMULATOR & HARDWARE READY)
  =============================================================================
  Sensors connected:
    1. MQ-3 Alcohol Sensor      -> GPIO 34 (Analog ADC)
    2. Helmet Buckle Switch     -> GPIO 27 (INPUT_PULLUP, LOW = Fastened)
    3. MFRC522 RFID Reader      -> SPI (SS:5, RST:4, SCK:18, MISO:19, MOSI:23)
    4. LM35 Temperature Sensor  -> GPIO 35 (Analog ADC)
    5. MPU6050 Accel + Gyro     -> I2C (SDA:21, SCL:22)
    6. MAX30105 Optical HR/SpO2 -> I2C (SDA:21, SCL:22)
    7. Blind-Spot HUD LED       -> GPIO 26 (OUTPUT)
  =============================================================================
*/

// ==================== LIBRARIES ====================
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <math.h>

// ==================== CONFIGURATION ====================

// NOTE FOR CIRKIT SIMULATOR:
// Cirkit Designer's simulated virtual WiFi is named "CirkitWifi" with NO PASSWORD.
const char* WIFI_SSID     = "CirkitWifi";
const char* WIFI_PASSWORD = "";

// LIVE PUBLIC TUNNEL URL (Already active and running on your computer):
const char* SERVER_URL    = "https://colorably-starchless-collen.ngrok-free.dev";

// Authorized RFID Card UID
const char* AUTHORIZED_UID = "DE AD BE EF";

// ==================== PIN CONFIGURATION ====================
#define MQ3_PIN        34
#define BUCKLE_PIN     27
#define LM35_PIN       35
#define BLIND_LED_PIN  26

#define RFID_SS_PIN    5
#define RFID_RST_PIN   4

// ==================== THRESHOLDS & TIMERS ====================
const int ALCOHOL_LIMIT         = 750;   // Demo threshold
const unsigned long RFID_VALID_MS     = 30000; // 30 seconds authorization validity
const unsigned long POST_INTERVAL_MS  = 1000;  // Send to dashboard every 1s
const unsigned long SERIAL_INTERVAL_MS= 1000;
const float CRASH_ACCEL_THRESHOLD     = 25.0f; // Impact magnitude threshold

// ==================== SENSOR OBJECTS ====================
MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
Adafruit_MPU6050 mpu;

// ==================== MAX30105 REGISTERS ====================
#define MAX_ADDR       0x57
#define REG_INT_EN1    0x02
#define REG_INT_EN2    0x03
#define REG_FIFO_WR    0x04
#define REG_OVF        0x05
#define REG_FIFO_RD    0x06
#define REG_FIFO_DATA  0x07
#define REG_FIFO_CFG   0x08
#define REG_MODE       0x09
#define REG_SPO2_CFG   0x0A
#define REG_RED_LED    0x0C
#define REG_IR_LED     0x0D
#define REG_PILOT_LED  0x10
#define REG_PART_ID    0xFF

// ==================== STATUS VARIABLES ====================
bool maxReady         = false;
bool mpuReady         = false;
bool rfidAuthorized   = false;
String lastScannedUID = "";
bool crashDetected    = false;

bool leftObstacle     = false;
bool rightObstacle    = false;

bool buckleFastened   = false;
bool alcoholSafe      = false;
bool startAllowed     = false;

bool heartRateValid   = false;
bool spo2Valid        = false;
bool maxFingerDetected= false;

unsigned long rfidTime        = 0;
unsigned long lastCrashTime   = 0;
unsigned long lastPostTime    = 0;
unsigned long lastSerialPrint = 0;

// Sensor Readings
int alcoholRaw            = 0;
int temperatureRaw        = 0;
float temperatureVoltage  = 0.0f;
float temperatureC        = 0.0f;

float accelX = 0.0f, accelY = 0.0f, accelZ = 9.81f;
float gyroX  = 0.0f, gyroY  = 0.0f, gyroZ  = 0.0f;
float accelerationMagnitude = 9.81f;

uint32_t latestRed = 0;
uint32_t latestIR  = 0;
float heartRate    = 0.0f;
float spo2         = 0.0f;

// MAX30105 Sample Buffer
const int WINDOW_SIZE = 100;
uint32_t redSamples[WINDOW_SIZE];
uint32_t irSamples[WINDOW_SIZE];
int sampleCount = 0;

float irDC        = 0.0f;
float previousAC  = 0.0f;
float olderAC     = 0.0f;
unsigned long lastBeatTime = 0;

float bpmHistory[5];
int bpmIndex = 0;
int bpmCount = 0;

// ==================== MAX30105 I2C HELPERS ====================
bool writeMAX(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MAX_ADDR);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool readMAX(uint8_t reg, uint8_t* data, size_t length) {
  Wire.beginTransmission(MAX_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  size_t received = Wire.requestFrom((uint8_t)MAX_ADDR, (uint8_t)length);
  if (received != length) {
    while (Wire.available()) Wire.read();
    return false;
  }
  for (size_t i = 0; i < length; i++) data[i] = Wire.read();
  return true;
}

bool initMAX30105() {
  uint8_t partID = 0;
  if (!readMAX(REG_PART_ID, &partID, 1)) {
    Serial.println("WARNING: MAX30105 not responding at 0x57 (will continue)");
    return false;
  }
  writeMAX(REG_MODE, 0x40); // Reset
  delay(100);
  writeMAX(REG_INT_EN1, 0x00);
  writeMAX(REG_INT_EN2, 0x00);
  writeMAX(REG_FIFO_WR, 0x00);
  writeMAX(REG_OVF, 0x00);
  writeMAX(REG_FIFO_RD, 0x00);
  writeMAX(REG_FIFO_CFG, 0x4F);
  writeMAX(REG_MODE, 0x03);
  writeMAX(REG_SPO2_CFG, 0x27);
  writeMAX(REG_RED_LED, 0x24);
  writeMAX(REG_IR_LED, 0x24);
  writeMAX(REG_PILOT_LED, 0x20);
  delay(100);
  Serial.println("MAX30105 initialized in Red + IR mode");
  return true;
}

// ==================== RFID HELPER ====================
String getUID() {
  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
    if (i + 1 < rfid.uid.size) uid += " ";
  }
  uid.toUpperCase();
  return uid;
}

void checkRFID() {
  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial()) return;

  lastScannedUID = getUID();
  String validUID = String(AUTHORIZED_UID);
  validUID.toUpperCase();

  Serial.println("\n========== RFID SCANNED ==========");
  Serial.print("Card UID: ");
  Serial.println(lastScannedUID);

  rfidAuthorized = (lastScannedUID == validUID);
  if (rfidAuthorized) {
    rfidTime = millis();
    Serial.println("Access Result: >>> AUTHORIZED <<<");
  } else {
    Serial.println("Access Result: >>> ACCESS DENIED <<<");
  }
  Serial.println("==================================");

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}

// ==================== HEART RATE & SPO2 PROCESSING ====================
void detectPulse(uint32_t irValue) {
  if (irDC == 0.0f) irDC = (float)irValue;
  irDC = 0.95f * irDC + 0.05f * (float)irValue;
  float ac = (float)irValue - irDC;
  float threshold = fmaxf(150.0f, irDC * 0.0015f);

  bool peak = olderAC < previousAC && previousAC > ac && previousAC > threshold;
  if (peak) {
    unsigned long now = millis();
    if (lastBeatTime != 0) {
      unsigned long interval = now - lastBeatTime;
      if (interval >= 300 && interval <= 1500) {
        float bpm = 60000.0f / (float)interval;
        bpmHistory[bpmIndex] = bpm;
        bpmIndex = (bpmIndex + 1) % 5;
        if (bpmCount < 5) bpmCount++;
        float total = 0.0f;
        for (int i = 0; i < bpmCount; i++) total += bpmHistory[i];
        heartRate = total / bpmCount;
        heartRateValid = true;
      }
    }
    lastBeatTime = now;
  }
  olderAC = previousAC;
  previousAC = ac;
}

void calculateSpO2() {
  if (sampleCount < WINDOW_SIZE) return;
  double redMean = 0.0, irMean = 0.0;
  uint32_t redMin = 0xFFFFFFFF, irMin = 0xFFFFFFFF;
  uint32_t redMax = 0, irMax = 0;

  for (int i = 0; i < WINDOW_SIZE; i++) {
    redMean += redSamples[i];
    irMean += irSamples[i];
    if (redSamples[i] < redMin) redMin = redSamples[i];
    if (irSamples[i] < irMin)  irMin = irSamples[i];
    if (redSamples[i] > redMax) redMax = redSamples[i];
    if (irSamples[i] > irMax)  irMax = irSamples[i];
  }
  redMean /= WINDOW_SIZE;
  irMean /= WINDOW_SIZE;

  double redAC = (double)(redMax - redMin);
  double irAC = (double)(irMax - irMin);

  if (redMean > 0.0 && irMean > 0.0 && redAC > 20.0 && irAC > 50.0) {
    double ratio = (redAC / redMean) / (irAC / irMean);
    double result = 110.0 - 25.0 * ratio;
    if (result > 100.0) result = 100.0;
    if (result < 70.0)  result = 70.0;
    spo2 = (float)result;
    spo2Valid = true;
  } else {
    spo2Valid = false;
  }
  sampleCount = 0;
}

void readMAX30105() {
  if (!maxReady) return;
  uint8_t writePtr = 0, readPtr = 0;
  if (!readMAX(REG_FIFO_WR, &writePtr, 1)) return;
  if (!readMAX(REG_FIFO_RD, &readPtr, 1)) return;

  int available = (writePtr - readPtr) & 0x1F;
  while (available-- > 0) {
    uint8_t data[6];
    if (!readMAX(REG_FIFO_DATA, data, 6)) break;

    uint32_t red = (((uint32_t)data[0] << 16) | ((uint32_t)data[1] << 8) | data[2]) & 0x3FFFF;
    uint32_t ir  = (((uint32_t)data[3] << 16) | ((uint32_t)data[4] << 8) | data[5]) & 0x3FFFF;

    latestRed = red;
    latestIR  = ir;
    maxFingerDetected = (ir >= 10000);

    if (!maxFingerDetected) {
      heartRateValid = false;
      spo2Valid = false;
      heartRate = 0.0f;
      spo2 = 0.0f;
      sampleCount = 0;
      irDC = 0.0f;
      previousAC = 0.0f;
      olderAC = 0.0f;
      lastBeatTime = 0;
      bpmCount = 0;
      bpmIndex = 0;
      continue;
    }

    detectPulse(ir);
    redSamples[sampleCount] = red;
    irSamples[sampleCount]  = ir;
    sampleCount++;
    if (sampleCount >= WINDOW_SIZE) calculateSpO2();
  }

  if (lastBeatTime != 0 && (millis() - lastBeatTime > 4000)) {
    heartRateValid = false;
    heartRate = 0.0f;
  }
}

// ==================== MULTI-CHANNEL TELEMETRY ENGINE ====================

const char* NGROK_HOST   = "colorably-starchless-collen.ngrok-free.dev";
const char* GATEWAY_HOST = "10.0.0.1";
const char* LOCAL_HOST   = "127.0.0.1";

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
  // Channel 3: Public Tunnel (ngrok:443 via TLS)
  else {
    Serial.println("[Net Engine] Testing Channel 3: Public Tunnel (ngrok:443)...");
    secureClient.stop();
    secureClient.setInsecure();
    secureClient.setTimeout(3500);
    if (secureClient.connect(NGROK_HOST, 443)) {
      Serial.println(">>> CHANNEL 3 CONNECTED: ngrok Tunnel (port 443) <<<");
      activeClient = &secureClient;
      connectedEndpoint = String(NGROK_HOST);
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
    Serial.println(">>> HELMET WEBSOCKET STREAM ESTABLISHED! <<<");
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

  uint8_t mask[4] = { 0x35, 0x7A, 0x19, 0x4B };
  activeClient->write(mask, 4);

  for (size_t i = 0; i < len; i++) {
    activeClient->write((uint8_t)(payload[i] ^ mask[i % 4]));
  }
  Serial.printf(">> [WS STREAM] Sent %d bytes to Dashboard via %s\n", len, connectedEndpoint.c_str());
}

// Read incoming WebSocket server messages (real-time blind spot alert)
void readWS() {
  if (activeClient == nullptr || !activeClient->connected()) return;

  while (activeClient->available()) {
    String line = activeClient->readString();
    if (line.indexOf("blind_spot_alert\":true") >= 0) {
      leftObstacle = true;
      digitalWrite(BLIND_LED_PIN, HIGH);
      Serial.println(">> [ALERT] Blind-spot hazard detected! HUD LED ON");
    } else if (line.indexOf("blind_spot_alert\":false") >= 0) {
      leftObstacle = false;
      rightObstacle = false;
      digitalWrite(BLIND_LED_PIN, LOW);
    }
  }
}

// Send Helmet telemetry frame
void sendHelmetData() {
  alcoholSafe  = alcoholRaw < ALCOHOL_LIMIT;
  startAllowed = alcoholSafe && buckleFastened && rfidAuthorized;

  DynamicJsonDocument doc(1024);

  doc["node"]             = "helmet";
  doc["alcohol_raw"]      = alcoholRaw;
  doc["alcohol_safe"]     = alcoholSafe;
  doc["buckle_fastened"]  = buckleFastened;
  doc["rfid_authorized"]  = rfidAuthorized;
  doc["rfid_uid"]         = lastScannedUID.length() > 0 ? lastScannedUID : AUTHORIZED_UID;
  doc["start_allowed"]    = startAllowed;
  doc["temperature_c"]    = temperatureC;
  doc["acceleration_m_s2"]= accelerationMagnitude;
  doc["accel_x"]          = accelX;
  doc["accel_y"]          = accelY;
  doc["accel_z"]          = accelZ;
  doc["gyro_x"]           = gyroX;
  doc["gyro_y"]           = gyroY;
  doc["gyro_z"]           = gyroZ;
  doc["crash_detected"]   = crashDetected;
  doc["blind_spot_alert"] = leftObstacle || rightObstacle;

  if (heartRateValid && heartRate > 0) doc["heart_rate_bpm"] = heartRate;
  else doc["heart_rate_bpm"] = nullptr;

  if (spo2Valid && spo2 > 0) doc["spo2_percent"] = spo2;
  else doc["spo2_percent"] = nullptr;

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
    "http://10.0.0.1:5000/api/helmet",
    "http://127.0.0.1:5000/api/helmet",
    "https://colorably-starchless-collen.ngrok-free.dev/api/helmet"
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

      // Check response payload for blind spot status
      String resp = http.getString();
      if (resp.indexOf("blind_spot_alert\":true") >= 0) {
        digitalWrite(BLIND_LED_PIN, HIGH);
      } else if (resp.indexOf("blind_spot_alert\":false") >= 0) {
        digitalWrite(BLIND_LED_PIN, LOW);
      }

      http.end();
      break;
    }
    http.end();
  }

  if (!sent) {
    Serial.println(">> [TELEMETRY] Probing available channels...");
  }
}

// ==================== SERIAL MONITOR OUTPUT ====================
void printAllSensorValues() {
  Serial.println("\n--- HELMET NODE TELEMETRY ---");
  Serial.print("WiFi: ");
  Serial.println(WiFi.status() == WL_CONNECTED ? "CONNECTED" : "DISCONNECTED");

  Serial.printf("Alcohol ADC: %d (%s)\n", alcoholRaw, alcoholSafe ? "SAFE" : "HAZARD");
  Serial.printf("Buckle: %s\n", buckleFastened ? "FASTENED (LOW)" : "OPEN (HIGH)");
  Serial.printf("RFID: %s\n", rfidAuthorized ? "AUTHORIZED" : "DENIED");
  Serial.printf("Temp: %.1f C\n", temperatureC);
  Serial.printf("Accel Mag: %.2f m/s2 | Crash: %s\n", accelerationMagnitude, crashDetected ? "CRITICAL CRASH!" : "NO");
  Serial.printf("Heart Rate: %.0f BPM | SpO2: %.1f %%\n", heartRateValid ? heartRate : 0.0f, spo2Valid ? spo2 : 0.0f);
  Serial.printf("Blind-spot HUD: %s\n", (leftObstacle || rightObstacle) ? "LED ACTIVE (ALERT)" : "CLEAR");
  Serial.printf("Master Start Allowed: %s\n", startAllowed ? "YES (AUTHORIZED)" : "NO (INTERLOCK LOCKED)");
  Serial.println("-----------------------------");
}

// ==================== SETUP ====================
void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n==================================");
  Serial.println(" SMART HELMET NODE STARTING");
  Serial.println("==================================");

  pinMode(BUCKLE_PIN, INPUT_PULLUP);
  pinMode(BLIND_LED_PIN, OUTPUT);
  digitalWrite(BLIND_LED_PIN, LOW);

  analogReadResolution(12);
  pinMode(MQ3_PIN, INPUT);
  pinMode(LM35_PIN, INPUT);

  Wire.begin(21, 22);
  Wire.setClock(100000);

  SPI.begin(18, 19, 23, RFID_SS_PIN);
  rfid.PCD_Init();
  Serial.println("RFID Reader Ready");

  mpuReady = mpu.begin(0x68, &Wire);
  if (mpuReady) {
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    Serial.println("MPU6050 Ready");
  }

  maxReady = initMAX30105();

  // Wi-Fi Connection
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
    Serial.println(">>> CIRKIT WIFI CONNECTED! <<<");
    Serial.print("ESP32 IP Address: ");
    Serial.println(WiFi.localIP());
    Serial.println("=========================================");
    connectWS();
  } else {
    Serial.printf("[WiFi] Status code: %d (Not connected yet). Will retry in loop.\n", WiFi.status());
  }
}

// ==================== MAIN LOOP ====================
void loop() {
  checkRFID();
  readMAX30105();

  alcoholRaw = analogRead(MQ3_PIN);
  buckleFastened = (digitalRead(BUCKLE_PIN) == LOW); // LOW when fastened with INPUT_PULLUP

  temperatureRaw = analogRead(LM35_PIN);
  temperatureVoltage = (temperatureRaw / 4095.0f) * 3.3f;
  temperatureC = temperatureVoltage * 100.0f;

  if (mpuReady) {
    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);
    accelX = a.acceleration.x;
    accelY = a.acceleration.y;
    accelZ = a.acceleration.z;
    gyroX  = g.gyro.x;
    gyroY  = g.gyro.y;
    gyroZ  = g.gyro.z;

    accelerationMagnitude = sqrtf(accelX*accelX + accelY*accelY + accelZ*accelZ);

    if (accelerationMagnitude > CRASH_ACCEL_THRESHOLD && (millis() - lastCrashTime > 5000)) {
      crashDetected = true;
      lastCrashTime = millis();
    }
    if (millis() - lastCrashTime > 3000) {
      crashDetected = false;
    }
  }

  // Expire RFID authorization after 30s
  if (rfidAuthorized && (millis() - rfidTime > RFID_VALID_MS)) {
    rfidAuthorized = false;
  }

  // Real-time bidirectional WebSocket reception (instant blind spot HUD alert)
  readWS();

  // Stream telemetry to dashboard every 1 second over WebSocket
  if (millis() - lastPostTime >= POST_INTERVAL_MS) {
    lastPostTime = millis();
    sendHelmetData();
  }

  if (millis() - lastSerialPrint >= SERIAL_INTERVAL_MS) {
    lastSerialPrint = millis();
    printAllSensorValues();
  }

  delay(10);
}
