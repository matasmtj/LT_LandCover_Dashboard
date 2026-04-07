r"""
Export LUCAS_LUC land cover for Lithuania: polygon-masked rasters + CSV.
Run: conda activate landcover2
     cd C:\Users\matas\Desktop\LEI\Data
     python analysis/export_lucas_lithuania.py
"""

from pathlib import Path
import json
from shapely.geometry import shape, Point
from shapely.ops import unary_union
import numpy as np
import pandas as pd
import xarray as xr
import matplotlib
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap

BASE = Path(r"C:\Users\matas\Desktop\LEI\Data")
LT_GEOJSON = BASE / "lt_boundary_admin.json"
# Use all LUCAS_LUC NetCDFs (1950–1959, 1960–1969, …, 2010–2015)
LUCAS_PATTERN = BASE / "Lucas_Luc" / "LUC_hist_EU_afts_v1.1_1-7" / "LUCAS_LUC_v1.1_historical_Europe_0.1deg_*.nc"
OUT_RASTERS = BASE / "rasters" / "lucas"
OUT_GEOTIFF = OUT_RASTERS / "geotiff"
OUT_RASTERS.mkdir(parents=True, exist_ok=True)
OUT_GEOTIFF.mkdir(parents=True, exist_ok=True)
OUT_CSV = BASE / "outputs" / "lucas_lithuania_timeseries.csv"
OUT_CSV.parent.mkdir(parents=True, exist_ok=True)

# Lithuania polygon (GeoJSON already in EPSG:4326) – union of all admin units
with open(LT_GEOJSON, "r", encoding="utf-8") as f:
    lt_data = json.load(f)
geoms = [shape(feat["geometry"]) for feat in lt_data["features"]]
lt_geom = unary_union(geoms)

def polygon_mask(lat_vals, lon_vals, geom):
    """Mask True where grid cell centers fall inside the polygon (no rasterio)."""
    h, w = len(lat_vals), len(lon_vals)
    mask = np.zeros((h, w), dtype=bool)
    for i, lat in enumerate(lat_vals):
        for j, lon in enumerate(lon_vals):
            mask[i, j] = geom.contains(Point(lon, lat))
    return mask

LAT_MIN, LAT_MAX = 53.5, 56.6
LON_MIN, LON_MAX = 20.5, 26.7

print("Opening LUCAS LUC datasets matching:", LUCAS_PATTERN)
ds = xr.open_mfdataset(str(LUCAS_PATTERN), chunks="auto", combine="by_coords")
frac = ds["landCoverFrac"]  # (time, lctype, lat, lon)

lat_name = "lat"
lon_name = "lon"
sub = frac.sel(**{lat_name: slice(LAT_MIN, LAT_MAX), lon_name: slice(LON_MIN, LON_MAX)})

lat_vals = sub[lat_name].values
lon_vals = sub[lon_name].values
mask = polygon_mask(lat_vals, lon_vals, lt_geom)

# LUCAS LUC v1.1 lctype codes (WDCC metadata):
# 1-2: tropical trees, 3-4: temperate trees, 5-6: coniferous, 7-8: shrubs,
# 9-10: grass, 11: tundra, 12: swamp, 13: non-irrigated crops, 14: irrigated crops,
# 15: urban, 16: bare. No water class (PFT dataset).
# Use STANDARD dashboard order: 1=Water, 2=Wetland, 3=Urban, 4=Agriculture, 5=Forest
group_to_lctypes = {
    "Water": [],              # LUCAS has no water class
    "Wetland": [12],          # swamp
    "Urban": [15],
    "Agriculture": [13, 14],  # non-irrigated + irrigated crops
    "Forest": [3, 4, 5, 6],  # temperate + coniferous trees
}
group_names = list(group_to_lctypes.keys())

# Standard 5-class colors (match dashboard CORINE_COLORS)
colors = ["#4DA6FF", "#7B68EE", "#FF4D4D", "#FFD24D", "#228B22"]
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
        if codes:
            gf = layer.sel(lctype=codes).sum(dim="lctype")
        else:
            gf = 0 * layer.isel(lctype=0).drop_vars("lctype", errors="ignore")
        group_fracs.append(gf)

    stack = xr.concat(group_fracs, dim="group").assign_coords(group=np.arange(len(group_names)))
    maxfrac = stack.max(dim="group")
    dominant = stack.argmax(dim="group") + 1  # 1..5
    arr = dominant.values.astype("float32")
    arr = np.where(np.isfinite(maxfrac.values), arr, np.nan)

    arr_masked = np.where(mask, arr, np.nan)
    # LUCAS lat ascending (row 0=south). GeoTIFF expects row 0=north – flip for correct north-up
    arr_display = np.flipud(arr_masked)

    flat = arr_masked[np.isfinite(arr_masked)].astype(int)
    if flat.size:
        uniq, cnts = np.unique(flat, return_counts=True)
        for cls_id, cnt in zip(uniq, cnts, strict=False):
            cls_id = int(cls_id)
            cls_name = group_names[cls_id - 1] if 1 <= cls_id <= len(group_names) else f"class_{cls_id}"
            records.append((int(year), int(cls_id), cls_name, int(cnt)))

    rgba = cmap(norm(arr_display))
    out_path = OUT_RASTERS / f"lucas_{int(year)}.png"
    plt.imsave(out_path, rgba)
    print("Saved", out_path)

    # GeoTIFF: arr_display has row 0=north (flipud applied)
    try:
        import rasterio
        from rasterio.transform import from_bounds
        arr_for_tif = arr_display
        h, w = arr_for_tif.shape
        west, east = float(np.min(lon_vals)), float(np.max(lon_vals))
        south, north = float(np.min(lat_vals)), float(np.max(lat_vals))
        arr_uint8 = np.where(np.isfinite(arr_for_tif), arr_for_tif.astype(np.uint8), 0)
        transform = from_bounds(west, south, east, north, w, h)
        out_tif = OUT_GEOTIFF / f"lucas_{int(year)}.tif"
        with rasterio.open(
            out_tif, "w", driver="GTiff", height=h, width=w, count=1,
            dtype=arr_uint8.dtype, crs="EPSG:4326", transform=transform, nodata=0,
        ) as dst:
            dst.write(arr_uint8, 1)
        print("Saved", out_tif)
    except ImportError:
        pass

df = pd.DataFrame(records, columns=["year", "class_id", "class_name", "count"])
df.to_csv(OUT_CSV, index=False)
print("Saved CSV:", OUT_CSV)