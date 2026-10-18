// Nationwide mode: any field in the continental US.
//  - Field outlines + crop history: USDA NASS Crop Sequence Boundaries (2015–2022)
//  - Imagery: Sentinel-2 L2A mosaics per timeline window (Planetary Computer)
//  - Place search: OpenStreetMap Nominatim
import { PC, SCENES, INDICES } from "./config.js";

const CSB_URL = "https://pdi.scinet.usda.gov/hosting/rest/services/Hosted/Crop_Sequence_Boundary_2022/FeatureServer/0/query";
const WINDOW_DAYS = 12;
export const CSB_YEARS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022];

// USDA Cropland Data Layer codes (most common US crops)
export const CDL = {
  1: "Corn", 2: "Cotton", 3: "Rice", 4: "Sorghum", 5: "Soybeans", 6: "Sunflower", 10: "Peanuts", 11: "Tobacco",
  12: "Sweet corn", 13: "Popcorn", 21: "Barley", 22: "Durum wheat", 23: "Spring wheat", 24: "Winter wheat",
  25: "Other small grains", 26: "Winter wheat / soybeans", 27: "Rye", 28: "Oats", 29: "Millet", 31: "Canola",
  32: "Flaxseed", 33: "Safflower", 36: "Alfalfa", 37: "Other hay", 41: "Sugarbeets", 42: "Dry beans", 43: "Potatoes",
  44: "Other crops", 45: "Sugarcane", 46: "Sweet potatoes", 47: "Misc. vegetables", 48: "Watermelons", 49: "Onions",
  52: "Lentils", 53: "Peas", 54: "Tomatoes", 57: "Herbs", 58: "Clover", 59: "Sod/grass seed", 61: "Fallow",
  66: "Cherries", 67: "Peaches", 68: "Apples", 69: "Grapes", 71: "Other tree crops", 72: "Citrus", 74: "Pecans",
  75: "Almonds", 76: "Walnuts", 77: "Pears", 176: "Grass/pasture", 204: "Pistachios", 205: "Triticale",
  206: "Carrots", 207: "Asparagus", 208: "Garlic", 209: "Cantaloupes", 211: "Olives", 212: "Oranges",
  213: "Honeydew", 214: "Broccoli", 216: "Peppers", 217: "Pomegranates", 220: "Plums", 221: "Strawberries",
  222: "Squash", 225: "Winter wheat / corn", 226: "Oats / corn", 227: "Lettuce", 236: "Winter wheat / sorghum",
  237: "Barley / corn", 238: "Winter wheat / cotton", 242: "Blueberries", 243: "Cabbage", 246: "Radishes",
  14: "Mint", 35: "Mustard", 50: "Cucumbers", 51: "Chickpeas", 55: "Caneberries", 56: "Hops", 60: "Switchgrass",
  70: "Christmas trees", 210: "Prunes", 215: "Avocados", 218: "Nectarines", 219: "Greens", 223: "Apricots",
  224: "Vetch", 229: "Pumpkins", 241: "Corn / soybeans", 254: "Barley / soybeans",
  // Non-crop land cover that USDA sometimes records inside a field boundary
  111: "Open water", 121: "Developed (open space)", 122: "Developed (buildings)", 123: "Developed (buildings)",
  124: "Developed (dense)", 131: "Barren", 141: "Deciduous forest", 142: "Evergreen forest", 143: "Mixed forest",
  152: "Shrubland", 190: "Woody wetland", 195: "Wetland",
};
export const cropName = (code) => CDL[code] || (code ? `Crop type ${code}` : "Unknown");

const STATES = { "01": "AL", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", 10: "DE", 12: "FL", 13: "GA", 16: "ID", 17: "IL", 18: "IN", 19: "IA", 20: "KS", 21: "KY", 22: "LA", 23: "ME", 24: "MD", 25: "MA", 26: "MI", 27: "MN", 28: "MS", 29: "MO", 30: "MT", 31: "NE", 32: "NV", 33: "NH", 34: "NJ", 35: "NM", 36: "NY", 37: "NC", 38: "ND", 39: "OH", 40: "OK", 41: "OR", 42: "PA", 44: "RI", 45: "SC", 46: "SD", 47: "TN", 48: "TX", 49: "UT", 50: "VT", 51: "VA", 53: "WA", 54: "WV", 55: "WI", 56: "WY" };
export const stateAbbr = (fips) => STATES[fips] || STATES[String(+fips)] || fips;

/* ---------------------------------------------------------------- USDA field boundaries */
export async function fetchFields([w, s, e, n], signal) {
  const q = new URLSearchParams({
    where: "1=1", geometry: [w, s, e, n].map((v) => v.toFixed(5)).join(","), geometryType: "esriGeometryEnvelope",
    inSR: "4326", spatialRel: "esriSpatialRelIntersects", outSR: "4326", f: "geojson",
    outFields: ["csbid", "csbacres", "cnty", "statefips", ...CSB_YEARS.map((y) => `r${String(y).slice(2)}`)].join(","),
    resultRecordCount: "2000", geometryPrecision: "6", maxAllowableOffset: "0.00002",
  });
  const res = await fetch(`${CSB_URL}?${q}`, { signal });
  if (!res.ok) throw new Error(`USDA field service ${res.status}`);
  const fc = await res.json();
  for (const f of fc.features || []) {
    const p = f.properties;
    p.history = CSB_YEARS.map((y) => ({ year: y, code: p[`r${String(y).slice(2)}`] }));
    p.cropCode = predictCrop(p.history);
    p.crop = cropName(p.cropCode);
    p.id = `US-${p.csbid}`;
  }
  return fc.features || [];
}

// Best guess for 2026. A yearly corn/soy rotation is back on the 2022 crop after an even
// number of years, and other fields mostly repeat, so the 2022 crop is the estimate either way.
export function predictCrop(history) {
  return history.at(-1)?.code;
}

export function rotationText(history) {
  const codes = history.map((h) => h.code);
  const uniq = [...new Set(codes)];
  if (uniq.length === 1) return `${cropName(uniq[0])} every year since 2015`;
  const alt = codes.every((c, i) => i < 2 || c === codes[i - 2]) && codes[0] !== codes[1];
  if (alt) return `${cropName(codes[0])} ↔ ${cropName(codes[1])} rotation`;
  return `${uniq.length} different crops since 2015`;
}

/* ---------------------------------------------------------------- Sentinel-2 mosaics */
function windowFor(sceneIdx, days = WINDOW_DAYS) {
  const d = Date.parse(SCENES[sceneIdx].date);
  const iso = (t) => new Date(t).toISOString().slice(0, 19) + "Z";
  return [iso(d - days * 864e5), iso(Math.min(Date.now(), d + days * 864e5))];
}

const mosaicCache = new Map();
async function registerMosaic(sceneIdx) {
  const [a, b] = windowFor(sceneIdx, 20);
  const body = JSON.stringify({
    "filter-lang": "cql2-json",
    filter: { op: "and", args: [
      { op: "=", args: [{ property: "collection" }, "sentinel-2-l2a"] },
      { op: "anyinteracts", args: [{ property: "datetime" }, { interval: [a, b] }] },
      { op: "<=", args: [{ property: "eo:cloud_cover" }, 50] },
    ] },
    sortby: [{ field: "eo:cloud_cover", direction: "asc" }],
  });
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${PC}/mosaic/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (!res.ok) throw new Error(`register ${res.status}`);
      const { searchid } = await res.json();
      if (!searchid) throw new Error("register returned no searchid");
      return searchid;
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); // transient 429/5xx
    }
  }
}
export function mosaicId(sceneIdx) {
  if (!mosaicCache.has(sceneIdx)) {
    mosaicCache.set(sceneIdx, registerMosaic(sceneIdx).catch((e) => { mosaicCache.delete(sceneIdx); throw e; }));
  }
  return mosaicCache.get(sceneIdx);
}

export function mosaicTileUrl(searchid, indexKey) {
  const q = new URLSearchParams({ collection: "sentinel-2-l2a" });
  if (indexKey === "none") {
    q.set("assets", "visual"); q.set("asset_bidx", "visual|1,2,3");
  } else {
    const ix = INDICES[indexKey];
    q.set("expression", ix.expr); q.set("asset_as_band", "true");
    q.set("rescale", ix.range.join(",")); q.set("colormap_name", ix.cmap); q.set("nodata", "0");
  }
  return `${PC}/mosaic/${searchid}/tiles/WebMercatorQuad/{z}/{x}/{y}@1x.png?${q}`;
}

/* ---------------------------------------------------------------- per-field live measurement */
const itemCache = new Map();
// Clearest pass near the timeline date: ±12 days under 20% cloud, widening to ±30 days / 50%.
export function sceneFor(sceneIdx, [w, s, e, n]) {
  const key = `${sceneIdx}:${w.toFixed(2)},${s.toFixed(2)}`;
  if (!itemCache.has(key)) {
    const search = (days, cloud) => {
      const [a, b] = windowFor(sceneIdx, days);
      return fetch("https://planetarycomputer.microsoft.com/api/stac/v1/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collections: ["sentinel-2-l2a"], bbox: [w, s, e, n], datetime: `${a}/${b}`,
          query: { "eo:cloud_cover": { lt: cloud } }, sortby: [{ field: "eo:cloud_cover", direction: "asc" }], limit: 1,
        }),
      }).then((r) => r.json()).then((j) => j.features?.[0]);
    };
    itemCache.set(key, (async () => {
      const f = (await search(WINDOW_DAYS, 20)) || (await search(30, 50));
      return f ? { id: f.id, date: f.properties.datetime.slice(0, 10), cloud: Math.round(f.properties["eo:cloud_cover"]) } : null;
    })().catch((e) => { itemCache.delete(key); throw e; }));
  }
  return itemCache.get(key);
}

export async function measure(itemId, geometry) {
  const q = new URLSearchParams({
    collection: "sentinel-2-l2a", item: itemId, asset_as_band: "true",
    expression: Object.values(INDICES).map((i) => i.expr).join(";"),
  });
  const res = await fetch(`${PC}/item/statistics?${q}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "Feature", properties: {}, geometry }),
  });
  if (!res.ok) throw new Error(`statistics ${res.status}`);
  const stats = Object.values((await res.json()).properties.statistics);
  if (!stats[0] || stats[0].count < 20) return null;
  return Object.fromEntries(Object.keys(INDICES).map((k, i) => [k, +stats[i].mean.toFixed(3)]));
}

/* ---------------------------------------------------------------- place search */
export async function geocode(q, signal) {
  const params = new URLSearchParams({ format: "jsonv2", q, countrycodes: "us", limit: "5" });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { signal, headers: { "Accept-Language": "en" } });
  if (!res.ok) return [];
  return (await res.json()).map((r) => ({
    name: r.display_name, bbox: [+r.boundingbox[2], +r.boundingbox[0], +r.boundingbox[3], +r.boundingbox[1]], type: r.type,
  }));
}
