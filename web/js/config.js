// Shared configuration for the map and the texting agent.

export const PC = "https://planetarycomputer.microsoft.com/api/data/v1";

// Sentinel-2 L2A scenes (relative orbit 069, tile 15TVG) used for the field history.
export const SCENES = [
  { date: "2026-05-15", label: "May 15", stage: "Planting", item: "S2B_MSIL2A_20260515T165839_R069_T15TVG_20260515T210102" },
  { date: "2026-06-01", label: "Jun 1", stage: "Emergence", item: "S2A_MSIL2A_20260601T170711_R069_T15TVG_20260601T233915" },
  { date: "2026-07-14", label: "Jul 14", stage: "Canopy", item: "S2B_MSIL2A_20260714T165849_R069_T15TVG_20260714T205605" },
  { date: "2026-08-08", label: "Aug 8", stage: "Peak", item: "S2C_MSIL2A_20260808T165851_R069_T15TVG_20260808T220309" },
  { date: "2026-08-20", label: "Aug 20", stage: "Grain fill", item: "S2A_MSIL2A_20260820T170711_R069_T15TVG_20260821T045312" },
  { date: "2026-10-02", label: "Oct 2", stage: "Harvest", item: "S2B_MSIL2A_20261002T170129_R069_T15TVG_20261002T223354" },
];
export const DEFAULT_SCENE = 3;

// Reflectance is stored as DN + 1000 (processing baseline 04.00+), hence the -2000.
export const INDICES = {
  ndvi: {
    key: "ndvi", name: "Crop health", short: "NDVI", icon: "eco",
    expr: "(B08-B04)/(B08+B04-2000)", range: [0, 0.9], cmap: "rdylgn",
    stops: ["#a50026", "#d73027", "#f46d43", "#fdae61", "#fee08b", "#ffffbf", "#d9ef8b", "#a6d96a", "#66bd63", "#1a9850", "#006837"],
    lo: "Bare / stressed", hi: "Dense, healthy",
    explain: "Normalized Difference Vegetation Index: how much healthy green canopy is there.",
  },
  ndre: {
    key: "ndre", name: "Nitrogen", short: "NDRE", icon: "science",
    expr: "(B8A-B05)/(B8A+B05-2000)", range: [0, 0.8], cmap: "rdylgn",
    stops: ["#a50026", "#d73027", "#f46d43", "#fdae61", "#fee08b", "#ffffbf", "#d9ef8b", "#a6d96a", "#66bd63", "#1a9850", "#006837"],
    lo: "Low chlorophyll", hi: "High chlorophyll",
    explain: "Normalized Difference Red Edge: tracks leaf chlorophyll, a proxy for nitrogen status in a full canopy.",
  },
  ndmi: {
    key: "ndmi", name: "Moisture", short: "NDMI", icon: "water_drop",
    expr: "(B8A-B11)/(B8A+B11-2000)", range: [-0.4, 0.5], cmap: "brbg",
    stops: ["#543005", "#8c510a", "#bf812d", "#dfc27d", "#f6e8c3", "#f5f5f5", "#c7eae5", "#80cdc1", "#35978f", "#01665e", "#003c30"],
    lo: "Dry canopy / soil", hi: "Well watered",
    explain: "Normalized Difference Moisture Index: water content in the crop canopy.",
  },
};

export const ALERT_TYPES = {
  pest: { label: "Pest outbreak", icon: "pest_control", verb: "pests" },
  disease: { label: "Crop disease", icon: "coronavirus", verb: "disease" },
  drought: { label: "Drought stress", icon: "wb_sunny", verb: "drought stress" },
  nutrient: { label: "Nutrient deficiency", icon: "science", verb: "a nutrient deficiency" },
  flood: { label: "Flooding", icon: "flood", verb: "flooding" },
};

export const HOME = { center: [-93.378, 42.098], zoom: 13.2 };
export const AOI_BOUNDS = [-93.6, 41.95, -93.15, 42.25];

export function indexTileUrl(sceneIdx, indexKey) {
  const s = SCENES[sceneIdx];
  const ix = INDICES[indexKey];
  const q = new URLSearchParams({
    collection: "sentinel-2-l2a", item: s.item, expression: ix.expr, asset_as_band: "true",
    rescale: ix.range.join(","), colormap_name: ix.cmap, nodata: "0",
  });
  return `${PC}/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x.png?${q}`;
}

export function trueColorTileUrl(sceneIdx) {
  const q = new URLSearchParams({ collection: "sentinel-2-l2a", item: SCENES[sceneIdx].item, assets: "visual", asset_bidx: "visual|1,2,3" });
  return `${PC}/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x.png?${q}`;
}

export function fieldImageUrl(sceneIdx, bbox, indexKey = null, size = [816, 320], itemId = SCENES[sceneIdx].item) {
  const q = new URLSearchParams({ collection: "sentinel-2-l2a", item: itemId });
  if (indexKey) {
    const ix = INDICES[indexKey];
    q.set("expression", ix.expr); q.set("asset_as_band", "true");
    q.set("rescale", ix.range.join(",")); q.set("colormap_name", ix.cmap);
  } else {
    q.set("assets", "visual"); q.set("asset_bidx", "visual|1,2,3");
  }
  const b = bbox.map((v) => v.toFixed(5)).join(",");
  return `${PC}/item/bbox/${b}/${size[0]}x${size[1]}.png?${q}`;
}

// Live per-field statistics straight from Sentinel-2 (CORS-enabled, no key).
export async function measureField(sceneIdx, geometry) {
  const s = SCENES[sceneIdx];
  const q = new URLSearchParams({
    collection: "sentinel-2-l2a", item: s.item, asset_as_band: "true",
    expression: Object.values(INDICES).map((i) => i.expr).join(";"),
  });
  const res = await fetch(`${PC}/item/statistics?${q}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "Feature", properties: {}, geometry }),
  });
  if (!res.ok) throw new Error(`Sentinel-2 statistics failed (${res.status})`);
  const stats = Object.values((await res.json()).properties.statistics);
  const keys = Object.keys(INDICES);
  return Object.fromEntries(keys.map((k, i) => [k, +stats[i].mean.toFixed(3)]));
}

export function colorFor(indexKey, v) {
  const ix = INDICES[indexKey];
  const t = Math.max(0, Math.min(1, (v - ix.range[0]) / (ix.range[1] - ix.range[0])));
  const stops = ix.stops;
  const p = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(p));
  const f = p - i;
  const a = hex(stops[i]), b = hex(stops[i + 1]);
  const c = a.map((x, j) => Math.round(x + (b[j] - x) * f));
  return `rgb(${c.join(",")})`;
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
