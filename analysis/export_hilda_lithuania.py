r"""
Export HILDA+ land cover for Lithuania: polygon-masked rasters + CSV.
Run: cd <Data repo> && python analysis/export_hilda_lithuania.py
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

try:
    BASE = Path(__file__).resolve().parent.parent
except NameError:  # interactive / some notebooks
    BASE = Path.cwd()
    for d in [BASE, *BASE.parents]:
        if (d / "lt_subbasins.json").is_file():
            BASE = d
            break


def polygon_mask(lat_vals, lon_vals, geom):
    """Mask True where grid cell centers fall inside the polygon (no rasterio)."""
    h, w = len(lat_vals), len(lon_vals)
    mask = np.zeros((h, w), dtype=bool)
    for i, lat in enumerate(lat_vals):
        for j, lon in enumerate(lon_vals):
            mask[i, j] = geom.contains(Point(lon, lat))
    return mask


def _hilda_to_png_channel(arr_masked):
    """Map class ids 1,3,4,5 → 0..3 for RGBA PNG; NaN stays masked."""
    out = np.full(arr_masked.shape, np.nan, dtype=np.float32)
    out[np.isfinite(arr_masked) & (arr_masked == 1)] = 0
    out[np.isfinite(arr_masked) & (arr_masked == 3)] = 1
    out[np.isfinite(arr_masked) & (arr_masked == 4)] = 2
    out[np.isfinite(arr_masked) & (arr_masked == 5)] = 3
    return out


def main() -> None:
    lt_geojson = BASE / "lt_boundary_admin.json"
    hilda_nc = (
        BASE
        / "Hilda"
        / "Version 2.0"
        / "Winkler-etal_2025_allfiles"
        / "hildap_vGLOB-2.0_netCDF_extended-time"
        / "hildaplus_GLOB-2-0_states.nc"
    )
    out_rasters = BASE / "rasters" / "hilda"
    out_geotiff = out_rasters / "geotiff"
    out_rasters.mkdir(parents=True, exist_ok=True)
    out_geotiff.mkdir(parents=True, exist_ok=True)
    out_csv = BASE / "outputs" / "hilda_lithuania_timeseries.csv"
    out_csv.parent.mkdir(parents=True, exist_ok=True)

    with open(lt_geojson, "r", encoding="utf-8") as f:
        lt_data = json.load(f)
    geoms = [shape(feat["geometry"]) for feat in lt_data["features"]]
    lt_geom = unary_union(geoms)

    lat_min, lat_max = 53.5, 56.6
    lon_min, lon_max = 20.5, 26.7

    print("Opening HILDA dataset:", hilda_nc)
    try:
        ds = xr.open_dataset(hilda_nc, chunks="auto")
    except ImportError:
        ds = xr.open_dataset(hilda_nc)
    da = ds["LULC_states"]

    lat_name = "latitude"
    lon_name = "longitude"
    lats = da[lat_name].values
    lat_slice = slice(lat_max, lat_min) if (len(lats) > 1 and lats[0] > lats[-1]) else slice(lat_min, lat_max)
    da_lt = da.sel(**{lat_name: lat_slice, lon_name: slice(lon_min, lon_max)})

    lat_vals = da_lt[lat_name].values
    lon_vals = da_lt[lon_name].values
    mask = polygon_mask(lat_vals, lon_vals, lt_geom)

    # HILDA+ states (see Readme.md): 22–24 crops/agroforestry; 33 pasture/rangeland;
    # 40–45 forest-related codes; 55 unmanaged grass/shrubland; 66/99 sparse/nodata.
    # 33 is grouped with agriculture (no separate “grassland” class in the dashboard).
    # 55 is not mapped (nodata). 40 is “forest unknown / other” — excluded from Forest so
    # mapped forest (41–45) aligns better with national forest inventory (~33% LT).
    groups = {
        "Water": [0, 77],
        "Urban": [11],
        "Agriculture": [22, 23, 24, 33],
        "Forest": [41, 42, 43, 44, 45],
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

    class_names = {1: "Water", 3: "Urban", 4: "Agriculture", 5: "Forest"}

    png_colors = ["#4DA6FF", "#FF4D4D", "#FFD24D", "#228B22"]
    cmap_png = ListedColormap(png_colors)
    cmap_png.set_bad((0, 0, 0, 0))
    norm_png = matplotlib.colors.Normalize(vmin=-0.5, vmax=3.5)

    def reclass_to_five(layer):
        data = layer.values
        out = np.full_like(data, fill_value=np.nan, dtype="float32")
        for orig, unified in five_map.items():
            mask_codes = data == orig
            out[mask_codes] = unified
        return out

    time_vals = da_lt["time"].values
    pairs = []
    for ti, t_val in enumerate(time_vals):
        y = int(round(float(t_val)))
        if 1910 <= y <= 2020:
            pairs.append((y, ti, float(t_val)))
    pairs.sort(key=lambda x: (x[0], x[2]))
    year_to_ti = {}
    for y, ti, _ in pairs:
        if y not in year_to_ti:
            year_to_ti[y] = ti
    years_export = np.array(sorted(year_to_ti.keys()), dtype=int)
    print("Exporting HILDA years:", years_export[:10], "...", years_export[-5:])

    try:
        import rasterio
        from rasterio.transform import from_bounds as _from_bounds
    except ImportError:
        rasterio = None
        _from_bounds = None

    if rasterio is not None:
        for stale in out_geotiff.glob("hilda_*.tif"):
            try:
                stale.unlink()
            except OSError:
                pass
    else:
        print(
            "Note: rasterio not importable — skipped clearing rasters/hilda/geotiff/*.tif "
            "(fix env: conda install -c conda-forge rasterio gdal; then re-run to refresh GeoTIFFs)."
        )

    records = []
    for year in years_export:
        ti = year_to_ti[int(year)]
        layer = da_lt.isel(time=ti)
        arr = reclass_to_five(layer)
        arr_masked = np.where(mask, arr, np.nan)

        flat = arr_masked[np.isfinite(arr_masked)].astype(int)
        if flat.size:
            uniq, cnts = np.unique(flat, return_counts=True)
            for cls_id, cnt in zip(uniq, cnts, strict=False):
                records.append(
                    (int(year), int(cls_id), class_names.get(int(cls_id), f"class_{cls_id}"), int(cnt))
                )

        rgba = cmap_png(norm_png(_hilda_to_png_channel(arr_masked)))
        out_path = out_rasters / f"hilda_{int(year)}.png"
        plt.imsave(out_path, rgba)
        print("Saved", out_path)

        if rasterio is None:
            pass
        else:
            try:
                h, w = arr_masked.shape
                west, east = float(np.min(lon_vals)), float(np.max(lon_vals))
                south, north = float(np.min(lat_vals)), float(np.max(lat_vals))
                arr_uint8 = np.zeros(arr_masked.shape, dtype=np.uint8)
                valid = np.isfinite(arr_masked)
                for v in (1, 3, 4, 5):
                    arr_uint8[valid & (arr_masked == v)] = v
                transform = _from_bounds(west, south, east, north, w, h)
                out_tif = out_geotiff / f"hilda_{int(year)}.tif"
                profile = dict(
                    driver="GTiff",
                    height=h,
                    width=w,
                    count=1,
                    dtype=arr_uint8.dtype,
                    transform=transform,
                    nodata=0,
                )
                last_err = None
                for crs_arg in ("EPSG:4326", None):
                    try:
                        kw = {**profile, **({} if crs_arg is None else {"crs": crs_arg})}
                        with rasterio.open(out_tif, "w", **kw) as dst:
                            dst.write(arr_uint8, 1)
                        note = " (no CRS tag; still WGS84 bounds in transform)" if crs_arg is None else ""
                        print(f"Saved {out_tif}{note}")
                        break
                    except Exception as e:
                        last_err = e
                else:
                    assert last_err is not None
                    raise last_err
            except Exception as e:
                print(f"Warning: GeoTIFF skipped for {year}: {e}")

    df = pd.DataFrame(records, columns=["year", "class_id", "class_name", "count"])
    df.to_csv(out_csv, index=False)
    print("Saved CSV:", out_csv)


if __name__ == "__main__":
    main()
