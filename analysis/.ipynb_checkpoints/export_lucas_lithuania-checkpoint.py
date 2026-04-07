"""
Export LUCAS_LUC land cover for Lithuania: polygon-masked rasters + CSV.
Run: conda activate landcover2
     cd C:\Users\matas\Desktop\LEI\Data
     python analysis/export_lucas_lithuania.py
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
LUCAS_NC = BASE / "Lucas_Luc" / "LUC_hist_EU_afts_v1.1_1-7" / "LUCAS_LUC_v1.1_historical_Europe_0.1deg_2000_2009.nc"
OUT_RASTERS = BASE / "rasters" / "lucas"
OUT_RASTERS.mkdir(parents=True, exist_ok=True)
OUT_CSV = BASE / "outputs" / "lucas_lithuania_timeseries.csv"
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

print("Opening LUCAS LUC dataset:", LUCAS_NC)
ds = xr.open_dataset(LUCAS_NC, chunks="auto")
frac = ds["landCoverFrac"]  # (time, lctype, lat, lon)

lat_name = "lat"
lon_name = "lon"
sub = frac.sel(**{lat_name: slice(LAT_MIN, LAT_MAX), lon_name: slice(LON_MIN, LON_MAX)})

lat_vals = sub[lat_name].values
lon_vals = sub[lon_name].values
mask = polygon_mask(lat_vals, lon_vals, lt_geom)

# Group mapping (from your stub)
lc_water = 1
lc_urban = 13
lc_forest = 16
lc_agri = 13
lc_wet = 13

group_to_lctypes = {
    "Agriculture": [lc_agri],
    "Forest": [lc_forest],
    "Water": [lc_water],
    "Urban": [lc_urban],
    "Wetland": [lc_wet],
}
group_names = list(group_to_lctypes.keys())

colors = ["#FFD24D", "#228B22", "#4DA6FF", "#FF4D4D", "#7B68EE"]
cmap = ListedColormap(colors)
cmap.set_bad((0, 0, 0, 0))
norm = matplotlib.colors.Normalize(vmin=1, vmax=len(group_names))

# Extract integer years from time (strings) 2000–2009
time_vals = frac["time"].values
years_all = pd.to_datetime(time_vals).year.astype(int)
years = np.unique(years_all)
print("Exporting LUCAS years:", years)

records = []
for year in years:
    layer = sub.sel(time=str(year), method="nearest")  # (lctype, lat, lon)

    group_fracs = []
    for name in group_names:
        codes = group_to_lctypes[name]
        gf = layer.sel(lctype=codes).sum(dim="lctype")
        group_fracs.append(gf)

    stack = xr.concat(group_fracs, dim="group").assign_coords(group=np.arange(len(group_names)))
    maxfrac = stack.max(dim="group")
    dominant = stack.argmax(dim="group") + 1  # 1..5
    arr = dominant.values.astype("float32")
    arr = np.where(np.isfinite(maxfrac.values), arr, np.nan)

    arr_masked = np.where(mask, arr, np.nan)

    flat = arr_masked[np.isfinite(arr_masked)].astype(int)
    if flat.size:
        uniq, cnts = np.unique(flat, return_counts=True)
        for cls_id, cnt in zip(uniq, cnts, strict=False):
            cls_id = int(cls_id)
            cls_name = group_names[cls_id - 1] if 1 <= cls_id <= len(group_names) else f"class_{cls_id}"
            records.append((int(year), int(cls_id), cls_name, int(cnt)))

    rgba = cmap(norm(arr_masked))
    out_path = OUT_RASTERS / f"lucas_{int(year)}.png"
    plt.imsave(out_path, rgba)
    print("Saved", out_path)

df = pd.DataFrame(records, columns=["year", "class_id", "class_name", "count"])
df.to_csv(OUT_CSV, index=False)
print("Saved CSV:", OUT_CSV)