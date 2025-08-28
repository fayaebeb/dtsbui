// === Upload & Parse ===
const statusMsg = document.getElementById("statusMsg");
const plansTableBody = document.querySelector("#plansTable tbody");
const personSearchInput = document.getElementById("personSearch");
const clearSearchBtn = document.getElementById("clearSearchBtn");
const exportSummaryBtn = document.getElementById("exportSummaryBtn");
const exportStepsBtn = document.getElementById("exportStepsBtn");

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
let drawnLayers = [];
function clearMapGraphics() {
  drawnLayers.forEach(l => map.removeLayer(l));
  drawnLayers = [];
}
document.getElementById("clearMapBtn").addEventListener("click", clearMapGraphics);

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
  __FILTERED_PERSONS__.forEach(p => {
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

// === UI <-> Persistence wiring (weights, filter, panel open) ===
function applyWeightsToInputs() {
  document.getElementById("wHome").value      = UI.weights.act.Home;
  document.getElementById("wWork").value      = UI.weights.act.Work;
  document.getElementById("wBusiness").value  = UI.weights.act.Business;
  document.getElementById("wShopping").value  = UI.weights.act.Shopping;
  document.getElementById("wOtherAct").value  = UI.weights.act.__other__;
  document.getElementById("wCar").value       = UI.weights.leg.car;
  document.getElementById("wWalk").value      = UI.weights.leg.walk;
  document.getElementById("wPt").value        = UI.weights.leg.pt;
  document.getElementById("wOtherLeg").value  = UI.weights.leg.__other__;
}
function readWeightsFromInputs() {
  UI.weights = getWeights();
  Persist.saveUI(UI);
}
["wHome","wWork","wBusiness","wShopping","wOtherAct","wCar","wWalk","wPt","wOtherLeg"]
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
});

// (Optional) expose for debugging
window._dbg = { atlantisToWGS84 };

// === Upload handling with caching + facilities ===
document.getElementById("folderUpload").addEventListener("change", async (event) => {
  const files = Array.from(event.target.files);
  const fileMap = {};
  for (let file of files) fileMap[file.name] = file;

  const plansFile = fileMap["output_plans.xml.gz"] || fileMap["output_plans.xml"];
  if (!plansFile) {
    alert("output_plans.xml(.gz) not found in the uploaded folder.");
    return;
  }

  // try to find a facilities file
  const facilitiesName = [
    "output_facilities.xml.gz",
    "facilities.xml.gz",
    "output_facilities.xml",
    "facilities.xml"
  ].find(n => fileMap[n]);

  const spinner = document.getElementById("folderUploadSpinner");
  const labelText = document.getElementById("folderUploadLabel");
  spinner.style.display = "inline";
  labelText.textContent = "Uploading to server...";
  statusMsg.textContent = "";

  try {
    const formData = new FormData();
    formData.append("file", plansFile);
    if (facilitiesName) {
      formData.append("facilities", fileMap[facilitiesName]); // optional
    }

    // selected_only=false so you can browse multiple plans per person
    const res = await fetch("http://127.0.0.1:5000/upload?limit=1000&selected_only=false", {
      method: "POST",
      body: formData
    });
    const parsed = await res.json();

    if (!Array.isArray(parsed)) throw new Error("Server returned invalid JSON.");

    // keep originals
    window.__PARSED__ = parsed;
    __ALL_PERSONS__ = parsed;

    // cache to IndexedDB and remember key
    const dsKey = makeDatasetKey(fileMap) || `plans:${Date.now()}`;
    await Persist.idbPut(dsKey, parsed);
    UI.datasetKey = dsKey;
    Persist.saveUI(UI);

    // apply any active filter
    applyFilterAndRender();

    labelText.textContent = "✅ Plans Loaded";
    statusMsg.textContent = `Loaded ${__FILTERED_PERSONS__.length} of ${__ALL_PERSONS__.length} persons (filtered)`;

    // Default map draw: selected plan for each filtered person
    redrawMapFromFiltered();
  } catch (err) {
    console.error(err);
    alert("Upload failed.");
    labelText.textContent = "❌ Error";
  } finally {
    spinner.style.display = "none";
  }
});

// === Boot-time restore from cache ===
(async function bootRestore() {
  try {
    if (UI.datasetKey) {
      const cached = await Persist.idbGet(UI.datasetKey);
      if (Array.isArray(cached) && cached.length) {
        window.__PARSED__ = cached;
        __ALL_PERSONS__ = cached;

        applyFilterAndRender();
        redrawMapFromFiltered();

        statusMsg.textContent = `Restored ${__FILTERED_PERSONS__.length} of ${__ALL_PERSONS__.length} persons (cached)`;
      }
    } else {
      applyFilterAndRender();
    }
  } catch (e) {
    console.warn("Restore failed:", e);
  }
})();

// === AI Story generation ===
// choose the top-scoring person/plan using CURRENT client weights
function findTopByClientScore() {
  const weights = getWeights();
  let best = null; // { person, planIndex, plan, score }
  __ALL_PERSONS__.forEach(p => {
    if (!p?.plans?.length) return;
    p.plans.forEach((pl, i) => {
      const s = computeScoreClient(pl, weights);
      if (!best || s > best.score) best = { person: p, planIndex: i, plan: pl, score: s };
    });
  });
  return { best, weights };
}

// button to call the Flask /story endpoint and persist the result for results.html
document.getElementById("genStoryBtn")?.addEventListener("click", async () => {
  const { best, weights } = findTopByClientScore();
  if (!best) return alert("No plans available.");

  try {
    const res = await fetch("http://127.0.0.1:5000/story", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personId: best.person.personId,
        plan: { steps: best.plan.steps },
        weights,
        lang: "ja" // set to "en" if you add a language toggle later
      })
    });
    const story = await res.json();

    const payload = {
      personId: best.person.personId,
      planIndex: best.planIndex,
      score: best.score,
      story,  // { title, one_liner, bubble }
      ts: Date.now()
    };
    localStorage.setItem("matsim-ai-story", JSON.stringify(payload));
    alert("AIストーリーを保存しました。results.html を開いてください。");
  } catch (e) {
    console.error(e);
    alert("AIストーリー生成に失敗しました。");
  }
});
