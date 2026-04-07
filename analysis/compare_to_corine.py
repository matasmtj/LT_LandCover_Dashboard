r"""
Compare HILDA, LUCAS, HYDE, and LUH2 against CORINE over Lithuania.

Reads the per-class CSVs produced by:
  - export_corine_lithuania.py
  - export_hilda_lithuania.py
  - export_lucas_lithuania.py
  - export_hyde_lithuania.py
  - export_luh2_lithuania.py

Outputs a CSV with, for each overlapping year and class:
  dataset, year, class_id, class_name,
  corine_count, dataset_count, diff_count, diff_pct_of_corine.

Run (from Data/ in landcover2 env):
  python analysis\compare_to_corine.py
"""

from pathlib import Path
import pandas as pd

BASE = Path(r"C:\Users\matas\Desktop\LEI\Data")
OUT_CSV = BASE / "outputs" / "corine_comparison.csv"

DATASET_FILES = {
    "hilda": BASE / "outputs" / "hilda_lithuania_timeseries.csv",
    "lucas": BASE / "outputs" / "lucas_lithuania_timeseries.csv",
    "hyde": BASE / "outputs" / "hyde_lithuania_timeseries.csv",
    "luh2": BASE / "outputs" / "luh2_lithuania_timeseries.csv",
}

CORINE_CSV = BASE / "outputs" / "corine_lithuania_timeseries.csv"


def load_table(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(path)
    df = pd.read_csv(path)
    return df


def main():
    cor = load_table(CORINE_CSV)
    # Ensure integers
    cor["year"] = cor["year"].astype(int)
    cor["class_id"] = cor["class_id"].astype(int)

    rows = []

    for name, path in DATASET_FILES.items():
        if not path.exists():
            print(f"Skipping {name}: {path} not found.")
            continue
        df = load_table(path)
        df["year"] = df["year"].astype(int)
        df["class_id"] = df["class_id"].astype(int)

        # Inner join on year + class_id where CORINE has data
        merged = cor.merge(
            df,
            on=["year", "class_id"],
            suffixes=("_corine", f"_{name}"),
        )
        if merged.empty:
            print(f"No overlapping years between CORINE and {name}.")
            continue

        for _, row in merged.iterrows():
            cor_cnt = int(row["count_corine"])
            ds_cnt = int(row[f"count_{name}"])
            cls_id = int(row["class_id"])
            cls_name = row["class_name_corine"]
            diff = ds_cnt - cor_cnt
            diff_pct = (diff / cor_cnt * 100.0) if cor_cnt > 0 else float("nan")
            rows.append(
                {
                    "dataset": name,
                    "year": int(row["year"]),
                    "class_id": cls_id,
                    "class_name": cls_name,
                    "corine_count": cor_cnt,
                    "dataset_count": ds_cnt,
                    "diff_count": diff,
                    "diff_pct_of_corine": diff_pct,
                }
            )

    if not rows:
        print("No comparisons could be made (no overlapping years).")
        return

    out = pd.DataFrame(rows)
    out = out.sort_values(["dataset", "year", "class_id"])
    out.to_csv(OUT_CSV, index=False)
    print("Saved comparison CSV:", OUT_CSV)


if __name__ == "__main__":
    main()

