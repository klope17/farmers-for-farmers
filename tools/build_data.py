"""
Builds web/data/farms.geojson for Farmers for Farmers.

- Field boundaries: quarter-sections (160 ac) on the PLSS road grid of rural
  Story County, Iowa. The road grid was located from Sentinel-2 imagery at
  zoom 14 (tile x 3940..3943, y 6074..6076).
- Index history: real Sentinel-2 L2A per-field statistics from Microsoft
  Planetary Computer (no API key required).
    NDVI = (B08-B04)/(B08+B04)   vegetation vigor
    NDRE = (B8A-B05)/(B8A+B05)   chlorophyll / nitrogen proxy
    NDMI = (B8A-B11)/(B8A+B11)   canopy water content

Farmer names and crops are fictional demo data.

Usage:  python tools/build_data.py
"""
import json
import math
import os
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "data", "farms.geojson")

PC = "https://planetarycomputer.microsoft.com/api/data/v1"
SCENES = [  # relative orbit 069 covers every field; orbit 112 clips the east side
    ("2026-05-15", "S2B_MSIL2A_20260515T165839_R069_T15TVG_20260515T210102"),
    ("2026-06-01", "S2A_MSIL2A_20260601T170711_R069_T15TVG_20260601T233915"),
    ("2026-07-14", "S2B_MSIL2A_20260714T165849_R069_T15TVG_20260714T205605"),
    ("2026-08-08", "S2C_MSIL2A_20260808T165851_R069_T15TVG_20260808T220309"),
    ("2026-08-20", "S2A_MSIL2A_20260820T170711_R069_T15TVG_20260821T045312"),
    ("2026-10-02", "S2B_MSIL2A_20261002T170129_R069_T15TVG_20261002T223354"),
]
INDICES = {
    "ndvi": "(B08-B04)/(B08+B04-2000)",
    "ndre": "(B8A-B05)/(B8A+B05-2000)",
    "ndmi": "(B8A-B11)/(B8A+B11-2000)",
}
# Processing baseline 04.00+ stores reflectance as DN + 1000, so the offset
# cancels in the numerator but must be removed (2 x 1000) from the denominator.

# Road grid in global pixel coords at z14 (detected from imagery).
Z = 14
X0, Y0 = 3940 * 256, 6074 * 256
ROAD_COLS = [28, 256, 484, 711, 938]
ROAD_ROWS = [122, 374, 604]
INSET_PX = 3  # ~21 m: keeps road ditches and fence lines out of field stats

FARMERS = [
    ("Dale & Marion Hesse", "+1 515-555-0101"),
    ("Rosa Delgado", "+1 515-555-0102"),
    ("Ruby Ho", "+1 515-555-0103"),
    ("Ruth Okafor", "+1 515-555-0104"),
    ("Hesse Family Trust", "+1 515-555-0105"),
    ("Arnie Lindqvist", "+1 515-555-0106"),
    ("Kevin Lopez", "+1 515-555-0107"),
    ("Jim & Carol Pruitt", "+1 515-555-0108"),
    ("Mai Nguyen", "+1 515-555-0109"),
    ("Brennan Acres LLC", "+1 515-555-0110"),
    ("Walt Schreiber", "+1 515-555-0111"),
    ("Grace Amundsen", "+1 515-555-0112"),
]


def px_to_lonlat(px, py):
    n = 256 * 2 ** Z
    lon = px / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * py / n))))
    return round(lon, 6), round(lat, 6)


def build_fields():
    fields = []
    for si in range(len(ROAD_COLS) - 1):
        for sj in range(len(ROAD_ROWS) - 1):
            c0, c1 = ROAD_COLS[si], ROAD_COLS[si + 1]
            r0, r1 = ROAD_ROWS[sj], ROAD_ROWS[sj + 1]
            cm, rm = (c0 + c1) / 2, (r0 + r1) / 2
            quarters = [
                ("NW", c0, cm, r0, rm), ("NE", cm, c1, r0, rm),
                ("SW", c0, cm, rm, r1), ("SE", cm, c1, rm, r1),
            ]
            for q, a, b, c, d in quarters:
                a, b, c, d = a + INSET_PX, b - INSET_PX, c + INSET_PX, d - INSET_PX
                ring = [px_to_lonlat(X0 + x, Y0 + y) for x, y in
                        [(a, c), (b, c), (b, d), (a, d), (a, c)]]
                fields.append({"section": si * 2 + sj, "quarter": q, "ring": ring})
    return fields


def acres(ring):
    lat0 = math.radians(sum(p[1] for p in ring) / len(ring))
    kx, ky = 111320 * math.cos(lat0), 110574
    s = 0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        s += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky)
    return round(abs(s) / 2 / 4046.86)


def stats(item, ring):
    expr = ";".join(INDICES.values())
    qs = urllib.parse.urlencode({
        "collection": "sentinel-2-l2a", "item": item,
        "expression": expr, "asset_as_band": "true",
    })
    body = json.dumps({"type": "Feature", "properties": {},
                       "geometry": {"type": "Polygon", "coordinates": [ring]}}).encode()
    req = urllib.request.Request(f"{PC}/item/statistics?{qs}", data=body,
                                 headers={"Content-Type": "application/json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                s = json.load(r)["properties"]["statistics"]
            vals = list(s.values())
            if any(v["count"] < 1000 or v["std"] == 0 for v in vals):
                return None  # field outside the scene footprint
            return {key: {"mean": round(v["mean"], 3), "std": round(v["std"], 3)}
                    for key, v in zip(INDICES, vals)}
        except Exception as e:  # noqa: BLE001 - retry transient API errors
            err = e
    raise RuntimeError(f"stats failed for {item}: {err}")


def main():
    fields = build_fields()
    jobs = [(fi, date, item) for fi in range(len(fields)) for date, item in SCENES]
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda j: (j, stats(j[2], fields[j[0]]["ring"])), jobs))

    series = {}
    for (fi, date, _), s in results:
        if s is None:
            continue
        series.setdefault(fi, []).append({"date": date, **{k: s[k]["mean"] for k in INDICES},
                                          "ndviStd": s["ndvi"]["std"]})

    # Assign owners: neighbouring quarters tend to share an owner.
    owner_of = [0, 0, 1, 1, 2, 3, 2, 3, 4, 4, 5, 5, 6, 6, 7, 7,
                8, 9, 8, 9, 10, 10, 11, 11, 1, 2, 3, 4, 6, 8, 10, 11]
    features = []
    for fi, f in enumerate(fields):
        fid = f"F{fi + 1:02d}"
        name, phone = FARMERS[owner_of[fi]]
        crop = "Corn" if (f["section"] + "NW NE SW SE".split().index(f["quarter"])) % 2 == 0 else "Soybeans"
        features.append({
            "type": "Feature",
            "id": fi + 1,
            "properties": {
                "id": fid,
                "name": f"{f['quarter']} ¼ · Sec. {f['section'] + 1}",
                "farmer": name,
                "farmerId": f"U{owner_of[fi] + 1:02d}",
                "phone": phone,
                "crop": crop,
                "acres": acres(f["ring"]),
                "series": sorted(series[fi], key=lambda r: r["date"]),
            },
            "geometry": {"type": "Polygon", "coordinates": [f["ring"]]},
        })

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection",
                   "metadata": {"source": "Sentinel-2 L2A via Microsoft Planetary Computer",
                                "scenes": [{"date": d, "item": i} for d, i in SCENES],
                                "indices": INDICES},
                   "features": features}, fh, ensure_ascii=False)
    print(f"wrote {len(features)} fields -> {OUT}")


if __name__ == "__main__":
    main()
