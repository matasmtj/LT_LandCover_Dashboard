r"""
Build national (and optional sub-basin) validation metrics vs CORINE for the dashboard.

Compares land-cover *national area shares* (from outputs/*_lithuania_timeseries.csv) at CORINE
snapshot years. Adds leave-one-year-out ML baselines (RandomForest + Ridge) mapping each
dataset's 5-class share vector to each CORINE class share.

Run from repo root:
  python analysis/compute_validation_metrics.py

Output:
  outputs/dashboard_validation_metrics.json
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

BASE = Path(__file__).resolve().parent.parent
OUT = BASE / "outputs"

CLASS_ORDER = ["Water", "Wetland", "Urban", "Agriculture", "Forest"]
CLASS_ID_TO_BUCKET = {1: "Water", 2: "Wetland", 3: "Urban", 4: "Agriculture", 5: "Forest"}
NAME_TO_BUCKET = {
    "Water": "Water",
    "Wetland": "Wetland",
    "Wetlands": "Wetland",
    "Urban": "Urban",
    "Agriculture": "Agriculture",
    "Forest": "Forest",
    # HYDE class 5 is residual natural land; for share-vector comparison it maps to the same slot as Forest.
    "Natural (residual)": "Forest",
}

DATASETS = ["hilda", "lucas", "hyde", "luh2"]


def load_csv(name: str) -> pd.DataFrame:
    p = OUT / f"{name}_lithuania_timeseries.csv"
    if not p.is_file():
        raise FileNotFoundError(p)
    return pd.read_csv(p)


def year_share_vector(df: pd.DataFrame, year: int) -> np.ndarray | None:
    sub = df[df["year"] == year]
    if sub.empty:
        return None
    counts = {c: 0.0 for c in CLASS_ORDER}
    has_id = "class_id" in df.columns
    for _, row in sub.iterrows():
        key = None
        if has_id and pd.notna(row.get("class_id")):
            try:
                cid = int(row["class_id"])
                if 1 <= cid <= 5:
                    key = CLASS_ID_TO_BUCKET.get(cid)
            except (TypeError, ValueError):
                pass
        if key is None:
            raw = str(row.get("class_name", "")).strip()
            key = NAME_TO_BUCKET.get(raw)
        if key is None:
            continue
        counts[key] += float(row["count"])
    tot = sum(counts.values())
    if tot <= 0:
        return None
    return np.array([counts[c] / tot for c in CLASS_ORDER], dtype=np.float64)


def aligned_matrix(df: pd.DataFrame, years: list[int]) -> tuple[np.ndarray, list[int]]:
    """Rows = years with data, cols = 5 shares."""
    rows = []
    ys = []
    for y in years:
        v = year_share_vector(df, y)
        if v is not None:
            rows.append(v)
            ys.append(y)
    if not rows:
        return np.zeros((0, 5)), []
    return np.stack(rows, axis=0), ys


def rmse(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.sqrt(np.mean((a - b) ** 2)))


def mae(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(np.abs(a - b)))


def cosine_sim(u: np.ndarray, v: np.ndarray) -> float:
    nu, nv = np.linalg.norm(u), np.linalg.norm(v)
    if nu < 1e-12 or nv < 1e-12:
        return 0.0
    return float(np.dot(u, v) / (nu * nv))


def safe_pearson(a: np.ndarray, b: np.ndarray) -> float | None:
    if a.size < 2 or np.std(a) < 1e-15 or np.std(b) < 1e-15:
        return None
    r = np.corrcoef(a, b)[0, 1]
    return None if np.isnan(r) else float(r)


def pearson_per_class(y_cor: np.ndarray, y_mod: np.ndarray) -> list[float | None]:
    out = []
    for j in range(5):
        if y_cor.shape[0] < 2:
            out.append(None)
            continue
        out.append(safe_pearson(y_cor[:, j], y_mod[:, j]))
    return out


def loyo_rf_rmse(X: np.ndarray, y: np.ndarray) -> float:
    """One target column y; features X (same n). Leave-one-year-out mean RMSE."""
    n = X.shape[0]
    if n < 3:
        return float("nan")
    errs = []
    for i in range(n):
        tr = [j for j in range(n) if j != i]
        Xtr, ytr = X[tr], y[tr]
        Xi, yi = X[i : i + 1], y[i]
        model = RandomForestRegressor(
            n_estimators=200, max_depth=3, random_state=42, min_samples_leaf=1
        )
        model.fit(Xtr, ytr)
        pred = model.predict(Xi)[0]
        errs.append((pred - yi) ** 2)
    return float(np.sqrt(np.mean(errs)))


def loyo_ridge_rmse(X: np.ndarray, y: np.ndarray) -> float:
    n = X.shape[0]
    if n < 3:
        return float("nan")
    errs = []
    for i in range(n):
        tr = [j for j in range(n) if j != i]
        Xtr, ytr = X[tr], y[tr]
        Xi, yi = X[i : i + 1], y[i]
        model = Ridge(alpha=1.0)
        model.fit(Xtr, ytr)
        pred = model.predict(Xi)[0]
        errs.append((pred - yi) ** 2)
    return float(np.sqrt(np.mean(errs)))


def national_block(cor_df: pd.DataFrame, mod_df: pd.DataFrame, mod_name: str) -> dict:
    cor_years = sorted(cor_df["year"].unique().tolist())
    X_cor, ylist_cor = aligned_matrix(cor_df, cor_years)
    X_mod, ylist_mod = aligned_matrix(mod_df, cor_years)
    common = sorted(set(ylist_cor) & set(ylist_mod))
    if len(common) < 2:
        return {
            "dataset": mod_name,
            "n_common_years": len(common),
            "years_used": common,
            "error": "Need at least 2 overlapping CORINE years with model data.",
        }

    idx_c = [ylist_cor.index(y) for y in common]
    idx_m = [ylist_mod.index(y) for y in common]
    C = X_cor[idx_c]
    M = X_mod[idx_m]

    diff = M - C
    flat_c = C.ravel()
    flat_m = M.ravel()

    # Classes that actually appear in the dataset (any positive share in overlapping years).
    # Others are implicit zeros only — per-class table should not show RMSE/MAE as "product accuracy".
    eps = 1e-12
    classes_present_in_dataset = [CLASS_ORDER[j] for j in range(5) if float(np.max(M[:, j])) > eps]

    per_class = {}
    for j, cname in enumerate(CLASS_ORDER):
        per_class[cname] = {
            "rmse_share": float(np.sqrt(np.mean(diff[:, j] ** 2))),
            "mae_share": float(np.mean(np.abs(diff[:, j]))),
            "bias_pp": float(np.mean(diff[:, j]) * 100.0),
        }

    pearsons = pearson_per_class(C, M)
    valid_r = [p for p in pearsons if p is not None]

    cosines = [cosine_sim(M[k], C[k]) for k in range(len(common))]

    # R² treating flattened vectors (agreement with CORINE)
    r2_flat = float(r2_score(flat_c, flat_m))

    # LOYO: for each CORINE class, predict from this dataset's 5 shares
    rf_by_class = []
    ridge_by_class = []
    for j in range(5):
        rf_by_class.append(loyo_rf_rmse(M, C[:, j]))
        ridge_by_class.append(loyo_ridge_rmse(M, C[:, j]))

    return {
        "dataset": mod_name,
        "n_common_years": len(common),
        "years_used": common,
        "classes_present_in_dataset": classes_present_in_dataset,
        "rmse_share_all": rmse(M, C),
        "mae_share_all": mae(M, C),
        "mean_abs_bias_pp": float(np.mean(np.abs(diff)) * 100.0),
        "mean_signed_bias_pp": float(np.mean(diff) * 100.0),
        "r2_flat": r2_flat,
        "pearson_r_by_class": {CLASS_ORDER[j]: pearsons[j] for j in range(5)},
        "mean_pearson_r": float(np.mean(valid_r)) if valid_r else None,
        "cosine_similarity_mean": float(np.mean(cosines)),
        "per_class": per_class,
        "ml_loyo_mean_rmse_rf": float(np.nanmean(rf_by_class)),
        "ml_loyo_mean_rmse_ridge": float(np.nanmean(ridge_by_class)),
        "ml_note": "LOYO: each CORINE class share predicted from this dataset’s five shares (same years).",
    }


def subbasin_mean_rmse(ref_key: str, cmp_key: str, year: int) -> float | None:
    p_ref = OUT / f"subbasin_zonal_{ref_key}.csv"
    p_cmp = OUT / f"subbasin_zonal_{cmp_key}.csv"
    if not p_ref.is_file() or not p_cmp.is_file():
        return None
    ref = pd.read_csv(p_ref)
    cmp = pd.read_csv(p_cmp)
    ref = ref[ref["year"] == year]
    cmp = cmp[cmp["year"] == year]
    if ref.empty or cmp.empty:
        return None

    def to_wide(dfp: pd.DataFrame) -> dict[int, np.ndarray]:
        out: dict[int, np.ndarray] = {}
        for bid, g in dfp.groupby("basin_index"):
            counts = {c: 0.0 for c in range(1, 6)}
            for _, r in g.iterrows():
                cid = int(r["class_id"])
                if 1 <= cid <= 5:
                    counts[cid] += float(r["count"])
            tot = sum(counts.values())
            if tot <= 0:
                continue
            out[int(bid)] = np.array([counts[i] / tot for i in range(1, 6)])
        return out

    w_ref = to_wide(ref)
    w_cmp = to_wide(cmp)
    common = sorted(set(w_ref) & set(w_cmp))
    if not common:
        return None
    rmses = [rmse(w_cmp[b], w_ref[b]) for b in common]
    return float(np.mean(rmses))


def main() -> None:
    cor = load_csv("corine")
    cor_years = sorted(cor["year"].unique().tolist())

    national = []
    for name in DATASETS:
        try:
            mod = load_csv(name)
        except FileNotFoundError:
            continue
        national.append(national_block(cor, mod, name))

    subbasin = {}
    for name in DATASETS:
        v = subbasin_mean_rmse("corine", name, 2018)
        if v is not None:
            subbasin[name] = {"year": 2018, "mean_rmse_share_vs_corine": v}

    payload = {
        "reference": "corine",
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "description": (
            "National class shares (0–1) at CORINE snapshot years where both series exist. "
            "RMSE/MAE in share units; bias in percentage points. "
            "ML columns: LOYO RMSE predicting each CORINE class from the product’s five shares."
        ),
        "class_order": CLASS_ORDER,
        "corine_years": cor_years,
        "national": national,
        "subbasin_zonal": subbasin,
        "subbasin_note": "Sub-basins: mean RMSE of five-class vectors vs CORINE (2018) when zonal CSVs exist.",
    }

    out_path = OUT / "dashboard_validation_metrics.json"
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print("Wrote", out_path)


if __name__ == "__main__":
    main()
