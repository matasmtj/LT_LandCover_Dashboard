"""
Export HYDE 3.4 land cover for Lithuania: polygon-masked stats + rasters + CSV.

Run: python analysis/export_hyde_lithuania.py

HYDE reassessment (important):
- HYDE does **not** publish a forest-fraction layer in the standard land-use zips/NetCDF.
  Cropland, built-up (urban), and **grazing** (pasture + rangeland + converted rangeland) are
  explicit; the remainder of land in a cell is "everything else" (natural vegetation, forest
  where present, bare soil, etc.), not a forest inventory.
- Earlier exports used agriculture = cropland + pasture only. Per the HYDE readme, **grazing**
  is the total grazing-land area; pasture/rangeland/conv_rangeland are sub-components. Omitting
  rangeland (etc.) misallocates those fractions into the residual and distorted the dominant class.
- We therefore prefer **cropland + grazing** when `grazing.nc` exists, else **cropland + pasture +
  rangeland + conv_rangeland** when those NetCDF files exist, else fall back to **cropland + pasture**.
- Dominant class among urban, agriculture, residual is mapped to dashboard ids 3, 4, 5.
  **Class 5 is labeled "Natural (residual)"** in the CSV — comparable to "forest" in HILDA/CORINE
  only in the sense of "non-urban, non-cropland, non-grazing remainder", not as standing forest %.
"""

from __future__ import annotations

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

try:
    BASE = Path(__file__).resolve().parent.parent
except NameError:
    BASE = Path.cwd()
    for d in [BASE, *BASE.parents]:
        if (d / "lt_subbasins.json").is_file():
            BASE = d
            break

LT_GEOJSON = BASE / "lt_boundary_admin.json"
HYDE_NC_DIR = BASE / "Hyde" / "34" / "NetCDF"
OUT_RASTERS = BASE / "rasters" / "hyde"
OUT_GEOTIFF = OUT_RASTERS / "geotiff"
OUT_CSV = BASE / "outputs" / "hyde_lithuania_timeseries.csv"

LAT_MIN, LAT_MAX = 53.5, 56.6
LON_MIN, LON_MAX = 20.5, 26.7


def polygon_mask(lat_vals, lon_vals, geom):
    """Mask True where grid cell centers fall inside the polygon (no rasterio)."""
    h, w = len(lat_vals), len(lon_vals)
    mask = np.zeros((h, w), dtype=bool)
    for i, lat in enumerate(lat_vals):
        for j, lon in enumerate(lon_vals):
            mask[i, j] = geom.contains(Point(lon, lat))
    return mask


def _first_var(ds: xr.Dataset) -> xr.DataArray:
    return ds[list(ds.data_vars)[0]]


def main() -> None:
    OUT_RASTERS.mkdir(parents=True, exist_ok=True)
    OUT_GEOTIFF.mkdir(parents=True, exist_ok=True)
    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)

    with open(LT_GEOJSON, "r", encoding="utf-8") as f:
        lt_data = json.load(f)
    geoms = [shape(feat["geometry"]) for feat in lt_data["features"]]
    lt_geom = unary_union(geoms)

    cropland_path = HYDE_NC_DIR / "cropland.nc"
    urban_path = HYDE_NC_DIR / "urban_area.nc"
    grazing_path = HYDE_NC_DIR / "grazing.nc"
    pasture_path = HYDE_NC_DIR / "pasture.nc"
    rangeland_path = HYDE_NC_DIR / "rangeland.nc"
    conv_rangeland_path = HYDE_NC_DIR / "conv_rangeland.nc"

    if not cropland_path.exists() or not urban_path.exists():
        raise FileNotFoundError(
            f"Need cropland.nc and urban_area.nc under {HYDE_NC_DIR}. "
            "NetCDF folder is optional in some HYDE layouts; add NetCDF outputs from the release."
        )

    try:
        ds_crop = xr.open_dataset(cropland_path, chunks="auto")
        ds_urban = xr.open_dataset(urban_path, chunks="auto")
    except ImportError:
        ds_crop = xr.open_dataset(cropland_path)
        ds_urban = xr.open_dataset(urban_path)
    crop_da = _first_var(ds_crop)
    urban_da = _first_var(ds_urban)

    lat_name = "lat" if "lat" in crop_da.coords else "latitude"
    lon_name = "lon" if "lon" in crop_da.coords else "longitude"

    lon_vals_raw = crop_da[lon_name].values
    lon_in_360 = float(np.max(lon_vals_raw)) > 180
    if lon_in_360:
        lon_lo, lon_hi = LON_MIN + 360, LON_MAX + 360
    else:
        lon_lo, lon_hi = LON_MIN, LON_MAX

    def try_crop(da: xr.DataArray):
        for lat_sl in [slice(LAT_MIN, LAT_MAX), slice(LAT_MAX, LAT_MIN)]:
            out = da.sel(**{lat_name: lat_sl, lon_name: slice(lon_lo, lon_hi)})
            if out.sizes.get(lat_name, 0) > 0:
                return out
        return None

    crop_lt = try_crop(crop_da)
    urban_lt = try_crop(urban_da)
    if crop_lt is None or urban_lt is None:
        raise ValueError(
            "HYDE crop to Lithuania bbox is empty. Check lat/lon names and ranges. "
            f"lat range: {float(crop_da[lat_name].min())}-{float(crop_da[lat_name].max())}, "
            f"lon range: {float(crop_da[lon_name].min())}-{float(crop_da[lon_name].max())}"
        )

    crop_lt, urban_lt = xr.align(crop_lt, urban_lt, join="inner")

    ds_extra: list[xr.Dataset] = []

    if grazing_path.exists():
        try:
            ds_g = xr.open_dataset(grazing_path, chunks="auto")
        except ImportError:
            ds_g = xr.open_dataset(grazing_path)
        ds_extra.append(ds_g)
        g_da = try_crop(_first_var(ds_g))
        if g_da is None:
            agriculture = crop_lt
        else:
            crop_lt, urban_lt, g_lt = xr.align(crop_lt, urban_lt, g_da, join="inner")
            agriculture = crop_lt + g_lt
    else:
        parts: list[xr.DataArray] = [crop_lt]
        for p in (pasture_path, rangeland_path, conv_rangeland_path):
            if not p.exists():
                continue
            try:
                ds_x = xr.open_dataset(p, chunks="auto")
            except ImportError:
                ds_x = xr.open_dataset(p)
            ds_extra.append(ds_x)
            x_da = try_crop(_first_var(ds_x))
            if x_da is not None:
                parts.append(x_da)
        if len(parts) == 1:
            if pasture_path.exists():
                try:
                    ds_p = xr.open_dataset(pasture_path, chunks="auto")
                except ImportError:
                    ds_p = xr.open_dataset(pasture_path)
                ds_extra.append(ds_p)
                p_da = try_crop(_first_var(ds_p))
                if p_da is not None:
                    crop_lt, urban_lt, p_lt = xr.align(crop_lt, urban_lt, p_da, join="inner")
                    agriculture = crop_lt + p_lt
                else:
                    agriculture = crop_lt
            else:
                agriculture = crop_lt
        else:
            aligned = xr.align(*parts, join="inner")
            agriculture = sum(aligned[1:], start=aligned[0])
            crop_lt = aligned[0]

    crop_lt, urban_lt, agriculture = xr.align(crop_lt, urban_lt, agriculture, join="inner")

    lat_vals = crop_lt[lat_name].values
    lon_vals = crop_lt[lon_name].values
    if len(lat_vals) > 1 and lat_vals[0] < lat_vals[-1]:
        crop_lt = crop_lt.isel({lat_name: slice(None, None, -1)})
        urban_lt = urban_lt.isel({lat_name: slice(None, None, -1)})
        agriculture = agriculture.isel({lat_name: slice(None, None, -1)})
        lat_vals = crop_lt[lat_name].values

    mask = polygon_mask(lat_vals, lon_vals, lt_geom)

    u_raw = urban_lt.astype("float64")
    a_raw = agriculture.astype("float64")
    s_raw = u_raw + a_raw
    # HYDE fractions can slightly exceed 1 when summed; clip before residual.
    scale = xr.where(s_raw > 1.0, 1.0 / s_raw, 1.0)
    urban_lt = (u_raw * scale).clip(0, 1)
    agriculture = (a_raw * scale).clip(0, 1)

    other = 1.0 - urban_lt - agriculture
    other = other.where(other > 0, 0)

    # class_id 5 = residual natural land (not "forest" in HYDE)
    class_names = {1: "Water", 2: "Wetland", 3: "Urban", 4: "Agriculture", 5: "Natural (residual)"}
    colors = ["#4DA6FF", "#7B68EE", "#FF4D4D", "#FFD24D", "#228B22"]
    cmap = ListedColormap(colors)
    cmap.set_bad((0, 0, 0, 0))
    norm = matplotlib.colors.Normalize(vmin=1, vmax=5)

    time_vals = crop_lt["time"].values
    all_years = np.array([t.year if hasattr(t, "year") else int(t) for t in time_vals], dtype=int)
    years = np.unique(all_years)
    years = years[(years >= 1900) & (years <= 2020)]

    print("Exporting HYDE years:", list(years[:10]), "...", list(years[-5:]))

    records = []
    for year in years:
        idx_arr = np.where(all_years == year)[0]
        if len(idx_arr) == 0:
            continue
        idx = int(idx_arr[0])
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

        try:
            import rasterio
            from rasterio.transform import from_bounds

            h, w = arr_masked.shape
            west, east = float(np.min(lon_vals)), float(np.max(lon_vals))
            south, north = float(np.min(lat_vals)), float(np.max(lat_vals))
            valid = np.isfinite(arr_masked)
            arr_uint8 = np.zeros(arr_masked.shape, dtype=np.uint8)
            arr_uint8[valid] = arr_masked[valid].astype(np.uint8)
            transform = from_bounds(west, south, east, north, w, h)
            out_tif = OUT_GEOTIFF / f"hyde_{int(year)}.tif"
            with rasterio.open(
                out_tif,
                "w",
                driver="GTiff",
                height=h,
                width=w,
                count=1,
                dtype=arr_uint8.dtype,
                crs="EPSG:4326",
                transform=transform,
                nodata=0,
            ) as dst:
                dst.write(arr_uint8, 1)
            print("Saved", out_tif)
        except ImportError:
            pass

    df = pd.DataFrame(records, columns=["year", "class_id", "class_name", "count"])
    df.to_csv(OUT_CSV, index=False)
    print("Saved CSV:", OUT_CSV)

    ds_crop.close()
    ds_urban.close()
    for ds in ds_extra:
        try:
            ds.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
