"""
Export HYDE 3.4 land cover for Lithuania: polygon-masked stats + rasters + CSV.
Run: python export_hyde_lithuania.py
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
HYDE_NC_DIR = BASE / "Hyde" / "34" / "NetCDF"
OUT_RASTERS = BASE / "rasters" / "hyde"
OUT_RASTERS.mkdir(parents=True, exist_ok=True)
OUT_CSV = BASE / "outputs" / "hyde_lithuania_timeseries.csv"
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

LAT_MIN, LAT_MAX = 53.5, 56.6
LON_MIN, LON_MAX = 20.5, 26.7

# Load cropland and urban_area (main HYDE vars)
cropland_path = HYDE_NC_DIR / "cropland.nc"
urban_path = HYDE_NC_DIR / "urban_area.nc"
pasture_path = HYDE_NC_DIR / "pasture.nc"

if not cropland_path.exists() or not urban_path.exists():
    raise FileNotFoundError("Need cropland.nc and urban_area.nc in HYDE NetCDF folder")

ds_crop = xr.open_dataset(cropland_path, chunks="auto")
ds_urban = xr.open_dataset(urban_path, chunks="auto")

# Get first data var from each
crop_da = ds_crop[list(ds_crop.data_vars)[0]]
urban_da = ds_urban[list(ds_urban.data_vars)[0]]

lat_name = "lat" if "lat" in crop_da.coords else "latitude"
lon_name = "lon" if "lon" in crop_da.coords else "longitude"

# Crop to Lithuania bbox
crop_lt = crop_da.sel(
    **{lat_name: slice(LAT_MAX, LAT_MIN) if lat_name == "latitude" else slice(LAT_MIN, LAT_MAX),
       lon_name: slice(LON_MIN, LON_MAX)}
)
urban_lt = urban_da.sel(
    **{lat_name: slice(LAT_MAX, LAT_MIN) if lat_name == "latitude" else slice(LAT_MIN, LAT_MAX),
       lon_name: slice(LON_MIN, LON_MAX)}
)

# Align on time (use common years)
crop_lt, urban_lt = xr.align(crop_lt, urban_lt, join="inner")

# Add pasture if available
if pasture_path.exists():
    ds_past = xr.open_dataset(pasture_path, chunks="auto")
    past_da = ds_past[list(ds_past.data_vars)[0]]
    past_lt = past_da.sel(
        **{lat_name: slice(LAT_MAX, LAT_MIN) if lat_name == "latitude" else slice(LAT_MIN, LAT_MAX),
           lon_name: slice(LON_MIN, LON_MAX)}
    )
    crop_lt, urban_lt, past_lt = xr.align(crop_lt, urban_lt, past_lt, join="inner")
    agriculture = crop_lt + past_lt
else:
    agriculture = crop_lt

lat_vals = crop_lt[lat_name].values
lon_vals = crop_lt[lon_name].values
if lat_vals[0] < lat_vals[-1]:
    crop_lt = crop_lt.isel({lat_name: slice(None, None, -1)})
    urban_lt = urban_lt.isel({lat_name: slice(None, None, -1)})
    agriculture = agriculture.isel({lat_name: slice(None, None, -1)})
    lat_vals = crop_lt[lat_name].values

mask = polygon_mask(lat_vals, lon_vals, lt_geom)

# Build dominant: Urban(3), Agriculture(4), Other(5)
other = 1.0 - urban_lt - agriculture
other = other.where(other > 0, 0)

class_names = {1: "Water", 2: "Wetland", 3: "Urban", 4: "Agriculture", 5: "Forest"}
colors = ["#4DA6FF", "#7B68EE", "#FF4D4D", "#FFD24D", "#228B22"]
cmap = ListedColormap(colors)
cmap.set_bad((0, 0, 0, 0))
norm = matplotlib.colors.Normalize(vmin=1, vmax=5)

time_vals = crop_lt["time"].values
years = pd.to_datetime(time_vals).year.astype(int)
years = np.unique(years)
years = years[(years >= 1900) & (years <= 2020)]
years_to_export = years[years % 10 == 0]
if len(years_to_export) == 0:
    years_to_export = years[:min(30, len(years))]

print("Exporting HYDE years:", list(years_to_export[:10]), "...", list(years_to_export[-5:]))

records = []
for i, year in enumerate(years_to_export):
    idx = np.argmin(np.abs(years - year))
    u = urban_lt.isel(time=idx).values
    a = agriculture.isel(time=idx).values
    o = other.isel(time=idx).values
    dom = np.argmax(np.stack([u, a, o], axis=-1), axis=-1)
    arr = np.full(dom.shape, np.nan, dtype="float32")
    arr[dom == 0] = 3
    arr[dom == 1] = 4
    arr[dom == 2] = 5
    arr_masked = np.where(mask, arr, np.nan)

    flat = arr_masked[np.isfinite(arr_masked)].astype(int)
    if flat.size:
        uniq, cnts = np.unique(flat, return_counts=True)
        for cls_id, cnt in zip(uniq, cnts, strict=False):
            records.append((int(year), int(cls_id), class_names[int(cls_id)], int(cnt)))

    rgba = cmap(norm(arr_masked))
    plt.imsave(OUT_RASTERS / f"hyde_{int(year)}.png", rgba)
    print("Saved", OUT_RASTERS / f"hyde_{int(year)}.png")

df = pd.DataFrame(records, columns=["year", "class_id", "class_name", "count"])
df.to_csv(OUT_CSV, index=False)
print("Saved CSV:", OUT_CSV)
