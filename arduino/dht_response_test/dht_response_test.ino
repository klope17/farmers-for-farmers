/*
  DHT11 response test: does the sensor answer at all?
  Sends the DHT11 start signal on pin 2 and listens for its reply
  (the sensor pulls the line LOW ~80 us, then HIGH ~80 us, then sends 40 bits).
  Open Serial Monitor at 9600 baud.
*/
const int PIN = 2;

// Wait while the pin stays at `level`; return microseconds waited, or -1 on timeout.
long waitWhile(int level, unsigned long timeoutUs) {
  unsigned long start = micros();
  while (digitalRead(PIN) == level) {
    if (micros() - start > timeoutUs) return -1;
  }
  return micros() - start;
}

void setup() {
  Serial.begin(9600);
  delay(2000);
}

void loop() {
  // Start signal: hold LOW 20 ms, then release and let the pull-up raise it.
  pinMode(PIN, OUTPUT);
  digitalWrite(PIN, LOW);
  delay(20);
  pinMode(PIN, INPUT_PULLUP);

  long a = waitWhile(HIGH, 300);   // sensor should pull LOW within ~40 us
  long b = a < 0 ? -1 : waitWhile(LOW, 300);   // ~80 us LOW
  long c = b < 0 ? -1 : waitWhile(HIGH, 300);  // ~80 us HIGH, then data starts

  if (a < 0) {
    Serial.println("NO RESPONSE: line never went LOW after the start signal.");
    Serial.println("  -> Pin 2 is on the + leg, the sensor has no ground, or the sensor is dead.");
  } else if (b < 0 || c < 0) {
    Serial.println("PARTIAL RESPONSE: sensor started answering, then stalled. Loose leg or bad sensor.");
  } else {
    Serial.print("SENSOR ANSWERED (LOW "); Serial.print(b); Serial.print(" us, HIGH "); Serial.print(c);
    Serial.println(" us). Wiring is right; the problem is the library/sketch, tell Claude.");
  }
  delay(2500);
}
