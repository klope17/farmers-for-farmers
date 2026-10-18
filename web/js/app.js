import {
  SCENES, DEFAULT_SCENE, INDICES, ALERT_TYPES, HOME, AOI_BOUNDS,
  indexTileUrl, trueColorTileUrl, fieldImageUrl, measureField, colorFor,
} from "./config.js";
import { assess, centroid, bbox, miles, fieldsWithin, valueAt, peers, activeAlerts } from "./analysis.js";
import { AlertStore } from "./alerts.js";
import { SoilSensor } from "./sensor.js";
import * as US from "./national.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  scene: DEFAULT_SCENE,
  index: "ndvi",
  base: "satellite",
  selected: null,       // feature
  tab: "overview",
  chartIndex: "ndvi",
  heroMode: "true",
  persona: ls.get("f4f.persona", "U02"),
  sensorField: null,
  seen: new Set(ls.get("f4f.seen", [])),
};

const data = await fetch("data/farms.geojson").then((r) => r.json());
const fields = data.features;
const byId = new Map(fields.map((f) => [f.properties.id, f]));
const farmers = [...new Map(fields.map((f) => [f.properties.farmerId, { id: f.properties.farmerId, name: f.properties.farmer, phone: f.properties.phone }])).values()]
  .sort((a, b) => a.id.localeCompare(b.id));
const store = new AlertStore(fields);
const sensor = new SoilSensor();

/* ------------------------------------------------------------------ map */
const map = new maplibregl.Map({
  container: "map",
  center: HOME.center, zoom: HOME.zoom, maxZoom: 18.5, minZoom: 4,
  attributionControl: { compact: true },
  dragRotate: false, pitchWithRotate: false,
  style: {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      esri: { type: "raster", tileSize: 256, maxzoom: 19, tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], attribution: "Imagery © Esri, Maxar, Earthstar Geographics" },
      esriRoads: { type: "raster", tileSize: 256, maxzoom: 19, tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"] },
      esriLabels: { type: "raster", tileSize: 256, maxzoom: 19, tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"] },
      carto: { type: "raster", tileSize: 256, maxzoom: 19, tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"], attribution: "Map © Esri, HERE, Garmin, OpenStreetMap contributors" },
    },
    layers: [
      { id: "carto", type: "raster", source: "carto", layout: { visibility: "none" } },
      { id: "esri", type: "raster", source: "esri" },
    ],
  },
});
map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-right");

map.on("load", () => {
  addSentinelLayers();
  map.addLayer({ id: "esriRoads", type: "raster", source: "esriRoads", paint: { "raster-opacity": 0.75 } });
  map.addLayer({ id: "esriLabels", type: "raster", source: "esriLabels" });

  map.addSource("fields", { type: "geojson", data });
  map.addLayer({
    id: "fields-fill", type: "fill", source: "fields",
    paint: {
      "fill-color": ["coalesce", ["feature-state", "color"], "#888"],
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.85, 12.5, ["case", ["boolean", ["feature-state", "hover"], false], 0.25, 0.04]],
    },
  });
  map.addLayer({
    id: "fields-line", type: "line", source: "fields",
    paint: {
      "line-color": ["match", ["feature-state", "level"], "alert", "#ff5449", "watch", "#fbbc04", "#ffffff"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 11, ["match", ["feature-state", "level"], "alert", 2, "watch", 2, 0.6], 15, ["match", ["feature-state", "level"], "alert", 4, "watch", 3.5, 1.5]],
      "line-opacity": ["match", ["feature-state", "level"], "alert", 1, "watch", 1, 0.7],
    },
  });
  map.addLayer({
    id: "fields-mine", type: "line", source: "fields",
    filter: ["==", ["get", "farmerId"], state.persona],
    paint: { "line-color": "#8ab4f8", "line-width": 2, "line-dasharray": [2, 1.5], "line-offset": 3 },
  });
  map.addLayer({
    id: "fields-selected", type: "line", source: "fields", filter: ["==", ["get", "id"], ""],
    paint: { "line-color": "#1a73e8", "line-width": 5 },
  });

  map.addSource("alerts", { type: "geojson", data: emptyFC() });
  map.addLayer({ id: "alerts-fill", type: "fill", source: "alerts", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.1 } });
  map.addLayer({ id: "alerts-line", type: "line", source: "alerts", paint: { "line-color": ["get", "color"], "line-width": 2, "line-dasharray": [3, 2] } });

  map.addLayer({
    id: "fields-label", type: "symbol", source: "fields", minzoom: 13.3,
    layout: { "text-field": ["get", "id"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-allow-overlap": false },
    paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,.75)", "text-halo-width": 1.5 },
  });

  addNationalLayers();
  wireMapEvents();
  updateSentinel();
  refreshAll();
  const hash = decodeURIComponent(location.hash.slice(1));
  if (byId.has(hash)) select(byId.get(hash), { fly: true });
  else if (hash.startsWith("@")) {
    const [lat, lng, z] = hash.slice(1).split(",").map(Number);
    if (!Number.isNaN(lat)) map.jumpTo({ center: [lng, lat], zoom: z || 15 });
  }
});

// 10 m index colors fade with zoom so the sharp aerial photo underneath shows through.
const INDEX_OPACITY = ["interpolate", ["linear"], ["zoom"], 12, 0.85, 15, 0.65, 17, 0.45];

function addSentinelLayers() {
  map.addSource("s2tc", { type: "raster", tileSize: 256, tiles: [trueColorTileUrl(state.scene)], bounds: AOI_BOUNDS, minzoom: 9, maxzoom: 14, attribution: "Sentinel-2 L2A (ESA Copernicus) via Microsoft Planetary Computer" });
  map.addLayer({ id: "s2tc", type: "raster", source: "s2tc", layout: { visibility: "none" }, paint: { "raster-opacity": 1, "raster-fade-duration": 150 } });
  map.addSource("s2ix", { type: "raster", tileSize: 256, tiles: [indexTileUrl(state.scene, state.index)], bounds: AOI_BOUNDS, minzoom: 9, maxzoom: 14 });
  map.addLayer({ id: "s2ix", type: "raster", source: "s2ix", paint: { "raster-opacity": INDEX_OPACITY, "raster-fade-duration": 150 } });
  tileUrls.s2tc = trueColorTileUrl(state.scene);
  tileUrls.s2ix = indexTileUrl(state.scene, state.index);
}

// Point a raster source at new tiles, creating it on first use (MapLibre won't take an empty tile list)
// and skipping no-op updates (which abort in-flight tiles and log errors).
const tileUrls = {};
function setRaster(id, url, { before, opacity = 1 } = {}) {
  if (tileUrls[id] === url) return;
  tileUrls[id] = url;
  if (map.getSource(id)) return map.getSource(id).setTiles([url]);
  map.addSource(id, { type: "raster", tileSize: 256, tiles: [url], minzoom: 10, maxzoom: 14, attribution: "Sentinel-2 L2A (ESA Copernicus) via Microsoft Planetary Computer" });
  map.addLayer({ id, type: "raster", source: id, minzoom: 10, paint: { "raster-opacity": opacity, "raster-fade-duration": 150 } }, before);
}

function updateSentinel() {
  // Nationwide mosaics underneath; the Iowa pilot's exact scenes draw on top.
  const scene = state.scene, index = state.index;
  // "Aerial photo" mode shows only the sharp Esri basemap: no 10 m Sentinel-2 layer on top.
  if (index === "none" && map.getLayer("usix")) map.setLayoutProperty("usix", "visibility", "none");
  if (index !== "none") US.mosaicId(scene).then((sid) => {
    if (scene !== state.scene || index !== state.index) return;
    try {
      setRaster("usix", US.mosaicTileUrl(sid, index), { before: "s2tc", opacity: INDEX_OPACITY });
      map.setLayoutProperty("usix", "visibility", "visible");
    } catch (e) {
      // Swapping tiles cancels in-flight requests (AbortError); that's expected, not a failure.
      if (e?.name !== "AbortError") console.warn("imagery layer:", e);
    }
  }, (e) => {
    console.warn("mosaic register failed:", e);
    snack("Couldn't load nationwide imagery from Planetary Computer. Try the date again.", "cloud_off");
  });
  const tc = trueColorTileUrl(state.scene);
  const swap = (id, url) => { try { map.getSource(id).setTiles([url]); } catch (e) { if (e?.name !== "AbortError") console.warn(e); } };
  if (tileUrls.s2tc !== tc) { tileUrls.s2tc = tc; swap("s2tc", tc); }
  const ix = state.index !== "none" && indexTileUrl(state.scene, state.index);
  if (ix && tileUrls.s2ix !== ix) { tileUrls.s2ix = ix; swap("s2ix", ix); }
  map.setLayoutProperty("s2ix", "visibility", state.index === "none" ? "none" : "visible");
  map.setLayoutProperty("s2tc", "visibility", "none");
}

let hoverId = null;
const hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, maxWidth: "260px" });
function wireMapEvents() {
  map.on("mousemove", "fields-fill", (e) => {
    const f = e.features[0];
    map.getCanvas().style.cursor = "pointer";
    if (hoverId !== f.id) {
      if (hoverId != null) map.setFeatureState({ source: "fields", id: hoverId }, { hover: false });
      hoverId = f.id;
      map.setFeatureState({ source: "fields", id: hoverId }, { hover: true });
    }
    const full = byId.get(f.properties.id);
    const k = state.index === "none" ? "ndvi" : state.index;
    const v = valueAt(full, state.scene, k);
    const a = assess(fields, full, state.scene, ctx(full));
    hoverPopup.setLngLat(e.lngLat).setHTML(
      `<b>${esc(full.properties.id)} · ${esc(full.properties.crop)}</b><br>${esc(full.properties.farmer)}<br>` +
      `<span style="color:${statusColor(a.level)}">●</span> ${esc(a.headline)} · ${INDICES[k].short} ${v != null ? v.toFixed(2) : "–"}`,
    ).addTo(map);
  });
  map.on("mouseleave", "fields-fill", () => {
    map.getCanvas().style.cursor = "";
    if (hoverId != null) map.setFeatureState({ source: "fields", id: hoverId }, { hover: false });
    hoverId = null;
    hoverPopup.remove();
  });
  map.on("click", "fields-fill", (e) => select(byId.get(e.features[0].properties.id)));
  map.on("click", (e) => {
    if (!map.queryRenderedFeatures(e.point, { layers: ["fields-fill", "us-fill"] }).length && state.selected) closePanel();
  });
}

/* ------------------------------------------------------------------ rendering */
function ctx(f) {
  return { alerts: store.alerts, sensor: state.sensorField === f.properties.id && sensor.last ? { ...sensor.last, riskAt: state.riskAt } : null };
}

function refreshAll() {
  if (!map.getSource("fields")) return;
  const k = state.index === "none" ? "ndvi" : state.index;
  for (const f of fields) {
    const v = valueAt(f, state.scene, k);
    const a = assess(fields, f, state.scene, ctx(f));
    map.setFeatureState({ source: "fields", id: f.id }, { color: v == null ? "#777" : colorFor(k, v), level: a.level });
  }
  map.setFilter("fields-mine", ["==", ["get", "farmerId"], state.persona]);
  drawAlerts();
  renderTimeline();
  renderBadges();
  if (state.selected) renderPanel();
  if (!$("#drawer").hidden) renderDrawer();
}

const alertMarkers = new Map();
let alertFC = emptyFC();
function emptyFC() { return { type: "FeatureCollection", features: [] }; }
function drawAlerts() {
  const act = activeAlerts(store.alerts);
  const color = { pest: "#d93025", disease: "#a142f4", drought: "#e37400", nutrient: "#1a73e8", flood: "#12b5cb" };
  alertFC = {
    type: "FeatureCollection",
    features: act.map((a) => ({ ...turf.circle(a.center, a.radiusMi, { units: "miles", steps: 96 }), properties: { id: a.id, color: color[a.type] || "#d93025" } })),
  };
  map.getSource("alerts").setData(alertFC);
  for (const [id, m] of alertMarkers) if (!act.some((a) => a.id === id)) { m.remove(); alertMarkers.delete(id); }
  for (const a of act) {
    if (alertMarkers.has(a.id)) continue;
    const el = document.createElement("div");
    el.className = `pulse ${a.type}`;
    el.title = `${ALERT_TYPES[a.type]?.label}: ${a.note || ""}`;
    el.addEventListener("click", (ev) => { ev.stopPropagation(); select(byId.get(a.fieldId), { fly: true }); });
    alertMarkers.set(a.id, new maplibregl.Marker({ element: el }).setLngLat(a.center).addTo(map));
  }
}

function statusColor(level) {
  return { alert: "#d93025", watch: "#f9ab00", ok: "#1e8e3e", idle: "#80868b" }[level];
}
const statusIcon = { ok: "check_circle", watch: "visibility", alert: "warning", idle: "schedule" };

function renderTimeline() {
  const k = state.index === "none" ? null : INDICES[state.index];
  $("#legend").innerHTML = k
    ? `<b>${k.name} · ${k.short}</b><span>${k.range[0]}</span><span class="bar" style="background:linear-gradient(90deg,${k.stops.join(",")})"></span><span>${k.range[1]}</span>`
    : `<b>Aerial photo</b><span>Esri imagery, about 0.5 m per pixel. Sharp, but not from a 2026 date and no infrared, so no crop health.</span>`;
  $("#dates").innerHTML = SCENES.map((s, i) =>
    `<button class="date" role="tab" data-i="${i}" aria-selected="${i === state.scene}" title="${s.stage}">${s.label}<br><small>${s.stage}</small></button>`).join("");
}
$("#dates").addEventListener("click", (e) => {
  const b = e.target.closest(".date");
  if (!b) return;
  state.scene = +b.dataset.i;
  updateSentinel();
  refreshAll();
});

$("#layerChips").addEventListener("click", (e) => {
  const b = e.target.closest(".chip");
  if (!b) return;
  if (b.id === "alertsChip") return toggleDrawer();
  state.index = b.dataset.index;
  if (state.index !== "none") state.chartIndex = state.index;
  for (const c of document.querySelectorAll("#layerChips .chip[data-index]")) c.setAttribute("aria-pressed", c === b);
  updateSentinel();
  refreshAll();
});

$("#baseToggle").addEventListener("click", () => {
  state.base = state.base === "satellite" ? "map" : "satellite";
  map.setLayoutProperty("esri", "visibility", state.base === "satellite" ? "visible" : "none");
  map.setLayoutProperty("esriRoads", "visibility", state.base === "satellite" ? "visible" : "none");
  map.setLayoutProperty("esriLabels", "visibility", state.base === "satellite" ? "visible" : "none");
  map.setLayoutProperty("carto", "visibility", state.base === "map" ? "visible" : "none");
  renderBaseThumb();
});
function renderBaseThumb() {
  const other = state.base === "satellite" ? "map" : "satellite";
  $("#baseLabel").textContent = other === "map" ? "Map" : "Satellite";
  $("#baseThumb").style.backgroundImage = other === "map"
    ? "url(https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/13/3037/1970)"
    : "url(https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/14/6075/3941)";
}
renderBaseThumb();

/* ------------------------------------------------------------------ panel */
function select(f, { fly = false } = {}) {
  if (!f) return;
  state.selected = f;
  const nat = isNational(f);
  const c = centroid(f);
  history.replaceState(null, "", nat ? `#@${c[1].toFixed(5)},${c[0].toFixed(5)},15` : `#${f.properties.id}`);
  map.setFilter("fields-selected", ["==", ["get", "id"], nat ? "" : f.properties.id]);
  map.setFilter("us-selected", ["==", ["get", "csbid"], nat ? f.properties.csbid : ""]);
  if (nat) measureNational(f);
  $("#panel").hidden = false;
  document.body.classList.add("panel-open");
  renderPanel();
  $("#panelBody").scrollTop = 0;
  const padding = window.innerWidth > 720 ? { left: 408, top: 40, right: 40, bottom: 120 } : { bottom: window.innerHeight * 0.62, top: 80, left: 20, right: 20 };
  const b = bbox(f);
  if (fly) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding, maxZoom: 15, duration: 900 });
  else map.easeTo({ center: centroid(f), padding, duration: 500 });
}

function closePanel() {
  state.selected = null;
  history.replaceState(null, "", location.pathname + location.search);
  map.setFilter("fields-selected", ["==", ["get", "id"], ""]);
  map.setFilter("us-selected", ["==", ["get", "csbid"], ""]);
  $("#panel").hidden = true;
  document.body.classList.remove("panel-open");
  map.easeTo({ padding: { left: 0, top: 0, right: 0, bottom: 0 }, duration: 300 });
}
$("#panelClose").addEventListener("click", closePanel);

function renderPanel() {
  if (isNational(state.selected)) return renderNationalPanel();
  const f = state.selected;
  const p = f.properties;
  const s = SCENES[state.scene];
  const a = assess(fields, f, state.scene, ctx(f));
  const mine = p.farmerId === state.persona;
  const b = bbox(f);
  const pad = 0.0025;
  const heroBox = [b[0] - pad, b[1] - pad * 0.75, b[2] + pad, b[3] + pad * 0.75];
  const heroIdx = state.heroMode === "true" ? null : (state.index === "none" ? "ndvi" : state.index);

  const metrics = Object.values(INDICES).map((ix) => {
    const v = valueAt(f, state.scene, ix.key);
    const d = a.deltas[ix.key];
    const dTxt = d == null ? "no comparison" : Math.abs(d) < 0.03 ? "≈ neighbors"
      : `${d > 0 ? "▲" : "▼"} ${ix.key === "ndmi" ? Math.abs(d).toFixed(2) : `${Math.abs(Math.round(d * 100))}%`} vs nearby`;
    return `<div class="metric" title="${esc(ix.explain)}"><span>${ix.name} · ${ix.short}</span><b>${v == null ? "–" : v.toFixed(2)}</b><em class="${d == null || Math.abs(d) < 0.03 ? "" : d > 0 ? "up" : "down"}">${dTxt}</em></div>`;
  }).join("");

  const near = fieldsWithin(fields, centroid(f), 2).filter(({ f: g }) => g !== f);
  const neighborList = near.map(({ f: g, d }) => {
    const k = state.index === "none" ? "ndvi" : state.index;
    const v = valueAt(g, state.scene, k);
    const ga = assess(fields, g, state.scene, ctx(g));
    return `<li data-id="${g.properties.id}"><span class="swatch" style="background:${v == null ? "#777" : colorFor(k, v)}"></span>
      <div><b>${g.properties.id} · ${esc(g.properties.crop)}</b><small>${esc(g.properties.farmer)} · <span style="color:${statusColor(ga.level)}">${esc(ga.headline)}</span></small></div>
      <span class="dist">${d.toFixed(1)} mi</span></li>`;
  }).join("");

  const sensorHere = state.sensorField === p.id && sensor.last;

  $("#panelBody").innerHTML = `
    <div class="hero">
      <img class="${heroIdx ? "" : "tc"}" alt="Sentinel-2 image of field ${esc(p.id)}" src="${fieldImageUrl(state.scene, heroBox, heroIdx)}" />
      <span class="hero-tag">Sentinel-2 · ${s.label}, 2026 · ${heroIdx ? INDICES[heroIdx].short : "true color"}</span>
    </div>
    <div class="p-head">
      <h1>Field ${esc(p.id)} · ${esc(p.crop)}</h1>
      <div class="sub">${esc(p.farmer)}${mine ? " (you)" : ""} · ${p.acres} acres · ${esc(p.name)}</div>
      <span class="status ${a.level === "idle" ? "" : a.level}" style="${a.level === "idle" ? "background:var(--surface-3)" : ""}"><span class="ms fill">${statusIcon[a.level]}</span>${esc(a.headline)} · ${s.label}</span>
    </div>
    <div class="actions">
      <button class="action warn" id="actReport"><span class="circle"><span class="ms">campaign</span></span>Warn neighbors</button>
      <button class="action" id="actMeasure"><span class="circle"><span class="ms">satellite_alt</span></span>Re-measure</button>
      <button class="action" id="actHero"><span class="circle"><span class="ms">${state.heroMode === "true" ? "eco" : "image"}</span></span>${state.heroMode === "true" ? "Index view" : "True color"}</button>
      <button class="action" id="actShare"><span class="circle"><span class="ms">share</span></span>Share</button>
    </div>
    <div class="tabs" role="tablist">
      ${["overview", "history", "neighbors"].map((t) => `<button class="tab" role="tab" data-tab="${t}" aria-selected="${state.tab === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
    </div>
    ${state.tab === "overview" ? `
      <div class="section">
        ${a.insights.map((i) => `<div class="insight ${i.level}"><span class="ms fill" style="color:${statusColor(i.level)}">${i.icon}</span><div><b>${esc(i.title)}</b><span class="muted">${esc(i.body)}</span></div></div>`).join("")}
      </div>
      <div class="section"><h3>Field readings · ${s.label}</h3><div class="metrics">${metrics}</div>
        <p class="muted small" style="margin:10px 0 0">Compared with ${peers(fields, f, state.scene).length} ${p.crop.toLowerCase()} fields within 1.6 mi on the same day, which cancels out weather and season.</p></div>
      ${sensorHere ? `<div class="section"><h3>Live field sensor</h3>
        <div class="row"><span class="ms">sensors</span><div><b>${sensor.last.moisture != null ? `${sensor.last.moisture.toFixed(0)}% soil moisture` : `${sensor.last.hum?.toFixed(0) ?? "--"}% air humidity`}${sensor.last.night != null ? ` · ${sensor.last.night ? "night: attachment on" : "day: attachment off"}` : ""}</b><small>${sensor.mode === "serial" ? "Arduino over USB" : "Demo sensor"} · ${sensor.last.temp != null ? `${sensor.last.temp.toFixed(1)} °C air · ` : ""}${sensor.last.hum != null ? `${sensor.last.hum.toFixed(0)}% RH` : ""}</small></div></div></div>` : ""}
      <div class="section">
        <div class="row"><span class="ms">person</span><div>${esc(p.farmer)}<small>Owner · ${p.farmerId}</small></div></div>
        <div class="row"><span class="ms">grass</span><div>${esc(p.crop)}, ${p.acres} acres<small>${esc(p.name)}, Story County, Iowa</small></div></div>
        <div class="row"><span class="ms">location_on</span><div>${centroid(f)[1].toFixed(4)}° N, ${Math.abs(centroid(f)[0]).toFixed(4)}° W</div></div>
      </div>` : ""}
    ${state.tab === "history" ? `
      <div class="section">
        <h3>Season history</h3>
        <div class="index-tabs">${Object.values(INDICES).map((ix) => `<button class="chip" data-chart="${ix.key}" aria-pressed="${state.chartIndex === ix.key}">${ix.short}</button>`).join("")}</div>
        ${chartSvg(f, state.chartIndex)}
        <div class="chart-key"><span><i></i>This field</span><span><i class="nb"></i>Nearby ${esc(p.crop.toLowerCase())} (median, shaded range)</span></div>
        <p class="muted small">${esc(INDICES[state.chartIndex].explain)}</p>
      </div>` : ""}
    ${state.tab === "neighbors" ? `
      <div class="section"><h3>Farms within 2 miles</h3><ul class="neighbors">${neighborList || '<li class="muted">No neighbors in range</li>'}</ul></div>` : ""}
    <div class="source">Satellite data: Sentinel-2 L2A (ESA Copernicus), computed per field through <a href="https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a" target="_blank" rel="noopener">Microsoft Planetary Computer</a>. Field lines follow the PLSS section roads. Farmer names, crops and phone numbers are demo data.</div>
  `;

  $("#actReport").onclick = () => openReport(f);
  $("#actMeasure").onclick = () => remeasure(f);
  $("#actHero").onclick = () => { state.heroMode = state.heroMode === "true" ? "index" : "true"; renderPanel(); };
  $("#actShare").onclick = async () => {
    const url = `${location.origin}${location.pathname}${location.search}#${p.id}`;
    try { await navigator.clipboard.writeText(url); snack("Link copied", "link"); } catch { snack(url, "link"); }
  };
  for (const t of document.querySelectorAll(".tab")) t.onclick = () => { state.tab = t.dataset.tab; renderPanel(); };
  for (const c of document.querySelectorAll("[data-chart]")) c.onclick = () => { state.chartIndex = c.dataset.chart; renderPanel(); };
  for (const li of document.querySelectorAll(".neighbors li[data-id]")) li.onclick = () => select(byId.get(li.dataset.id));
}

function chartSvg(f, key, pool = fields) {
  const W = 360, H = 160, L = 30, R = 18, T = 10, B = 26;
  const ix = INDICES[key];
  const t0 = Date.parse(SCENES[0].date), t1 = Date.parse(SCENES.at(-1).date);
  const x = (d) => L + ((Date.parse(d) - t0) / (t1 - t0)) * (W - L - R);
  const lo = Math.min(ix.range[0], -0.1 * (key === "ndmi")), hi = ix.range[1] + 0.05;
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const rows = SCENES.map((s, i) => {
    const vs = peers(pool, f, i).map((g) => valueAt(g, i, key)).filter((v) => v != null).sort((a, b) => a - b);
    return { s, i, me: valueAt(f, i, key), med: vs.length ? vs[vs.length >> 1] : null, min: vs[0], max: vs.at(-1) };
  });
  const path = (pts) => pts.filter((p) => p[1] != null).map((p, j) => `${j ? "L" : "M"}${p[0].toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const band = rows.filter((r) => r.min != null);
  const bandPath = band.length ? `M${band.map((r) => `${x(r.s.date)},${y(r.max)}`).join("L")}L${[...band].reverse().map((r) => `${x(r.s.date)},${y(r.min)}`).join("L")}Z` : "";
  const ticks = [lo, (lo + hi) / 2, hi].map((v) => +v.toFixed(1));
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${ix.short} over the 2026 season">
    ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${v}</text>`).join("")}
    <path class="band" d="${bandPath}"/>
    <path class="line-nb" d="${path(rows.map((r) => [x(r.s.date), r.med]))}"/>
    <path class="line-me" d="${path(rows.map((r) => [x(r.s.date), r.me]))}"/>
    ${rows.filter((r) => r.me != null).map((r) => `<circle class="pt ${r.i === state.scene ? "sel" : ""}" cx="${x(r.s.date)}" cy="${y(r.me)}" r="${r.i === state.scene ? 5 : 3.5}"><title>${r.s.label}: ${r.me.toFixed(2)} (nearby ${r.med?.toFixed(2) ?? "–"})</title></circle>`).join("")}
    ${rows.filter((r, i) => i === 0 || x(r.s.date) - x(rows[i - 1].s.date) > 30).map((r) => `<text x="${x(r.s.date)}" y="${H - 8}" text-anchor="middle">${r.s.label}</text>`).join("")}
  </svg>`;
}

async function remeasure(f) {
  snack(`Measuring ${f.properties.id} from Sentinel-2 (${SCENES[state.scene].label})…`, "satellite_alt", null, 8000);
  try {
    const t = performance.now();
    const live = await measureField(state.scene, f.geometry);
    const ms = Math.round(performance.now() - t);
    snack(`Live from Sentinel-2 in ${ms} ms: NDVI ${live.ndvi.toFixed(2)} · NDRE ${live.ndre.toFixed(2)} · NDMI ${live.ndmi.toFixed(2)}`, "check_circle", null, 7000);
  } catch (e) {
    snack(`Couldn't reach Planetary Computer: ${e.message}`, "error");
  }
}

/* ------------------------------------------------------------------ report flow */
let reportField = null;
function openReport(f, preset = {}) {
  reportField = f;
  $("#reportField").textContent = `From field ${f.properties.id} (${f.properties.crop}, ${f.properties.farmer})`;
  if (preset.type) $(`#reportType input[value="${preset.type}"]`).checked = true;
  $("#reportNote").value = preset.note || "";
  updateReach();
  $("#reportDialog").showModal();
}
function reach(f, r) {
  const reporter = f.properties.farmerId;
  const ids = new Set(fieldsWithin(fields, centroid(f), r).map(({ f: g }) => g.properties.farmerId).filter((id) => id !== reporter));
  const bySms = store.subscribers.filter((s) => ids.has(s.farmerId)).length;
  return { farmers: ids.size, sms: bySms };
}
function updateReach() {
  const r = +$("#reportRadius").value;
  $("#radiusOut").textContent = r;
  const n = reach(reportField, r);
  $("#reportReach").textContent = `Reaches ${n.farmers} neighboring farmer${n.farmers === 1 ? "" : "s"}` +
    (store.online ? `, ${n.sms} by text message` : " in the app (texting agent offline)");
  // Preview circle
  map.getSource("alerts")?.setData({
    type: "FeatureCollection",
    features: [...alertFC.features, { ...turf.circle(centroid(reportField), r, { units: "miles", steps: 96 }), properties: { id: "preview", color: "#1a73e8" } }],
  });
}
$("#reportRadius").addEventListener("input", updateReach);
$("#reportDialog").addEventListener("close", async () => {
  drawAlerts();
  if ($("#reportDialog").returnValue !== "send" || !reportField) return;
  const persona = farmers.find((x) => x.id === state.persona);
  const reporter = reportField.properties.farmerId === state.persona ? persona : { id: reportField.properties.farmerId, name: reportField.properties.farmer };
  const alert = await store.create({
    type: $("#reportType input:checked").value,
    note: $("#reportNote").value.trim(),
    radiusMi: +$("#reportRadius").value,
    field: reportField, reporter,
    source: state.sensorField === reportField.properties.id && sensor.last ? "sensor" : "web",
  });
  state.seen.add(alert.id); ls.set("f4f.seen", [...state.seen]);
  const sms = alert.notified.filter((n) => n.channel === "imessage" || n.channel === "simulator").length;
  snack(`Alert sent to ${alert.notified.length} neighbor${alert.notified.length === 1 ? "" : "s"}${sms ? `, ${sms} by text` : ""}`, "campaign");
  refreshAll();
});

/* ------------------------------------------------------------------ alerts drawer, badges */
function myFields() { return fields.filter((f) => f.properties.farmerId === state.persona); }
function alertsForMe() {
  const mine = myFields();
  return activeAlerts(store.alerts).filter((a) => a.reporterId !== state.persona &&
    mine.some((f) => miles(centroid(f), a.center) - 0.35 <= a.radiusMi));
}
function renderBadges() {
  const unseen = alertsForMe().filter((a) => !state.seen.has(a.id)).length;
  $("#bellBadge").hidden = !unseen; $("#bellBadge").textContent = unseen;
  const n = activeAlerts(store.alerts).length;
  $("#alertsChipBadge").hidden = !n; $("#alertsChipBadge").textContent = n;
}
function toggleDrawer(force) {
  const open = force ?? $("#drawer").hidden;
  $("#drawer").hidden = !open;
  $("#alertsChip").setAttribute("aria-pressed", open);
  if (open) {
    renderDrawer();
    for (const a of alertsForMe()) state.seen.add(a.id);
    ls.set("f4f.seen", [...state.seen]);
    renderBadges();
  }
}
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function renderDrawer() {
  const list = activeAlerts(store.alerts);
  const mine = myFields();
  $("#alertList").innerHTML = list.length ? list.map((a) => {
    const t = ALERT_TYPES[a.type] || ALERT_TYPES.pest;
    const d = mine.length ? Math.min(...mine.map((f) => miles(centroid(f), a.center))) : null;
    const sms = a.notified?.filter((n) => n.channel === "imessage").length || 0;
    return `<div class="alert-card ${a.type}" data-id="${a.id}">
      <span class="icon"><span class="ms">${t.icon}</span></span>
      <div><b>${t.label} · ${esc(a.fieldId)}</b><small>${esc(a.reporterName)}${a.note ? ` · “${esc(a.note)}”` : ""}</small>
      <div class="meta"><span>${ago(a.createdAt)}</span>
        ${d != null ? `<span class="tag"><span class="ms">near_me</span>${d.toFixed(1)} mi from you</span>` : ""}
        <span class="tag ${a.source === "sms" ? "sms" : ""}"><span class="ms">${a.source === "sms" ? "sms" : a.source === "sensor" ? "sensors" : "language"}</span>${a.source === "sms" ? "via text" : a.source === "sensor" ? "sensor" : "web"}</span>
        <span class="tag"><span class="ms">group</span>${a.notified?.length || 0} notified${sms ? ` · ${sms} iMessage` : ""}</span>
        ${a.demo ? '<span class="tag">example</span>' : ""}
        ${a.reporterId === state.persona ? `<button class="btn text" data-resolve="${a.id}" style="height:24px;padding:0 6px">Mark resolved</button>` : ""}
      </div></div></div>`;
  }).join("") : `<div class="empty"><span class="ms" style="font-size:40px">notifications_off</span><p>No active alerts. When a neighbor reports pests, disease or drought, it shows up here.</p></div>`;
  for (const el of document.querySelectorAll(".alert-card")) {
    el.onclick = (e) => {
      const r = e.target.closest("[data-resolve]");
      if (r) { e.stopPropagation(); store.resolve(r.dataset.resolve); return; }
      const a = store.alerts.find((x) => x.id === el.dataset.id);
      if (window.innerWidth <= 720) toggleDrawer(false);
      select(byId.get(a.fieldId), { fly: true });
    };
  }
}
$("#bellBtn").addEventListener("click", () => toggleDrawer());
$("#drawerClose").addEventListener("click", () => toggleDrawer(false));

store.addEventListener("change", refreshAll);
store.addEventListener("new", (e) => {
  const a = e.detail;
  const t = ALERT_TYPES[a.type] || ALERT_TYPES.pest;
  const forMe = alertsForMe().some((x) => x.id === a.id);
  snack(`${a.source === "sms" ? "New text report" : "New report"}: ${t.label.toLowerCase()} at ${a.fieldId} from ${a.reporterName}${forMe ? ", near your fields" : ""}`, t.icon,
    { label: "View", run: () => select(byId.get(a.fieldId), { fly: true }) }, 8000);
});
store.addEventListener("online", renderAgent);
store.startSync();

/* ------------------------------------------------------------------ agent + persona menus */
function renderAgent() {
  $("#agentDot").classList.toggle("on", store.online);
  $("#agentLabel").textContent = store.online ? `Texting agent · ${store.subscribers.length} farmer${store.subscribers.length === 1 ? "" : "s"}` : "Texting agent offline";
}
renderAgent();

function avatarColor(id) { return ["#7e57c2", "#e8710a", "#188038", "#d01884", "#1a73e8", "#a50e0e", "#007b83", "#9334e6", "#b06000", "#3c4043", "#c5221f", "#137333"][parseInt(id.slice(1), 10) % 12]; }
function initials(name) { return name.replace(/&.*/, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase(); }
function renderPersona() {
  const me = farmers.find((x) => x.id === state.persona) || farmers[0];
  const btn = $("#personaBtn");
  btn.textContent = initials(me.name);
  btn.style.background = avatarColor(me.id);
  btn.title = `Viewing as ${me.name}`;
}
renderPersona();

$("#personaBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const m = $("#personaMenu");
  if (!m.hidden && m.dataset.kind === "persona") { m.hidden = true; return; }
  m.dataset.kind = "persona";
  m.innerHTML = `<h3>View the map as</h3>` + farmers.map((x) => {
    const n = fields.filter((f) => f.properties.farmerId === x.id).length;
    return `<div class="menu-item" data-id="${x.id}" aria-current="${x.id === state.persona}"><span class="avatar" style="background:${avatarColor(x.id)}">${initials(x.name)}</span><div>${esc(x.name)}<small>${n} field${n === 1 ? "" : "s"}</small></div></div>`;
  }).join("");
  m.hidden = false;
  m.onclick = (ev) => {
    const it = ev.target.closest(".menu-item");
    if (!it) return;
    state.persona = it.dataset.id; ls.set("f4f.persona", state.persona);
    m.hidden = true;
    renderPersona(); refreshAll();
    const mine = myFields();
    if (mine.length) {
      const bb = mine.map(bbox).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
      map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 120, maxZoom: 14.5 });
    }
    snack(`Viewing as ${farmers.find((x) => x.id === state.persona).name}. Your fields have a blue dashed outline.`, "person");
  };
});

$("#agentPill").addEventListener("click", (e) => {
  e.stopPropagation();
  const m = $("#personaMenu");
  if (!m.hidden && m.dataset.kind === "agent") { m.hidden = true; return; }
  m.dataset.kind = "agent";
  const subs = store.subscribers.map((s) => `<div class="menu-item"><span class="ms">sms</span><div>${esc(s.name || s.farmerId)}<small>${esc(s.phoneMasked || "")} · fields ${esc((s.fieldIds || []).join(", "))}</small></div></div>`).join("");
  m.innerHTML = `<h3>Texting agent</h3>
    <div style="padding:0 16px 8px" class="small muted">${store.online ? `Connected to <b>${esc(store.agentUrl)}</b> (${esc(store.channel || "photon")}). Farmers opt in by texting <b>JOIN F05</b> (their field code) to the Photon number.` : `Not reachable at <b>${esc(store.agentUrl)}</b>. Start it with <code>npm start</code> in <code>/agent</code>. Alerts still work in the app.`}</div>
    <div style="padding:0 16px 12px;display:flex;gap:8px"><input class="text-input" id="agentUrlInput" value="${esc(store.agentUrl)}" style="height:36px;font-size:13px" /><button class="btn tonal" id="agentUrlSave" style="height:36px">Save</button></div>
    ${store.online ? `<h3>Opted in by text (${store.subscribers.length})</h3>${subs || '<div class="menu-item muted small">Nobody yet</div>'}` : ""}`;
  m.hidden = false;
  m.onclick = (ev) => ev.stopPropagation();
  $("#agentUrlSave").onclick = () => { store.setAgentUrl($("#agentUrlInput").value.trim()); m.hidden = true; snack("Agent address saved", "link"); };
});
document.addEventListener("click", (e) => { if (!e.target.closest("#personaMenu")) $("#personaMenu").hidden = true; });

/* ------------------------------------------------------------------ search */
const sInput = $("#searchInput"), sRes = $("#searchResults");
let sItems = [], sIdx = 0;
function searchFor(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const f of fields) {
    const p = f.properties;
    if ([p.id, p.farmer, p.crop, p.name].some((s) => s.toLowerCase().includes(q)))
      out.push({ icon: "agriculture", title: `${p.id} · ${p.crop}`, sub: `${p.farmer} · ${p.acres} ac`, run: () => select(f, { fly: true }) });
  }
  for (const a of activeAlerts(store.alerts)) {
    const t = ALERT_TYPES[a.type];
    if ([t.label, a.note || "", a.reporterName, a.type].some((s) => s.toLowerCase().includes(q)))
      out.unshift({ icon: t.icon, title: `${t.label} at ${a.fieldId}`, sub: `${a.reporterName} · ${ago(a.createdAt)}`, run: () => select(byId.get(a.fieldId), { fly: true }) });
  }
  out.splice(7);
  out.push({ icon: "travel_explore", title: `Search the US for “${q}”`, sub: "Any town, county or address", keep: true, run: () => placeSearch(q) });
  return out;
}
function renderSearch() {
  sRes.hidden = !sItems.length;
  sRes.innerHTML = sItems.map((it, i) => `<div class="result" role="option" data-i="${i}" aria-selected="${i === sIdx}"><span class="ms">${it.icon}</span><div><b>${esc(it.title)}</b><small>${esc(it.sub)}</small></div></div>`).join("");
}
sInput.addEventListener("input", () => { sItems = searchFor(sInput.value); sIdx = 0; renderSearch(); });
sInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { sIdx = Math.min(sItems.length - 1, sIdx + 1); renderSearch(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { sIdx = Math.max(0, sIdx - 1); renderSearch(); e.preventDefault(); }
  else if (e.key === "Enter" && sItems[sIdx]) { const it = sItems[sIdx]; it.run(); if (!it.keep) { sRes.hidden = true; sInput.blur(); } }
  else if (e.key === "Escape") { sRes.hidden = true; sInput.blur(); }
});
sRes.addEventListener("mousedown", (e) => {
  const r = e.target.closest(".result");
  if (!r) return;
  e.preventDefault();
  const it = sItems[+r.dataset.i];
  it.run();
  if (!it.keep) { sRes.hidden = true; sInput.blur(); }
});
sInput.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== sInput) sRes.hidden = true; }, 150));
$("#searchBtn").addEventListener("click", () => { sItems = searchFor(sInput.value); if (sItems[0]) sItems[0].run(); });
$("#menuBtn").addEventListener("click", () => toggleDrawer());
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement.tagName !== "INPUT") { e.preventDefault(); sInput.focus(); }
  if (e.key === "Escape" && state.selected && !document.querySelector("dialog[open]")) closePanel();
});

/* ------------------------------------------------------------------ map controls */
$("#zoomIn").onclick = () => map.zoomIn();
$("#zoomOut").onclick = () => map.zoomOut();
$("#homeBtn").onclick = () => map.flyTo({ ...HOME, padding: { left: state.selected && innerWidth > 720 ? 408 : 0, top: 0, right: 0, bottom: 0 } });

/* ------------------------------------------------------------------ sensor */
let sensorMarker = null, dryWarned = false;
state.riskAt = 75;
$("#riskAt").addEventListener("input", (e) => { state.riskAt = +e.target.value; $("#riskOut").textContent = state.riskAt; dryWarned = false; });
$("#sensorField").innerHTML = fields.map((f) => `<option value="${f.properties.id}">${f.properties.id} · ${f.properties.crop} · ${esc(f.properties.farmer)}</option>`).join("");
$("#sensorBtn").onclick = () => {
  $("#sensorField").value = state.sensorField || state.selected?.properties.id || myFields()[0]?.properties.id || "F01";
  $("#sensorConnect").disabled = !sensor.supported;
  if (!sensor.supported) $("#sensorStatus").textContent = "This browser has no Web Serial. Use Chrome or Edge on a laptop, or try the demo sensor.";
  if (!$("#sensorDialog").open) $("#sensorDialog").show(); // non-modal: keeps the map usable
};
$("#sensorClose").onclick = () => $("#sensorDialog").close();
$("#sensorConnect").onclick = async () => {
  try {
    placeSensor();
    await sensor.connect();
  } catch (e) {
    $("#sensorStatus").textContent = /failed to open/i.test(e.message)
      ? "Another program is using the Arduino's port. Close the Arduino IDE Serial Monitor and any other tab of this map, then Connect again."
      : e.name === "NotFoundError" ? "No port chosen." : e.message;
  }
};
$("#sensorSim").onclick = () => { placeSensor(); sensor.startDemo(); };
$("#sensorField").onchange = () => { if (sensor.mode !== "off") placeSensor(); };
function placeSensor() {
  state.sensorField = $("#sensorField").value;
  dryWarned = false;
  const f = byId.get(state.sensorField);
  if (!sensorMarker) {
    const el = document.createElement("div");
    el.className = "sensor-pin"; el.innerHTML = '<span class="ms">sensors</span>'; el.title = "Soil sensor";
    el.onclick = (ev) => { ev.stopPropagation(); select(byId.get(state.sensorField), { fly: true }); };
    sensorMarker = new maplibregl.Marker({ element: el });
  }
  const c = centroid(f);
  sensorMarker.setLngLat([c[0] + 0.002, c[1] - 0.001]).addTo(map);
  $("#sensorBtn").classList.add("live");
}
sensor.addEventListener("status", (e) => {
  $("#sensorStatus").textContent = e.detail;
  // Disconnect frees the USB port, e.g. so the Arduino IDE can upload a sketch.
  $("#sensorDisconnect").hidden = sensor.mode === "off";
  if (sensor.mode === "off") { $("#sensorBtn").classList.remove("live"); sensorMarker?.remove(); }
});
$("#sensorDisconnect").onclick = () => sensor.stop();
sensor.addEventListener("line", (e) => { $("#sensorRaw").textContent = e.detail; });
let riskStreak = 0;
let lastNight = null; // last day/night state from the photocell, to announce switches
let lastPanelPaint = 0;
sensor.addEventListener("reading", (e) => {
  const r = e.detail;
  const air = r.kind === "air";
  // Gauge shows soil moisture for a soil probe, air humidity for a DHT11 station.
  const pct = Math.max(0, Math.min(100, air ? r.hum : r.moisture));
  const risky = air ? pct >= state.riskAt : pct < 25;
  $("#gaugeLabel").textContent = air ? "% air humidity" : "% soil moisture";
  $("#humRow").hidden = air; // humidity is already the gauge
  $("#moistVal").textContent = pct.toFixed(0);
  $("#tempVal").textContent = r.temp != null ? r.temp.toFixed(1) : "--";
  $("#humVal").textContent = r.hum != null ? r.hum.toFixed(0) : "--";
  $("#thirdIcon").textContent = r.night ? "dark_mode" : r.light != null ? "light_mode" : "memory";
  $("#thirdLabel").textContent = r.night != null ? (r.night ? "light · night, attachment on" : "light · day, attachment off")
    : r.light != null ? "light (0–1023)" : "raw ADC";
  if (r.night != null && lastNight != null && r.night !== lastNight && state.sensorField) {
    const fid = state.sensorField;
    snack(r.night ? `It's dark at ${fid}: the tractor attachment switched on.` : `Daylight at ${fid}: the tractor attachment switched off.`,
      r.night ? "dark_mode" : "light_mode", null, 6000);
  }
  if (r.night != null) lastNight = r.night;
  $("#rawVal").textContent = r.light ?? r.raw ?? "--";
  if (sensor.mode === "serial") $("#sensorStatus").textContent = `Live from the Arduino · ${air ? "DHT11 air station" : "soil probe"}`;
  const g = $("#gaugeFill");
  g.style.strokeDashoffset = 157 * (1 - pct / 100);
  g.style.stroke = risky ? "#d93025" : "var(--primary)";
  const h = sensor.history.filter((p) => p.kind === r.kind);
  const val = (p) => Math.min(100, (air ? p.hum : p.moisture) ?? 0);
  $("#sensorSpark").innerHTML = h.length > 1 ? `<path d="${h.map((p, i) => `${i ? "L" : "M"}${(i / (h.length - 1)) * 300},${50 - (val(p) / 100) * 46 - 2}`).join("")}"/>` : "";
  if (state.selected?.properties.id === state.sensorField && Date.now() - lastPanelPaint > 2000) { lastPanelPaint = Date.now(); refreshAll(); }
  riskStreak = risky ? riskStreak + 1 : 0;
  if (riskStreak >= 2 && !dryWarned) { // two readings in a row, so one glitchy sample can't raise an alarm
    dryWarned = true;
    refreshAll();
    const f = byId.get(state.sensorField);
    select(f, { fly: true });
    if (air) {
      const tTxt = r.temp != null ? ` at ${r.temp.toFixed(0)} °C` : "";
      snack(`Humidity at ${f.properties.id} hit ${pct.toFixed(0)}%${tTxt}: fungal disease risk.`, "coronavirus",
        { label: "Warn neighbors", run: () => openReport(f, { type: "disease", note: `Field sensor: ${pct.toFixed(0)}% humidity${tTxt}. Blight/mildew risk` }) }, 15000);
    } else {
      snack(`Soil at ${f.properties.id} dropped to ${pct.toFixed(0)}%, which is dry.`, "water_drop",
        { label: "Warn neighbors", run: () => openReport(f, { type: "drought", note: `Soil sensor reads ${pct.toFixed(0)}% moisture` }) }, 15000);
    }
  } else if (air ? pct < state.riskAt - 5 : pct > 30) dryWarned = false;
});

/* ------------------------------------------------------------------ snackbar */
let snackTimer;
function snack(text, icon = "info", action = null, ms = 5000) {
  const s = $("#snackbar");
  s.innerHTML = `<span class="ms">${icon}</span><span>${esc(text)}</span>${action ? `<button>${esc(action.label)}</button>` : ""}`;
  if (action) s.querySelector("button").onclick = () => { s.hidden = true; action.run(); };
  s.hidden = false;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => (s.hidden = true), ms);
}

/* ------------------------------------------------------------------ nationwide fields (USDA + live Sentinel-2) */
const PILOT_BBOX = fields.map(bbox).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
const usFields = new Map();   // csbid -> feature
const natCache = new Map();   // csbid -> { series, neighbors: { scene, list, busy }, busy, error }
let usAbort = null;

function isNational(f) { return !!f?.properties?.csbid; }
function inPilot([x, y]) { return x >= PILOT_BBOX[0] && x <= PILOT_BBOX[2] && y >= PILOT_BBOX[1] && y <= PILOT_BBOX[3]; }

function addNationalLayers() {
  map.addSource("us", { type: "geojson", data: emptyFC() });
  const before = "fields-fill";
  map.addLayer({ id: "us-fill", type: "fill", source: "us", minzoom: 12, paint: { "fill-color": "#fff", "fill-opacity": 0.01 } }, before);
  map.addLayer({ id: "us-line", type: "line", source: "us", minzoom: 12, paint: { "line-color": "#fff", "line-opacity": 0.75, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.4, 16, 1.4] } }, before);
  map.addLayer({ id: "us-selected", type: "line", source: "us", filter: ["==", ["get", "csbid"], ""], paint: { "line-color": "#1a73e8", "line-width": 5 } });
  map.on("moveend", loadNationalFields);
  map.on("moveend", () => { $("#zoomHint").hidden = map.getZoom() >= 12 || inPilot(map.getCenter().toArray()); });
  map.on("mousemove", "us-fill", (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ["fields-fill"] }).length) return;
    const p = e.features[0].properties;
    map.getCanvas().style.cursor = "pointer";
    hoverPopup.setLngLat(e.lngLat).setHTML(`<b>${esc(US.cropName(+p.r22))}</b> · ${Math.round(p.csbacres)} ac<br>${esc(p.cnty)} County, ${US.stateAbbr(p.statefips)}<br><span class="small">USDA field · click for live satellite health</span>`).addTo(map);
  });
  map.on("mouseleave", "us-fill", () => { map.getCanvas().style.cursor = ""; hoverPopup.remove(); });
  map.on("click", "us-fill", (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ["fields-fill"] }).length) return; // pilot fields win
    select(usFields.get(e.features[0].properties.csbid), { fly: true });
  });
  loadNationalFields();
}

async function loadNationalFields() {
  if (map.getZoom() < 12.5) return;
  const b = map.getBounds();
  const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  usAbort?.abort();
  usAbort = new AbortController();
  try {
    const feats = await US.fetchFields(view, usAbort.signal);
    for (const f of feats) if (!inPilot(centroid(f))) usFields.set(f.properties.csbid, f);
    if (usFields.size > 8000) { // keep memory bounded on long sessions
      for (const k of [...usFields.keys()].slice(0, usFields.size - 8000)) usFields.delete(k);
    }
    map.getSource("us").setData({ type: "FeatureCollection", features: [...usFields.values()] });
  } catch (e) {
    if (e.name !== "AbortError") console.warn("USDA fields:", e.message);
  }
}

async function measureNational(f, { force = false } = {}) {
  const id = f.properties.csbid;
  let nat = natCache.get(id);
  if (!nat || force) {
    nat = { series: null, neighbors: null, busy: true, error: null };
    natCache.set(id, nat);
    renderPanelIf(f);
    try {
      const bb = bbox(f);
      nat.series = await Promise.all(SCENES.map(async (s, i) => {
        const item = await US.sceneFor(i, bb);
        if (!item) return { date: s.date, item: null };
        const v = await US.measure(item.id, f.geometry).catch(() => null);
        return { date: s.date, actual: item.date, item: item.id, ...(v || {}) };
      }));
    } catch (e) {
      nat.error = e.message;
    }
    nat.busy = false;
  }
  if (nat.series && nat.neighbors?.scene !== state.scene) await measureNeighbors(f, nat);
  renderPanelIf(f);
}

async function measureNeighbors(f, nat) {
  const scene = state.scene;
  const row = nat.series[scene];
  nat.neighbors = { scene, list: [], busy: true };
  if (!row?.item) { nat.neighbors.busy = false; return; }
  const c = centroid(f);
  const cands = [...usFields.values()]
    .filter((g) => g !== f && g.properties.cropCode === f.properties.cropCode)
    .map((g) => ({ g, d: miles(c, centroid(g)) }))
    .filter(({ d }) => d <= 1.6)
    .sort((a, b) => a.d - b.d).slice(0, 8);
  renderPanelIf(f);
  const measured = await Promise.all(cands.map(async ({ g }) => {
    const v = await US.measure(row.item, g.geometry).catch(() => null);
    return v ? pseudo(g, [{ date: SCENES[scene].date, ...v }]) : null;
  }));
  if (nat.neighbors.scene === scene) nat.neighbors = { scene, list: measured.filter(Boolean), busy: false };
}

function pseudo(f, series) {
  return { type: "Feature", geometry: f.geometry, properties: { id: f.properties.id, crop: f.properties.crop, farmerId: null, series } };
}

function natAssessment(f) {
  const nat = natCache.get(f.properties.csbid);
  if (!nat?.series) return null;
  const target = pseudo(f, nat.series.filter((r) => r.ndvi != null));
  const pool = [target, ...(nat.neighbors?.list || [])];
  return { target, pool, a: assess(pool, target, state.scene, { alerts: [] }) };
}

function renderPanelIf(f) { if (state.selected === f) renderPanel(); }

function renderNationalPanel() {
  const f = state.selected, p = f.properties, s = SCENES[state.scene];
  const nat = natCache.get(p.csbid) || {};
  const row = nat.series?.[state.scene];
  const r = natAssessment(f);
  const a = r?.a;
  const b = bbox(f), pad = 0.0025;
  const heroBox = [b[0] - pad, b[1] - pad * 0.75, b[2] + pad, b[3] + pad * 0.75];
  const heroIdx = state.heroMode === "true" ? null : (state.index === "none" ? "ndvi" : state.index);
  const busy = nat.busy || nat.neighbors?.busy;
  const nbCount = nat.neighbors?.list?.length ?? 0;
  const tab = state.tab === "history" ? "history" : "overview";

  const metrics = Object.values(INDICES).map((ix) => {
    const v = row?.[ix.key];
    const d = a?.deltas?.[ix.key];
    const dTxt = d == null ? (busy ? "measuring…" : "no comparison") : Math.abs(d) < 0.03 ? "≈ neighbors"
      : `${d > 0 ? "▲" : "▼"} ${ix.key === "ndmi" ? Math.abs(d).toFixed(2) : `${Math.abs(Math.round(d * 100))}%`} vs nearby`;
    return `<div class="metric" title="${esc(ix.explain)}"><span>${ix.name} · ${ix.short}</span><b>${v == null ? "–" : v.toFixed(2)}</b><em class="${d == null || Math.abs(d) < 0.03 ? "" : d > 0 ? "up" : "down"}">${dTxt}</em></div>`;
  }).join("");

  const hist = p.history.map((h) => `<span class="tag" title="${h.year}">'${String(h.year).slice(2)} ${esc(US.cropName(h.code))}</span>`).join(" ");

  $("#panelBody").innerHTML = `
    <div class="hero">
      ${row?.item ? `<img class="${heroIdx ? "" : "tc"}" alt="Sentinel-2 image of this field" src="${fieldImageUrl(state.scene, heroBox, heroIdx, [816, 320], row.item)}" />` : `<div class="empty">${busy ? "Finding the clearest Sentinel-2 pass…" : "No clear Sentinel-2 pass in this window"}</div>`}
      ${row?.actual ? `<span class="hero-tag">Sentinel-2 · ${row.actual} · ${heroIdx ? INDICES[heroIdx].short : "true color"}</span>` : ""}
    </div>
    <div class="p-head">
      <h1>${esc(p.crop)} field · ${Math.round(p.csbacres)} acres</h1>
      <div class="sub">${esc(p.cnty)} County, ${US.stateAbbr(p.statefips)} · USDA field ${esc(p.csbid)}</div>
      ${a ? `<span class="status ${a.level === "idle" ? "" : a.level}" style="${a.level === "idle" ? "background:var(--surface-3)" : ""}"><span class="ms fill">${statusIcon[a.level]}</span>${esc(a.headline)} · ${s.label}</span>`
        : `<span class="status" style="background:var(--surface-3)"><span class="ms">satellite_alt</span>${busy ? "Measuring from space…" : "No data"}</span>`}
    </div>
    <div class="actions">
      <button class="action" id="actMeasure"><span class="circle"><span class="ms">satellite_alt</span></span>Re-measure</button>
      <button class="action" id="actHero"><span class="circle"><span class="ms">${state.heroMode === "true" ? "eco" : "image"}</span></span>${state.heroMode === "true" ? "Index view" : "True color"}</button>
      <button class="action" id="actZoom"><span class="circle"><span class="ms">zoom_in_map</span></span>Zoom to field</button>
      <button class="action" id="actShare"><span class="circle"><span class="ms">share</span></span>Share</button>
    </div>
    <div class="tabs" role="tablist">
      ${["overview", "history"].map((t) => `<button class="tab" role="tab" data-tab="${t}" aria-selected="${tab === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
    </div>
    ${tab === "overview" ? `
      <div class="section">
        ${a ? a.insights.map((i) => `<div class="insight ${i.level}"><span class="ms fill" style="color:${statusColor(i.level)}">${i.icon}</span><div><b>${esc(i.title)}</b><span class="muted">${esc(i.body)}</span></div></div>`).join("")
          : `<div class="insight"><span class="ms">hourglass_top</span><div><b>${busy ? "Pulling this field's season from Sentinel-2" : esc(nat.error || "No measurements yet")}</b><span class="muted">Six passes from May to October, plus up to 8 nearby ${esc(p.crop.toLowerCase())} fields for comparison.</span></div></div>`}
      </div>
      <div class="section"><h3>Field readings · ${s.label}${row?.actual ? ` (pass of ${row.actual})` : ""}</h3><div class="metrics">${metrics}</div>
        <p class="muted small" style="margin:10px 0 0">${nat.neighbors?.busy ? "Measuring nearby fields…" : `Compared with ${nbCount} nearby ${esc(p.crop.toLowerCase())} field${nbCount === 1 ? "" : "s"} on the same satellite pass.`}</p></div>
      <div class="section"><h3>Crop history (USDA)</h3>
        <div class="row"><span class="ms">autorenew</span><div>${esc(US.rotationText(p.history))}<small>2026 estimate: ${esc(p.crop)}, from USDA Crop Sequence Boundaries</small></div></div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">${hist}</div>
      </div>` : `
      <div class="section">
        <h3>Season history</h3>
        <div class="index-tabs">${Object.values(INDICES).map((ix) => `<button class="chip" data-chart="${ix.key}" aria-pressed="${state.chartIndex === ix.key}">${ix.short}</button>`).join("")}</div>
        ${r ? chartSvg(r.target, state.chartIndex, r.pool) : `<p class="muted">${busy ? "Measuring…" : "No data"}</p>`}
        <div class="chart-key"><span><i></i>This field</span><span><i class="nb"></i>Nearby ${esc(p.crop.toLowerCase())} on ${s.label}</span></div>
      </div>`}
    <div class="source">Field outline and crop history: USDA NASS Crop Sequence Boundaries (2015–2022). Imagery and indices: Sentinel-2 L2A, the clearest pass within ±12 days of each date, measured live through Microsoft Planetary Computer.</div>`;

  $("#actMeasure").onclick = () => measureNational(f, { force: true });
  $("#actHero").onclick = () => { state.heroMode = state.heroMode === "true" ? "index" : "true"; renderPanel(); };
  $("#actZoom").onclick = () => { const bb = bbox(f); map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: { left: innerWidth > 720 ? 448 : 40, top: 60, right: 60, bottom: 140 }, maxZoom: 16 }); };
  $("#actShare").onclick = async () => {
    const url = `${location.origin}${location.pathname}${location.search}${location.hash}`;
    try { await navigator.clipboard.writeText(url); snack("Link copied", "link"); } catch { snack(url, "link"); }
  };
  for (const t of document.querySelectorAll(".tab")) t.onclick = () => { state.tab = t.dataset.tab; renderPanel(); };
  for (const c of document.querySelectorAll("[data-chart]")) c.onclick = () => { state.chartIndex = c.dataset.chart; renderPanel(); };
}

// Re-measure neighbors when the timeline date changes on a national field
$("#dates").addEventListener("click", () => { if (isNational(state.selected)) measureNational(state.selected); });

/* ------------------------------------------------------------------ place search (any US location) */
async function placeSearch(q) {
  sRes.hidden = false;
  sRes.innerHTML = `<div class="result"><span class="ms">travel_explore</span><div>Searching the US for “${esc(q)}”…</div></div>`;
  const places = await US.geocode(q).catch(() => []);
  sItems = places.map((pl) => ({
    icon: "location_on", title: pl.name.split(",").slice(0, 2).join(","), sub: pl.name.split(",").slice(2).join(",").trim(),
    run: () => {
      const [w, s2, e, n] = pl.bbox;
      if (e - w < 0.05) map.flyTo({ center: [(w + e) / 2, (s2 + n) / 2], zoom: 14.5 });
      else map.fitBounds([[w, s2], [e, n]], { padding: 60, maxZoom: 14.5 });
      snack("Zoom in to farmland to see USDA fields, then click one for live satellite health.", "agriculture", null, 6000);
    },
  }));
  sIdx = 0;
  if (!sItems.length) sRes.innerHTML = `<div class="result"><span class="ms">search_off</span><div>No US place found for “${esc(q)}”</div></div>`;
  else renderSearch();
}
