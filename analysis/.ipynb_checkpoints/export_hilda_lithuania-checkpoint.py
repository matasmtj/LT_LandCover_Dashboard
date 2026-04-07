"""
Export HILDA+ land cover for Lithuania: polygon-masked rasters + CSV.
Run: conda activate landcover2
     cd C:\Users\matas\Desktop\LEI\Data
     python analysis/export_hilda_lithuania.py
"""

from pathlib import Path
import json
from shapely.geometry import shape
import numpy as np
import pandas as pd
import xarray as xr
import rasterio.features
import rasterio.transform
import matplotlib
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap

BASE = Path(r"C:\Users\matas\Desktop\LEI\Data")
LT_GEOJSON = BASE / "lt_boundary_admin.json"
HILDA_NC = BASE / "Hilda" / "Version 2.0" / "Winkler-etal_2025_allfiles" / "hildap_vGLOB-2.0_netCDF_extended-time" / "hildaplus_GLOB-2-0_states.nc"
OUT_RASTERS = BASE / "rasters" / "hilda"
OUT_RASTERS.mkdir(parents=True, exist_ok=True)
OUT_CSV = BASE / "outputs" / "hilda_lithuania_timeseries.csv"
OUT_CSV.parent.mkdir(parents=True, exist_ok=True)

# Lithuania polygon (GeoJSON already in EPSG:4326)
with open(LT_GEOJSON, "r", encoding="utf-8") as f:
    lt_data = json.load(f)
lt_geom = shape(lt_data["features"][0]["geometry"])

def polygon_mask(lat_vals, lon_vals, geom):
    h, w = len(lat_vals), len(lon_vals)
    transform = rasterio.transform.from_bounds(
        float(np.min(lon_vals)), float(np.min(lat_vals)),
        float(np.max(lon_vals)), float(np.max(lat_vals)),
        w, h,
    )
    return rasterio.features.geometry_mask(
        [geom], out_shape=(h, w), transform=transform, invert=True, all_touched=False
    )

LAT_MIN, LAT_MAX = 53.5, 56.6
LON_MIN, LON_MAX = 20.5, 26.7

print("Opening HILDA dataset:", HILDA_NC)
ds = xr.open_dataset(HILDA_NC, chunks="auto")
da = ds["LULC_states"]  # (time, latitude, longitude)

# Subset roughly to Lithuania box (HILDA lat likely descending)
lat_name = "latitude"
lon_name = "longitude"
lats = da[lat_name].values
lat_slice = slice(LAT_MAX, LAT_MIN) if (len(lats) > 1 and lats[0] > lats[-1]) else slice(LAT_MIN, LAT_MAX)
da_lt = da.sel(**{lat_name: lat_slice, lon_name: slice(LON_MIN, LON_MAX)})

lat_vals = da_lt[lat_name].values
lon_vals = da_lt[lon_name].values
mask = polygon_mask(lat_vals, lon_vals, lt_geom)

# HILDA+ v2.0 LULC_states (Readme.md): 40–45 forest; 77 water; 22–24+33 agriculture.
groups = {
    "Water": [0, 77],
    "Urban": [11],
    "Agriculture": [22, 23, 24, 33],
    "Forest": [40, 41, 42, 43, 44, 45, 55],
}

five_map = {}
for c in groups["Water"]:
    five_map[c] = 1
for c in groups["Urban"]:
    five_map[c] = 3
for c in groups["Agriculture"]:
    five_map[c] = 4
for c in groups["Forest"]:
    five_map[c] = 5

class_names = {1: "Water", 2: "Wetlands", 3: "Urban", 4: "Agriculture", 5: "Forest"}
colors = ["#4DA6FF", "#7B68EE", "#FF4D4D", "#FFD24D", "#228B22"]
cmap = ListedColormap(colors)
cmap.set_bad((0, 0, 0, 0))
norm = matplotlib.colors.Normalize(vmin=1, vmax=5)

def reclass_to_five(layer):
    data = layer.values
    out = np.full_like(data, fill_value=np.nan, dtype="float32")
    for orig, unified in five_map.items():
        mask_codes = data == orig
        out[mask_codes] = unified
    return out  # plain ndarray

time_vals = da_lt["time"].values
year_to_ti = {}
for ti, t_val in enumerate(time_vals):
    y = int(round(float(t_val)))
    if 1910 <= y <= 2020:
        year_to_ti[y] = ti
years_export = np.array(sorted(year_to_ti.keys()), dtype=int)
print("Exporting HILDA years:", years_export[:10], "...", years_export[-5:])

records = []
for year in years_export:
    layer = da_lt.isel(time=year_to_ti[int(year)])
    arr = reclass_to_five(layer)
    arr_masked = np.where(mask, arr, np.nan)

    flat = arr_masked[np.isfinite(arr_masked)].astype(int)
    if flat.size:
        uniq, cnts = np.unique(flat, return_counts=True)
        for cls_id, cnt in zip(uniq, cnts, strict=False):
            records.append((int(year), int(cls_id), class_names.get(int(cls_id), f"class_{cls_id}"), int(cnt)))

    rgba = cmap(norm(arr_masked))
    out_path = OUT_RASTERS / f"hilda_{int(year)}.png"
    plt.imsave(out_path, rgba)
    print("Saved", out_path)

df = pd.DataFrame(records, columns=["year", "class_id", "class_name", "count"])
df.to_csv(OUT_CSV, index=False)
print("Saved CSV:", OUT_CSV)