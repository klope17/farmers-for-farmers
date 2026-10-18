"""
Drone vs. satellite resolution, same field, same NDVI color scale.

Drone: MicaSense RedEdge sample orthomosaics (https://sample.micasense.com/),
       bands 480/550/670/850 nm, reflectance scaled so 32768 = 100%.

The samples' embedded coordinates don't match the imagery (they place lush
fields in the Utah/Wyoming desert), so instead of pulling a satellite scene from
the wrong place we aggregate the drone's own NDVI into 10 m blocks, which is what
a Sentinel-2 pixel records over the same ground, and 3 m blocks (PlanetScope).

Usage: python tools/drone_compare.py <drone.tif> <name> [<drone2.tif> <name2> ...]
Writes web/img/<name>-{rgb,drone,s3,s10}.jpg and web/img/<name>.json
"""
import json
import os
import sys

import numpy as np
import rasterio
from matplotlib import colormaps
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "img")
CMAP = colormaps["RdYlGn"]
LO, HI = 0.0, 0.9    # same ramp as the map's crop-health layer
MAX_PX = 1600        # web-friendly output width/height
BG = (255, 255, 255)


def colorize(ndvi, valid):
    t = np.clip((np.nan_to_num(ndvi) - LO) / (HI - LO), 0, 1)
    rgb = (CMAP(t)[..., :3] * 255).astype(np.uint8)
    rgb[~valid] = BG
    return rgb


def block_mean(ndvi, valid, k):
    """Average NDVI over k x k pixel blocks (a coarser sensor), then expand back."""
    h, w = ndvi.shape
    H, W = -(-h // k) * k, -(-w // k) * k
    pad = np.full((H, W), np.nan, np.float32)
    pad[:h, :w] = np.where(valid, ndvi, np.nan)
    blocks = pad.reshape(H // k, k, W // k, k)
    with np.errstate(invalid="ignore"):
        cnt = np.sum(~np.isnan(blocks), axis=(1, 3))
        mean = np.nanmean(blocks, axis=(1, 3))
    mean[cnt < (k * k) * 0.5] = np.nan  # mostly outside the flight = no data
    up = np.repeat(np.repeat(mean, k, axis=0), k, axis=1)[:h, :w]
    return up, int(np.sum(cnt >= (k * k) * 0.5))


def save(arr, path):
    im = Image.fromarray(arr, "RGB")
    im.thumbnail((MAX_PX, MAX_PX), Image.NEAREST if arr.dtype == np.uint8 else Image.LANCZOS)
    im.save(path, quality=88, optimize=True)
    return im.size


def run(path, name):
    with rasterio.open(path) as r:
        b, g, red, nir = (r.read(i).astype(np.float32) / 32768.0 for i in (1, 2, 3, 4))
        res = float(r.res[0])
        w_m, h_m = r.width * r.res[0], r.height * r.res[1]
    valid = (nir > 0) & (red > 0)
    ndvi = np.where(valid, (nir - red) / np.maximum(nir + red, 1e-6), np.nan).astype(np.float32)

    os.makedirs(OUT, exist_ok=True)
    stack = np.dstack([red, g, b])
    lo, hi = np.percentile(stack[valid], [2, 98])
    rgb = (np.clip((stack - lo) / (hi - lo), 0, 1) ** 0.8 * 255).astype(np.uint8)
    rgb[~valid] = BG
    size = save(rgb, os.path.join(OUT, f"{name}-rgb.jpg"))
    save(colorize(ndvi, valid), os.path.join(OUT, f"{name}-drone.jpg"))

    tiers = {}
    for label, metres in (("s3", 3), ("s10", 10)):
        k = max(1, round(metres / res))
        coarse, n = block_mean(ndvi, valid, k)
        save(colorize(coarse, valid & ~np.isnan(coarse)), os.path.join(OUT, f"{name}-{label}.jpg"))
        tiers[label] = {"metres": metres, "pixels": n}

    meta = {
        "name": name,
        "source": "MicaSense RedEdge sample data (sample.micasense.com)",
        "cmPerPixel": round(res * 100, 1),
        "widthM": round(w_m, 1), "heightM": round(h_m, 1), "acres": round(w_m * h_m / 4046.86, 2),
        "imageSize": size,
        "dronePixels": int(valid.sum()),
        "satellite10m": tiers["s10"], "planet3m": tiers["s3"],
        "detailRatio": round((10 / res) ** 2),
        "ndvi": {"mean": round(float(np.nanmean(ndvi)), 3),
                 "p5": round(float(np.nanpercentile(ndvi, 5)), 3), "p95": round(float(np.nanpercentile(ndvi, 95)), 3)},
    }
    with open(os.path.join(OUT, f"{name}.json"), "w") as fh:
        json.dump(meta, fh, indent=2)
    print(json.dumps(meta))


if __name__ == "__main__":
    args = sys.argv[1:]
    for p, n in zip(args[::2], args[1::2]):
        run(p, n)
