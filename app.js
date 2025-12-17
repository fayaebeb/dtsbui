// === Upload & Parse ===
const statusMsg = document.getElementById("statusMsg");
const plansTableBody = document.querySelector("#plansTable tbody");
const personSearchInput = document.getElementById("personSearch");
const clearSearchBtn = document.getElementById("clearSearchBtn");
const exportSummaryBtn = document.getElementById("exportSummaryBtn");
const exportStepsBtn = document.getElementById("exportStepsBtn");
const simulationSelect = document.getElementById("simulationSelect");
const downloadSimulationBtn = document.getElementById("downloadSimulationBtn");
if (downloadSimulationBtn) downloadSimulationBtn.disabled = true;
window.__PUBLISHED_SIMS__ = window.__PUBLISHED_SIMS__ || [];
const showCachedSimulationBtn = document.getElementById("showCachedSimulationBtn");

// ---- Persistence helpers ----
const LS_KEY = "matsim-ui-v1";
const DB_NAME = "matsim-cache";
const DB_STORE = "persons";

const Persist = {
  // small state
  saveUI: (state) => localStorage.setItem(LS_KEY, JSON.stringify(state)),
  loadUI: () => {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); }
    catch { return {}; }
  },

  // big JSON via IndexedDB
  idbOpen: () => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }),
  idbPut: async (key, value) => {
    const db = await Persist.idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  },
  idbGet: async (key) => {
    const db = await Persist.idbOpen();
    const val = await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return val;
  },
  idbDelete: async (key) => {
    const db = await Persist.idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }
};

// single source of truth for persisted UI state
const UI = {
  // defaults
  personFilter: "",
  weights: {
    act: { Home: 1.0, Work: 0.5, Business: 0.3, Shopping: 0.2, __other__: 0.1 },
    leg: { car: -2.0, walk: 0.5, pt: 0.1, __other__: 0.0 }
  },
  selectedByPerson: {},   // { [personId]: number }
  analysisOpen: false,    // panel visibility
  datasetKey: null,       // key used in IndexedDB for persons array
};

// load immediately
Object.assign(UI, Persist.loadUI());

let __ALL_PERSONS__ = [];       // full dataset from server/cached
let __FILTERED_PERSONS__ = [];  // filtered view by personId

// Generate a dataset key from uploaded file (name/size/mtime)
function makeDatasetKey(fileMap) {
  const f = fileMap["output_plans.xml.gz"] || fileMap["output_plans.xml"];
  if (!f) return null;
  return `plans:${f.name}:${f.size}:${f.lastModified}`;
}

// === Projection ===
proj4.defs("EPSG:6671", "+proj=tmerc +lat_0=36 +lon_0=132.1666666666667 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs");
function atlantisToWGS84(x, y) {
  try {
    const [lon, lat] = proj4("EPSG:6671", "EPSG:4326", [x, y]);
    return [lon, lat];
  } catch (e) {
    console.error("Projection failed:", e, x, y);
    return [0, 0];
  }
}

// === Color map for activities ===
const colorMap = {
  Home: "blue",
  Work: "green",
  Business: "orange",
  Shopping: "purple",
  "pt interaction": "gray"
};

// === Map drawings ===
const MAX_MAP_PERSONS = 1000;
let drawnLayers = [];
function clearMapGraphics() {
  drawnLayers.forEach(l => map.removeLayer(l));
  drawnLayers = [];
}
document.getElementById("clearMapBtn")?.addEventListener("click", clearMapGraphics);
document.getElementById("clearMapTopBtn")?.addEventListener("click", clearMapGraphics);

function drawPlanOnMap(person, plan) {
  if (!plan || !Array.isArray(plan.steps)) return; // guard

  const points = [];
  plan.steps.forEach((s) => {
    if (!s) return;
    if (s.kind === "activity" && s.x != null && s.y != null) {
      const [lon, lat] = atlantisToWGS84(s.x, s.y);
      points.push([lat, lon]);
      const marker = L.circleMarker([lat, lon], {
        radius: 4,
        color: colorMap[s.type] || "black",
        fillOpacity: 0.8
      })
        .bindPopup(
          `<strong>${s.type}</strong><br>${person.personId}<br>` +
          `start: ${s.startTime ?? "-"}<br>end: ${s.endTime ?? "-"}<br>` +
          `dur: ${formatSec(s.durationSec)}`
        );
      marker.addTo(map);
      drawnLayers.push(marker);
    }
  });

  if (points.length >= 2) {
    const line = L.polyline(points, { color: "blue", weight: 2 });
    line.addTo(map);
    drawnLayers.push(line);
  }
}

function preferredSelectedIndex(person) {
  const stored = UI.selectedByPerson?.[person.personId];
  if (Number.isInteger(stored)) return stored;
  if (Number.isInteger(person.selectedPlanIndex)) return person.selectedPlanIndex;
  return 0;
}

function redrawMapFromFiltered() {
  clearMapGraphics();
  const subset = Array.isArray(__FILTERED_PERSONS__)
    ? __FILTERED_PERSONS__.slice(0, MAX_MAP_PERSONS)
    : [];
  subset.forEach(p => {
    if (!p || !p.plans || p.plans.length === 0) return;
    const selectedIdx = preferredSelectedIndex(p);
    const plan = p.plans[selectedIdx] || p.plans[0];
    if (plan && Array.isArray(plan.steps)) {
      drawPlanOnMap(p, plan);
    }
  });
}

// === Utilities ===
function formatSec(sec) {
  if (sec == null) return "-";
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function getWeights() {
  return {
    act: {
      Home: parseFloat(document.getElementById("wHome").value),
      Work: parseFloat(document.getElementById("wWork").value),
      Business: parseFloat(document.getElementById("wBusiness").value),
      Shopping: parseFloat(document.getElementById("wShopping").value),
      __other__: parseFloat(document.getElementById("wOtherAct").value)
    },
    leg: {
      car: parseFloat(document.getElementById("wCar").value),
      walk: parseFloat(document.getElementById("wWalk").value),
      pt: parseFloat(document.getElementById("wPt").value),
      __other__: parseFloat(document.getElementById("wOtherLeg").value)
    }
  };
}

function computeScoreClient(plan, weights) {
  if (!plan || !Array.isArray(plan.steps)) return 0; // guard
  let score = 0;
  (plan.steps || []).forEach(s => {
    if (!s) return;
    if (s.kind === "activity") {
      const w = weights.act[s.type] ?? weights.act.__other__ ?? 0;
      score += (s.durationSec ?? 0) * w;
    } else if (s.kind === "leg") {
      const w = weights.leg[s.mode] ?? weights.leg.__other__ ?? 0;
      score += (s.durationSec ?? 0) * w;
    }
  });
  return score;
}

function findTopBusByClientScore() {
  // Kept for backwards-compatibility; no longer used for global
  // calculations now that the backend summary endpoint exists.
  const baseW = getWeights();
  baseW.leg.bus = baseW.leg.pt; // treat bus like PT
  let best = null;
  __ALL_PERSONS__.forEach(p => (p.plans || []).forEach((pl, i) => {
    const hasBus = (pl.steps || []).some((s) => s.kind === "leg" && s.mode === "pt");
    if (!hasBus) return;
    const score = computeScoreClient(pl, baseW);
    if (!best || score > best.score) {
      best = { person: p, planIndex: i, plan: pl, score };
    }
  }));
  return best;
}

document.addEventListener("DOMContentLoaded", () => {
  const busBtn = document.getElementById("topBusBtn");
  if (busBtn) {
    busBtn.addEventListener("click", async () => {
      const out = document.getElementById("bus-result");
      const sel = document.getElementById("simulationSelect");
      const simId = sel && sel.value;
      if (!simId) {
        alert("シミュレーションを選択してください。"); // Please select a simulation.
        return;
      }
      if (out) out.textContent = "全員分を集計中…"; // computing over all persons
      try {
        const res = await fetch(`/api/simulations/${simId}/summary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ weights: getWeights() }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Summary failed");
        const best = data?.bestBusPlan;
        if (!best) {
          if (out) out.textContent = "No bus users found.";
          return;
        }
        const lines = [
          `Person: ${best.personId}`,
          `Plan Index: ${best.planIndex}`,
          `Client Score: ${best.clientScore?.toFixed?.(2) ?? "-"}`,
          `MATSim Score: ${best.matsimScore ?? "-"}`,
          `Server Score: ${best.serverScore ?? "-"}`,
          "",
          "Behavior:",
        ];
        if (Array.isArray(best.steps)) {
          best.steps.forEach((s, idx) => {
            if (!s) return;
            if (s.kind === "activity") {
              lines.push(`${idx}. [ACT] ${s.type} ${s.startTime || "-"} → ${s.endTime || "-"}  dur=${formatSec(s.durationSec)}`);
            } else {
              lines.push(`${idx}. [LEG] ${s.mode} dep=${s.depTime || "-"} dur=${formatSec(s.durationSec)}`);
            }
          });
        }
        if (out) out.textContent = lines.join("\n");
      } catch (e) {
        console.error(e);
        if (out) out.textContent = "集計に失敗しました。"; // failed to compute
      }
    });
  }
});

async function fetchFullSummary(simId, weights) {
  const res = await fetch(`/api/simulations/${simId}/summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weights }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "Summary failed");
  return data;
}

function renderFullSummary(summary) {
  const statusEl = document.getElementById("fullSummaryStatus");
  const preEl = document.getElementById("fullSummaryPre");
  if (!preEl) return;

  if (!summary || typeof summary !== "object") {
    if (statusEl) statusEl.textContent = "Full summary unavailable.";
    preEl.textContent = "";
    return;
  }

  const lines = [];
  if (typeof summary.personCount === "number") lines.push(`Persons: ${summary.personCount}`);
  if (typeof summary.selectedPlanCount === "number") lines.push(`Selected plans: ${summary.selectedPlanCount}`);
  if (typeof summary.avgClientScore === "number") lines.push(`Avg client score (selected): ${summary.avgClientScore.toFixed(2)}`);

  const best = summary.bestPlan;
  if (best) {
    lines.push("");
    lines.push("Best plan (all persons):");
    lines.push(`  Person: ${best.personId ?? "-"}`);
    lines.push(`  Plan index: ${best.planIndex ?? "-"}`);
    lines.push(`  Client score: ${best.clientScore?.toFixed?.(2) ?? "-"}`);
    lines.push(`  MATSim score: ${best.matsimScore ?? "-"}`);
    lines.push(`  Server score: ${best.serverScore ?? "-"}`);
  }

  const bestBus = summary.bestBusPlan;
  if (bestBus) {
    lines.push("");
    lines.push("Best bus plan (all persons):");
    lines.push(`  Person: ${bestBus.personId ?? "-"}`);
    lines.push(`  Plan index: ${bestBus.planIndex ?? "-"}`);
    lines.push(`  Client score: ${bestBus.clientScore?.toFixed?.(2) ?? "-"}`);
    lines.push(`  MATSim score: ${bestBus.matsimScore ?? "-"}`);
    lines.push(`  Server score: ${bestBus.serverScore ?? "-"}`);
  }

  if (statusEl) statusEl.textContent = "Full summary computed on backend.";
  preEl.textContent = lines.join("\n");
}

async function computeAndShowFullSummary() {
  const sel = document.getElementById("simulationSelect");
  const simId = sel && sel.value;
  const statusEl = document.getElementById("fullSummaryStatus");
  const preEl = document.getElementById("fullSummaryPre");
  if (!statusEl || !preEl) return;

  if (!simId) {
    statusEl.textContent = "Select a simulation first.";
    preEl.textContent = "";
    return;
  }

  statusEl.textContent = "Computing full summary on backend…";
  preEl.textContent = "";
  try {
    const summary = await fetchFullSummary(simId, getWeights());
    renderFullSummary(summary);
  } catch (e) {
    console.error(e);
    statusEl.textContent = "Full summary failed.";
    preEl.textContent = e?.message || "Error";
  }
}

document.getElementById("fullSummaryBtn")?.addEventListener("click", computeAndShowFullSummary);


// === UI <-> Persistence wiring (weights, filter, panel open) ===
function applyWeightsToInputs() {
  document.getElementById("wHome").value = UI.weights.act.Home;
  document.getElementById("wWork").value = UI.weights.act.Work;
  document.getElementById("wBusiness").value = UI.weights.act.Business;
  document.getElementById("wShopping").value = UI.weights.act.Shopping;
  document.getElementById("wOtherAct").value = UI.weights.act.__other__;
  document.getElementById("wCar").value = UI.weights.leg.car;
  document.getElementById("wWalk").value = UI.weights.leg.walk;
  document.getElementById("wPt").value = UI.weights.leg.pt;
  document.getElementById("wOtherLeg").value = UI.weights.leg.__other__;
}
function readWeightsFromInputs() {
  UI.weights = getWeights();
  Persist.saveUI(UI);
}
["wHome", "wWork", "wBusiness", "wShopping", "wOtherAct", "wCar", "wWalk", "wPt", "wOtherLeg"]
  .forEach(id => document.getElementById(id)?.addEventListener("input", readWeightsFromInputs));

if (personSearchInput) {
  personSearchInput.value = UI.personFilter || "";
  personSearchInput.addEventListener("input", () => {
    UI.personFilter = personSearchInput.value;
    Persist.saveUI(UI);
  });
}

// panel open/close state
const analysisBlock = document.getElementById("analysisBlock");
const toggleAnalysisBtn = document.getElementById("toggleAnalysisBtn");
function setAnalysisOpen(open) {
  UI.analysisOpen = !!open;
  Persist.saveUI(UI);
  if (analysisBlock) analysisBlock.style.display = open ? "block" : "none";
  if (toggleAnalysisBtn) {
    toggleAnalysisBtn.textContent = open ? "▲ 解析パネルを閉じる" : "▼ 解析パネルを開く";
  }
  if (window.reflowAnalysisPanel) window.reflowAnalysisPanel();
}
toggleAnalysisBtn?.addEventListener("click", () => setAnalysisOpen(!UI.analysisOpen));
// restore now
setAnalysisOpen(!!UI.analysisOpen);
applyWeightsToInputs();

// === Persons Table ===
function renderPersonsTable(persons) {
  plansTableBody.innerHTML = "";
  persons.forEach(p => {
    // If person has no plans, render a minimal row and skip
    if (!p || !p.plans || p.plans.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${p?.personId ?? "-"}</td>
        <td>-</td>
        <td>-</td>
        <td><span class="badge">no plans</span></td>
        <td class="muted">N/A</td>
        <td class="muted">N/A</td>
      `;
      plansTableBody.appendChild(tr);
      return;
    }

    const selectedIdx = preferredSelectedIndex(p);
    const selected = p.plans[selectedIdx] || p.plans[0];
    const tr = document.createElement("tr");

    // Plans selector
    const sel = document.createElement("select");
    sel.style.fontSize = "12px";
    p.plans.forEach((pl, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      const matsimScore = (pl.matsimScore != null) ? pl.matsimScore.toFixed(3) : "n/a";
      opt.text = `#${i} (MATSim:${matsimScore}) ${pl.selected ? "[selected]" : ""}`;
      sel.appendChild(opt);
    });
    sel.value = String(selectedIdx);
    sel.addEventListener("change", (e) => {
      const idx = Number(e.target.value);
      UI.selectedByPerson = UI.selectedByPerson || {};
      UI.selectedByPerson[p.personId] = idx;     // persist
      Persist.saveUI(UI);

      clearMapGraphics();
      const plan = p.plans[idx] || p.plans[0];
      if (plan && Array.isArray(plan.steps)) {
        drawPlanOnMap(p, plan);
      }
    });

    // Actions
    const btnDraw = document.createElement("button");
    btnDraw.type = "button";
    btnDraw.className = "btn";
    btnDraw.textContent = "Draw";
    btnDraw.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearMapGraphics();
      const plan = p.plans[Number(sel.value)];
      if (plan && Array.isArray(plan.steps)) {
        drawPlanOnMap(p, plan);
      }
    });

    const btnDetails = document.createElement("button");
    btnDetails.type = "button";
    btnDetails.className = "btn secondary";
    btnDetails.textContent = "Details";
    btnDetails.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = Number(sel.value);
      const target = p.plans[idx];
      if (!target || !Array.isArray(target.steps)) {
        alert(`Person: ${p.personId}\nPlan #${idx}\n(no steps)`);
        return;
      }
      const lines = [
        `Person: ${p.personId}`,
        `Plan #${idx}  MATSimScore: ${target.matsimScore?.toFixed?.(3) ?? "-"}`,
        `ServerScore: ${target.serverScore?.toFixed?.(2) ?? "-"}`,
        `ClientScore (current weights): ${computeScoreClient(target, getWeights()).toFixed(2)}`,
        `Steps:`
      ];
      target.steps.forEach((s, i) => {
        if (!s) return;
        if (s.kind === "activity") {
          lines.push(`  ${i}. [ACT] ${s.type}  ${s.startTime ?? "-"} → ${s.endTime ?? "-"}  dur=${formatSec(s.durationSec)}`);
        } else {
          lines.push(`  ${i}. [LEG] ${s.mode}  dep=${s.depTime ?? "-"}  tt=${formatSec(s.durationSec)}`);
        }
      });
      alert(lines.join("\n"));
    });

    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.appendChild(btnDraw);
    actions.appendChild(btnDetails);

    // Our score (use client weights) — guarded
    const ourScore = computeScoreClient(selected, getWeights());

    tr.innerHTML = `
      <td>${p.personId}</td>
      <td>${selected?.matsimScore != null ? selected.matsimScore.toFixed(3) : "-"}</td>
      <td data-ourscore>${ourScore.toFixed(2)}</td>
      <td>${selected?.selected ? '<span class="badge">selected=yes</span>' : ''}</td>
    `;
    const tdPlans = document.createElement("td");
    tdPlans.appendChild(sel);
    const tdActions = document.createElement("td");
    tdActions.appendChild(actions);

    tr.appendChild(tdPlans);
    tr.appendChild(tdActions);
    plansTableBody.appendChild(tr);
  });
}

// === Filtering ===
function applyFilterAndRender() {
  const q = (personSearchInput?.value || "").trim().toLowerCase();
  if (!q) {
    __FILTERED_PERSONS__ = __ALL_PERSONS__.slice();
  } else {
    __FILTERED_PERSONS__ = __ALL_PERSONS__.filter(p =>
      (p?.personId || "").toLowerCase().includes(q)
    );
  }
  renderPersonsTable(__FILTERED_PERSONS__);
  if (window.reflowAnalysisPanel) window.reflowAnalysisPanel();
}

let _searchTimer = null;
personSearchInput?.addEventListener("input", () => {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => {
    applyFilterAndRender();
    redrawMapFromFiltered();
    statusMsg.textContent = `Loaded ${__FILTERED_PERSONS__.length} of ${__ALL_PERSONS__.length} persons (filtered)`;
  }, 150);
});

clearSearchBtn?.addEventListener("click", () => {
  if (personSearchInput) personSearchInput.value = "";
  UI.personFilter = "";
  Persist.saveUI(UI);
  applyFilterAndRender();
  redrawMapFromFiltered();
  statusMsg.textContent = `Loaded ${__FILTERED_PERSONS__.length} of ${__ALL_PERSONS__.length} persons (filtered)`;
});

// === CSV export ===
function downloadCSV(filename, rows) {
  const csv = rows.map(r => r.map(v => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }).join(",")).join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(url);
  a.remove();
}

// reads the current selected plan index per row from the DOM
function getCurrentTableSelection() {
  const selections = [];
  const rows = Array.from(plansTableBody.querySelectorAll("tr"));
  rows.forEach((tr, i) => {
    const p = __FILTERED_PERSONS__[i];
    if (!p || !p.plans || p.plans.length === 0) return;
    const selEl = tr.querySelector("select");
    let idx = 0;
    if (selEl) {
      const n = Number(selEl.value);
      if (!Number.isNaN(n)) idx = n;
    } else if (UI.selectedByPerson && Number.isInteger(UI.selectedByPerson[p.personId])) {
      idx = UI.selectedByPerson[p.personId];
    } else if (Number.isInteger(p.selectedPlanIndex)) {
      idx = p.selectedPlanIndex;
    }
    const plan = p.plans[idx] || p.plans[0];
    selections.push({ person: p, planIndex: idx, plan });
  });
  return selections;
}

exportSummaryBtn?.addEventListener("click", () => {
  const weights = getWeights();
  const selections = getCurrentTableSelection();
  const rows = [
    ["personId", "planIndex", "matsimScore", "serverScore", "clientScore", "selectedFlag"]
  ];
  selections.forEach(({ person, planIndex, plan }) => {
    const clientScore = computeScoreClient(plan, weights);
    rows.push([
      person.personId,
      planIndex,
      plan?.matsimScore ?? "",
      plan?.serverScore ?? "",
      clientScore.toFixed(2),
      plan?.selected ? "yes" : "no"
    ]);
  });
  downloadCSV(`matsim_summary_${Date.now()}.csv`, rows);
});

exportStepsBtn?.addEventListener("click", () => {
  const selections = getCurrentTableSelection();
  const header = [
    "personId", "planIndex", "stepIndex", "kind", "type", "mode",
    "startTime", "endTime", "depTime", "travelTime", "durationSec", "x", "y"
  ];
  const rows = [header];
  selections.forEach(({ person, planIndex, plan }) => {
    const steps = (plan && Array.isArray(plan.steps)) ? plan.steps : [];
    steps.forEach((s, i) => {
      rows.push([
        person.personId,
        planIndex,
        i,
        s?.kind ?? "",
        s?.type ?? "",
        s?.mode ?? "",
        s?.startTime ?? "",
        s?.endTime ?? "",
        s?.depTime ?? "",
        s?.travelTime ?? "",
        s?.durationSec ?? "",
        s?.x ?? "",
        s?.y ?? ""
      ]);
    });
  });
  downloadCSV(`matsim_steps_${Date.now()}.csv`, rows);
});

document.getElementById("recomputeBtn").addEventListener("click", () => {
  const weights = getWeights();
  const rows = Array.from(plansTableBody.querySelectorAll("tr"));
  rows.forEach((tr, i) => {
    const p = __FILTERED_PERSONS__[i];
    if (!p || !p.plans || p.plans.length === 0) return;
    const sel = tr.querySelector("select");
    if (!sel) return;
    const idx = Number(sel.value);
    const plan = p.plans[idx] || p.plans[0];
    const td = tr.querySelector("[data-ourscore]");
    if (!td) return;
    td.textContent = computeScoreClient(plan, weights).toFixed(2);
  });
  if (window.reflowAnalysisPanel) window.reflowAnalysisPanel();
  computeAndShowFullSummary();
});

// (Optional) expose for debugging
window._dbg = { atlantisToWGS84 };

// === Public simulation loader (no uploads) ===
function updateDownloadButtonState() {
  if (!downloadSimulationBtn) return;
  const sims = Array.isArray(window.__PUBLISHED_SIMS__) ? window.__PUBLISHED_SIMS__ : [];
  const selectedId = simulationSelect?.value || '';
  const selected = sims.find((s) => s.id === selectedId);
  const canDownload = !!(selected && selected.has_blob);
  downloadSimulationBtn.disabled = !canDownload;
  downloadSimulationBtn.title = canDownload ? 'Download the original simulation zip' : 'No Azure blob available for download';
}

if (simulationSelect) {
  simulationSelect.addEventListener('change', updateDownloadButtonState);
}

if (downloadSimulationBtn) {
  const originalDownloadLabel = downloadSimulationBtn.textContent || 'Download';
  downloadSimulationBtn.addEventListener('click', async () => {
    const selectedId = simulationSelect?.value;
    if (!selectedId) return;
    downloadSimulationBtn.disabled = true;
    downloadSimulationBtn.textContent = 'Preparing...';
    try {
      const res = await fetch(`/api/simulations/${selectedId}/blob-url`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.downloadUrl) {
        throw new Error(data?.error || 'Download link unavailable');
      }
      window.open(data.downloadUrl, '_blank', 'noopener');
    } catch (err) {
      console.error('Download link error', err);
      alert(err?.message || 'Failed to retrieve download link.');
    } finally {
      if (downloadSimulationBtn) {
        downloadSimulationBtn.textContent = originalDownloadLabel;
        downloadSimulationBtn.disabled = false;
      }
      updateDownloadButtonState();
    }
  });
}

async function populateSimulationList() {
  try {
    const res = await fetch('/api/simulations');
    const sims = await res.json();
    window.__PUBLISHED_SIMS__ = Array.isArray(sims) ? sims : [];
    const sel = simulationSelect;
    if (!sel) return;
    sel.innerHTML = '';

    const list = window.__PUBLISHED_SIMS__;
    if (!Array.isArray(list) || list.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No published simulations';
      sel.appendChild(opt);
      updateDownloadButtonState();
      return;
    }

    list.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.name} — ${s.id.slice(0, 8)}`;
      sel.appendChild(opt);
    });
    updateDownloadButtonState();
  } catch (e) {
    console.error('Failed to load simulations', e);
    if (downloadSimulationBtn) downloadSimulationBtn.disabled = true;
  }
}


document.getElementById('loadSimulationBtn')?.addEventListener('click', async () => {
  const sel = document.getElementById('simulationSelect');
  if (!sel || !sel.value) return alert('Select a simulation');
  const id = sel.value;
  const spinner = document.getElementById('loadSimSpinner');
  spinner && (spinner.style.display = 'inline');
  statusMsg.textContent = '';
  try {
    const res = await fetch(`/api/simulations/${id}/data?limit=1000`);
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (data?.error?.includes('No cached data')) {
        alert('⚠️ Admin has not parsed this simulation yet.');
      } else {
        alert(data?.error || 'Load failed.');
      }
      return;
    }

    const parsed = data;
    if (!Array.isArray(parsed)) throw new Error('Server returned invalid JSON');
    window.__PARSED__ = parsed;
    __ALL_PERSONS__ = parsed;
    const dsKey = `pub:${id}`;
    await Persist.idbPut(dsKey, parsed);
    UI.datasetKey = dsKey;
    Persist.saveUI(UI);
    applyFilterAndRender();
    statusMsg.textContent = `Loaded ${__FILTERED_PERSONS__.length} of ${__ALL_PERSONS__.length} persons (filtered)`;
    redrawMapFromFiltered();
    computeAndShowFullSummary();
  } catch (err) {
    console.error(err);
    alert('Load failed.');
  } finally {
    spinner && (spinner.style.display = 'none');
  }
});

// === Boot-time restore from cache ===
(async function bootRestore() {
  try {
    populateSimulationList();
    if (UI.datasetKey) {
      const cached = await Persist.idbGet(UI.datasetKey);
      if (Array.isArray(cached) && cached.length) {
        window.__PARSED__ = cached;
        __ALL_PERSONS__ = cached;

        applyFilterAndRender();
        statusMsg.textContent = `Restored ${__FILTERED_PERSONS__.length} of ${__ALL_PERSONS__.length} persons (cached). Click "Show on Map" to display.`;
      }
    } else {
      applyFilterAndRender();
    }
  } catch (e) {
    console.warn("Restore failed:", e);
  }
})();

// Button to show currently loaded (or cached) persons on the map on demand
showCachedSimulationBtn?.addEventListener("click", () => {
  if (!Array.isArray(__ALL_PERSONS__) || __ALL_PERSONS__.length === 0) {
    alert("No simulation data loaded. Please Load a Published Simulation first.");
    return;
  }
  // Ensure filtered list exists
  if (!Array.isArray(__FILTERED_PERSONS__) || __FILTERED_PERSONS__.length === 0) {
    applyFilterAndRender();
  }
  redrawMapFromFiltered();
  const shown = Math.min(
    Array.isArray(__FILTERED_PERSONS__) ? __FILTERED_PERSONS__.length : 0,
    MAX_MAP_PERSONS,
  );
  statusMsg.textContent = `Displayed ${shown} of ${__ALL_PERSONS__.length} persons on the map.`;
});

// === Single button: Show/Clear toggle (top published sims) ===
(() => {
  const toggleBtn = document.getElementById("toggleCachedSimulationBtn");
  const showBtn = document.getElementById("showCachedSimulationBtn");
  const clearBtn = document.getElementById("clearMapTopBtn"); // already wired to clearMapGraphics

  if (!toggleBtn || !showBtn || !clearBtn) return;

  const setState = (state) => {
    toggleBtn.dataset.state = state;
    toggleBtn.textContent = (state === "show") ? "地図に表示" : "地図クリア";
  };

  // initial label
  setState("show");

  toggleBtn.addEventListener("click", () => {
    if (toggleBtn.dataset.state === "show") {
      try {
        showBtn.click();
      } finally {
        // flip only if something actually got drawn
        if (Array.isArray(drawnLayers) && drawnLayers.length > 0) {
          setState("clear");
        }
      }
    } else {
      clearBtn.click();
      setState("show");
    }
  });

  clearBtn.addEventListener("click", () => setState("show"));
})();


// button to call the Flask /story endpoint and persist the result for results.html
document.getElementById("genStoryBtn")?.addEventListener("click", async () => {
  const sel = document.getElementById("simulationSelect");
  const simId = sel && sel.value;
  if (!simId) {
    alert("シミュレーションを選択してください。");
    return;
  }
  const weights = getWeights();

  try {
    function loadRouteParams() {
      try { return JSON.parse(localStorage.getItem("routeParams") || "null"); } catch { return null; }
    }

    // Prefer the "most impacted" person from the saved frequency-change params (if available).
    let picked = null;
    const routeParams = loadRouteParams();
    if (routeParams && routeParams.oldFrequency != null && routeParams.newFrequency != null) {
      try {
        const resCmp = await fetch(`/api/simulations/${simId}/frequency-compare`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            routeId: routeParams.routeId,
            oldFrequency: routeParams.oldFrequency,
            newFrequency: routeParams.newFrequency,
            weights,
            includeMostImpactedSteps: true,
          }),
        });
        const cmp = await resCmp.json().catch(() => ({}));
        if (resCmp.ok) {
          const mi = cmp?.mostImpacted;
          if (mi && mi.personId && Array.isArray(mi.afterPlanSteps) && mi.afterPlanSteps.length) {
            picked = {
              personId: mi.personId,
              planIndex: mi.afterPlanIndex,
              planSteps: mi.afterPlanSteps,
              meta: { kind: "mostImpacted", deltaScore: mi.deltaScore, routeId: routeParams.routeId },
            };
          }
        }
      } catch (e) {
        console.warn("frequency-compare failed; falling back to bestPlan", e);
      }
    }

    if (!picked) {
      // Fallback: ask backend to find the best plan over all persons
      const resSummary = await fetch(`/api/simulations/${simId}/summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weights }),
      });
      const summary = await resSummary.json().catch(() => ({}));
      if (!resSummary.ok) throw new Error(summary?.error || "Summary failed");
      const best = summary?.bestPlan;
      if (!best || !Array.isArray(best.steps)) {
        alert("No plans available.");
        return;
      }
      picked = {
        personId: best.personId,
        planIndex: best.planIndex,
        planSteps: best.steps,
        meta: { kind: "bestPlan" },
      };
    }

    const res = await fetch("http://127.0.0.1:3000/story", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personId: picked.personId,
        plan: { steps: picked.planSteps },
        weights,
        lang: "ja", // set to "en" if you add a language toggle later
      }),
    });
    const story = await res.json();

    const payload = {
      personId: picked.personId,
      planIndex: picked.planIndex,
      meta: picked.meta,
      story,
      ts: Date.now(),
    };
    localStorage.setItem("matsim-ai-story", JSON.stringify(payload));
    alert("AIストーリーを保存しました。results.html を開いてください。");
  } catch (e) {
    console.error(e);
    alert("AIストーリー生成に失敗しました。");
  }
});
