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

/**
 * Resolve repo-root files (outputs/, rasters/, lt_subbasins.json) when the page is served from
 * .../dashboard/ — avoids broken relative URLs on GitHub Pages if the pathname omits a trailing slash.
 */
function resolveDataFileUrl(relFromRepoRoot) {
  const clean = String(relFromRepoRoot || "").replace(/^\/+/, "");
  if (window.location.protocol === "file:") {
    try {
      return new URL(`../${clean}`, window.location.href).href;
    } catch {
      return `../${clean}`;
    }
  }
  const pathname = window.location.pathname || "";
  const parts = pathname.split("/").filter(Boolean);
  const dIdx = parts.indexOf("dashboard");
  if (dIdx < 0) {
    try {
      return new URL(`../${clean}`, window.location.href).href;
    } catch {
      return `../${clean}`;
    }
  }
  const rootParts = parts.slice(0, dIdx);
  const basePath = rootParts.length ? `/${rootParts.join("/")}` : "";
  const origin = window.location.origin || "";
  return `${origin}${basePath}/${clean}`;
}

/** Drop "baseinas" / "pabaseinis" wording from hydrology labels (map + list). */
function sanitizeBasinDisplayName(raw) {
  if (raw == null) return raw;
  let s = String(raw).trim();
  s = s.replace(/\s*\(?\s*baseinas\s*\)?/gi, "");
  s = s.replace(/\bbaseinas\b/gi, "");
  s = s.replace(/\s*\(?\s*pabaseinio\b/gi, "");
  s = s.replace(/\bpabaseinis\b/gi, "");
  s = s.replace(/\bpabaseinių\b/gi, "");
  s = s.replace(/\bpabaseiniai\b/gi, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s || String(raw).trim();
}

function fitMapToBounds(map, bounds, options) {
  if (!map || !bounds || !bounds.isValid()) return;
  const size = map.getSize();
  const minSide = Math.max(1, Math.min(size.x, size.y));
  const pad = Math.max(12, Math.min(40, Math.round(minSide * 0.05)));
  map.fitBounds(bounds, {
    padding: [pad, pad],
    animate: false,
    maxZoom: 18,
    ...options,
  });
}

/** Lithuania overview — same bounds as initial map view. */
const LT_OVERVIEW_BOUNDS = L.latLngBounds([53.5, 20.5], [56.6, 26.7]);

const BASIN_STYLE_DEFAULT = {
  className: "basin-outline-path",
  color: "#64748b",
  weight: 1.25,
  fill: true,
  fillColor: "#64748b",
  fillOpacity: 0.02,
};

const BASIN_STYLE_SELECTED = {
  className: "basin-outline-path basin-outline-selected",
  color: "#c2410c",
  weight: 4,
  fill: true,
  fillColor: "#ea580c",
  fillOpacity: 0.12,
};

function basinFeatureStyle(feature, geojsonRef) {
  const idx = geojsonRef.features.indexOf(feature);
  const sel = state.map.selectedBasinIndex;
  const selected = sel !== null && sel !== undefined && Number.isFinite(sel) && idx === sel;
  return selected ? { ...BASIN_STYLE_SELECTED } : { ...BASIN_STYLE_DEFAULT };
}

function applyBasinOutlineHighlight(selectedBasinIndex) {
  state.map.selectedBasinIndex =
    selectedBasinIndex === null ||
    selectedBasinIndex === undefined ||
    selectedBasinIndex === "" ||
    !Number.isFinite(selectedBasinIndex)
      ? null
      : selectedBasinIndex;
  const layer = state.map.basinLayer;
  const gj = state.map.subbasins;
  if (!layer || typeof layer.setStyle !== "function" || !gj) return;
  layer.setStyle((feature) => basinFeatureStyle(feature, gj));
}

function getCsvYearsSorted(datasetKey) {
  const y = state.yearsByDataset[datasetKey] || [];
  return [...new Set(y.filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
}

/** CORINE CLC snapshots only exist from 1990 onward in this project. */
const CORINE_MIN_MAP_YEAR = 1990;

/** Calendar years allowed on the map slider (CORINE clamped to valid CLC years). */
function getYearsForMapSlider(datasetKey) {
  const y = getCsvYearsSorted(datasetKey);
  if (datasetKey === "corine") {
    return y.filter((yr) => yr >= CORINE_MIN_MAP_YEAR);
  }
  return y;
}

/** Largest CSV / stats year ≤ calendarYear (same “floor” rule as the map raster). */
function pickDataYearForCalendarYear(calendarYear, datasetKey) {
  const ys = getYearsForMapSlider(datasetKey);
  return pickRasterYearForCalendarYear(calendarYear, ys);
}

function getRasterYearsSorted(datasetKey) {
  const r = state.rasterYearsByDataset[datasetKey];
  if (r !== null && Array.isArray(r) && r.length) return r.slice().sort((a, b) => a - b);
  return [];
}

/** Largest exported raster year ≤ calendarYear; if none, smallest available. */
function pickRasterYearForCalendarYear(calendarYear, rasterYearsSorted) {
  const ys = (rasterYearsSorted || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!ys.length) return NaN;
  if (calendarYear < ys[0]) return ys[0];
  let pick = ys[0];
  for (const y of ys) {
    if (y <= calendarYear) pick = y;
    else break;
  }
  return pick;
}

function formatMapYearLabel(calendarYear, rasterYear) {
  if (!Number.isFinite(calendarYear)) return "—";
  if (!Number.isFinite(rasterYear) || calendarYear === rasterYear) return String(calendarYear);
  return `${calendarYear} → ${rasterYear}`;
}

/** Slider value = calendar year; returns { calendarYear, rasterYear } for map + zonal. */
function readYearSliderMapPair(datasetKey) {
  const yearSlider = document.getElementById("year-slider");
  const calendarYear = yearSlider ? Number(yearSlider.value) : NaN;
  if (!Number.isFinite(calendarYear)) return { calendarYear: NaN, rasterYear: NaN };
  const rasterYs = getRasterYearsSorted(datasetKey);
  let rasterYear = pickRasterYearForCalendarYear(calendarYear, rasterYs);
  if (!Number.isFinite(rasterYear)) {
    rasterYear = pickDataYearForCalendarYear(calendarYear, datasetKey);
  }
  if (!Number.isFinite(rasterYear)) rasterYear = calendarYear;
  return { calendarYear, rasterYear };
}

function getZonalYearsForBasin(index, basinIndex) {
  if (!(index instanceof Map) || !Number.isFinite(basinIndex)) return [];
  const ys = new Set();
  for (const key of index.keys()) {
    const [bi, y] = key.split("|").map(Number);
    if (bi === basinIndex && Number.isFinite(y)) ys.add(y);
  }
  return Array.from(ys).sort((a, b) => a - b);
}

/** Floor calendar year to latest zonal CSV year ≤ year; if none, same rule on raster years. */
function pickSubbasinZonalYearForCalendar(index, basinIndex, calendarYear, datasetKey) {
  const zonalYs = getZonalYearsForBasin(index, basinIndex);
  if (zonalYs.length) return pickRasterYearForCalendarYear(calendarYear, zonalYs);
  return pickRasterYearForCalendarYear(calendarYear, getRasterYearsSorted(datasetKey));
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
    selectedBasinIndex: null,
  },
  charts: {
    trend: null,
    distribution: null,
  },
  /** Pre-computed sub-basin zonal CSV: datasetKey → Map("basin|year" → { counts, total }) | false if missing */
  subbasinZonal: {},
  /** datasetKey → Promise while CSV is loading */
  subbasinZonalLoading: {},
  /** Latest fetch of outputs/dashboard_validation_metrics.json (for reference switcher) */
  validationMetrics: null,
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
      const url = resolveDataFileUrl(`outputs/subbasin_zonal_${datasetKey}.csv`);
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
    const hildaResp = await fetch(resolveDataFileUrl("outputs/hilda_lithuania_timeseries.csv"));
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
    const lucasResp = await fetch(resolveDataFileUrl("outputs/lucas_lithuania_timeseries.csv"));
    if (lucasResp.ok) {
      const txt = await lucasResp.text();
      state.lucas = parseCsv(txt).map((row) => ({
        year: Number(row.year),
        class_id: row.class_id !== undefined && row.class_id !== "" ? Number(row.class_id) : NaN,
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
    const hydeResp = await fetch(resolveDataFileUrl("outputs/hyde_lithuania_timeseries.csv"));
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
    const luh2Resp = await fetch(resolveDataFileUrl("outputs/luh2_lithuania_timeseries.csv"));
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
    const corResp = await fetch(resolveDataFileUrl("outputs/corine_lithuania_timeseries.csv"));
    if (corResp.ok) {
      const txt = await corResp.text();
      state.corine = parseCsv(txt)
        .map((row) => ({
          year: Number(row.year),
          class_name: row.class_name,
          count: Number(row.count),
        }))
        .filter((r) => Number.isFinite(r.year) && r.year >= CORINE_MIN_MAP_YEAR);
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
  const map = L.map("map", {
    zoomControl: true,
    maxBounds: LT_OVERVIEW_BOUNDS,
    maxBoundsViscosity: 1.0,
    /** Canvas paths align with raster/tiles in screenshots; SVG + html2canvas often shifts outlines */
    preferCanvas: true,
  }).fitBounds(LT_OVERVIEW_BOUNDS, { padding: [12, 12] });

  map.createPane("basinOutlinePane");
  map.getPane("basinOutlinePane").style.zIndex = "450";

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  // Load basin config and sub-basins, then draw
  Promise.all([
    fetch("basins-config.json").then((r) => (r.ok ? r.json() : null)),
    fetch(resolveDataFileUrl("lt_subbasins.json")).then((r) => (r.ok ? r.json() : null)),
  ]).then(([config, geojson]) => {
    if (!geojson) return;
    state.map.subbasins = geojson;
    state.map.basinsConfig = config;

    function getBasinName(feature, index) {
      const oid = String(feature.properties?.OBJECTID ?? index);
      const fromConfig = config?.namesByObjectId?.[oid];
      let label;
      if (fromConfig) label = fromConfig;
      else {
        const raw = feature.properties?.PAVADINIMA || feature.properties?.pavadinima || "";
        label = raw && raw !== "-" ? raw : `Basin polygon ${index + 1}`;
      }
      return sanitizeBasinDisplayName(label);
    }

    const basinSelect = document.getElementById("basin-select");
    if (basinSelect) {
      basinSelect.innerHTML = '<option value="">All Lithuania (national charts)</option>';
      const entries = geojson.features.map((f, i) => ({
        idx: i,
        name: getBasinName(f, i),
      }));
      entries.sort((a, b) => a.name.localeCompare(b.name, "lt", { sensitivity: "base" }));
      entries.forEach(({ idx, name }) => {
        const opt = document.createElement("option");
        opt.value = String(idx);
        opt.textContent = name;
        basinSelect.appendChild(opt);
      });
    }

    const layer = L.geoJSON(geojson, {
      pane: "basinOutlinePane",
      interactive: true,
      style: (feature) => basinFeatureStyle(feature, geojson),
      onEachFeature: (feature, leafletLayer) => {
        const idx = geojson.features.indexOf(feature);
        leafletLayer._basinIndex = idx;
        leafletLayer.feature = feature;
        const name = getBasinName(feature, idx);
        const oid = feature.properties?.OBJECTID;
        const offset =
          oid === 673 ? L.point(-140, -8) : L.point(0, 0);
        leafletLayer.bindTooltip(name, {
          permanent: true,
          direction: "center",
          offset,
          className: "basin-label",
          interactive: false,
        });
      },
    }).addTo(map);
    state.map.basinLayer = layer;
    state.map.selectedBasinIndex = null;
    applyBasinOutlineHighlight(null);
    fitMapToBounds(map, layer.getBounds());
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
      applyBasinOutlineHighlight(null);
      fitMapToBounds(map, LT_OVERVIEW_BOUNDS);
    } else {
      const i = parseInt(idx, 10);
      applyBasinOutlineHighlight(Number.isFinite(i) ? i : null);
      const layerForFeature = getBasinLeafletLayer(i);
      if (layerForFeature && layerForFeature.getBounds) {
        fitMapToBounds(map, layerForFeature.getBounds().pad(0.06));
      }
    }
    setTimeout(() => {
      map.invalidateSize();
      applyFilters();
    }, 0);
  });
}

function getGeotiffUrl(datasetKey, year) {
  const rel = {
    hilda: `rasters/hilda/geotiff/hilda_${year}.tif`,
    lucas: `rasters/lucas/geotiff/lucas_${year}.tif`,
    hyde: `rasters/hyde/geotiff/hyde_${year}.tif`,
    luh2: `rasters/luh2/geotiff/luh2_${year}.tif`,
    corine: `rasters/corine/geotiff/corine_${year}.tif`,
  }[datasetKey];
  return rel ? resolveDataFileUrl(rel) : null;
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

/** Trimmed year from a number input; empty → NaN (never treat "" as 0). */
function parseYearInputEl(el) {
  if (!el) return NaN;
  const t = String(el.value ?? "").trim();
  if (t === "") return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function readFilterYearRange() {
  const fromEl = document.getElementById("year-from");
  const toEl = document.getElementById("year-to");
  const fromY = parseYearInputEl(fromEl);
  const toY = parseYearInputEl(toEl);
  return { fromY, toY };
}

/**
 * Years to export: basin → union of zonal years for that basin; else national CSV/raster years.
 * Empty from/to → all years in pool; partial range clamps to pool bounds.
 */
function resolveExportYears(datasetKey, basinIndex) {
  const { fromY, toY } = readFilterYearRange();
  const rasterYears = state.rasterYearsByDataset[datasetKey];
  const sliderYears = getYearsForMapSlider(datasetKey);
  const nationalPool = (rasterYears !== null && rasterYears.length ? rasterYears : sliderYears)
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
        const yEl = document.getElementById("year-label");
        const yr =
          (yEl?.dataset?.rasterYear && String(yEl.dataset.rasterYear)) ||
          (yEl?.textContent?.match(/^(\d{4})/)?.[1] ?? "");

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
          fitMapToBounds(map, bounds, { maxZoom: 18 });
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
              const r = document.getElementById("year-label")?.dataset?.rasterYear;
              hint.textContent = r ? `GeoTIFF: ${r}` : "";
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
function makeLandcoverRasterLayer(georaster, map) {
  const size = map?.getSize?.();
  const resolution = size
    ? Math.min(1024, Math.max(384, Math.round(Math.min(size.x, size.y) * 1.15)))
    : 512;
  return new GeoRasterLayer({
    georaster,
    opacity: 0.86,
    // Higher resolution + rounded class ids: GeoRasterLayer resamples rasters; without rounding,
    // categorical 1–5 become floats (e.g. 4.37) and CORINE_COLORS[v] is undefined → transparent
    // pixels, so forest/agriculture look like scattered dots while CSV stats stay correct.
    resolution,
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
  if (!map) return;

  const hint = document.getElementById("map-overlay-hint");

  if (state.map.overlay) {
    map.removeLayer(state.map.overlay);
    state.map.overlay = null;
  }

  if (!Number.isFinite(year)) {
    if (hint) hint.textContent = "No raster for the resolved map year.";
    return;
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

    const layerMain = makeLandcoverRasterLayer(georaster, map);
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
  const candidates = getYearsForMapSlider(datasetKey);
  if (candidates.length === 0) {
    state.rasterYearsByDataset[datasetKey] = [];
    return [];
  }

  const hint = document.getElementById("map-overlay-hint");
  if (hint) hint.textContent = "Scanning available rasters…";

  const found = [];
  const geotiffPaths = {
    hilda: (y) => resolveDataFileUrl(`rasters/hilda/geotiff/hilda_${y}.tif`),
    lucas: (y) => resolveDataFileUrl(`rasters/lucas/geotiff/lucas_${y}.tif`),
    hyde: (y) => resolveDataFileUrl(`rasters/hyde/geotiff/hyde_${y}.tif`),
    luh2: (y) => resolveDataFileUrl(`rasters/luh2/geotiff/luh2_${y}.tif`),
    corine: (y) => resolveDataFileUrl(`rasters/corine/geotiff/corine_${y}.tif`),
  };
  const tifPath = geotiffPaths[datasetKey];
  for (const year of candidates) {
    if (!tifPath) continue;
    const url = tifPath(year);
    let ok = false;
    try {
      const r = await fetch(url, { method: "HEAD", mode: "cors" });
      if (r.ok) ok = true;
    } catch (_) {
      ok = false;
    }
    if (!ok) {
      try {
        const r2 = await fetch(url, {
          method: "GET",
          mode: "cors",
          cache: "no-store",
          headers: { Range: "bytes=0-1" },
        });
        if (r2.ok || r2.status === 206) ok = true;
      } catch (_) {
        ok = false;
      }
    }
    if (ok) found.push(year);
  }

  let yearsOut = found;
  if (yearsOut.length === 0 && candidates.length) {
    yearsOut = candidates.slice();
    if (hint) {
      hint.textContent = `GeoTIFF check inconclusive (HEAD often blocked on static hosts). Using ${yearsOut.length} CSV years — map may warn if a file is missing.`;
    }
  } else if (hint) {
    hint.textContent =
      yearsOut.length > 0 ? `Found ${yearsOut.length} GeoTIFF year(s).` : "No GeoTIFF files found.";
  }
  state.rasterYearsByDataset[datasetKey] = yearsOut;
  return yearsOut;
}

function collectClasses(datasetRows) {
  if (!datasetRows) return [];
  const set = new Set(datasetRows.map((r) => r.class_name).filter(Boolean));
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
  const csvYears = getYearsForMapSlider(datasetKey);
  if (!yearSlider || !yearLabel) return;

  if (csvYears.length === 0) {
    yearSlider.min = 0;
    yearSlider.max = 0;
    yearSlider.value = 0;
    yearLabel.textContent = "—";
    yearLabel.dataset.calendarYear = "";
    yearLabel.dataset.rasterYear = "";
    return;
  }

  let minY = csvYears[0];
  let maxY = csvYears[csvYears.length - 1];
  const { fromY, toY } = readFilterYearRange();
  if (Number.isFinite(fromY)) minY = Math.max(minY, fromY);
  if (Number.isFinite(toY)) maxY = Math.min(maxY, toY);
  if (minY > maxY) [minY, maxY] = [maxY, minY];

  yearSlider.min = String(minY);
  yearSlider.max = String(maxY);
  yearSlider.step = "1";

  let cur = Number(yearSlider.value);
  if (!Number.isFinite(cur)) cur = maxY;
  cur = Math.min(maxY, Math.max(minY, cur));
  yearSlider.value = String(cur);

  const ry = pickRasterYearForCalendarYear(cur, getRasterYearsSorted(datasetKey));
  yearLabel.textContent = formatMapYearLabel(cur, ry);
  yearLabel.dataset.calendarYear = String(cur);
  yearLabel.dataset.rasterYear = Number.isFinite(ry) ? String(ry) : "";
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
    const builder =
      datasetKey === "hyde" || datasetKey === "luh2" ? buildHydeLuh2Trend : buildHildaTrend;
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

/**
 * Quick summary under the map. When a polygon is selected, `zonalYear` must match zonal CSV keys
 * (usually the raster year used on the map).
 */
function updateBasinKeyMetrics(datasetKey, basinIndex, zonalYear, calendarYear) {
  const wrap = document.getElementById("basin-key-metrics");
  const titleEl = document.getElementById("basin-metrics-title");
  const grid = document.getElementById("basin-metrics-grid");
  if (!wrap || !grid) return;

  const basinSelect = document.getElementById("basin-select");
  const basinName = basinSelect?.selectedOptions?.[0]?.textContent?.trim() || "";

  wrap.hidden = false;

  if (!Number.isFinite(basinIndex)) {
    if (titleEl) titleEl.textContent = "Sub-basin summary";
    grid.innerHTML =
      '<p class="basin-metrics-placeholder">Select a <strong>sub-basin</strong> in the left-hand <strong>Filters</strong> panel (dropdown under the dataset/class controls). The map outlines, quick metrics below, and the change table will then use that polygon.</p>';
    return;
  }

  const sub =
    Number.isFinite(calendarYear) &&
    Number.isFinite(zonalYear) &&
    calendarYear !== zonalYear
      ? ` (${calendarYear} → raster ${zonalYear})`
      : Number.isFinite(zonalYear)
        ? ` (${zonalYear})`
        : "";
  if (titleEl) titleEl.textContent = `${basinName}${sub}`;

  const index = state.subbasinZonal[datasetKey];
  if (!(index instanceof Map) || !Number.isFinite(zonalYear)) {
    grid.innerHTML =
      '<p class="basin-metrics-placeholder">Load zonal statistics (<code>outputs/subbasin_zonal_*.csv</code>) and choose a map year on the slider.</p>';
    return;
  }

  const cell = index.get(`${basinIndex}|${zonalYear}`);
  if (!cell || cell.total <= 0) {
    grid.innerHTML =
      '<p class="basin-metrics-placeholder">No classified cells for this sub-basin and raster year (missing export or year not in zonal CSV).</p>';
    return;
  }

  const labels = nationalDistributionClassLabels(datasetKey);
  const shares = [];
  for (let id = 1; id <= 5; id++) {
    const c = cell.counts[id] || 0;
    shares.push({ id, p: (c / cell.total) * 100 });
  }
  shares.sort((a, b) => b.p - a.p);
  const top = shares[0];
  const second = shares[1];
  const dominant = labels[(top?.id || 1) - 1] || "—";
  const maxShare = top?.p ?? 0;
  const secondLine =
    second && second.p > 0.05
      ? `${labels[second.id - 1]} (${second.p.toFixed(1)}%)`
      : "—";

  const tiles = [
    `<div class="metric-tile"><span class="metric-k">Classified cells</span><span class="metric-v">${cell.total.toLocaleString()}</span></div>`,
    `<div class="metric-tile"><span class="metric-k">Dominant class</span><span class="metric-v">${dominant} (${maxShare.toFixed(1)}%)</span></div>`,
    `<div class="metric-tile"><span class="metric-k">Second-largest class</span><span class="metric-v">${secondLine}</span></div>`,
    `<div class="metric-tile metric-tile-wide"><span class="metric-k">Note</span><span class="metric-v metric-small">Percentages match the donut: share of raster cells inside the polygon (Python zonal stats).</span></div>`,
  ];
  grid.innerHTML = `<div class="basin-metrics-grid-inner">${tiles.join("")}</div>`;
}

/** Update donut from current slider year (national or sub-basin) without reloading the GeoTIFF. */
function syncDistributionToMapYear() {
  const datasetSelect = document.getElementById("dataset-select");
  if (!datasetSelect) return;
  const datasetKey = datasetSelect.value;
  const { calendarYear, rasterYear } = readYearSliderMapPair(datasetKey);
  const basinVal = document.getElementById("basin-select")?.value;
  const basinIndex = basinVal === "" || basinVal === undefined ? NaN : parseInt(basinVal, 10);

  const dataYearNational = pickDataYearForCalendarYear(calendarYear, datasetKey);

  if (!Number.isFinite(basinIndex)) {
    renderDistributionChart(datasetKey, { mapYear: dataYearNational });
    updateBasinKeyMetrics(datasetKey, NaN, NaN, calendarYear);
    return;
  }
  const index = state.subbasinZonal[datasetKey];
  if (index instanceof Map) {
    const zonalYear = pickSubbasinZonalYearForCalendar(index, basinIndex, calendarYear, datasetKey);
    const distPayload = buildSubbasinDistPayload(index, basinIndex, zonalYear, datasetKey);
    renderDistributionChart(datasetKey, { distOverride: distPayload });
  } else {
    renderDistributionChart(datasetKey, { mapYear: dataYearNational });
  }
  const zonalForMetrics =
    index instanceof Map
      ? pickSubbasinZonalYearForCalendar(index, basinIndex, calendarYear, datasetKey)
      : rasterYear;
  updateBasinKeyMetrics(datasetKey, basinIndex, zonalForMetrics, calendarYear);
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
  const fromYear = parseYearInputEl(fromInput);
  const toYear = parseYearInputEl(toInput);
  /** Keep map slider min/max in sync with filter (full CSV span when From/To are cleared). */
  setYearSliderForDataset(datasetKey);
  const { calendarYear, rasterYear } = readYearSliderMapPair(datasetKey);
  if (yearLabel) {
    yearLabel.textContent = formatMapYearLabel(calendarYear, rasterYear);
    yearLabel.dataset.calendarYear = Number.isFinite(calendarYear) ? String(calendarYear) : "";
    yearLabel.dataset.rasterYear = Number.isFinite(rasterYear) ? String(rasterYear) : "";
  }

  const basinVal = document.getElementById("basin-select")?.value;
  const basinIndex = basinVal === "" || basinVal === undefined ? NaN : parseInt(basinVal, 10);
  let zonalYearForMetrics = rasterYear;

  const trendNote = document.getElementById("trend-scope-note");
  const distNote = document.getElementById("distribution-scope-note");
  const hint = document.getElementById("map-overlay-hint");

  setLegend(datasetKey);

  await updateRasterOverlay(datasetKey, rasterYear);
  if (seq !== applyFiltersSeq) return;
  if (state.map.instance) state.map.instance.invalidateSize();

  const dataYearNational = pickDataYearForCalendarYear(calendarYear, datasetKey);

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
    renderDistributionChart(datasetKey, { mapYear: dataYearNational });
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
      renderDistributionChart(datasetKey, { mapYear: dataYearNational });
    } else {
      const index = state.subbasinZonal[datasetKey];
      const zonalYearList = getZonalYearsForBasin(index, basinIndex);
      if (trendNote) {
        trendNote.hidden = false;
        trendNote.textContent = "Trend and distribution use sub-basin aggregates.";
      }
      const zonalYear = pickSubbasinZonalYearForCalendar(index, basinIndex, calendarYear, datasetKey);
      zonalYearForMetrics = zonalYear;
      if (distNote) {
        distNote.hidden = false;
        distNote.textContent = Number.isFinite(zonalYear)
          ? `Sub-basin distribution for zonal year ${zonalYear}${calendarYear !== zonalYear ? ` (map slider: ${calendarYear})` : ""}.`
          : "Choose a map year on the slider.";
      }
      const trendPayload = buildSubbasinTrendPayload(
        index,
        basinIndex,
        selectedClass,
        fromYear,
        toYear,
        zonalYearList.length ? zonalYearList : getYearsForMapSlider(datasetKey),
        datasetKey,
      );
      renderTrendChart(datasetKey, selectedClass, fromYear, toYear, trendPayload);
      const distPayload = buildSubbasinDistPayload(index, basinIndex, zonalYear, datasetKey);
      renderDistributionChart(datasetKey, { distOverride: distPayload });
    }
  }

  if (hint) {
    if (Number.isFinite(rasterYear)) {
      hint.textContent =
        Number.isFinite(calendarYear) && calendarYear !== rasterYear
          ? `GeoTIFF: ${rasterYear} (slider: ${calendarYear})`
          : `GeoTIFF: ${rasterYear}`;
    } else {
      hint.textContent = "";
    }
  }

  updateBasinKeyMetrics(datasetKey, basinIndex, zonalYearForMetrics, calendarYear);

  await runChangeDetectionOutput();
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

/** @returns {object | null} */
function getValidationRefBlock(data, refKey) {
  if (data.references && data.references[refKey]) {
    return data.references[refKey];
  }
  if (refKey === "corine" && Array.isArray(data.national)) {
    return {
      national: data.national,
      subbasin_zonal: data.subbasin_zonal || {},
      description: data.description,
      subbasin_note: data.subbasin_note,
      label: "CORINE CLC",
      key: "corine",
    };
  }
  return null;
}

function bindValidationReferenceSelectOnce() {
  const sel = document.getElementById("validation-reference-select");
  if (!sel || sel.dataset.bound) return;
  sel.dataset.bound = "1";
  sel.addEventListener("change", () => renderValidationRef(sel.value));
}

function renderValidationRef(refKey) {
  const data = state.validationMetrics;
  const descEl = document.getElementById("validation-description");
  const errEl = document.getElementById("validation-error");
  const tbody = document.getElementById("validation-summary-body");
  const perDs = document.getElementById("validation-per-dataset");
  const mlNote = document.getElementById("validation-ml-note");
  const canvas = document.getElementById("validation-rmse-chart");
  const titleEl = document.getElementById("validation-panel-title");
  if (!data || !tbody || !canvas || !descEl) return;

  const block = getValidationRefBlock(data, refKey);
  if (!block) {
    if (errEl) {
      errEl.hidden = false;
      errEl.textContent = `No validation block for reference "${refKey}".`;
    }
    return;
  }

  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }

  if (titleEl) {
    titleEl.textContent = `Validation — ${block.label || refKey}`;
  }

  const genEl = document.getElementById("validation-generated");
  if (genEl) {
    if (data.generated_at) {
      genEl.hidden = false;
      const base = `Computed: ${data.generated_at}`;
      genEl.textContent =
        refKey === "corine"
          ? `${base} · CORINE years: ${(data.corine_years || []).join(", ")}`
          : `${base} · Single GRPK snapshot (national shares); see outputs/grpk_reference_shares.json.`;
    } else {
      genEl.hidden = true;
      genEl.textContent = "";
    }
  }

  descEl.replaceChildren();
  descEl.append(
    document.createTextNode(
      block.description ||
        data.description ||
        "National shares; RMSE/MAE in share units (0–1).",
    ),
  );
  descEl.append(document.createTextNode(" "));
  const regen = document.createElement("span");
  regen.className = "validation-ml-note";
  regen.append("Regenerate ");
  const codeEl = document.createElement("code");
  codeEl.textContent =
    refKey === "grpk"
      ? "python analysis/build_grpk_reference.py && python analysis/compute_validation_metrics.py"
      : "python analysis/compute_validation_metrics.py";
  regen.append(codeEl);
  regen.append(" after changing outputs/*.csv.");
  descEl.append(regen);

  const footEl = document.getElementById("validation-footnotes");
  if (footEl) {
    if (refKey === "corine") {
      footEl.textContent = [
        "‡ Mean r: average of per-class correlations across years.",
        block.subbasin_note || "",
      ]
        .filter(Boolean)
        .join(" ");
    } else {
      footEl.textContent = [block.subbasin_note || ""].filter(Boolean).join(" ");
    }
  }

  const sub = block.subbasin_zonal || {};
  const labels = [];
  const rmseVals = [];
  const barColors = ["#0ea5e9", "#22c55e", "#a855f7", "#f97316", "#6366f1"];

  tbody.innerHTML = "";
  if (perDs) perDs.innerHTML = "";

  const nationalRows = block.national || [];
  if (block.error && nationalRows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 10;
    td.textContent = block.error;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  nationalRows.forEach((row) => {
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
    const hasPresent = Array.isArray(presentList) && presentList.length > 0;
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

  if (mlNote && nationalRows[0] && nationalRows[0].ml_note) {
    mlNote.textContent = nationalRows[0].ml_note;
  } else if (mlNote) {
    mlNote.textContent = "";
  }

  if (validationRmseChart) validationRmseChart.destroy();
  validationRmseChart = null;
  const refLabel = block.label || refKey;
  if (labels.length > 0) {
    const ctx = canvas.getContext("2d");
    validationRmseChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: `RMSE vs ${refLabel} (share 0–1)`,
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
          title: {
            display: true,
            text: `National RMSE vs ${refLabel} (share units)`,
          },
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
}

async function loadValidationDashboard() {
  const descEl = document.getElementById("validation-description");
  const errEl = document.getElementById("validation-error");
  const tbody = document.getElementById("validation-summary-body");
  const canvas = document.getElementById("validation-rmse-chart");
  if (!tbody || !canvas || !descEl) return;

  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }

  try {
    const resp = await fetch(
      `${resolveDataFileUrl("outputs/dashboard_validation_metrics.json")}?t=${Date.now()}`,
      { cache: "no-store" },
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    state.validationMetrics = data;
    bindValidationReferenceSelectOnce();
    const sel = document.getElementById("validation-reference-select");
    const refKey = sel?.value || "corine";
    renderValidationRef(refKey);
  } catch (e) {
    state.validationMetrics = null;
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
    const { calendarYear, rasterYear } = readYearSliderMapPair(key);
    yearLabel.textContent = formatMapYearLabel(calendarYear, rasterYear);
    yearLabel.dataset.calendarYear = Number.isFinite(calendarYear) ? String(calendarYear) : "";
    yearLabel.dataset.rasterYear = Number.isFinite(rasterYear) ? String(rasterYear) : "";
    syncDistributionToMapYear();
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

async function runChangeDetectionOutput() {
  const out = document.getElementById("change-detect-output");
  if (!out) return;
  const ds = document.getElementById("dataset-select")?.value || "hilda";
  const rows = state[ds];
  const fromInput = document.getElementById("year-from");
  const toInput = document.getElementById("year-to");
  const yFrom = parseYearInputEl(fromInput);
  const yTo = parseYearInputEl(toInput);
  if (!Number.isFinite(yFrom) || !Number.isFinite(yTo)) {
    out.innerHTML =
      "<p>Set <strong>From</strong> and <strong>To</strong> years in Filters, then click <strong>Apply filters</strong> to show the change table.</p>";
    return;
  }
  if (!rows?.length) {
    out.innerHTML = "<p>No time series loaded for this dataset.</p>";
    return;
  }

  const basinSelect = document.getElementById("basin-select");
  const basinVal = basinSelect?.value;
  const basinIndex = basinVal === "" || basinVal === undefined ? NaN : parseInt(basinVal, 10);
  const basinName = basinSelect?.selectedOptions?.[0]?.textContent?.trim() || "";
  const order = nationalDistributionClassLabels(ds);

  const renderTable = (metaHtml, yA, yB, pa, pb) => {
    const rowsHtml = order
      .map((lb) => {
        const va = pa[lb] ?? 0;
        const vb = pb[lb] ?? 0;
        const d = vb - va;
        const sign = d > 0 ? "+" : "";
        return `<tr><td>${lb}</td><td class="num">${va.toFixed(1)}%</td><td class="num">${vb.toFixed(1)}%</td><td class="num">${sign}${d.toFixed(1)}%</td></tr>`;
      })
      .join("");
    out.innerHTML = `${metaHtml}<table class="change-detect-table"><thead><tr><th>Class</th><th>${yA}</th><th>${yB}</th><th>Δ</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
  };

  if (Number.isFinite(basinIndex)) {
    await ensureSubbasinZonalLoaded(ds);
    const index = state.subbasinZonal[ds];
    if (!(index instanceof Map)) {
      out.innerHTML = "<p>Zonal statistics are not available for this dataset.</p>";
      return;
    }
    const rA = pickSubbasinZonalYearForCalendar(index, basinIndex, yFrom, ds);
    const rB = pickSubbasinZonalYearForCalendar(index, basinIndex, yTo, ds);
    const a = buildSubbasinDistPayload(index, basinIndex, rA, ds);
    const b = buildSubbasinDistPayload(index, basinIndex, rB, ds);
    if (!a.labels.length || !b.labels.length) {
      out.innerHTML = "<p>No sub-basin data for those years (check zonal CSV / raster exports).</p>";
      return;
    }
    const pa = {};
    const pb = {};
    a.labels.forEach((lb, i) => {
      pa[lb] = a.values[i];
    });
    b.labels.forEach((lb, i) => {
      pb[lb] = b.values[i];
    });
    const extra =
      rA !== yFrom || rB !== yTo
        ? ` Table headers use your filter years (${yFrom}, ${yTo}); values use the nearest sub-basin zonal years <strong>${rA}</strong> and <strong>${rB}</strong> (floor to available zonal exports, same idea as the map year slider).`
        : "";
    renderTable(
      `<p class="change-detect-meta">Sub-basin: <strong>${basinName}</strong>.${extra}</p>`,
      yFrom,
      yTo,
      pa,
      pb,
    );
    return;
  }

  const dFrom = pickDataYearForCalendarYear(yFrom, ds);
  const dTo = pickDataYearForCalendarYear(yTo, ds);
  const a = buildNationalDistributionForYear(rows, dFrom, ds);
  const b = buildNationalDistributionForYear(rows, dTo, ds);
  if (!a.labels.length || !b.labels.length) {
    out.innerHTML = "<p>No national class totals for at least one of those years (after snapping to available CSV years).</p>";
    return;
  }
  const pa = {};
  const pb = {};
  a.labels.forEach((lb, i) => {
    pa[lb] = a.values[i];
  });
  b.labels.forEach((lb, i) => {
    pb[lb] = b.values[i];
  });
  const natExtra =
    dFrom !== yFrom || dTo !== yTo
      ? ` Filter years ${yFrom}→<strong>${dFrom}</strong>, ${yTo}→<strong>${dTo}</strong> (nearest year with national rows, same as the donut).`
      : "";
  renderTable(
    `<p class="change-detect-meta">National (whole Lithuania), dataset <strong>${ds}</strong>. Δ is the difference between the two percentage columns (percentage points), shown with a % sign.${natExtra}</p>`,
    dFrom,
    dTo,
    pa,
    pb,
  );
}

document.addEventListener("DOMContentLoaded", main);

