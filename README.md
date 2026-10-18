# Farmers for Farmers 🌱

**HackHarvard 2026 · Sustainability ("Save the Earth") + Hardware for Good · Photon messaging challenge**

A community crop-health map. Every field gets a health check from multispectral imagery. When one farmer finds pests, disease, drought or a nutrient problem, every neighbor within a few miles gets a text before it spreads.

- **Map (Google-Maps-style):** real Sentinel-2 imagery of 32 quarter-section fields in Story County, Iowa, with per-field **NDVI** (crop vigor), **NDRE** (chlorophyll, a nitrogen proxy) and **NDMI** (canopy moisture) over the 2026 season. Each field is compared with nearby fields of the same crop on the same day, which cancels out weather and season. The time slider covers May 15 (planting) to Oct 2 (harvest).
- **Texting agent (Photon 2.0):** farmers opt in by texting `JOIN F05`. Then:
  - `STATUS` returns their field health.
  - `REPORT <what you see>` warns every opted-in farmer within 2 miles by iMessage, and the report appears live on the map.
  - Free-form questions are answered by Claude (optional), grounded in that farmer's own field data.
- **Nationwide:** search any US town or county and zoom in. Every field outline and its 2015–2022 crop history come from USDA's Crop Sequence Boundaries. Click a field and the app measures its whole 2026 season live from Sentinel-2, plus up to 8 nearby fields with the same crop for comparison. The Story County fields remain the pilot, with farmers and alerts.
- **Drone vs. satellite** (`/compare.html`): real MicaSense RedEdge drone NDVI at 7 cm/pixel, next to the same field averaged to 3 m (PlanetScope) and 10 m (Sentinel-2).
- **Hardware:** an Arduino Uno with a soil-moisture probe streams readings to the map over **Web Serial**. When the soil goes dry, the app offers to warn neighbors. This prototype stands in for a sensor pack that bolts onto tractors farmers already own.

## Run it (one command)

```bash
npm install
npm run agent          # http://localhost:8787  (map at /, phone simulator at /phone.html)
```

With no Photon keys, the agent runs in **simulator mode**: open `/phone.html` and text it like a phone. The map's "Texting agent" pill turns green when it's connected.

### Turn on real iMessage (Photon)

The agent works with either kind of Photon project and picks the right SDK from the ID. A Photon 2.0 beta ID starts with `pho_prj_`. A stable Spectrum project uses a Project ID plus Secret Key. On the stable free plan, the agent can only text numbers that have texted it first or are listed under **Users**.
Test with `node --env-file=agent/.env agent/send-test.js +1XXXXXXXXXX`.

#### Photon 2.0 beta setup

1. Sign up at https://app.beta.photon.codes, create a project, and assign a **shared iMessage line**.
2. **API keys → New API key** with read and write permissions. Copy the `pho_sk_…` key (it's shown once).
3. `cp agent/.env.example agent/.env` and fill in `PHOTON_PROJECT_ID` and `PHOTON_API_KEY`.
4. `npm run agent`, then text **JOIN F05** from your phone to the assigned number.

> On a shared line Photon only lets the agent reply to people who texted it first, so the opt-in ("JOIN") is required. Alerts go back into that same conversation. That's also the right consent model for real farmers.

Optional: set `ANTHROPIC_API_KEY` in `agent/.env` for free-form answers (Claude Opus 5.5). The commands work without it.

### Hardware (Arduino Uno)

1. Wire a capacitive soil-moisture sensor v1.2: VCC→5V, GND→GND, AOUT→A0. A DHT11 on D2 is optional.
2. Flash `arduino/soil_sensor/soil_sensor.ino`. Calibrate `DRY_RAW` (probe in air) and `WET_RAW` (probe in water).
3. In Chrome or Edge, click the **sensor** button (bottom right) → **Connect** → choose the Arduino's port.
4. No board handy? Use **Use demo sensor**. It dries out over about 25 seconds.

### Deploy the map publicly (GitHub Pages)

The `web/` folder is static. Push this repo to GitHub, then set **Settings → Pages → Source: GitHub Actions**. The included workflow (`.github/workflows/pages.yml`) publishes `web/` on every push. It can also go to Netlify Drop: drag the `web` folder onto https://app.netlify.com/drop. On the public site, alerts stay in the browser unless you point it at a running agent with `?agent=https://<your-tunnel>`.

### Reset demo state

Stop the agent, delete `agent/state.json`, and in the browser clear site data (or run `localStorage.clear()`).

## How it works

| Piece | Where |
|---|---|
| Field boundaries + real index history (Planetary Computer, no key) | `tools/build_data.py` → `web/data/farms.geojson` |
| Neighbor-relative health analysis (shared by map and agent) | `web/js/analysis.js` |
| Map UI (MapLibre GL, Material 3) | `web/index.html`, `web/js/app.js`, `web/css/app.css` |
| Live Sentinel-2 tiles and "Re-measure" | `web/js/config.js` (Planetary Computer tiler + statistics API) |
| Nationwide fields, mosaics, place search | `web/js/national.js` (USDA CSB ArcGIS service, Planetary Computer mosaics, Nominatim) |
| Drone vs. satellite comparison | `tools/drone_compare.py` → `web/img/`, `web/compare.html` |
| Web Serial soil sensor | `web/js/sensor.js`, `arduino/soil_sensor/` |
| Texting agent + alert broadcast | `agent/server.js`, `agent/photon.js`, `agent/brain.js` |

Data: Sentinel-2 L2A (ESA Copernicus) via Microsoft Planetary Computer. Basemap © Esri. **Farmer names, crops and phone numbers are fictional demo data.**
