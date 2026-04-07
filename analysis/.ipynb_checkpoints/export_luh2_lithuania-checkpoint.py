"""
Export LUH2 v2h land cover for Lithuania: polygon-masked stats + rasters + CSV.
Run: python export_luh2_lithuania.py
Or copy the cell contents into a Jupyter notebook.
"""

from pathlib import Path
import numpy as np
import pandas as pd
import geopandas as gpd
import xarray as xr
import rasterio.features
import rasterio.transform
import matplotlib
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap

BASE = Path(r"C:\Users\matas\Desktop\LEI\Data")
LT_GEOJSON = BASE / "lt_boundary_admin.json"
LUH2_STATES = BASE / "LUH2" / "3_LUH2 v2h" / "Base" / "states.nc"
OUT_RASTERS = BASE / "rasters" / "luh2"
OUT_RASTERS.mkdir(parents=True, exist_ok=True)
OUT_CSV = BASE / "outputs" / "luh2_lithuania_timeseries.csv"
OUT_CSV.parent.mkdir(parents=True, exist_ok=True)

# Lithuania polygon
lt = gpd.read_file(LT_GEOJSON).to_crs("EPSG:4326")
lt_geom = lt.unary_union

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
years_to_export = years[years % 10 == 0]
if len(years_to_export) == 0:
    years_to_export = years

print("Exporting LUH2 years:", list(years_to_export[:10]), "...", list(years_to_export[-5:]))

class_names = {1: "Water", 2: "Wetland", 3: "Urban", 4: "Agriculture", 5: "Forest"}
colors = ["#4DA6FF", "#7B68EE", "#FF4D4D", "#FFD24D", "#228B22"]
cmap = ListedColormap(colors)
cmap.set_bad((0, 0, 0, 0))
norm = matplotlib.colors.Normalize(vmin=1, vmax=5)

records = []
for year in years_to_export:
    idx = int(np.argmin(np.abs(years - year)))
    layer = sub.isel(time=idx)

    forest = v("primf").isel(time=idx) + v("secdf").isel(time=idx)
    crops = v("c3ann").isel(time=idx) + v("c3per").isel(time=idx) + v("c4ann").isel(time=idx) + v("c4per").isel(time=idx) + v("c3nfx").isel(time=idx)
    grazing = v("pastr").isel(time=idx) + v("range").isel(time=idx)
    agriculture = crops + grazing
    urban = v("urban").isel(time=idx)
    water = forest * 0
    wetland = forest * 0

    stack = xr.concat([water, wetland, urban, agriculture, forest], dim="c")
    dom = stack.argmax(dim="c").values + 1
    arr = np.where(np.isfinite(dom), dom.astype("float32"), np.nan)
    arr_masked = np.where(mask, arr, np.nan)

    flat = arr_masked[np.isfinite(arr_masked)].astype(int)
    if flat.size:
        uniq, cnts = np.unique(flat, return_counts=True)
        for cls_id, cnt in zip(uniq, cnts, strict=False):
            records.append((int(year), int(cls_id), class_names[int(cls_id)], int(cnt)))

    rgba = cmap(norm(arr_masked))
    plt.imsave(OUT_RASTERS / f"luh2_{int(year)}.png", rgba)
    print("Saved", OUT_RASTERS / f"luh2_{int(year)}.png")

df = pd.DataFrame(records, columns=["year", "class_id", "class_name", "count"])
df.to_csv(OUT_CSV, index=False)
print("Saved CSV:", OUT_CSV)
