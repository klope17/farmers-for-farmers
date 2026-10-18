/*
  Farmers for Farmers: field air station (ELEGOO UNO R3 + DHT11 + photocell)
  Humidity = fungal disease risk: warm, humid air lets blight and mildew spread.
  Light = day/night: the tractor attachment switches itself on after dark, when
  dew forms and disease risk is highest, and off again at daylight.
  Stand-in for a low-cost kit mounted on tractors farmers already own.

  Wiring
    DHT11:       S -> pin 2, middle -> 5V, - -> GND
    Risk LED:    long leg -> pin 13, short leg -> 220 ohm -> GND
    Photocell:   one leg (row 45) -> 3.3V, other leg (row 46) -> A1,
                 and a 10k resistor from row 46 -> GND
    Night LED:   (optional, "attachment on") long leg -> pin 12, short leg -> 220 ohm -> GND

  Brighter light = higher reading. Cover the photocell with your hand to fake night.
  Needs "DHT sensor library" by Adafruit. The website reads this over Web Serial
  at 9600 baud; close the Serial Monitor before clicking Connect on the site.
*/
#include <DHT.h>
DHT dht(2, DHT11);            // DHT11 talks on pin 2

const float HUMID_ALERT = 75;   // % humidity that means disease risk (match the website's slider)
const int NIGHT_BELOW = 150;    // light reading that counts as dark (cover the cell and check the number)
const int DAY_ABOVE = 220;      // must get this bright to switch back to day, so it doesn't flicker at dusk
const int RISK_LED = 13;
const int ATTACH_PIN = 12;      // attachment on/off (LED stands in for the tractor attachment)

bool night = false;

void setup() {
  Serial.begin(9600);
  dht.begin();
  pinMode(RISK_LED, OUTPUT);
  pinMode(ATTACH_PIN, OUTPUT);
}

void loop() {
  int light = analogRead(A1);
  float temp = dht.readTemperature();
  float hum = dht.readHumidity();

  if (!night && light < NIGHT_BELOW) night = true;
  else if (night && light > DAY_ABOVE) night = false;

  digitalWrite(RISK_LED, hum > HUMID_ALERT ? HIGH : LOW);  // red light = disease risk
  digitalWrite(ATTACH_PIN, night ? HIGH : LOW);            // attachment runs at night

  Serial.print("{\"light\":"); Serial.print(light);
  Serial.print(",\"night\":"); Serial.print(night ? 1 : 0);
  Serial.print(",\"temp\":"); Serial.print(temp);
  Serial.print(",\"humidity\":"); Serial.print(hum);
  Serial.println("}");

  delay(2000);
}
