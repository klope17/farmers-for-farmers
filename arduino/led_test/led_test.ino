/*
  LED diagnosis. Open Serial Monitor at 9600 baud and watch the LED.

  Part 1: blinks pin 13 three times (1 s on, 1 s off).
    - LED blinks        -> wiring is good.
    - LED never lights  -> see Part 2 and the checklist printed below.
  Part 2: lights each other digital pin for 2 s and names it. If the LED lights
    during, say, "pin 12", the LED's long leg is in pin 12 instead of 13.
    (Skips 0/1, which carry USB serial, and 2, which is the DHT11 data line.)
*/

void setup() {
  Serial.begin(9600);
  delay(1500);
  for (int p = 3; p <= 13; p++) { pinMode(p, OUTPUT); digitalWrite(p, LOW); }
}

void loop() {
  Serial.println("=== Part 1: blinking pin 13 (your LED should blink 3 times) ===");
  for (int i = 1; i <= 3; i++) {
    Serial.print("  pin 13 ON  ("); Serial.print(i); Serial.println("/3)");
    digitalWrite(13, HIGH); delay(1000);
    Serial.println("  pin 13 OFF");
    digitalWrite(13, LOW); delay(1000);
  }

  Serial.println("=== Part 2: lighting each other pin for 2 s ===");
  for (int p = 3; p <= 12; p++) {
    Serial.print("  pin "); Serial.print(p); Serial.println(" ON. Is your LED lit now?");
    digitalWrite(p, HIGH); delay(2000);
    digitalWrite(p, LOW); delay(300);
  }

  Serial.println("=== If the LED never lit ===");
  Serial.println("  1. Flip the LED: long leg toward the pin, short leg toward the resistor.");
  Serial.println("  2. Resistor should be 220 ohm (red-red-brown) from the short leg's row to GND.");
  Serial.println("  3. Each wire must be in the SAME breadboard row as the leg it connects to.");
  Serial.println("  4. GND wire must go to a GND hole on the Arduino (or a powered - rail).");
  Serial.println("  5. Still dark? Try another LED from the kit; it may be dead.");
  Serial.println("Repeating in 5 s...");
  Serial.println();
  delay(5000);
}
