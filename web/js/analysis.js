// Field-health analysis shared by the web app and the texting agent (no DOM, no deps).
import { SCENES, INDICES, ALERT_TYPES } from "./config.js";

const NEIGHBOR_MI = 1.6;      // compare against fields within this distance…
const MIN_PEERS = 3;          // …needing at least this many same-crop peers
const ALERT_ACTIVE_DAYS = 14;

// Outer ring of a Polygon, or of the first part of a MultiPolygon (USDA fields can be multi-part).
const outer = (g) => (g.type === "MultiPolygon" ? g.coordinates[0][0] : g.coordinates[0]);

export function centroid(feature) {
  const ring = outer(feature.geometry).slice(0, -1);
  const n = ring.length;
  return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
}

export function bbox(feature) {
  const ring = feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates.flatMap((p) => p[0]) : outer(feature.geometry);
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function miles([lon1, lat1], [lon2, lat2]) {
  const R = 3958.8, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// A field is "within" an alert radius if any part of its quarter-section could be:
// centroid distance minus half the field's diagonal (~0.35 mi for 160 ac).
export function fieldsWithin(fields, center, radiusMi) {
  return fields
    .map((f) => ({ f, d: miles(center, centroid(f)) }))
    .filter(({ d }) => d - 0.35 <= radiusMi)
    .sort((a, b) => a.d - b.d);
}

export function valueAt(feature, sceneIdx, key) {
  const row = feature.properties.series.find((r) => r.date === SCENES[sceneIdx].date);
  return row ? row[key] : null;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function peers(fields, feature, sceneIdx) {
  const c = centroid(feature);
  const sameCrop = fields.filter((f) => f !== feature && f.properties.crop === feature.properties.crop
    && valueAt(f, sceneIdx, "ndvi") != null && miles(c, centroid(f)) <= NEIGHBOR_MI);
  return sameCrop.length >= MIN_PEERS ? sameCrop
    : fields.filter((f) => f !== feature && valueAt(f, sceneIdx, "ndvi") != null && miles(c, centroid(f)) <= NEIGHBOR_MI * 1.5);
}

export function neighborhoodMedian(fields, feature, sceneIdx, key) {
  const vals = peers(fields, feature, sceneIdx).map((f) => valueAt(f, sceneIdx, key)).filter((v) => v != null);
  return vals.length ? median(vals) : null;
}

export function activeAlerts(alerts, now = Date.now()) {
  return alerts.filter((a) => !a.resolved && now - new Date(a.createdAt).getTime() < ALERT_ACTIVE_DAYS * 864e5);
}

/**
 * Returns { level: ok|watch|alert|idle, headline, insights: [{level, icon, title, body}], deltas }
 * deltas[key] = difference vs same-crop neighbors: relative for NDVI/NDRE (-0.12 = 12% below),
 * absolute index points for NDMI.
 */
export function assess(fields, feature, sceneIdx, { alerts = [], sensor = null } = {}) {
  const insights = [];
  const deltas = {};
  const stage = SCENES[sceneIdx].stage;
  const crop = feature.properties.crop.toLowerCase();
  const ndviMed = neighborhoodMedian(fields, feature, sceneIdx, "ndvi");
  const canopy = ndviMed != null && ndviMed >= 0.55;

  for (const key of Object.keys(INDICES)) {
    const v = valueAt(feature, sceneIdx, key);
    const m = neighborhoodMedian(fields, feature, sceneIdx, key);
    // NDMI hovers around 0, so compare it in absolute index points; the others relatively.
    deltas[key] = v == null || m == null ? null : key === "ndmi" ? v - m : (v - m) / m;
  }

  // Community alerts that reach this field
  const c = centroid(feature);
  for (const a of activeAlerts(alerts)) {
    const d = miles(c, a.center);
    if (d - 0.35 > a.radiusMi) continue;
    const own = a.fieldId === feature.properties.id;
    const t = ALERT_TYPES[a.type] || ALERT_TYPES.pest;
    insights.push({
      level: own ? "alert" : "watch", icon: t.icon,
      title: own ? `${t.label} reported on this field` : `${t.label} ${d < 0.4 ? "next door" : `${d.toFixed(1)} mi away`}`,
      body: `${a.reporterName || "A neighbor"}${a.note ? `: “${a.note}”` : " flagged it"}. ${own ? "Neighbors have been notified." : "Scout the edge of your field nearest to it."}`,
      alertId: a.id,
    });
  }

  if (!canopy) {
    insights.push({
      level: "idle", icon: stage === "Harvest" ? "agriculture" : "grass",
      title: stage === "Harvest" ? "Harvest underway across the area" : "Canopy not closed yet",
      body: "Neighbor comparisons switch on once crops cover the ground (NDVI ≥ 0.55). Pick Jul 14 to Aug 20 on the timeline.",
    });
  } else {
    const dN = deltas.ndvi, dR = deltas.ndre, dM = deltas.ndmi;
    if (dN != null && dN <= -0.08) {
      const lvl = dN <= -0.15 ? "alert" : "watch";
      insights.push({
        level: lvl, icon: "trending_down",
        title: `Crop vigor ${Math.round(-dN * 100)}% below nearby ${crop}`,
        body: "Thin or stressed canopy compared with neighbors on the same date. Could be pests, disease, ponding, or non-crop ground (waterways, pasture). Scout to confirm.",
      });
    }
    if (dR != null && dR <= -0.08 && (dN == null || dN > dR / 2)) {
      insights.push({
        level: "watch", icon: "science",
        title: `Possible nitrogen shortfall (${Math.round(-dR * 100)}% lower chlorophyll)`,
        body: crop === "corn"
          ? "Red-edge reflectance is low for this stage. A tissue test or in-season N top-up on the weak zones can recover yield."
          : "Red-edge reflectance is low. For soybeans, check nodulation and for iron chlorosis (IDC) on high-pH spots.",
      });
    }
    if (dM != null && dM <= -0.10) {
      insights.push({
        level: "watch", icon: "water_drop",
        title: `Canopy drier than neighbors (NDMI ${dM.toFixed(2)})`,
        body: "Early sign of water stress. Check soil moisture and tile drainage outlets.",
      });
    }
    // Sudden drop between consecutive in-season scenes
    if (sceneIdx > 0) {
      const prev = valueAt(feature, sceneIdx - 1, "ndvi"), now = valueAt(feature, sceneIdx, "ndvi");
      const mPrev = neighborhoodMedian(fields, feature, sceneIdx - 1, "ndvi");
      if (prev != null && now != null && mPrev != null && mPrev >= 0.55
          && prev - now >= 0.06 && (now - prev) - (ndviMed - mPrev) <= -0.06) {
        insights.push({
          level: "watch", icon: "warning",
          title: `Dropped ${((prev - now) * 100).toFixed(0)} pts since ${SCENES[sceneIdx - 1].label}`,
          body: "Faster decline than neighbors. Sudden drops often mean hail, pests, or disease.",
        });
      }
    }
  }

  if (sensor && sensor.moisture == null && sensor.hum != null) {
    const riskAt = sensor.riskAt ?? 75;
    const risky = sensor.hum >= riskAt;
    insights.push({
      level: risky ? "watch" : "ok", icon: "humidity_percentage",
      title: `Field sensor: ${Math.round(sensor.hum)}% humidity${sensor.temp != null ? ` at ${sensor.temp.toFixed(0)} °C` : ""}${risky ? " (disease risk)" : ""}`,
      body: risky
        ? `Above ${riskAt}%. Warm, humid air lets fungal diseases like blight, mildew and tar spot spread. Scout leaves and warn neighbors.`
        : "Air humidity is below the fungal-disease risk level.",
    });
  }
  if (sensor && sensor.moisture != null) {
    const dry = sensor.moisture < 25;
    insights.push({
      level: dry ? "watch" : "ok", icon: "sensors",
      title: `Soil sensor: ${Math.round(sensor.moisture)}% moisture${dry ? " (dry)" : ""}`,
      body: dry ? "Below 25% volumetric. Consider irrigation, and warn neighbors if it's widespread." : "Soil moisture is in a healthy range.",
    });
  }

  const rank = { alert: 3, watch: 2, ok: 1, idle: 0 };
  const top = insights.reduce((m, i) => (rank[i.level] > rank[m] ? i.level : m), "ok");
  if (canopy && !insights.some((i) => i.level === "watch" || i.level === "alert")) {
    insights.unshift({ level: "ok", icon: "check_circle", title: "On par with neighbors", body: `Vigor, chlorophyll and moisture are in line with nearby ${crop} fields.` });
  }
  const level = !canopy && top === "ok" ? "idle" : top;
  const headline = { ok: "Healthy", watch: "Needs a look", alert: "Alert nearby", idle: stage }[level];
  insights.sort((a, b) => rank[b.level] - rank[a.level]);
  return { level, headline, insights, deltas };
}
