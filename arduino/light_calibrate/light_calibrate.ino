/*
  Photocell calibration for air_station.ino
  Open Serial Monitor at 9600 baud and follow the prompts:
    1. leave the photocell uncovered (normal light)
    2. cover it with your hand (fake night)
  It prints the NIGHT_BELOW / DAY_ABOVE lines to paste into air_station.ino.
  Wiring: photocell row 45 -> 3.3V (or 5V), row 46 -> A1, 10k from row 46 -> GND.
*/
const int PIN = A1;

// Average the photocell for `ms` milliseconds, printing a live bar while it samples.
int sample(unsigned long ms) {
  long sum = 0; int n = 0;
  unsigned long start = millis(), lastPrint = 0;
  while (millis() - start < ms) {
    int v = analogRead(PIN);
    sum += v; n++;
    if (millis() - lastPrint > 500) {
      lastPrint = millis();
      Serial.print("    light = "); Serial.print(v); Serial.print("  ");
      for (int i = 0; i < v / 25; i++) Serial.print('#');
      Serial.println();
    }
    delay(20);
  }
  return sum / n;
}

void countdown(const char *what) {
  Serial.println(what);
  for (int s = 3; s > 0; s--) { Serial.print("  starting in "); Serial.println(s); delay(1000); }
}

void setup() {
  Serial.begin(9600);
  delay(1500);
}

void loop() {
  Serial.println();
  Serial.println("===== Photocell calibration =====");
  countdown("STEP 1: leave the photocell UNCOVERED (normal room / daylight).");
  int bright = sample(5000);
  Serial.print("  -> uncovered average: "); Serial.println(bright);

  countdown("STEP 2: COVER the photocell with your hand (fake night). Hold it there.");
  int dark = sample(5000);
  Serial.print("  -> covered average: "); Serial.println(dark);

  int gap = bright - dark;
  Serial.println();
  if (gap < 60) {
    Serial.println("PROBLEM: covered and uncovered are almost the same.");
    if (bright < 30) Serial.println("  Reading stays near 0: check the row 45 wire goes to 3.3V/5V and row 46 to A1.");
    else if (dark > 990) Serial.println("  Reading stays near 1023: the 10k resistor from row 46 to GND is missing.");
    else Serial.println("  Check the photocell legs are in rows 45 and 46, and A1's wire is in row 46.");
  } else {
    int nightBelow = dark + gap * 35 / 100;  // a bit above "covered"
    int dayAbove = dark + gap * 55 / 100;    // higher, so it doesn't flicker at dusk
    Serial.println("SUCCESS. Paste these two lines into air_station.ino (replace the old ones):");
    Serial.println();
    Serial.print("const int NIGHT_BELOW = "); Serial.print(nightBelow); Serial.println(";");
    Serial.print("const int DAY_ABOVE = "); Serial.print(dayAbove); Serial.println(";");
    Serial.println();
    Serial.println("Then upload air_station.ino and reconnect the website.");
  }
  Serial.println("Repeating in 10 s (press the Arduino's RESET button to restart sooner).");
  delay(10000);
}
