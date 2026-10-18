/*
  Farmers for Farmers: tractor-mount soil probe (prototype)
  Arduino Uno + capacitive soil moisture sensor v1.2 (+ optional DHT11/DHT22 air sensor)

  Wiring
    Soil sensor:  VCC -> 5V, GND -> GND, AOUT -> A0
    DHT11 (opt):  VCC -> 5V, GND -> GND, DATA -> D2 (10k pull-up to 5V if it's a bare sensor)

  Output: one JSON line per second at 9600 baud, read by the website over Web Serial:
    {"raw":412,"moisture":41.5,"temp":22.0,"hum":51.0}

  Calibrate: note the raw value with the probe in dry air (DRY_RAW) and in a cup of
  water (WET_RAW), then update the two constants below.
  A resistive (fork) sensor reads the other way round (wet = high), so swap the constants.
*/

// #define USE_DHT   // uncomment if a DHT sensor is wired (needs "DHT sensor library" by Adafruit)

#ifdef USE_DHT
#include <DHT.h>
#define DHT_PIN 2
#define DHT_TYPE DHT11   // or DHT22
DHT dht(DHT_PIN, DHT_TYPE);
#endif

const int SOIL_PIN = A0;
const int DRY_RAW = 520;   // probe in air
const int WET_RAW = 260;   // probe in water
const int LED = LED_BUILTIN;

void setup() {
  Serial.begin(9600);
  pinMode(LED, OUTPUT);
#ifdef USE_DHT
  dht.begin();
#endif
}

int readSoilRaw() {
  long sum = 0;
  for (int i = 0; i < 10; i++) {   // average out noise
    sum += analogRead(SOIL_PIN);
    delay(5);
  }
  return sum / 10;
}

void loop() {
  int raw = readSoilRaw();
  float pct = (float)(DRY_RAW - raw) * 100.0 / (DRY_RAW - WET_RAW);
  pct = constrain(pct, 0.0, 100.0);

  // Blink fast when the soil is dry, so it's visible on the table during the demo.
  digitalWrite(LED, pct < 25 ? !digitalRead(LED) : LOW);

  Serial.print("{\"raw\":");
  Serial.print(raw);
  Serial.print(",\"moisture\":");
  Serial.print(pct, 1);
#ifdef USE_DHT
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (!isnan(t) && !isnan(h)) {
    Serial.print(",\"temp\":");
    Serial.print(t, 1);
    Serial.print(",\"hum\":");
    Serial.print(h, 1);
  }
#endif
  Serial.println("}");
  delay(1000);
}
