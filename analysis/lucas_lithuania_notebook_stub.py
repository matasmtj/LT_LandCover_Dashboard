import xarray as xr
import geopandas as gpd
import numpy as np
import pandas as pd
from pathlib import Path

# Notebook-friendly helper for LUCAS_LUC, modelled after your Lucas_Luc_v1.ipynb

BASE_DIR = Path(r"C:\Users\matas\Desktop\LEI\Data")
LUCAS_NC = BASE_DIR / "Lucas_Luc" / "LUC_hist_EU_afts_v1.1_1-7" / "LUCAS_LUC_v1.1_historical_Europe_0.1deg_2000_2009.nc"
LT_BOUNDARY = BASE_DIR / "lt_boundary_admin.json"

print("LUCAS file exists:", LUCAS_NC.exists())
print("Boundary file exists:", LT_BOUNDARY.exists())


def lucas_grouped_lithuania_snapshot(year: int = 2000):
    """
    Return a single-year LUCAS_LUC dominant-class map over Lithuania,
    using the same 5 groups you inferred in Lucas_Luc_v1.ipynb:
    Agriculture, Forest, Water, Urban, Wetland.

    Output:
      dominant: DataArray (lat, lon) with values 1..5 (group ids)
      group_names: list of group names in id order
    """
    ds = xr.open_dataset(LUCAS_NC, chunks="auto")
    frac = ds["landCoverFrac"]  # (time, lctype, lat, lon)

    # Pick nearest time slice
    layer = frac.sel(time=str(year), method="nearest")  # (lctype, lat, lon)

    # LUCAS LUC v1.1 lctype codes (WDCC): 1-2 tropical, 3-6 trees, 7-8 shrubs,
    # 9-10 grass, 11 tundra, 12 swamp, 13-14 crops, 15 urban, 16 bare. No water.
    group_to_lctypes = {
        "Agriculture": [13, 14],
        "Forest": [3, 4, 5, 6],
        "Water": [],
        "Urban": [15],
        "Wetland": [12],
    }

    group_names = list(group_to_lctypes.keys())

    group_fracs = []
    for name in group_names:
        codes = group_to_lctypes[name]
        if codes:
            gf = layer.sel(lctype=codes).sum(dim="lctype")
        else:
            gf = 0 * layer.isel(lctype=0).drop_vars("lctype", errors="ignore")
        group_fracs.append(gf)

    stack = xr.concat(group_fracs, dim="group").assign_coords(group=group_names)
    maxfrac = stack.max(dim="group")
    dominant = stack.argmax(dim="group") + 1  # 1..5

    # Do NOT subset here; return full grid and we’ll slice in the notebook.
    return dominant, group_names


def lucas_lithuania_timeseries(year: int = 2000):
    """
    Turn the dominant-class map for a given year into a summary
    table (counts per class) for Lithuania.
    """
    dom, group_names = lucas_grouped_lithuania_snapshot(year=year)
    vals = dom.values
    mask = np.isfinite(vals)
    flat = vals[mask].astype("int64")
    unique, counts = np.unique(flat, return_counts=True)

    records = []
    for cls_id, cnt in zip(unique, counts, strict=False):
        cls_id = int(cls_id)
        cls_name = group_names[cls_id - 1] if 1 <= cls_id <= len(group_names) else f"class_{cls_id}"
        records.append((year, cls_id, cls_name, int(cnt)))

    df = pd.DataFrame(records, columns=["year", "class_id", "class_name", "count"])
    return df


if __name__ == "__main__":
    dom, names = lucas_grouped_lithuania_snapshot(year=2000)
    print("Groups:", names)
    print(dom)

