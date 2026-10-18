/*
  DHT11 wiring diagnosis (no multimeter needed).
  Upload, open Serial Monitor at 9600 baud, read the verdict lines.

  How it works: the blue DHT11 module has a pull-up resistor from S to its + leg,
  so when the module is powered and S is wired to pin 2, pin 2 sits HIGH.
  We read pin 2 with and without the Arduino's own pull-up to tell apart:
    - S line working, - S wired to ground, - pin 2 connected to nothing.
  Then we try a real DHT11 reading.
*/
#include <DHT.h>

const int PIN = 2;
DHT dht(PIN, DHT11);

int countHighs(int mode) {
  pinMode(PIN, mode);
  delay(20);
  int highs = 0;
  for (int i = 0; i < 100; i++) { highs += digitalRead(PIN); delayMicroseconds(300); }
  return highs;
}

void setup() {
  Serial.begin(9600);
  delay(1500); // DHT11 needs ~1 s after power-up
}

void loop() {
  int plain = countHighs(INPUT);          // no internal pull-up: floats if nothing is connected
  int pulled = countHighs(INPUT_PULLUP);  // internal pull-up: HIGH unless something drags it to ground

  Serial.print("pin 2 HIGH readings: "); Serial.print(plain);
  Serial.print("/100 plain, "); Serial.print(pulled); Serial.println("/100 with pull-up");

  if (pulled < 10) {
    Serial.println("VERDICT: pin 2 is tied to GROUND. The pin-2 wire is on the module's - leg (or a GND hole). Swap it with the - wire.");
  } else if (plain > 95) {
    Serial.println("VERDICT: pin 2 sees the module's pull-up, so S and + look connected.");
  } else if (plain < 5) {
    Serial.println("VERDICT: pin 2 reaches the module but it has NO POWER. Check the + (middle) leg wire goes to 5V and the - leg wire to GND.");
  } else {
    Serial.println("VERDICT: pin 2 is connected to NOTHING (floating). The wire isn't in pin 2, or isn't in the same breadboard row as the S leg.");
  }

  dht.begin();
  delay(1200);
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (isnan(h) || isnan(t)) {
    Serial.println("DHT11 read: FAILED (nan)");
    if (plain > 95) Serial.println("  -> Pin 2 looks right, so the S wire may be on the + leg instead. Re-read the leg labels; if wiring matches them, the sensor itself may be faulty.");
  } else {
    Serial.print("DHT11 read: OK  humidity "); Serial.print(h); Serial.print("%  temp "); Serial.print(t); Serial.println(" C");
    Serial.println("  -> Wiring is good. Re-upload air_station.ino and reconnect the website.");
  }
  Serial.println("-----");
  delay(3000);
}
