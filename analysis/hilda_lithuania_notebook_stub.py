import xarray as xr
import geopandas as gpd
import numpy as np
import pandas as pd
from pathlib import Path

# You can copy-paste the cells from this file into a Jupyter notebook
# in your working Python environment.

BASE_DIR = Path(r"C:\Users\matas\Desktop\LEI\Data")
HILDA_NC = BASE_DIR / "Hilda" / "Version 2.0" / "Winkler-etal_2025_allfiles" / "hildap_vGLOB-2.0_netCDF_extended-time" / "hildaplus_GLOB-2-0_states.nc"
LT_BOUNDARY = BASE_DIR / "lt_boundary_admin.json"

print("HILDA file exists:", HILDA_NC.exists())
print("Boundary file exists:", LT_BOUNDARY.exists())


def hilda_grouped_lithuania_timeseries():
    """
    Run this function inside a Jupyter notebook to get
    a Lithuania-wide HILDA+ time series aggregated into
    five classes: Water, Wetland, Urban, Agriculture, Forest.
    """
    # Load boundary (GeoJSON with administrative borders)
    lt = gpd.read_file(LT_BOUNDARY)
    lt = lt.to_crs(epsg=4326)

    # Load HILDA dataset
    ds = xr.open_dataset(HILDA_NC, chunks="auto")
    da = ds["LULC_states"]

    # Subset roughly to Lithuania box to speed up (same as in your notebook)
    da_lt = da.sel(latitude=slice(56.5, 53.5), longitude=slice(20.5, 26.5))

    groups = {
        "Water": [0, 77],
        "Urban": [11],
        "Agriculture": [22, 23, 24, 33],
        "Forest": [41, 42, 43, 44, 45],
    }

    # 1=Water, 3=Urban, 4=Agriculture, 5=Forest
    five_map = {}
    for c in groups["Water"]:
        five_map[c] = 1
    for c in groups["Urban"]:
        five_map[c] = 3
    for c in groups["Agriculture"]:
        five_map[c] = 4
    for c in groups["Forest"]:
        five_map[c] = 5
    # 66, 99 unmapped

    def reclass_to_five(layer):
        data = layer.values
        out = np.full_like(data, fill_value=np.nan, dtype="float32")
        for orig, unified in five_map.items():
            mask = data == orig
            out[mask] = unified
        return xr.DataArray(
            out,
            coords=layer.coords,
            dims=layer.dims,
            name="landcover5",
        )

    records = []
    years = np.asarray(da_lt["time"].values)
    id_to_name = {1: "Water", 3: "Urban", 4: "Agriculture", 5: "Forest"}

    for t_val in years:
        year = int(round(float(t_val)))
        layer = da_lt.sel(time=t_val)
        five = reclass_to_five(layer)
        vals = five.values
        mask = np.isfinite(vals)
        flat = vals[mask].astype("int64")
        unique, counts = np.unique(flat, return_counts=True)
        for cls_id, cnt in zip(unique, counts, strict=False):
            cls_id = int(cls_id)
            cls_name = id_to_name.get(cls_id, f"class_{cls_id}")
            records.append((year, cls_id, cls_name, int(cnt)))

    df = pd.DataFrame(records, columns=["year", "class_id", "class_name", "count"])
    df = df.sort_values(["year", "class_id"]).reset_index(drop=True)
    return df


if __name__ == "__main__":
    df = hilda_grouped_lithuania_timeseries()
    print(df.head())
    print(df.tail())

