// Simple CSV parser: returns array of objects with header keys
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = cols[i] !== undefined ? cols[i].trim() : "";
    });
    return obj;
  });
}

// Global state
const state = {
  hilda: null,
  lucas: null,
  hyde: null,
  luh2: null,
  corine: null,
  yearsByDataset: {
    hilda: [],
    lucas: [],
    hyde: [],
    luh2: [],
    corine: [],
  },
  rasterYearsByDataset: {
    hilda: null,
    lucas: null,
    hyde: null,
    luh2: null,
    corine: null,
  },
  map: {
    instance: null,
    overlay: null,
    basinLayer: null,
    subbasins: null,
    basinsConfig: null,
  },
  charts: {
    trend: null,
    distribution: null,
  },
  /** Pre-computed sub-basin zonal CSV: datasetKey → Map("basin|year" → { counts, total }) | false if missing */
  subbasinZonal: {},
  /** datasetKey → Promise while CSV is loading */
  subbasinZonalLoading: {},
};

let applyFiltersSeq = 0;

/** Matches GeoTIFF class codes (same as Python export) */
const CLASS_ID_TO_NAME = {
  1: "Water",
  2: "Wetland",
  3: "Urban",
  4: "Agriculture",
  5: "Forest",
};
const NAME_TO_CLASS_ID = {
  Water: 1,
  Wetland: 2,
  Urban: 3,
  Agriculture: 4,
  Forest: 5,
  "Natural (residual)": 5,
};

function buildSubbasinZonalIndex(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.year) || !Number.isFinite(r.basin_index)) continue;
    const key = `${r.basin_index}|${r.year}`;
    let cell = m.get(key);
    if (!cell) {
      cell = { counts: {}, total: 0 };
      m.set(key, cell);
    }
    const id = Math.round(Number(r.class_id));
    const c = Number.isFinite(r.count) ? r.count : 0;
    if (id >= 1 && id <= 5) {
      cell.counts[id] = (cell.counts[id] || 0) + c;
      cell.total += c;
    }
  }
  return m;
}

async function ensureSubbasinZonalLoaded(datasetKey) {
  const cached = state.subbasinZonal[datasetKey];
  if (cached instanceof Map) return true;
  if (cached === false) return false;

  if (state.subbasinZonalLoading[datasetKey]) {
    await state.subbasinZonalLoading[datasetKey];
    return state.subbasinZonal[datasetKey] instanceof Map;
  }

  const p = (async () => {
    try {
      const url = `../outputs/subbasin_zonal_${datasetKey}.csv`;
      const resp = await fetch(url);
      if (!resp.ok) {
        state.subbasinZonal[datasetKey] = false;
        return;
      }
      const text = await resp.text();
      const raw = parseCsv(text);
      const rows = raw.map((row) => ({
        year: Number(row.year),
        basin_index: Number(row.basin_index),
        class_id: Number(row.class_id),
        count: Number(row.count),
      }));
      state.subbasinZonal[datasetKey] = buildSubbasinZonalIndex(rows);
    } catch (e) {
      console.warn("Sub-basin zonal CSV load failed", e);
      state.subbasinZonal[datasetKey] = false;
    } finally {
      delete state.subbasinZonalLoading[datasetKey];
    }
  })();

  state.subbasinZonalLoading[datasetKey] = p;
  await p;
  return state.subbasinZonal[datasetKey] instanceof Map;
}

function buildSubbasinTrendPayload(
  index,
  basinIndex,
  selectedClass,
  fromYear,
  toYear,
  availableYears,
  datasetKey,
) {
  const classNamesOrdered = nationalDistributionClassLabels(datasetKey);
  const yearsFiltered = availableYears.filter((y) => {
    if (Number.isFinite(fromYear) && y < fromYear) return false;
    if (Number.isFinite(toYear) && y > toYear) return false;
    return true;
  });
  const labels = yearsFiltered.slice();
  const pickNames =
    selectedClass && selectedClass !== "ALL" ? [selectedClass] : classNamesOrdered;

  const series = pickNames.map((cls) => {
    const idNum = NAME_TO_CLASS_ID[cls];
    return {
      label: cls,
      data: labels.map((y) => {
        const cell = index.get(`${basinIndex}|${y}`);
        if (!cell || cell.total <= 0 || !idNum) return 0;
        const cnt = cell.counts[idNum] || 0;
        return (cnt / cell.total) * 100;
      }),
    };
  });

  return {
    labels,
    series,
    yLabel: "% of basin cells (Python zonal)",
  };
}

function buildSubbasinDistPayload(index, basinIndex, mapYear, datasetKey) {
  if (!Number.isFinite(mapYear)) return { labels: [], values: [] };
  const cell = index.get(`${basinIndex}|${mapYear}`);
  if (!cell || cell.total <= 0) return { labels: [], values: [] };
  const labels = [];
  const values = [];
  nationalDistributionClassLabels(datasetKey).forEach((nm, i) => {
    const id = i + 1;
    const cnt = cell.counts[id] || 0;
    labels.push(nm);
    values.push((cnt / cell.total) * 100);
  });
  return { labels, values };
}

/** National shares for one map year; percentages sum to 100% over classified cells. */
function buildNationalDistributionForYear(rows, mapYear, datasetKey = "hilda") {
  if (!rows?.length || !Number.isFinite(mapYear)) return { labels: [], values: [] };
  const byId = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  rows
    .filter((r) => r.year === mapYear)
    .forEach((r) => {
      let id = Number(r.class_id);
      if (!Number.isFinite(id) || id < 1 || id > 5) {
        const nm = r.class_name === "Wetlands" ? "Wetland" : r.class_name;
        id = NAME_TO_CLASS_ID[nm];
      }
      if (Number.isFinite(id) && id >= 1 && id <= 5) {
        byId[id] += r.count;
      }
    });
  const labels = nationalDistributionClassLabels(datasetKey);
  const total = labels.reduce((s, _, i) => s + byId[i + 1], 0);
  if (total <= 0) return { labels: [], values: [] };
  return {
    labels: labels.slice(),
    values: labels.map((_, i) => (byId[i + 1] / total) * 100),
  };
}

function distributionNonZeroSlices(labels, values) {
  const outL = [];
  const outV = [];
  labels.forEach((lb, i) => {
    const v = values[i];
    if (v > 0) {
      outL.push(lb);
      outV.push(v);
    }
  });
  return { labels: outL, values: outV };
}

async function loadData() {
  // Paths are relative to dashboard/ folder.
  // For simplicity, we serve CSVs from Data/outputs/, so that the
  // static HTTP server rooted at Data can see them.
  try {
    const hildaResp = await fetch("../outputs/hilda_lithuania_timeseries.csv");
    if (hildaResp.ok) {
      const txt = await hildaResp.text();
      state.hilda = parseCsv(txt).map((row) => ({
        year: Number(row.year),
        class_id: Number(row.class_id),
        class_name: row.class_name,
        count: Number(row.count),
      }));
      console.log("Loaded HILDA rows:", state.hilda.length);
      state.yearsByDataset.hilda = Array.from(new Set(state.hilda.map((r) => r.year)))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    }
  } catch (e) {
    console.warn("Could not load HILDA CSV", e);
  }

  try {
    // Updated to use full LUCAS time-series CSV
    const lucasResp = await fetch("../outputs/lucas_lithuania_timeseries.csv");
    if (lucasResp.ok) {
      const txt = await lucasResp.text();
      state.lucas = parseCsv(txt).map((row) => ({
        year: Number(row.year),
        class_name: row.class_name,
        count: Number(row.count),
      }));
      console.log("Loaded LUCAS rows:", state.lucas.length);
      state.yearsByDataset.lucas = Array.from(new Set(state.lucas.map((r) => r.year)))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    }
  } catch (e) {
    console.warn("Could not load LUCAS CSV", e);
  }

  try {
    const hydeResp = await fetch("../outputs/hyde_lithuania_timeseries.csv");
    if (hydeResp.ok) {
      const txt = await hydeResp.text();
      state.hyde = parseCsv(txt).map((row) => ({
        year: Number(row.year),
        class_id: Number(row.class_id),
        class_name: row.class_name,
        count: Number(row.count),
      }));
      console.log("Loaded HYDE rows:", state.hyde.length);
      state.yearsByDataset.hyde = Array.from(new Set(state.hyde.map((r) => r.year)))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    }
  } catch (e) {
    console.warn("Could not load HYDE CSV", e);
  }

  try {
    const luh2Resp = await fetch("../outputs/luh2_lithuania_timeseries.csv");
    if (luh2Resp.ok) {
      const txt = await luh2Resp.text();
      state.luh2 = parseCsv(txt).map((row) => ({
        year: Number(row.year),
        class_name: row.class_name,
        count: Number(row.count),
      }));
      console.log("Loaded LUH2 rows:", state.luh2.length);
      state.yearsByDataset.luh2 = Array.from(new Set(state.luh2.map((r) => r.year)))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    }
  } catch (e) {
    console.warn("Could not load LUH2 CSV", e);
  }

  try {
    const corResp = await fetch("../outputs/corine_lithuania_timeseries.csv");
    if (corResp.ok) {
      const txt = await corResp.text();
      state.corine = parseCsv(txt).map((row) => ({
        year: Number(row.year),
        class_name: row.class_name,
        count: Number(row.count),
      }));
      console.log("Loaded CORINE rows:", state.corine.length);
      state.yearsByDataset.corine = Array.from(new Set(state.corine.map((r) => r.year)))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    }
  } catch (e) {
    console.warn("Could not load CORINE CSV", e);
  }
}

function initMap() {
  const boundsLt = [
    [53.5, 20.5],
    [56.6, 26.7],
  ];

  const map = L.map("map", {
    zoomControl: true,
    maxBounds: boundsLt,
    maxBoundsViscosity: 1.0,
    /** Canvas paths align with raster/tiles in screenshots; SVG + html2canvas often shifts outlines */
    preferCanvas: true,
  }).fitBounds(boundsLt, { padding: [12, 12] });

  map.createPane("basinOutlinePane");
  map.getPane("basinOutlinePane").style.zIndex = "450";

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  // Load basin config and sub-basins, then draw
  Promise.all([
    fetch("basins-config.json").then((r) => (r.ok ? r.json() : null)),
    fetch("../lt_subbasins.json").then((r) => (r.ok ? r.json() : null)),
  ]).then(([config, geojson]) => {
    if (!geojson) return;
    state.map.subbasins = geojson;
    state.map.basinsConfig = config;

    function getBasinName(feature, index) {
      const oid = String(feature.properties?.OBJECTID ?? index);
      const fromConfig = config?.namesByObjectId?.[oid];
      if (fromConfig) return fromConfig;
      const raw = feature.properties?.PAVADINIMA || feature.properties?.pavadinima || "";
      return raw && raw !== "-" ? raw : `Pabaseinis ${index + 1}`;
    }

    const basinSelect = document.getElementById("basin-select");
    if (basinSelect) {
      basinSelect.innerHTML = '<option value="">All Lithuania</option>';
      geojson.features.forEach((f, i) => {
        const name = getBasinName(f, i);
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = name;
        basinSelect.appendChild(opt);
      });
    }

    const layer = L.geoJSON(geojson, {
      pane: "basinOutlinePane",
      interactive: true,
      style: {
        className: "basin-outline-path",
        color: "#1e40af",
        weight: 1.5,
        fill: true,
        fillColor: "#1e40af",
        fillOpacity: 0.02,
      },
      onEachFeature: (feature, leafletLayer) => {
        const idx = geojson.features.indexOf(feature);
        leafletLayer._basinIndex = idx;
        leafletLayer.feature = feature;
        const name = getBasinName(feature, idx);
        leafletLayer.bindTooltip(name, {
          permanent: true,
          direction: "center",
          className: "basin-label",
          interactive: false,
        });
      },
    }).addTo(map);
    state.map.basinLayer = layer;
    map.fitBounds(layer.getBounds(), { padding: [20, 20] });
  }).catch((e) => {
    console.warn("Could not load basins config or lt_subbasins.json", e);
  });

  state.map.instance = map;
  setupMapExport();
  setupBasinZoom();
}

function setupFullscreen() {
  const btn = document.getElementById("map-fullscreen");
  const frame = document.querySelector(".map-frame");
  if (!btn || !frame) return;

  function syncLabel() {
    const isFs = document.fullscreenElement === frame;
    btn.textContent = isFs ? "Exit full screen" : "Full screen";
    // Leaflet needs this after container size changes
    if (state.map.instance) {
      setTimeout(() => state.map.instance.invalidateSize(), 50);
    }
  }

  btn.addEventListener("click", async () => {
    if (document.fullscreenElement === frame) {
      await document.exitFullscreen();
    } else {
      await frame.requestFullscreen();
    }
    syncLabel();
  });

  document.addEventListener("fullscreenchange", syncLabel);
  syncLabel();
}

function getBasinLeafletLayer(basinIndex) {
  const group = state.map.basinLayer;
  if (!group || !Number.isFinite(basinIndex)) return null;
  let found = null;
  group.eachLayer((ly) => {
    if (ly._basinIndex === basinIndex) found = ly;
  });
  return found;
}

/** Sub-basin: map zoom + charts (pre-computed Python CSV when available) */
function setupBasinZoom() {
  const basinSelect = document.getElementById("basin-select");
  if (!basinSelect || !state.map.instance) return;

  basinSelect.addEventListener("change", () => {
    const map = state.map.instance;
    const idx = basinSelect.value;

    if (!idx || idx === "") {
      map.fitBounds([[53.5, 20.5], [56.6, 26.7]], { padding: [20, 20] });
    } else {
      const i = parseInt(idx, 10);
      const layerForFeature = getBasinLeafletLayer(i);
      if (layerForFeature && layerForFeature.getBounds) {
        map.fitBounds(layerForFeature.getBounds(), { padding: [56, 56] });
      }
    }
    setTimeout(() => {
      map.invalidateSize();
      applyFilters();
    }, 0);
  });
}

function getGeotiffUrl(datasetKey, year) {
  const geotiffPaths = {
    hilda: `../rasters/hilda/geotiff/hilda_${year}.tif`,
    lucas: `../rasters/lucas/geotiff/lucas_${year}.tif`,
    hyde: `../rasters/hyde/geotiff/hyde_${year}.tif`,
    luh2: `../rasters/luh2/geotiff/luh2_${year}.tif`,
    corine: `../rasters/corine/geotiff/corine_${year}.tif`,
  };
  return geotiffPaths[datasetKey] || null;
}

async function getGeorasterCached(datasetKey, year) {
  const url = getGeotiffUrl(datasetKey, year);
  if (!url) return null;
  // Always fetch fresh: disk cache + in-memory cache both caused maps to disagree with re-exported CSVs
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) return null;
  const buf = await resp.arrayBuffer();
  if (typeof parseGeoraster === "undefined") return null;
  return parseGeoraster(buf);
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function escapeCsvCell(s) {
  const t = String(s ?? "");
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

const FIVE_CLASSES_ORDER = ["Water", "Wetland", "Urban", "Agriculture", "Forest"];

/** Display labels for national/sub-basin charts (HYDE class 5 is not a forest layer). */
function nationalDistributionClassLabels(datasetKey) {
  if (datasetKey === "hyde") {
    return ["Water", "Wetland", "Urban", "Agriculture", "Natural (residual)"];
  }
  return FIVE_CLASSES_ORDER.slice();
}

/** Map CSV class_name (e.g. CORINE "Wetlands") to canonical 5-class id for zonal export */
function csvClassNameToBasinClassId(csvName) {
  if (!csvName || csvName === "ALL") return null;
  const norm = csvName === "Wetlands" ? "Wetland" : csvName;
  return NAME_TO_CLASS_ID[norm] ?? null;
}

function readFilterYearRange() {
  const fromEl = document.getElementById("year-from");
  const toEl = document.getElementById("year-to");
  const fromY = fromEl?.value !== undefined && fromEl.value !== "" ? Number(fromEl.value) : NaN;
  const toY = toEl?.value !== undefined && toEl.value !== "" ? Number(toEl.value) : NaN;
  return {
    fromY: Number.isFinite(fromY) ? fromY : NaN,
    toY: Number.isFinite(toY) ? toY : NaN,
  };
}

/**
 * Years to export: basin → union of zonal years for that basin; else national CSV/raster years.
 * Empty from/to → all years in pool; partial range clamps to pool bounds.
 */
function resolveExportYears(datasetKey, basinIndex) {
  const { fromY, toY } = readFilterYearRange();
  const rasterYears = state.rasterYearsByDataset[datasetKey];
  const csvYears = state.yearsByDataset[datasetKey] || [];
  const nationalPool = (rasterYears !== null && rasterYears.length ? rasterYears : csvYears)
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b);

  let pool;
  if (Number.isFinite(basinIndex)) {
    const idx = state.subbasinZonal[datasetKey];
    if (!(idx instanceof Map)) {
      return { years: [], error: "zonal" };
    }
    const ys = new Set();
    idx.forEach((_, key) => {
      const parts = String(key).split("|");
      const bi = Number(parts[0]);
      const y = Number(parts[1]);
      if (bi === basinIndex && Number.isFinite(y)) ys.add(y);
    });
    pool = Array.from(ys).sort((a, b) => a - b);
    if (!pool.length) {
      return { years: [], error: "basin_years" };
    }
  } else {
    pool = nationalPool;
    if (!pool.length) {
      return { years: [], error: "national_years" };
    }
  }

  const hasFrom = Number.isFinite(fromY);
  const hasTo = Number.isFinite(toY);
  if (!hasFrom && !hasTo) {
    return { years: pool, error: null };
  }

  let lo;
  let hi;
  if (hasFrom && hasTo) {
    lo = Math.min(fromY, toY);
    hi = Math.max(fromY, toY);
  } else if (hasFrom) {
    lo = fromY;
    hi = pool[pool.length - 1];
  } else {
    lo = pool[0];
    hi = toY;
  }

  const years = pool.filter((y) => y >= lo && y <= hi);
  return { years, error: years.length ? null : "range_empty" };
}

const EXPORT_HEADER = [
  "Subbasin",
  "Land_cover_type",
  "Area_cells",
  "Percentage",
  "Dataset",
  "Year",
  "Note",
];

function appendNationalRowsForYear(aoa, datasetKey, year, selectedClass, noteNat) {
  const data = state[datasetKey];
  if (!data?.length) return;
  const filtered = data.filter((r) => r.year === year);
  const byClass = {};
  filtered.forEach((r) => {
    byClass[r.class_name] = (byClass[r.class_name] || 0) + r.count;
  });
  const totalNat = Object.values(byClass).reduce((s, v) => s + v, 0);
  let classNames = Object.keys(byClass).sort();
  if (selectedClass && selectedClass !== "ALL") {
    classNames = classNames.filter((c) => c === selectedClass);
  }
  classNames.forEach((cls) => {
    const cnt = byClass[cls];
    const pct = totalNat > 0 ? (cnt / totalNat) * 100 : 0;
    aoa.push(["Lithuania (national)", cls, cnt, Number(pct.toFixed(4)), datasetKey, year, noteNat]);
  });
}

function appendBasinRowsForYear(aoa, datasetKey, year, basinIndex, basinName, selectedClass, noteBas, index) {
  const cell = index.get(`${basinIndex}|${year}`);
  const total = cell?.total ?? 0;
  let classes = nationalDistributionClassLabels(datasetKey).slice();
  if (selectedClass && selectedClass !== "ALL") {
    const wantId = csvClassNameToBasinClassId(selectedClass);
    if (!wantId) return;
    classes = classes.filter((c) => NAME_TO_CLASS_ID[c] === wantId);
  }
  classes.forEach((cls) => {
    const id = NAME_TO_CLASS_ID[cls];
    const cnt = cell?.counts[id] ?? 0;
    const pct = total > 0 ? (cnt / total) * 100 : 0;
    aoa.push([basinName, cls, cnt, Number(pct.toFixed(4)), datasetKey, year, noteBas]);
  });
}

function buildExportDataAoas(datasetKey, years, basinIndex, basinName, selectedClass) {
  const noteNat =
    "National: outputs/*_lithuania_timeseries.csv (counts in range of selected years).";
  const noteBas =
    "Sub-basin: outputs/subbasin_zonal_*.csv (GeoTIFF zonal counts per year).";

  const byYear = [EXPORT_HEADER.slice()];
  const dataRowsFlat = [];

  if (Number.isFinite(basinIndex)) {
    const index = state.subbasinZonal[datasetKey];
    years.forEach((year, yi) => {
      const startLen = byYear.length;
      appendBasinRowsForYear(byYear, datasetKey, year, basinIndex, basinName, selectedClass, noteBas, index);
      for (let r = startLen; r < byYear.length; r++) {
        dataRowsFlat.push(byYear[r]);
      }
      if (yi < years.length - 1) {
        byYear.push(new Array(EXPORT_HEADER.length).fill(""));
      }
    });
  } else {
    years.forEach((year, yi) => {
      const startLen = byYear.length;
      appendNationalRowsForYear(byYear, datasetKey, year, selectedClass, noteNat);
      for (let r = startLen; r < byYear.length; r++) {
        dataRowsFlat.push(byYear[r]);
      }
      if (yi < years.length - 1) {
        byYear.push(new Array(EXPORT_HEADER.length).fill(""));
      }
    });
  }

  const sortedBody = dataRowsFlat
    .slice()
    .sort((a, b) => {
      const t = String(a[1]).localeCompare(String(b[1]));
      if (t !== 0) return t;
      const s = String(a[0]).localeCompare(String(b[0]));
      if (s !== 0) return s;
      return Number(a[5]) - Number(b[5]);
    });
  const byClass = [EXPORT_HEADER.slice(), ...sortedBody];

  return { byYear, byClass, rowCount: dataRowsFlat.length };
}

function buildExportInfoAoa(datasetKey, years, basinIndex, basinName, selectedClass) {
  const { fromY, toY } = readFilterYearRange();
  const yLabel =
    years.length === 0
      ? "—"
      : years.length === 1
        ? String(years[0])
        : `${years[0]}–${years[years.length - 1]} (${years.length} years)`;
  const rangeInput =
    Number.isFinite(fromY) || Number.isFinite(toY)
      ? `${Number.isFinite(fromY) ? fromY : "…"} – ${Number.isFinite(toY) ? toY : "…"}`
      : "(empty = all years available for this scope)";
  return [
    ["Land cover export — filters used"],
    [],
    ["Dataset", datasetKey],
    ["Scope", Number.isFinite(basinIndex) ? `Sub-basin: ${basinName}` : "National (whole Lithuania)"],
    ["Years in this file", yLabel],
    ["Year range fields (sidebar)", rangeInput],
    ["Class filter", selectedClass === "ALL" ? "All classes" : selectedClass],
    [],
    [
      "Charts sheet",
      "Embedded PNG figures from Chart.js: pie = latest year in this export; line = class share (%) vs year (same filters as data).",
    ],
    [],
    ["Reading the workbook"],
    [
      "By year",
      "Rows grouped by calendar year; a blank row separates each year for readability. Enable AutoFilter on the header row.",
    ],
    [
      "By class",
      "Same data sorted by land-cover type, then basin, then year — convenient for comparing one class across years.",
    ],
  ];
}

function applyLandCoverSheetLayout(ws) {
  ws["!cols"] = [
    { wch: 36 },
    { wch: 16 },
    { wch: 12 },
    { wch: 12 },
    { wch: 10 },
    { wch: 8 },
    { wch: 72 },
  ];
  if (ws["!ref"]) {
    ws["!autofilter"] = { ref: ws["!ref"] };
  }
  ws["!views"] = [{ ySplit: 1, xSplit: 0, topLeftCell: "A2", activeCell: "A2", state: "frozen" }];
}

const EXPORT_CHART_COLORS = {
  Water: "rgba(77,166,255,0.95)",
  Wetland: "rgba(123,104,238,0.95)",
  Wetlands: "rgba(123,104,238,0.95)",
  Urban: "rgba(255,77,77,0.95)",
  Agriculture: "rgba(255,210,77,0.95)",
  Forest: "rgba(34,139,34,0.95)",
  "Natural (residual)": "rgba(34,139,34,0.95)",
};

function exportChartColorForClass(name) {
  return EXPORT_CHART_COLORS[name] || "rgba(100,116,139,0.9)";
}

/** Percentage by class and year (matches export filters) for chart layer */
function collectSharesForExportCharts(datasetKey, years, basinIndex, selectedClass) {
  if (!years.length) return null;
  const latestYear = years[years.length - 1];

  if (Number.isFinite(basinIndex)) {
    const index = state.subbasinZonal[datasetKey];
    if (!(index instanceof Map)) return null;
    let classes = nationalDistributionClassLabels(datasetKey).slice();
    if (selectedClass && selectedClass !== "ALL") {
      const wantId = csvClassNameToBasinClassId(selectedClass);
      if (!wantId) return { classes: [], byYear: {}, latestYear, scope: "basin" };
      classes = classes.filter((c) => NAME_TO_CLASS_ID[c] === wantId);
    }
    const byYear = {};
    years.forEach((year) => {
      const cell = index.get(`${basinIndex}|${year}`);
      const total = cell?.total ?? 0;
      const row = {};
      classes.forEach((cls) => {
        const id = NAME_TO_CLASS_ID[cls];
        const cnt = cell?.counts[id] ?? 0;
        row[cls] = total > 0 ? (cnt / total) * 100 : 0;
      });
      byYear[year] = row;
    });
    return { classes, byYear, latestYear, scope: "basin" };
  }

  const data = state[datasetKey];
  if (!data?.length) return null;
  const classSet = new Set();
  years.forEach((year) => {
    data.filter((r) => r.year === year).forEach((r) => classSet.add(r.class_name));
  });
  let classes = Array.from(classSet).sort();
  if (selectedClass && selectedClass !== "ALL") {
    classes = classes.filter((c) => c === selectedClass);
  }
  const byYear = {};
  years.forEach((year) => {
    const filtered = data.filter((r) => r.year === year);
    const agg = {};
    filtered.forEach((r) => {
      agg[r.class_name] = (agg[r.class_name] || 0) + r.count;
    });
    const tot = classes.reduce((s, c) => s + (agg[c] || 0), 0);
    const row = {};
    classes.forEach((c) => {
      row[c] = tot > 0 ? ((agg[c] || 0) / tot) * 100 : 0;
    });
    byYear[year] = row;
  });
  return { classes, byYear, latestYear, scope: "national" };
}

function applyExcelJsLandCoverSheet(worksheet, aoa) {
  const widths = [36, 16, 12, 12, 10, 8, 72];
  widths.forEach((w, i) => {
    worksheet.getColumn(i + 1).width = w;
  });
  aoa.forEach((row, ri) => {
    const excelRow = worksheet.getRow(ri + 1);
    row.forEach((val, ci) => {
      const cell = excelRow.getCell(ci + 1);
      if (val === "" || val === null || val === undefined) {
        cell.value = "";
      } else if (typeof val === "number" && Number.isFinite(val)) {
        cell.value = val;
      } else {
        cell.value = val;
      }
    });
  });
  const lastRow = Math.max(1, aoa.length);
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: lastRow, column: EXPORT_HEADER.length },
  };
  worksheet.views = [{ state: "frozen", ySplit: 1, xSplit: 0, topLeftCell: "A2", activeCell: "A2" }];
}

function buildPieChartConfig(classes, byYear, latestYear, titleSuffix) {
  const row = byYear[latestYear] || {};
  const pairs = classes.map((c) => ({ c, v: row[c] ?? 0 })).filter((p) => p.v > 0.0001);
  if (!pairs.length) return null;
  return {
    type: "pie",
    data: {
      labels: pairs.map((p) => p.c),
      datasets: [
        {
          data: pairs.map((p) => Number(p.v.toFixed(3))),
          backgroundColor: pairs.map((p) => exportChartColorForClass(p.c)),
          borderColor: "#ffffff",
          borderWidth: 1,
        },
      ],
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: `Land cover ${titleSuffix} — ${latestYear} (%)`,
          font: { size: 14 },
        },
        legend: { position: "right", labels: { boxWidth: 11, font: { size: 11 } } },
      },
    },
  };
}

function buildLineChartConfig(classes, byYear, years, titleSuffix) {
  if (!classes.length) return null;
  return {
    type: "line",
    data: {
      labels: years.map(String),
      datasets: classes.map((c) => ({
        label: c,
        data: years.map((y) => Number((byYear[y]?.[c] ?? 0).toFixed(4))),
        borderColor: exportChartColorForClass(c),
        backgroundColor: exportChartColorForClass(c).replace("0.95", "0.15"),
        fill: false,
        tension: 0.25,
        pointRadius: years.length > 40 ? 0 : 3,
        borderWidth: 2,
      })),
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: `Class share over time ${titleSuffix} (%)`,
          font: { size: 14 },
        },
        legend: {
          position: "bottom",
          labels: { boxWidth: 10, font: { size: 10 } },
        },
      },
      scales: {
        x: { title: { display: true, text: "Year" } },
        y: {
          beginAtZero: true,
          suggestedMax: 100,
          title: { display: true, text: "Share (%)" },
        },
      },
    },
  };
}

/**
 * Renders Chart.js off-screen (native Excel charts are not available from browser APIs;
 * embedded PNGs open correctly in Excel / LibreOffice).
 */
async function renderChartJsToDataUrl(chartConfig, width, height) {
  if (typeof Chart === "undefined" || !chartConfig) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = "position:fixed;left:-99999px;top:0;width:1px;height:1px;opacity:0.01;";
  document.body.appendChild(canvas);
  try {
    const ctx = canvas.getContext("2d");
    const { type, data, options: innerOpts } = chartConfig;
    const chart = new Chart(ctx, {
      type,
      data,
      options: {
        responsive: false,
        maintainAspectRatio: false,
        devicePixelRatio: 2,
        animation: false,
        ...(innerOpts || {}),
      },
    });
    chart.update("none");
    const dataUrl = canvas.toDataURL("image/png");
    chart.destroy();
    return dataUrl;
  } catch (e) {
    console.warn("Chart.js render for Excel export failed", e);
    return null;
  } finally {
    canvas.remove();
  }
}

async function writeLandCoverWorkbookExcelJs(filename, byYear, byClass, infoAoa, chartCtx) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Lithuania land cover dashboard";
  wb.created = new Date();

  const wsY = wb.addWorksheet("By year");
  applyExcelJsLandCoverSheet(wsY, byYear);

  const wsC = wb.addWorksheet("By class");
  applyExcelJsLandCoverSheet(wsC, byClass);

  const wsI = wb.addWorksheet("Export info");
  wsI.getColumn(1).width = 22;
  wsI.getColumn(2).width = 72;
  infoAoa.forEach((row, ri) => {
    const r = wsI.getRow(ri + 1);
    row.forEach((v, ci) => {
      r.getCell(ci + 1).value = v === undefined || v === null ? "" : v;
    });
  });

  const fig = wb.addWorksheet("Charts");
  const classes = chartCtx?.classes ?? [];
  const shareByYear = chartCtx?.byYear ?? {};
  const exportYears = chartCtx?.years ?? [];
  const latestYear = chartCtx?.latestYear ?? exportYears[exportYears.length - 1];
  const titleSuffix =
    chartCtx?.scope === "basin" && chartCtx?.basinName
      ? `(${chartCtx.basinName})`
      : "(national)";

  let anchorRow = 0.3;
  fig.getCell(1, 1).value = `Pie — latest exported year (${latestYear})`;
  fig.getCell(1, 1).font = { bold: true, size: 12 };

  const pieCfg = buildPieChartConfig(classes, shareByYear, latestYear, titleSuffix);
  if (pieCfg && classes.length) {
    const pieUrl = await renderChartJsToDataUrl(pieCfg, 580, 440);
    if (pieUrl) {
      const id = wb.addImage({ base64: pieUrl.split(",")[1], extension: "png" });
      fig.addImage(id, { tl: { col: 0, row: anchorRow }, ext: { width: 520, height: 400 } });
      anchorRow += 24;
    } else {
      fig.getCell(3, 1).value = "(Pie chart could not be rendered.)";
      anchorRow = 4;
    }
  } else {
    fig.getCell(3, 1).value = "(No non-zero classes for pie chart.)";
    anchorRow = 4;
  }

  const titleRow = Math.ceil(anchorRow) + 1;
  fig.getCell(titleRow, 1).value = "Line — class share (%) vs year";
  fig.getCell(titleRow, 1).font = { bold: true, size: 12 };
  anchorRow = titleRow + 0.3;

  const lineCfg = buildLineChartConfig(classes, shareByYear, exportYears, titleSuffix);
  if (lineCfg && classes.length && exportYears.length) {
    const lineUrl = await renderChartJsToDataUrl(lineCfg, 780, 420);
    if (lineUrl) {
      const id2 = wb.addImage({ base64: lineUrl.split(",")[1], extension: "png" });
      fig.addImage(id2, { tl: { col: 0, row: anchorRow }, ext: { width: 700, height: 400 } });
    } else {
      fig.getCell(Math.ceil(anchorRow) + 2, 1).value = "(Line chart could not be rendered.)";
    }
  } else {
    fig.getCell(Math.ceil(anchorRow) + 2, 1).value = "(Not enough data for line chart.)";
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Lithuania bounds (WGS84), same as map maxBounds — used for full-map export framing */
const LT_OVERVIEW_BOUNDS = L.latLngBounds(
  [53.5, 20.5],
  [56.6, 26.7],
);

/**
 * After fitBounds / setView, wait for Leaflet + tiles/raster to settle before html2canvas.
 */
function waitMapSettled(map, timeoutMs = 1600, postRafDelayMs = 450) {
  return new Promise((resolve) => {
    if (!map) {
      resolve();
      return;
    }
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(tid);
      map.off("moveend zoomend", onIdle);
      map.invalidateSize(false);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(resolve, postRafDelayMs);
        });
      });
    };
    const onIdle = () => done();
    map.on("moveend zoomend", onIdle);
    const tid = setTimeout(done, timeoutMs);
    map.invalidateSize(false);
  });
}

/**
 * Excel (or CSV) from Filters: year range, optional sub-basin, optional class.
 * — National: timeseries CSV only, all years in range (or all years if From/To empty).
 * — Sub-basin: zonal CSV for that basin; years from zonal keys, filtered by range or all if empty.
 */
async function exportLandCoverSummaryXlsx() {
  const datasetKey = document.getElementById("dataset-select")?.value || "hilda";
  const classSelect = document.getElementById("class-select");
  const selectedClass = classSelect?.value || "ALL";
  const basinSelect = document.getElementById("basin-select");
  const basinVal = basinSelect?.value;
  const basinIndex =
    basinVal === "" || basinVal === undefined || basinVal == null ? NaN : parseInt(basinVal, 10);

  if (!state[datasetKey]?.length) {
    alert("No timeseries data loaded for this dataset.");
    return;
  }

  if (Number.isFinite(basinIndex)) {
    await ensureSubbasinZonalLoaded(datasetKey);
    if (!(state.subbasinZonal[datasetKey] instanceof Map)) {
      alert("Sub-basin export requires zonal statistics for this dataset.");
      return;
    }
  }

  const { years, error } = resolveExportYears(datasetKey, basinIndex);
  if (error === "range_empty") {
    alert(
      "No years fall in the selected range. Clear Year range (From/To) or widen it, then try again.",
    );
    return;
  }
  if (error === "basin_years") {
    alert("No zonal statistics found for this sub-basin in the CSV.");
    return;
  }
  if (error === "national_years") {
    alert("No national years available for this dataset.");
    return;
  }
  if (!years.length) {
    alert("Nothing to export for the current filters.");
    return;
  }

  const basinName =
    Number.isFinite(basinIndex) && basinSelect
      ? basinSelect.selectedOptions?.[0]?.textContent?.trim() || `Basin_${basinIndex}`
      : "";

  const { byYear, byClass, rowCount } = buildExportDataAoas(
    datasetKey,
    years,
    basinIndex,
    basinName,
    selectedClass,
  );

  if (rowCount === 0) {
    alert(
      "No rows match the export (try a different class or year range). For a single class, pick one that exists in this dataset.",
    );
    return;
  }

  const safeDs = datasetKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  const scope = Number.isFinite(basinIndex) ? "basin" : "national";
  const y0 = years[0];
  const y1 = years[years.length - 1];
  const yearTag = years.length === 1 ? String(y0) : `${y0}-${y1}`;
  const filename = `landcover_${safeDs}_${scope}_${yearTag}.xlsx`;

  const chartCtx = collectSharesForExportCharts(datasetKey, years, basinIndex, selectedClass);

  if (typeof ExcelJS !== "undefined" && ExcelJS.Workbook) {
    try {
      await writeLandCoverWorkbookExcelJs(
        filename,
        byYear,
        byClass,
        buildExportInfoAoa(datasetKey, years, basinIndex, basinName, selectedClass),
        chartCtx
          ? { ...chartCtx, years, basinName }
          : {
              classes: [],
              byYear: {},
              latestYear: y1,
              years,
              basinName,
              scope,
            },
      );
      return;
    } catch (e) {
      console.warn("ExcelJS export failed; trying SheetJS (tables only, no chart images)", e);
    }
  }

  if (typeof XLSX !== "undefined" && XLSX.utils && XLSX.utils.book_new) {
    const wb = XLSX.utils.book_new();
    const wsYear = XLSX.utils.aoa_to_sheet(byYear);
    applyLandCoverSheetLayout(wsYear);
    XLSX.utils.book_append_sheet(wb, wsYear, "By year");

    const wsClass = XLSX.utils.aoa_to_sheet(byClass);
    applyLandCoverSheetLayout(wsClass);
    XLSX.utils.book_append_sheet(wb, wsClass, "By class");

    const wsInfo = XLSX.utils.aoa_to_sheet(
      buildExportInfoAoa(datasetKey, years, basinIndex, basinName, selectedClass),
    );
    wsInfo["!cols"] = [{ wch: 22 }, { wch: 72 }];
    XLSX.utils.book_append_sheet(wb, wsInfo, "Export info");

    XLSX.writeFile(wb, filename);
    return;
  }

  const lines = byYear.map((row) => row.map((c) => escapeCsvCell(c)).join(","));
  const bom = "\uFEFF";
  downloadTextFile(
    filename.replace(/\.xlsx$/i, "_by_year.csv"),
    bom + lines.join("\n"),
    "text/csv;charset=utf-8",
  );
  const lines2 = byClass.map((row) => row.map((c) => escapeCsvCell(c)).join(","));
  downloadTextFile(
    filename.replace(/\.xlsx$/i, "_by_class.csv"),
    bom + lines2.join("\n"),
    "text/csv;charset=utf-8",
  );
  alert(
    "Excel libraries did not load; downloaded two CSV files (by year + by class). Load exceljs + xlsx from CDN for .xlsx with chart images.",
  );
}

function setupMapExport() {
  const mapContainer = document.querySelector(".map-container");
  const menuBtn = document.getElementById("export-menu-btn");
  const menu = document.getElementById("export-menu");
  const dropdown = document.getElementById("export-dropdown");
  if (!mapContainer || typeof html2canvas === "undefined") return;

  function closeMenu() {
    if (menu) {
      menu.hidden = true;
      if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
    }
  }

  function openMenu() {
    if (menu) {
      menu.hidden = false;
      if (menuBtn) menuBtn.setAttribute("aria-expanded", "true");
    }
  }

  /**
   * Snapshot #map — prefer html-to-image (Leaflet panes use translate3d; html2canvas often misaligns SVG vs tiles).
   */
  async function captureAndDownload(filename, pixelRatio) {
    const pr = pixelRatio || 2.5;
    const map = state.map.instance;
    let restoreTooltips = () => {};
    if (map) {
      const pane = map.getPane("tooltipPane");
      if (pane) {
        const prev = pane.style.visibility;
        pane.style.visibility = "hidden";
        restoreTooltips = () => {
          pane.style.visibility = prev;
        };
      }
    }
    try {
      const hi = typeof window !== "undefined" && window.htmlToImage ? window.htmlToImage : null;
      if (hi && typeof hi.toPng === "function") {
        try {
          const dataUrl = await hi.toPng(mapContainer, {
            cacheBust: true,
            pixelRatio: pr,
            backgroundColor: "#f8fafc",
          });
          const link = document.createElement("a");
          link.download = filename;
          link.href = dataUrl;
          link.click();
          return;
        } catch (e) {
          console.warn("html-to-image failed, falling back to html2canvas", e);
        }
      }
      const canvas = await html2canvas(mapContainer, {
        useCORS: true,
        allowTaint: true,
        backgroundColor: "#f8fafc",
        scale: pr,
        logging: false,
      });
      const link = document.createElement("a");
      link.download = filename;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } finally {
      restoreTooltips();
    }
  }

  if (menuBtn && menu) {
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menu.hidden) openMenu();
      else closeMenu();
    });
    document.addEventListener("click", () => closeMenu());
    dropdown?.addEventListener("click", (e) => e.stopPropagation());

    menu.querySelectorAll("[data-export]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const kind = btn.getAttribute("data-export");
        closeMenu();
        const ds = document.getElementById("dataset-select")?.value || "map";
        const yr = document.getElementById("year-label")?.textContent || "";

        if (kind === "map-png") {
          const map = state.map.instance;
          if (!map) {
            await captureAndDownload(`lithuania_landcover_${ds}_${yr || "full"}.png`, 3.25);
            return;
          }
          const center = map.getCenter();
          const zoom = map.getZoom();
          // Fit Lithuania tightly to the map div (no extra geographic pad / maxZoom cap — those zoomed out too far)
          map.fitBounds(LT_OVERVIEW_BOUNDS, { padding: [20, 20], animate: false });
          await waitMapSettled(map, 1800, 480);
          await captureAndDownload(`lithuania_landcover_${ds}_${yr || "full"}.png`, 3.25);
          map.setView(center, zoom, { animate: false });
          map.invalidateSize(false);
          return;
        }

        if (kind === "basin-png") {
          const sel = document.getElementById("basin-select")?.value;
          if (!sel) {
            alert('Choose a sub-basin in Filters → Sub-basin first.');
            return;
          }
          const map = state.map.instance;
          const i = parseInt(sel, 10);
          const leafletLayer = getBasinLeafletLayer(i);
          if (!map || !leafletLayer?.getBounds) {
            alert("Could not find sub-basin geometry.");
            return;
          }
          const basinName =
            document.getElementById("basin-select")?.selectedOptions?.[0]?.textContent || "basin";
          const safe = basinName.replace(/[^a-zA-Z0-9\u0080-\u024F\s-]/g, "").replace(/\s+/g, "_");

          const center = map.getCenter();
          const zoom = map.getZoom();
          const bounds = leafletLayer.getBounds().pad(0.06);
          map.fitBounds(bounds, { padding: [28, 28], animate: false, maxZoom: 18 });
          await waitMapSettled(map, 1800, 480);
          await captureAndDownload(`${safe}_${ds}_${yr || "full"}.png`, 3);
          map.setView(center, zoom, { animate: false });
          map.invalidateSize(false);
          return;
        }

        if (kind === "excel-xlsx") {
          const hint = document.getElementById("map-overlay-hint");
          if (hint) hint.textContent = "Building summary workbook…";
          try {
            await exportLandCoverSummaryXlsx();
          } finally {
            if (hint) {
              const y = document.getElementById("year-label")?.textContent;
              hint.textContent = y && y !== "—" ? `Showing raster (GeoTIFF) ${y}` : "";
            }
          }
        }
      });
    });
  }
}

// CORINE 5-class colors (match export)
const CORINE_COLORS = {
  1: "#4DA6FF", // Water
  2: "#7B68EE", // Wetland
  3: "#FF4D4D", // Urban
  4: "#FFD24D", // Agriculture
  5: "#228B22", // Forest
};

// Update raster overlay for given dataset/year.
// All datasets: GeoTIFF rasters only (no PNG fallback).
function makeLandcoverRasterLayer(georaster) {
  return new GeoRasterLayer({
    georaster,
    opacity: 0.82,
    // Higher resolution + rounded class ids: GeoRasterLayer resamples rasters; without rounding,
    // categorical 1–5 become floats (e.g. 4.37) and CORINE_COLORS[v] is undefined → transparent
    // pixels, so forest/agriculture look like scattered dots while CSV stats stay correct.
    resolution: 512,
    pixelValuesToColorFn: (values) => {
      const raw = values[0];
      if (raw == null || !Number.isFinite(raw)) return null;
      if (raw === 0) return null;
      const v = Math.round(raw);
      if (v < 1 || v > 5) return null;
      return CORINE_COLORS[v] || null;
    },
  });
}

async function updateRasterOverlay(datasetKey, year) {
  const map = state.map.instance;
  if (!map || !Number.isFinite(year)) return;

  const hint = document.getElementById("map-overlay-hint");

  if (state.map.overlay) {
    map.removeLayer(state.map.overlay);
    state.map.overlay = null;
  }

  if (typeof parseGeoraster === "undefined" || typeof GeoRasterLayer === "undefined") {
    if (hint) hint.textContent = "GeoTIFF libraries not loaded.";
    return;
  }

  const tifUrl = getGeotiffUrl(datasetKey, year);
  if (!tifUrl) {
    if (hint) hint.textContent = "No GeoTIFF path for dataset.";
    return;
  }

  try {
    const georaster = await getGeorasterCached(datasetKey, year);
    if (!georaster) {
      if (hint) hint.textContent = `No GeoTIFF for ${year}.`;
      return;
    }

    const layerMain = makeLandcoverRasterLayer(georaster);
    layerMain.addTo(map);
    state.map.overlay = layerMain;

    const mainEl = layerMain.getContainer?.();
    if (mainEl) mainEl.style.pointerEvents = "none";

    if (state.map.basinLayer && typeof state.map.basinLayer.bringToFront === "function") {
      state.map.basinLayer.bringToFront();
    }

    if (hint) hint.textContent = `Showing raster (GeoTIFF) ${year}`;
  } catch (e) {
    console.warn(`${datasetKey} GeoTIFF load failed:`, e);
    if (hint) hint.textContent = `GeoTIFF load failed for ${year}.`;
  }
}

async function scanRasterYears(datasetKey) {
  const candidates = state.yearsByDataset[datasetKey] || [];
  if (candidates.length === 0) {
    state.rasterYearsByDataset[datasetKey] = [];
    return [];
  }

  const hint = document.getElementById("map-overlay-hint");
  if (hint) hint.textContent = "Scanning available rasters…";

  const found = [];
  const geotiffPaths = {
    hilda: (y) => `../rasters/hilda/geotiff/hilda_${y}.tif`,
    lucas: (y) => `../rasters/lucas/geotiff/lucas_${y}.tif`,
    hyde: (y) => `../rasters/hyde/geotiff/hyde_${y}.tif`,
    luh2: (y) => `../rasters/luh2/geotiff/luh2_${y}.tif`,
    corine: (y) => `../rasters/corine/geotiff/corine_${y}.tif`,
  };
  const tifPath = geotiffPaths[datasetKey];
  for (const year of candidates) {
    if (tifPath) {
      try {
        const r = await fetch(tifPath(year), { method: "HEAD" });
        if (r.ok) found.push(year);
      } catch (_) {}
    }
  }

  state.rasterYearsByDataset[datasetKey] = found;
  if (hint) {
    hint.textContent =
      found.length > 0 ? `Found ${found.length} GeoTIFF year(s).` : "No GeoTIFF files found.";
  }
  return found;
}

function collectClasses(datasetRows) {
  if (!datasetRows) return [];
  const set = new Set(datasetRows.map((r) => r.class_name));
  return Array.from(set).sort();
}

function populateClassDropdown(datasetKey) {
  const select = document.getElementById("class-select");
  select.innerHTML = "";

  const rows = state[datasetKey];
  const classes = collectClasses(rows);

   // "ALL" option at the top
  const allOpt = document.createElement("option");
  allOpt.value = "ALL";
  allOpt.textContent = "All classes";
  select.appendChild(allOpt);

  classes.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
}

function setLegend(datasetKey) {
  const el = document.getElementById("map-legend");
  if (!el) return;

  const legends = {
    hilda: {
      title: "Legend (HILDA+ v2.0)",
      items: [
        { label: "Water", color: "#4DA6FF" },
        { label: "Wetland", color: "#7B68EE" },
        { label: "Urban", color: "#FF4D4D" },
        { label: "Agriculture", color: "#FFD24D" },
        { label: "Forest", color: "#228B22" },
      ],
    },
    lucas: {
      title: "Legend (LUCAS dominant)",
      items: [
        { label: "Water", color: "#4DA6FF" },
        { label: "Wetland", color: "#7B68EE" },
        { label: "Urban", color: "#FF4D4D" },
        { label: "Agriculture", color: "#FFD24D" },
        { label: "Forest", color: "#228B22" },
      ],
    },
    hyde: {
      title: "Legend (HYDE 3.4 — residual land, not forest inventory)",
      items: [
        { label: "Water", color: "#4DA6FF" },
        { label: "Wetland", color: "#7B68EE" },
        { label: "Urban", color: "#FF4D4D" },
        { label: "Agriculture", color: "#FFD24D" },
        { label: "Natural (residual)", color: "#228B22" },
      ],
    },
    luh2: {
      title: "Legend (LUH2 v2h)",
      items: [
        { label: "Water", color: "#4DA6FF" },
        { label: "Wetland", color: "#7B68EE" },
        { label: "Urban", color: "#FF4D4D" },
        { label: "Agriculture", color: "#FFD24D" },
        { label: "Forest", color: "#228B22" },
      ],
    },
    corine: {
      title: "Legend (CORINE CLC, validation)",
      items: [
        { label: "Water", color: "#4DA6FF" },
        { label: "Wetland", color: "#7B68EE" },
        { label: "Urban", color: "#FF4D4D" },
        { label: "Agriculture", color: "#FFD24D" },
        { label: "Forest", color: "#228B22" },
      ],
    },
  };

  const cfg = legends[datasetKey] || legends.hilda;
  const itemsHtml = cfg.items
    .map(
      (it) =>
        `<div class="legend-item"><span class="legend-swatch" style="background:${it.color}"></span>${it.label}</div>`,
    )
    .join("");

  el.innerHTML = `
    <div class="legend-title">${cfg.title}</div>
    <div class="legend-items">${itemsHtml}</div>
  `;
}

function setYearSliderForDataset(datasetKey) {
  const yearSlider = document.getElementById("year-slider");
  const yearLabel = document.getElementById("year-label");
  // Prefer raster years (only years that actually have PNGs). If we haven't scanned yet,
  // temporarily fall back to CSV years.
  const rasterYears = state.rasterYearsByDataset[datasetKey];
  const years = rasterYears !== null ? rasterYears : (state.yearsByDataset[datasetKey] || []);
  if (!yearSlider || !yearLabel) return;

  if (years.length === 0) {
    yearSlider.min = 0;
    yearSlider.max = 0;
    yearSlider.value = 0;
    yearLabel.textContent = "—";
    return;
  }

  // Slider is an index into the years array
  yearSlider.min = 0;
  yearSlider.max = String(years.length - 1);
  yearSlider.step = 1;
  yearSlider.value = String(Math.min(Number(yearSlider.value) || 0, years.length - 1));
  yearLabel.textContent = String(years[Number(yearSlider.value)]);
}

function filterByYear(rows, fromYear, toYear) {
  if (!rows) return [];
  return rows.filter((r) => {
    if (!Number.isFinite(fromYear) && !Number.isFinite(toYear)) return true;
    if (Number.isFinite(fromYear) && r.year < fromYear) return false;
    if (Number.isFinite(toYear) && r.year > toYear) return false;
    return true;
  });
}

function buildHildaTrend(rows, selectedClass) {
  if (!rows || rows.length === 0) return { labels: [], series: [] };

  const byYear = {};
  rows.forEach((r) => {
    if (!byYear[r.year]) byYear[r.year] = {};
    byYear[r.year][r.class_name] = (byYear[r.year][r.class_name] || 0) + r.count;
  });

  const years = Object.keys(byYear)
    .map((y) => Number(y))
    .sort((a, b) => a - b);

  const labels = years;
  const series = [];

  // If a class is selected, show only that; otherwise show all as separate lines
  const classNames =
    selectedClass && selectedClass !== "ALL"
      ? [selectedClass]
      : collectClasses(rows);

  classNames.forEach((cls) => {
    const data = years.map((year) => {
      const counts = byYear[year];
      const total = Object.values(counts).reduce((s, v) => s + v, 0);
      const clsCount = counts[cls] || 0;
      return total > 0 ? (clsCount / total) * 100.0 : 0;
    });
    series.push({ label: cls, data });
  });

  return { labels, series, yLabel: "% of grid cells" };
}

function buildHydeLuh2Trend(rows, selectedClass) {
  if (!rows || rows.length === 0) return { labels: [], series: [] };
  const byYear = {};
  rows.forEach((r) => {
    if (!byYear[r.year]) byYear[r.year] = {};
    byYear[r.year][r.class_name] = (byYear[r.year][r.class_name] || 0) + r.count;
  });
  const years = Object.keys(byYear).map((y) => Number(y)).sort((a, b) => a - b);
  const labels = years;
  const classNames =
    selectedClass && selectedClass !== "ALL"
      ? [selectedClass]
      : collectClasses(rows);
  const series = classNames.map((cls) => {
    const data = years.map((year) => {
      const counts = byYear[year];
      const total = Object.values(counts).reduce((s, v) => s + v, 0);
      const clsCount = counts[cls] || 0;
      return total > 0 ? (clsCount / total) * 100.0 : 0;
    });
    return { label: cls, data };
  });
  return { labels, series, yLabel: "% of grid cells" };
}

function buildLucasTrend(rows, selectedClass) {
  if (!rows || rows.length === 0) return { labels: [], series: [] };
  const filtered =
    selectedClass && selectedClass !== "ALL"
      ? rows.filter((r) => r.class_name === selectedClass)
      : rows;

  const byYear = {};
  filtered.forEach((r) => {
    if (!byYear[r.year]) byYear[r.year] = 0;
    byYear[r.year] += r.count;
  });

  const years = Object.keys(byYear)
    .map((y) => Number(y))
    .sort((a, b) => a - b);

  const labels = years;
  const data = years.map((y) => byYear[y]);
  return { labels, series: [{ label: selectedClass || "All classes", data }], yLabel: "Grid-cell count" };
}


function renderTrendChart(datasetKey, selectedClass, fromYear, toYear, trendOverride) {
  const ctx = document.getElementById("trend-chart").getContext("2d");
  const useOverride =
    trendOverride &&
    Array.isArray(trendOverride.labels) &&
    trendOverride.labels.length > 0 &&
    Array.isArray(trendOverride.series);

  let labels;
  let series;
  let yLabel;

  if (useOverride) {
    labels = trendOverride.labels;
    series = trendOverride.series;
    yLabel = trendOverride.yLabel || "% of basin cells";
  } else {
    const rows = filterByYear(state[datasetKey], fromYear, toYear);
    const builder = datasetKey === "hilda" ? buildHildaTrend : buildHydeLuh2Trend;
    const built = builder(rows, selectedClass);
    labels = built.labels;
    series = built.series;
    yLabel = built.yLabel;
  }

  if (state.charts.trend) state.charts.trend.destroy();

  const nYears = labels.length;
  let maxTicksLimit = 22;
  if (nYears > 80) maxTicksLimit = 10;
  else if (nYears > 45) maxTicksLimit = 14;
  else if (nYears > 24) maxTicksLimit = 18;

  const hildaColors = {
    Water: "#4DA6FF",
    Wetland: "#7B68EE",
    Urban: "#FF4D4D",
    Agriculture: "#FFD24D",
    Forest: "#228B22",
  };
  const lucasColors = {
    Agriculture: "#FFD24D",
    Forest: "#228B22",
    Water: "#4DA6FF",
    Urban: "#FF4D4D",
    Wetland: "#7B68EE",
  };
  const hydeLuh2Colors = {
    Water: "#4DA6FF",
    Wetland: "#7B68EE",
    Urban: "#FF4D4D",
    Agriculture: "#FFD24D",
    Forest: "#228B22",
    "Natural (residual)": "#228B22",
  };

  const fallback = ["#0f766e", "#e11d48", "#0369a1", "#ca8a04", "#7c3aed"];

  state.charts.trend = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: (series || []).map((s, idx) => ({
        label: s.label,
        data: s.data,
        fill: false,
        borderColor: useOverride
          ? hydeLuh2Colors[s.label] || fallback[idx % 5]
          : datasetKey === "hilda"
            ? hildaColors[s.label] || fallback[idx % 5]
            : datasetKey === "lucas"
              ? lucasColors[s.label] || fallback[idx % 5]
              : hydeLuh2Colors[s.label] || fallback[idx % 5],
        tension: 0.25,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: { top: 4, right: 6, bottom: 10, left: 4 },
      },
      plugins: {
        legend: { display: true },
      },
      scales: {
        x: {
          title: { display: true, text: "Year" },
          ticks: {
            autoSkip: true,
            maxTicksLimit,
            maxRotation: 45,
            minRotation: 0,
          },
          grid: { display: true },
        },
        y: { title: { display: true, text: yLabel } },
      },
    },
  });
}

// Class colors for distribution chart (match map legends)
const classColorsByDataset = {
  hilda: { Water: "#4DA6FF", Wetland: "#7B68EE", Urban: "#FF4D4D", Agriculture: "#FFD24D", Forest: "#228B22" },
  lucas: { Water: "#4DA6FF", Wetland: "#7B68EE", Urban: "#FF4D4D", Agriculture: "#FFD24D", Forest: "#228B22" },
  hyde: {
    Water: "#4DA6FF",
    Wetland: "#7B68EE",
    Urban: "#FF4D4D",
    Agriculture: "#FFD24D",
    Forest: "#228B22",
    "Natural (residual)": "#228B22",
  },
  luh2: { Water: "#4DA6FF", Wetland: "#7B68EE", Urban: "#FF4D4D", Agriculture: "#FFD24D", Forest: "#228B22" },
  corine: { Water: "#4DA6FF", Wetland: "#7B68EE", Urban: "#FF4D4D", Agriculture: "#FFD24D", Forest: "#228B22" },
};
const fallbackColors = ["#0f766e", "#2563eb", "#f97316", "#e11d48", "#7c3aed", "#64748b"];

/**
 * @param {string} datasetKey
 * @param {{ mapYear?: number, distOverride?: { labels: string[], values: number[] } }} options
 *        distOverride = sub-basin zonal for mapYear; else national CSV for mapYear.
 */
function renderDistributionChart(datasetKey, options = {}) {
  const ctx = document.getElementById("distribution-chart").getContext("2d");
  const { mapYear, distOverride } = options;
  const useOverride =
    distOverride &&
    Array.isArray(distOverride.labels) &&
    distOverride.labels.length > 0 &&
    Array.isArray(distOverride.values);

  let labels;
  let values;

  if (useOverride) {
    labels = distOverride.labels;
    values = distOverride.values;
  } else if (Number.isFinite(mapYear)) {
    const built = buildNationalDistributionForYear(state[datasetKey], mapYear, datasetKey);
    labels = built.labels;
    values = built.values;
  } else {
    labels = [];
    values = [];
  }

  const nz = distributionNonZeroSlices(labels, values);
  labels = nz.labels;
  values = nz.values;

  if (state.charts.distribution) state.charts.distribution.destroy();

  const legendEl = document.getElementById("distribution-legend");
  if (!labels.length) {
    if (legendEl) legendEl.innerHTML = "<span class='legend-item'>No data for this view</span>";
    return;
  }

  const colorMap = classColorsByDataset[datasetKey] || classColorsByDataset.hilda;
  const backgroundColor = labels.map(
    (lbl, i) => colorMap[lbl] || fallbackColors[i % fallbackColors.length],
  );

  state.charts.distribution = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data: values, backgroundColor }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
      },
    },
  });

  if (legendEl) {
    const items = labels.map(
      (lbl, i) =>
        `<span class="legend-item"><span class="legend-swatch" style="background:${backgroundColor[i]}"></span>${lbl}: ${values[i].toFixed(1)}%</span>`
    );
    legendEl.innerHTML = items.join("");
  }
}

/** Update donut from current slider year (national or sub-basin) without reloading the GeoTIFF. */
function syncDistributionToMapYear() {
  const datasetSelect = document.getElementById("dataset-select");
  const yearSlider = document.getElementById("year-slider");
  if (!datasetSelect || !yearSlider) return;
  const datasetKey = datasetSelect.value;
  const rasterYears = state.rasterYearsByDataset[datasetKey];
  const years = rasterYears !== null ? rasterYears : (state.yearsByDataset[datasetKey] || []);
  const idx = Number(yearSlider.value);
  const mapYear = Number.isFinite(idx) && years[idx] !== undefined ? Number(years[idx]) : NaN;
  const basinVal = document.getElementById("basin-select")?.value;
  const basinIndex = basinVal === "" || basinVal === undefined ? NaN : parseInt(basinVal, 10);

  if (!Number.isFinite(basinIndex)) {
    renderDistributionChart(datasetKey, { mapYear });
    return;
  }
  const index = state.subbasinZonal[datasetKey];
  if (index instanceof Map) {
    const distPayload = buildSubbasinDistPayload(index, basinIndex, mapYear, datasetKey);
    renderDistributionChart(datasetKey, { distOverride: distPayload });
  } else {
    renderDistributionChart(datasetKey, { mapYear });
  }
}

async function applyFiltersAsync() {
  const seq = ++applyFiltersSeq;
  const datasetSelect = document.getElementById("dataset-select");
  const classSelect = document.getElementById("class-select");
  const fromInput = document.getElementById("year-from");
  const toInput = document.getElementById("year-to");
  const yearSlider = document.getElementById("year-slider");
  const yearLabel = document.getElementById("year-label");

  const datasetKey = datasetSelect.value;
  const selectedClass = classSelect.value || "ALL";
  const fromYear = fromInput.value ? Number(fromInput.value) : NaN;
  const toYear = toInput.value ? Number(toInput.value) : NaN;
  const rasterYears = state.rasterYearsByDataset[datasetKey];
  const years = rasterYears !== null ? rasterYears : (state.yearsByDataset[datasetKey] || []);
  const idx = yearSlider && yearSlider.value ? Number(yearSlider.value) : NaN;
  const mapYear = Number.isFinite(idx) && years[idx] !== undefined ? Number(years[idx]) : NaN;
  if (yearLabel) yearLabel.textContent = Number.isFinite(mapYear) ? String(mapYear) : "—";

  const basinVal = document.getElementById("basin-select")?.value;
  const basinIndex = basinVal === "" || basinVal === undefined ? NaN : parseInt(basinVal, 10);

  const trendNote = document.getElementById("trend-scope-note");
  const distNote = document.getElementById("distribution-scope-note");
  const hint = document.getElementById("map-overlay-hint");

  setLegend(datasetKey);

  await updateRasterOverlay(datasetKey, mapYear);
  if (seq !== applyFiltersSeq) return;
  if (state.map.instance) state.map.instance.invalidateSize();

  if (!Number.isFinite(basinIndex)) {
    if (trendNote) {
      trendNote.hidden = true;
      trendNote.textContent = "";
    }
    if (distNote) {
      distNote.hidden = true;
      distNote.textContent = "";
    }
    renderTrendChart(datasetKey, selectedClass, fromYear, toYear);
    renderDistributionChart(datasetKey, { mapYear });
  } else {
    const loaded = await ensureSubbasinZonalLoaded(datasetKey);
    if (seq !== applyFiltersSeq) return;

    if (!loaded) {
      if (trendNote) {
        trendNote.hidden = false;
        trendNote.textContent = "Sub-basin charts need zonal statistics for the selected basin.";
      }
      if (distNote) {
        distNote.hidden = false;
        distNote.textContent = "Showing national totals until sub-basin data is available.";
      }
      renderTrendChart(datasetKey, selectedClass, fromYear, toYear);
      renderDistributionChart(datasetKey, { mapYear });
    } else {
      const index = state.subbasinZonal[datasetKey];
      if (trendNote) {
        trendNote.hidden = false;
        trendNote.textContent = "Trend and distribution use sub-basin aggregates.";
      }
      if (distNote) {
        distNote.hidden = false;
        distNote.textContent = Number.isFinite(mapYear)
          ? `Distribution for sub-basin and map year ${mapYear}.`
          : "Select a map year on the slider.";
      }
      const trendPayload = buildSubbasinTrendPayload(
        index,
        basinIndex,
        selectedClass,
        fromYear,
        toYear,
        years,
        datasetKey,
      );
      renderTrendChart(datasetKey, selectedClass, fromYear, toYear, trendPayload);
      const distPayload = buildSubbasinDistPayload(index, basinIndex, mapYear, datasetKey);
      renderDistributionChart(datasetKey, { distOverride: distPayload });
    }
  }

  if (hint) {
    const y = document.getElementById("year-label")?.textContent;
    hint.textContent = y && y !== "—" ? `Showing raster (GeoTIFF) ${y}` : "";
  }
}

function applyFilters() {
  applyFiltersAsync().catch((e) => console.error(e));
}

let validationRmseChart = null;

function setupTabs() {
  document.querySelectorAll(".tabs .tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.getAttribute("data-tab");
      document.querySelectorAll(".tabs .tab").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("active", panel.getAttribute("data-panel") === name);
      });
      if (name === "validation") {
        loadValidationDashboard().catch((e) => console.error(e));
      }
    });
  });
}

function fmtValidation(x, decimals) {
  const d = decimals === undefined ? 4 : decimals;
  if (x === null || x === undefined || (typeof x === "number" && Number.isNaN(x))) return "—";
  return Number(x).toFixed(d);
}

async function loadValidationDashboard() {
  const descEl = document.getElementById("validation-description");
  const errEl = document.getElementById("validation-error");
  const tbody = document.getElementById("validation-summary-body");
  const perDs = document.getElementById("validation-per-dataset");
  const mlNote = document.getElementById("validation-ml-note");
  const canvas = document.getElementById("validation-rmse-chart");
  if (!tbody || !canvas || !descEl) return;

  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }

  try {
    const resp = await fetch(
      `../outputs/dashboard_validation_metrics.json?t=${Date.now()}`,
      { cache: "no-store" },
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    const genEl = document.getElementById("validation-generated");
    if (genEl) {
      if (data.generated_at) {
        genEl.hidden = false;
        genEl.textContent = `Computed: ${data.generated_at} · CORINE years: ${(data.corine_years || []).join(", ")}`;
      } else {
        genEl.hidden = true;
        genEl.textContent = "";
      }
    }

    descEl.replaceChildren();
    descEl.append(
      document.createTextNode(
        data.description ||
          "National shares at CORINE snapshot years; RMSE/MAE in share units (0–1).",
      ),
    );
    descEl.append(document.createTextNode(" "));
    const regen = document.createElement("span");
    regen.className = "validation-ml-note";
    regen.append("Regenerate ");
    const codeEl = document.createElement("code");
    codeEl.textContent = "python analysis/compute_validation_metrics.py";
    regen.append(codeEl);
    regen.append(" after changing outputs/*.csv.");
    descEl.append(regen);

    const footEl = document.getElementById("validation-footnotes");
    if (footEl) {
      footEl.textContent = [
        "‡ Mean r: average of per-class correlations across years.",
        data.subbasin_note || "",
      ]
        .filter(Boolean)
        .join(" ");
    }

    const sub = data.subbasin_zonal || {};
    const labels = [];
    const rmseVals = [];
    const barColors = ["#0ea5e9", "#22c55e", "#a855f7", "#f97316", "#6366f1"];

    tbody.innerHTML = "";
    if (perDs) perDs.innerHTML = "";

    (data.national || []).forEach((row) => {
      if (row.error) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 10;
        td.textContent = `${row.dataset}: ${row.error}`;
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }
      labels.push(row.dataset.toUpperCase());
      rmseVals.push(row.rmse_share_all);
      const sb = sub[row.dataset];
      const tr = document.createElement("tr");
      tr.innerHTML = [
        `<td>${row.dataset}</td>`,
        `<td>${(row.years_used || []).join(", ")}</td>`,
        `<td class="num">${fmtValidation(row.rmse_share_all)}</td>`,
        `<td class="num">${fmtValidation(row.mae_share_all)}</td>`,
        `<td class="num">${fmtValidation(row.r2_flat)}</td>`,
        `<td class="num">${row.mean_pearson_r != null ? fmtValidation(row.mean_pearson_r) : "—"}</td>`,
        `<td class="num">${fmtValidation(row.cosine_similarity_mean)}</td>`,
        `<td class="num">${fmtValidation(row.ml_loyo_mean_rmse_rf)}</td>`,
        `<td class="num">${fmtValidation(row.ml_loyo_mean_rmse_ridge)}</td>`,
        `<td class="num">${sb ? fmtValidation(sb.mean_rmse_share_vs_corine) : "—"}</td>`,
      ].join("");
      tbody.appendChild(tr);

      const det = document.createElement("details");
      det.className = "validation-details";
      const summ = document.createElement("summary");
      summ.textContent = `${row.dataset} — per class (RMSE, MAE, bias pp, r)`;
      det.appendChild(summ);
      const tbl = document.createElement("table");
      tbl.className = "validation-mini-table";
      const thead = document.createElement("thead");
      thead.innerHTML =
        "<tr><th>Class</th><th class='num'>RMSE</th><th class='num'>MAE</th><th class='num'>Bias (pp)</th><th class='num'>r</th></tr>";
      tbl.appendChild(thead);
      const tb = document.createElement("tbody");
      const order = data.class_order || ["Water", "Wetland", "Urban", "Agriculture", "Forest"];
      const pc = row.per_class || {};
      const pr = row.pearson_r_by_class || {};
      const presentList = row.classes_present_in_dataset;
      const hasPresent =
        Array.isArray(presentList) && presentList.length > 0;
      const present = new Set(hasPresent ? presentList : order);
      let anyAbsent = false;
      const absentTitle = "No mapped counts for this class in the product CSV.";
      order.forEach((cls) => {
        const inProduct = present.has(cls);
        if (hasPresent && !inProduct) anyAbsent = true;
        const p = pc[cls] || {};
        const r = pr[cls];
        const tr2 = document.createElement("tr");
        const tdName = document.createElement("td");
        tdName.textContent = cls;
        tr2.appendChild(tdName);
        const addMetric = (val, decimals) => {
          const td = document.createElement("td");
          td.className = "num";
          if (inProduct && val != null && !Number.isNaN(val)) {
            td.textContent = fmtValidation(val, decimals);
          } else if (inProduct) {
            td.textContent = "—";
          } else {
            td.textContent = "—";
            td.classList.add("metric-na");
            td.title = absentTitle;
          }
          tr2.appendChild(td);
        };
        addMetric(p.rmse_share);
        addMetric(p.mae_share);
        addMetric(p.bias_pp, 2);
        const tdR = document.createElement("td");
        tdR.className = "num";
        if (inProduct) {
          tdR.textContent = r == null ? "—" : fmtValidation(r);
        } else {
          tdR.textContent = "—";
          tdR.classList.add("metric-na");
          tdR.title = absentTitle;
        }
        tr2.appendChild(tdR);
        tb.appendChild(tr2);
      });
      tbl.appendChild(tb);
      det.appendChild(tbl);
      if (anyAbsent) {
        const note = document.createElement("p");
        note.className = "validation-mini-footnote";
        note.textContent =
          "— = class absent in the product CSV; headline metrics still use a full five-vector (zero for missing classes).";
        det.appendChild(note);
      }
      if (perDs) perDs.appendChild(det);
    });

    if (mlNote && data.national && data.national[0] && data.national[0].ml_note) {
      mlNote.textContent = data.national[0].ml_note;
    }

    if (validationRmseChart) validationRmseChart.destroy();
    validationRmseChart = null;
    if (labels.length > 0) {
      const ctx = canvas.getContext("2d");
      validationRmseChart = new Chart(ctx, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: "RMSE vs CORINE (share units 0–1)",
              data: rmseVals,
              backgroundColor: labels.map((_, i) => barColors[i % barColors.length]),
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            title: { display: true, text: "National RMSE vs CORINE (share units)" },
          },
          scales: {
            y: {
              beginAtZero: true,
              title: { display: true, text: "RMSE" },
            },
            x: {
              title: { display: true, text: "Dataset" },
            },
          },
        },
      });
    }
  } catch (e) {
    const genElErr = document.getElementById("validation-generated");
    if (genElErr) {
      genElErr.hidden = true;
      genElErr.textContent = "";
    }
    if (errEl) {
      errEl.hidden = false;
      errEl.textContent = `Could not load validation metrics (${e.message}).`;
    }
    if (validationRmseChart) {
      validationRmseChart.destroy();
      validationRmseChart = null;
    }
  }
}

async function main() {
  initMap();
  setupFullscreen();
  setupTabs();
  await loadData();

  const datasetSelect = document.getElementById("dataset-select");
  const applyBtn = document.getElementById("apply-filters");
  const yearSlider = document.getElementById("year-slider");
  const yearLabel = document.getElementById("year-label");

  datasetSelect.addEventListener("change", () => {
    const key = datasetSelect.value;
    delete state.subbasinZonal[key];
    delete state.subbasinZonalLoading[key];
    populateClassDropdown(key);
    // Scan rasters once per dataset so the slider only shows exported years
    if (state.rasterYearsByDataset[key] === null) {
      scanRasterYears(key).then(() => {
        setYearSliderForDataset(key);
        applyFilters();
      });
    } else {
      setYearSliderForDataset(key);
      applyFilters();
    }
    setLegend(key);
  });

  applyBtn.addEventListener("click", applyFilters);

  yearSlider.addEventListener("input", () => {
    const key = datasetSelect.value;
    const rasterYears = state.rasterYearsByDataset[key];
    const years = rasterYears !== null ? rasterYears : (state.yearsByDataset[key] || []);
    const idx = Number(yearSlider.value);
    yearLabel.textContent = years[idx] !== undefined ? String(years[idx]) : "—";
  });

  yearSlider.addEventListener("change", () => {
    applyFilters();
  });

  // Initial state: choose first dataset that has data
  let initialDataset = "hilda";
  if (state.hilda) initialDataset = "hilda";
  else if (state.lucas) initialDataset = "lucas";
  else if (state.hyde) initialDataset = "hyde";
  else if (state.luh2) initialDataset = "luh2";
  document.getElementById("dataset-select").value = initialDataset;

  // Initial scan for raster years (so slider is sparse-but-clean)
  await scanRasterYears(initialDataset);
  setYearSliderForDataset(initialDataset);
  setLegend(initialDataset);
  populateClassDropdown(initialDataset);
  applyFilters();
}

document.addEventListener("DOMContentLoaded", main);

