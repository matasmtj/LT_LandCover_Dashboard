import os
from pathlib import Path
from typing import Dict, Tuple

import geopandas as gpd
import numpy as np
import pandas as pd
import rioxarray  # noqa: F401  # required to register xarray .rio accessor
import xarray as xr
from shapely.geometry import mapping


BASE_DIR = Path(__file__).resolve().parents[1]


def load_boundary(boundary_path: Path, layer: str | None = None) -> gpd.GeoDataFrame:
    """
    Load Lithuania boundary (or basin boundaries) from a vector file.

    boundary_path: path to e.g. a shapefile, geopackage, or geojson.
    layer: optional layer name for geopackage.
    """
    if not boundary_path.exists():
        raise FileNotFoundError(f"Boundary file not found: {boundary_path}")

    if layer:
        gdf = gpd.read_file(boundary_path, layer=layer)
    else:
        gdf = gpd.read_file(boundary_path)

    # Reproject to EPSG:4326 for consistency with most NetCDF rasters
    if gdf.crs is None:
        raise ValueError("Boundary file has no CRS defined.")

    gdf = gdf.to_crs(epsg=4326)
    return gdf


def open_netcdf_as_da(nc_path: Path, var_name: str) -> xr.DataArray:
    """
    Open a NetCDF file and return the requested variable as a DataArray
    with geographic coordinates (lon, lat) in EPSG:4326.
    """
    if not nc_path.exists():
        raise FileNotFoundError(f"NetCDF file not found: {nc_path}")

    ds = xr.open_dataset(nc_path)
    if var_name not in ds:
        raise KeyError(f"Variable '{var_name}' not found in {nc_path.name}. "
                       f"Available variables: {list(ds.data_vars)}")

    da = ds[var_name]

    # Try to normalise coordinate names to lon/lat
    coord_map = {}
    for coord in da.coords:
        lower = coord.lower()
        if lower in {"lon", "longitude", "x"}:
            coord_map[coord] = "lon"
        elif lower in {"lat", "latitude", "y"}:
            coord_map[coord] = "lat"

    da = da.rename(coord_map)

    # Attach spatial reference for rioxarray
    if "lon" not in da.coords or "lat" not in da.coords:
        raise ValueError("DataArray must have longitude and latitude coordinates named 'lon' and 'lat'.")

    da = da.rio.set_spatial_dims(x_dim="lon", y_dim="lat", inplace=False)
    da = da.rio.write_crs("EPSG:4326", inplace=False)
    return da


def clip_da_to_boundary(da: xr.DataArray, boundary: gpd.GeoDataFrame) -> xr.DataArray:
    """Clip a DataArray to the given boundary using rioxarray."""
    geometry = [mapping(boundary.unary_union)]
    clipped = da.rio.clip(geometry, boundary.crs, drop=True)
    return clipped


def compute_class_areas(
    da: xr.DataArray,
    class_mapping: Dict[int, str],
    pixel_area_km2: float | None = None,
) -> pd.DataFrame:
    """
    Aggregate cell counts/areas per land-cover class.

    da: DataArray with integer class codes.
    class_mapping: maps integer codes in da to readable labels.
    pixel_area_km2: area of each pixel; if None, returns counts instead of areas.
    """
    values = da.values
    valid_mask = np.isfinite(values)
    flat = values[valid_mask].astype("int64")

    unique, counts = np.unique(flat, return_counts=True)
    records: list[Tuple[str, int, float]] = []

    for code, count in zip(unique, counts, strict=False):
        label = class_mapping.get(int(code), f"class_{int(code)}")
        area_km2 = float(count) * pixel_area_km2 if pixel_area_km2 is not None else float("nan")
        records.append((label, int(code), area_km2 if pixel_area_km2 is not None else float(count)))

    df = pd.DataFrame(records, columns=["class_name", "class_code", "area_km2" if pixel_area_km2 else "count"])
    df = df.sort_values("class_code")
    return df


def harmonise_to_five_classes(da: xr.DataArray, mapping_to_five: Dict[int, int]) -> xr.DataArray:
    """
    Reclassify dataset-specific land-cover codes to the five main classes:
    Water, Wetlands, Urban, Agriculture, Forest.

    mapping_to_five: dict {original_code: unified_code (1..5)}.
    """
    data = da.values
    result = np.full_like(data, fill_value=np.nan, dtype="float32")

    for orig, unified in mapping_to_five.items():
        mask = data == orig
        result[mask] = unified

    out = xr.DataArray(
        result,
        dims=da.dims,
        coords=da.coords,
        name="landcover5",
        attrs={"description": "Harmonised 5-class land cover"},
    )
    out = out.rio.set_spatial_dims(x_dim="lon", y_dim="lat", inplace=False)
    out = out.rio.write_crs("EPSG:4326", inplace=False)
    return out


def compare_with_corine(
    model_da: xr.DataArray,
    corine_da: xr.DataArray,
    five_class_mapping_model: Dict[int, int],
    five_class_mapping_corine: Dict[int, int],
) -> pd.DataFrame:
    """
    Compute a confusion matrix-style comparison between a model dataset and CORINE.

    The function:
    - reclasses each dataset into the 5 main classes,
    - resamples CORINE to the model grid,
    - returns a table of counts for (model_class, corine_class).
    """
    # Harmonise both to 5 classes
    model_5 = harmonise_to_five_classes(model_da, five_class_mapping_model)
    corine_5 = harmonise_to_five_classes(corine_da, five_class_mapping_corine)

    # Align grids by reprojecting CORINE to model grid
    corine_reproj = corine_5.rio.reproject_match(model_5)

    m_vals = model_5.values
    c_vals = corine_reproj.values

    valid_mask = np.isfinite(m_vals) & np.isfinite(c_vals)
    m_flat = m_vals[valid_mask].astype("int64")
    c_flat = c_vals[valid_mask].astype("int64")

    records = []
    for m_class in range(1, 6):
        for c_class in range(1, 6):
            mask = (m_flat == m_class) & (c_flat == c_class)
            count = int(mask.sum())
            records.append((m_class, c_class, count))

    df = pd.DataFrame(records, columns=["model_class", "corine_class", "count"])
    return df


def hilda_lithuania_timeseries() -> pd.DataFrame:
    """
    Compute a Lithuania-wide time series of HILDA+ land cover
    aggregated into five harmonised classes:
    1=Water, 2=Wetlands, 3=Urban, 4=Agriculture, 5=Forest.

    Returns a tidy DataFrame with columns:
    [year, class_id, class_name, count]
    where 'count' is the number of grid cells within Lithuania.
    """
    # HILDA states file and boundary
    hilda_nc = (
        BASE_DIR
        / "Hilda"
        / "Version 2.0"
        / "Winkler-etal_2025_allfiles"
        / "hildap_vGLOB-2.0_netCDF_extended-time"
        / "hildaplus_GLOB-2-0_states.nc"
    )
    boundary_path = BASE_DIR / "lt_boundary_admin.json"

    boundary = load_boundary(boundary_path)

    # Load HILDA states DataArray (codes)
    da = open_netcdf_as_da(hilda_nc, "LULC_states")

    # Clip once to Lithuania to reduce size
    da_lt = clip_da_to_boundary(da, boundary)

    hilda_groups: Dict[str, list[int]] = {
        "Water": [0, 77],
        "Urban": [11],
        "Agriculture": [22, 23, 24, 33],
        "Forest": [41, 42, 43, 44, 45],
    }

    # 1=Water, 3=Urban, 4=Agriculture, 5=Forest (40/55/66/99 unmapped; no HILDA wetland code)
    five_class_mapping_hilda: Dict[int, int] = {}
    for code in hilda_groups["Water"]:
        five_class_mapping_hilda[code] = 1
    for code in hilda_groups["Urban"]:
        five_class_mapping_hilda[code] = 3
    for code in hilda_groups["Agriculture"]:
        five_class_mapping_hilda[code] = 4
    for code in hilda_groups["Forest"]:
        five_class_mapping_hilda[code] = 5

    # Reclassify entire DataArray to five-class scheme
    da_5 = harmonise_to_five_classes(da_lt, five_class_mapping_hilda)

    records: list[tuple[int, int, str, int]] = []

    time_coord = da_5.coords.get("time")
    if time_coord is None:
        raise ValueError("Expected 'time' coordinate in HILDA DataArray.")

    years = np.asarray(time_coord.values)

    id_to_name = {
        1: "Water",
        2: "Wetland",
        3: "Urban",
        4: "Agriculture",
        5: "Forest",
    }

    for t_val in years:
        year = int(round(float(t_val)))
        slice_t = da_5.sel(time=t_val)
        vals = slice_t.values
        mask = np.isfinite(vals)
        flat = vals[mask].astype("int64")

        unique, counts = np.unique(flat, return_counts=True)
        for cls_id, cnt in zip(unique, counts, strict=False):
            cls_id_int = int(cls_id)
            cls_name = id_to_name.get(cls_id_int, f"class_{cls_id_int}")
            records.append((year, cls_id_int, cls_name, int(cnt)))

    df = pd.DataFrame(records, columns=["year", "class_id", "class_name", "count"])
    df = df.sort_values(["year", "class_id"]).reset_index(drop=True)
    return df


def example_lucas_vs_corine() -> None:
    """
    Example workflow:
    - Load Lithuania boundary.
    - Clip one LUCAS_LUC NetCDF file to Lithuania.
    - Clip one CORINE raster to Lithuania.
    - Compute area distribution per class.
    - Compute comparison table between LUCAS_LUC and CORINE.

    You need to adjust the file paths and variable names to match your local data.
    """
    # Lithuania boundary (GeoJSON with administrative borders)
    boundary_path = BASE_DIR / "lt_boundary_admin.json"
    lucas_nc = BASE_DIR / "Lucas_Luc" / "LUC_hist_EU_afts_v1.1_1-7" / "LUCAS_LUC_v1.1_historical_Europe_0.1deg_2000_2009.nc"
    corine_raster = (
        BASE_DIR
        / "Validation"
        / "Corine_LandCover_raster"
        / "States"
        / "u2018_clc2018_v2020_20u1_raster100m"
        / "u2018_clc2018_v2020_20u1_raster100m.tif"
    )

    # Variable name inside LUCAS NetCDF that stores land-cover classes
    lucas_var_name = "landCoverFrac"  

    boundary = load_boundary(boundary_path)

    # LUCAS
    lucas_da = open_netcdf_as_da(lucas_nc, lucas_var_name)
    lucas_lt = clip_da_to_boundary(lucas_da, boundary)

    # CORINE
    if not corine_raster.exists():
        raise FileNotFoundError(
            "Expected a CORINE GeoTIFF at "
            f"{corine_raster}. Please unzip the official CORINE raster and update this path."
        )

    corine_da = xr.open_dataarray(corine_raster).rio.write_crs("EPSG:3035", inplace=False)
    corine_da = corine_da.rio.reproject("EPSG:4326")
    corine_lt = clip_da_to_boundary(corine_da, boundary)

    # Example: mapping of dataset-specific codes to unified 5 classes
    # You need to adapt these mappings based on each dataset's documentation.
    five_class_mapping_lucas = {
        # original_code: unified_five_class_code
        # 1..5 = [Water, Wetlands, Urban, Agriculture, Forest] or any order you decide
    }
    five_class_mapping_corine = {
        # e.g., CORINE codes 1xx, 2xx, 3xx, 4xx, 5xx mapped to 5 main classes
        # 111: 3, 112: 3, 211: 4, 311: 5, 412: 1, etc.
    }

    # Compute simple distributions (raw codes)
    # Example class mapping placeholder
    class_mapping_placeholder = {0: "NoData"}
    lucas_areas = compute_class_areas(lucas_lt, class_mapping_placeholder, pixel_area_km2=None)
    print("LUCAS_LUC raw class distribution (counts within Lithuania):")
    print(lucas_areas.head())

    # If mappings are provided, compute comparison
    if five_class_mapping_lucas and five_class_mapping_corine:
        comparison = compare_with_corine(
            lucas_lt,
            corine_lt,
            five_class_mapping_lucas,
            five_class_mapping_corine,
        )
        print("LUCAS vs CORINE confusion-style table (counts):")
        print(comparison)
    else:
        print(
            "five_class_mapping_lucas and/or five_class_mapping_corine are empty. "
            "Fill them in based on your class definitions to get comparison metrics."
        )


from lithuania_landcover import hilda_lithuania_timeseries  # if needed, or just call directly
if __name__ == "__main__":
    df = hilda_lithuania_timeseries()
    print(df.head())
    print(df.tail())


