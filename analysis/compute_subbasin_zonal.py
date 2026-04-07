r"""
Pre-compute land-cover class counts per sub-basin polygon for each exported GeoTIFF year.

This keeps the dashboard fast: the browser only loads a CSV and plots — no client-side
GeoTIFF sampling (which caused lag).

Uses **rasterio** + **numpy** only (no rasterstats / Fiona). On Windows, ``rasterstats`` imports
Fiona, which often fails with ``DLL load failed`` even when packages show as installed; this script avoids that.

Requirements:
  pip install rasterio numpy

Run from repo root:
  python analysis/compute_subbasin_zonal.py
  python analysis/compute_subbasin_zonal.py --dataset hilda

Outputs (one CSV per dataset):
  outputs/subbasin_zonal_hilda.csv
  ...

CSV columns: year,basin_index,class_id,count
  class_id: 1=Water, 2=Wetland, 3=Urban, 4=Agriculture, 5=Forest or HYDE “Natural (residual)”
  (matches GeoTIFF values)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
SUBBASINS_PATH = BASE / "lt_subbasins.json"
OUT_DIR = BASE / "outputs"

DATASETS: dict[str, tuple[Path, str]] = {
    "hilda": (BASE / "rasters" / "hilda" / "geotiff", "hilda"),
    "lucas": (BASE / "rasters" / "lucas" / "geotiff", "lucas"),
    "hyde": (BASE / "rasters" / "hyde" / "geotiff", "hyde"),
    "luh2": (BASE / "rasters" / "luh2" / "geotiff", "luh2"),
    "corine": (BASE / "rasters" / "corine" / "geotiff", "corine"),
}


def load_features() -> list[dict]:
    with open(SUBBASINS_PATH, "r", encoding="utf-8") as f:
        fc = json.load(f)
    return fc.get("features") or []


def list_years(geotiff_dir: Path, prefix: str) -> list[int]:
    if not geotiff_dir.is_dir():
        return []
    years: list[int] = []
    for p in geotiff_dir.glob(f"{prefix}_*.tif"):
        try:
            years.append(int(p.stem.split("_")[-1]))
        except (ValueError, IndexError):
            continue
    return sorted(set(years))


def count_classes_in_basin(src, feature: dict) -> dict[int, int]:
    """Pixel counts for classes 1–5 inside polygon; nodata=0 ignored."""
    import numpy as np
    from rasterio.mask import mask

    geom = feature.get("geometry")
    if not geom:
        return {}

    try:
        out_image, _ = mask(src, [geom], crop=True, nodata=0, indexes=1)
    except ValueError:
        return {}

    data = out_image
    if data.ndim == 3:
        data = data[0]
    valid = data[(data >= 1) & (data <= 5)]
    if valid.size == 0:
        return {}

    uniq, cnts = np.unique(valid, return_counts=True)
    return {int(u): int(c) for u, c in zip(uniq, cnts, strict=False)}


def process_dataset(ds_key: str, features: list[dict]) -> None:
    import rasterio

    folder, prefix = DATASETS[ds_key]
    years = list_years(folder, prefix)
    if not years:
        print(f"[{ds_key}] No GeoTIFF files under {folder} — skip.")
        return

    out_path = OUT_DIR / f"subbasin_zonal_{ds_key}.csv"
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    rows_written = 0
    with open(out_path, "w", encoding="utf-8") as out:
        out.write("year,basin_index,class_id,count\n")
        for year in years:
            tif = folder / f"{prefix}_{year}.tif"
            if not tif.is_file():
                continue
            print(f"  [{ds_key}] {year} ({tif.name}) …")
            with rasterio.open(tif) as src:
                for basin_index, feat in enumerate(features):
                    counts = count_classes_in_basin(src, feat)
                    for cid in range(1, 6):
                        c = counts.get(cid, 0)
                        if c > 0:
                            out.write(f"{year},{basin_index},{cid},{c}\n")
                            rows_written += 1

    print(f"[{ds_key}] Wrote {out_path} ({rows_written} data rows)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Pre-compute sub-basin zonal stats from GeoTIFFs.")
    parser.add_argument(
        "--dataset",
        choices=list(DATASETS.keys()),
        help="Only process one dataset (default: all)",
    )
    args = parser.parse_args()

    try:
        import numpy  # noqa: F401
        import rasterio  # noqa: F401
    except ImportError as e:
        print(
            "Missing dependency. Install with:\n  pip install rasterio numpy\n"
            f"Original error: {e}",
            file=sys.stderr,
        )
        sys.exit(1)

    if not SUBBASINS_PATH.is_file():
        print(f"Missing {SUBBASINS_PATH}", file=sys.stderr)
        sys.exit(1)

    features = load_features()
    if not features:
        print("No features in sub-basins GeoJSON.", file=sys.stderr)
        sys.exit(1)

    print(f"Loaded {len(features)} sub-basin polygons from {SUBBASINS_PATH.name}")

    keys = [args.dataset] if args.dataset else list(DATASETS.keys())
    for ds_key in keys:
        print(f"\n=== {ds_key} ===")
        process_dataset(ds_key, features)

    print("\nDone.")


if __name__ == "__main__":
    main()
