// Field sensor over Web Serial (Arduino Uno over USB), with a demo fallback.
// The sketch prints one JSON object per line. Two kinds of station are understood:
//   air (DHT11):  {"light":512,"night":0,"temp":22.00,"humidity":45.00}
//                 humidity = fungal disease risk; night = photocell says it's dark (attachment on)
//   soil probe:   {"raw":412,"moisture":38.5,"temp":21.4,"hum":55.0}
// A DHT11 wiring fault prints nan, which we surface instead of dropping.

const DRY_RAW = 520, WET_RAW = 260; // capacitive v1.2 sensor calibration (air vs. water)

export class SoilSensor extends EventTarget {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.simTimer = null;
    this.mode = "off"; // off | serial | demo
    this.last = null;
    this.history = [];
  }

  get supported() { return "serial" in navigator; }

  async connect() {
    if (!this.supported) throw new Error("Web Serial needs Chrome or Edge on desktop.");
    await this.stop(); // fully release any earlier connection before reopening
    const port = await navigator.serial.requestPort();
    if (port.readable) { try { await port.close(); } catch {} } // still open from an earlier connect
    await port.open({ baudRate: 9600 });
    this.port = port;
    this.mode = "serial";
    this.#status("Connected over USB");
    this.#readLoop();
  }

  async #readLoop() {
    const decoder = new TextDecoderStream();
    const closed = this.port.readable.pipeTo(decoder.writable).catch(() => {});
    this.reader = decoder.readable.getReader();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buf += value;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.dispatchEvent(new CustomEvent("line", { detail: line }));
          const reading = parseLine(line);
          if (reading) this.#emit(reading);
        }
      }
    } catch (e) {
      this.#status(`Disconnected: ${e.message}`);
    } finally {
      this.reader?.releaseLock();
      await closed;
    }
  }

  // Simulates someone breathing on the DHT11: humidity climbs past the risk line, then settles.
  startDemo() {
    this.stop();
    this.mode = "demo";
    this.#status("Demo sensor (simulated DHT11): breath at ~5 s, nightfall at ~40 s");
    let t = 0;
    this.simTimer = setInterval(() => {
      t += 1;
      const breath = t > 5 && t < 20 ? Math.min(1, (t - 5) / 6) : t >= 20 ? Math.max(0, 1 - (t - 20) / 15) : 0;
      const hum = 47 + breath * 40 + (Math.random() - 0.5) * 1.5;
      const dark = t > 38 && t < 52; // after the breath, a hand over the photocell fakes nightfall
      this.#emit({
        temp: 22.5 + breath * 3 + Math.random() * 0.3, hum,
        light: dark ? 80 + Math.round(Math.random() * 20) : 520 + Math.round(Math.random() * 20), night: dark,
      });
    }, 1000);
  }

  async stop() {
    // Reset state synchronously so a connect/startDemo right after us isn't clobbered.
    const { reader, port, mode } = this;
    clearInterval(this.simTimer);
    this.simTimer = null;
    this.port = null; this.reader = null; this.mode = "off";
    if (mode !== "off") this.#status("Not connected");
    try { await reader?.cancel(); } catch {}
    try { await port?.close(); } catch {}
  }

  #emit(r) {
    if (r.moisture == null && r.raw != null) {
      r.moisture = Math.max(0, Math.min(100, ((DRY_RAW - r.raw) / (DRY_RAW - WET_RAW)) * 100));
    }
    r.kind = r.moisture != null ? "soil" : r.hum != null ? "air" : "none";
    if (r.dhtError) {
      this.#status("Connected, but the DHT11 reads nan. Check: S leg → pin 2, middle leg → 5V (+), − leg → GND.");
      return;
    }
    if (r.kind === "none") {
      this.#status("Receiving data, but no humidity or moisture value in it. Check the sketch's output below.");
      return;
    }
    r.at = Date.now();
    this.last = r;
    this.history.push(r);
    if (this.history.length > 120) this.history.shift();
    this.dispatchEvent(new CustomEvent("reading", { detail: r }));
  }

  #status(text) { this.dispatchEvent(new CustomEvent("status", { detail: text })); }
}

export function parseLine(line) {
  if (!line) return null;
  if (line.startsWith("{")) {
    try {
      const dhtError = /"(temp|hum|humidity)"\s*:\s*nan/i.test(line);
      const j = JSON.parse(line.replace(/\bnan\b/gi, "null")); // Arduino prints nan for a failed DHT read
      return {
        raw: num(j.raw), moisture: num(j.moisture ?? j.soil ?? j.pct), temp: num(j.temp ?? j.t),
        hum: num(j.hum ?? j.humidity ?? j.h), light: num(j.light), dhtError,
        night: j.night == null ? null : !!+j.night, // photocell day/night switch from the sketch
      };
    } catch { return null; }
  }
  const kv = Object.fromEntries([...line.matchAll(/([a-z]+)\s*[:=]\s*(-?\d+(?:\.\d+)?)/gi)].map((m) => [m[1].toLowerCase(), +m[2]]));
  if (Object.keys(kv).length) return { raw: num(kv.raw ?? kv.adc), moisture: num(kv.moisture ?? kv.soil), temp: num(kv.temp ?? kv.t), hum: num(kv.hum ?? kv.humidity ?? kv.h) };
  if (/^\d+$/.test(line)) return { raw: +line };
  return null;
}
const num = (v) => (v == null || v === "" || Number.isNaN(+v) ? null : +v);
