"""
Export LUH2 v2h land cover for Lithuania: polygon-masked stats + rasters + CSV.
Run: python export_luh2_lithuania.py
Or copy the cell contents into a Jupyter notebook.
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
LUH2_STATES = BASE / "LUH2" / "3_LUH2 v2h" / "Base" / "states.nc"
OUT_RASTERS = BASE / "rasters" / "luh2"
OUT_GEOTIFF = OUT_RASTERS / "geotiff"
OUT_RASTERS.mkdir(parents=True, exist_ok=True)
OUT_GEOTIFF.mkdir(parents=True, exist_ok=True)
OUT_CSV = BASE / "outputs" / "luh2_lithuania_timeseries.csv"
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

def normalize_lon(ds):
    lon_name = "lon" if "lon" in ds.coords else "longitude"
    lon = ds[lon_name]
    if float(lon.max()) > 180:
        ds = ds.assign_coords({lon_name: (((lon + 180) % 360) - 180)})
        ds = ds.sortby(lon_name)
    return ds

LAT_MIN, LAT_MAX = 53.5, 56.6
LON_MIN, LON_MAX = 20.5, 26.7

print("Loading LUH2 states.nc...")
ds = xr.open_dataset(LUH2_STATES, chunks="auto", decode_times=False)
ds = normalize_lon(ds)

lat_name = "lat" if "lat" in ds.coords else "latitude"
lon_name = "lon" if "lon" in ds.coords else "longitude"

# Subset to Lithuania bbox
lats = ds[lat_name].values
lat_slice = slice(LAT_MAX, LAT_MIN) if (len(lats) > 1 and lats[0] > lats[-1]) else slice(LAT_MIN, LAT_MAX)
sub = ds.sel(**{lat_name: lat_slice, lon_name: slice(LON_MIN, LON_MAX)})

lat_vals = sub[lat_name].values
lon_vals = sub[lon_name].values
mask = polygon_mask(lat_vals, lon_vals, lt_geom)

# LUH2 state vars
def v(name):
    return sub[name] if name in sub.data_vars else (sub[list(sub.data_vars)[0]] * 0)

# Get years from time
time_vals = sub["time"].values
# LUH2: "years since 850-01-01" or similar
units = sub["time"].attrs.get("units", "")
if "850" in units:
    base_year = 850
elif "1" in units:
    base_year = 1
else:
    base_year = 0
years = (np.array(time_vals, dtype=float) + base_year).astype(int)
years = np.unique(years)
years = years[(years >= 1900) & (years <= 2020)]

print("Exporting LUH2 years:", list(years[:10]), "...", list(years[-5:]))

class_names = {1: "Water", 2: "Wetland", 3: "Urban", 4: "Agriculture", 5: "Forest"}
colors = ["#4DA6FF", "#7B68EE", "#FF4D4D", "#FFD24D", "#228B22"]
cmap = ListedColormap(colors)
cmap.set_bad((0, 0, 0, 0))
norm = matplotlib.colors.Normalize(vmin=1, vmax=5)

records = []
for year in years:
    # Map calendar year to time index (time = years since base_year)
    idx = int(year - base_year)
    if idx < 0 or idx >= len(sub["time"]):
        continue

    forest = v("primf").isel(time=idx) + v("secdf").isel(time=idx)
    crops = v("c3ann").isel(time=idx) + v("c3per").isel(time=idx) + v("c4ann").isel(time=idx) + v("c4per").isel(time=idx) + v("c3nfx").isel(time=idx)
    grazing = v("pastr").isel(time=idx) + v("range").isel(time=idx)
    agriculture = crops + grazing
    urban = v("urban").isel(time=idx)
    # LUH2: primn+secdn = primary/secondary non-forest (grassland, shrub, peatland).
    # Peatlands (durpynai) are NOT wetlands (pelkės) – map to Forest/natural vegetation.
    water = forest * 0
    wetland = forest * 0  # LUH2 has no true wetland; avoid overcounting
    forest = forest + v("primn").isel(time=idx) + v("secdn").isel(time=idx)

    stack = xr.concat([water, wetland, urban, agriculture, forest], dim="c")
    # Compute dominant class across classes (c axis), not spatial axes
    with np.errstate(all="ignore"):
        vals = stack.values  # shape (c, lat, lon)
        vals_safe = np.where(np.isfinite(vals), vals, -np.inf)
        dom = np.argmax(vals_safe, axis=0) + 1  # now shape (lat, lon), values 1..5
        mask_valid = np.isfinite(vals).any(axis=0)
        arr = np.where(mask_valid, dom.astype("float32"), np.nan)
    arr_masked = np.where(mask, arr, np.nan)
    # LUH2 lat is descending (row 0 = north), so no flip needed for Leaflet

    flat = arr_masked[np.isfinite(arr_masked)].astype(int)
    if flat.size:
        uniq, cnts = np.unique(flat, return_counts=True)
        for cls_id, cnt in zip(uniq, cnts, strict=False):
            records.append((int(year), int(cls_id), class_names[int(cls_id)], int(cnt)))

    rgba = cmap(norm(arr_masked))
    plt.imsave(OUT_RASTERS / f"luh2_{int(year)}.png", rgba)

    # GeoTIFF for zoomable web display (LUH2 lat descending, row 0=north)
    try:
        import rasterio
        from rasterio.transform import from_bounds
        h, w = arr_masked.shape
        west, east = float(np.min(lon_vals)), float(np.max(lon_vals))
        south, north = float(np.min(lat_vals)), float(np.max(lat_vals))
        arr_uint8 = np.where(np.isfinite(arr_masked), arr_masked.astype(np.uint8), 0)
        transform = from_bounds(west, south, east, north, w, h)
        out_tif = OUT_GEOTIFF / f"luh2_{int(year)}.tif"
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
