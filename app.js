// === Upload & Parse ===
const statusMsg = document.getElementById("statusMsg");
const plansTableBody = document.querySelector("#plansTable tbody");
const personSearchInput = document.getElementById("personSearch");
const clearSearchBtn = document.getElementById("clearSearchBtn");
const exportSummaryBtn = document.getElementById("exportSummaryBtn");
const exportStepsBtn = document.getElementById("exportStepsBtn");
const simulationSelect = document.getElementById("simulationSelect");
const downloadSimulationBtn = document.getElementById("downloadSimulationBtn");
const analysisActions = document.querySelector(".dtsb-actions");
const personPlansModal = document.getElementById("personPlansModal");
const personPlansModalBody = document.getElementById("personPlansModalBody");
const personPlansModalStatus = document.getElementById("personPlansModalStatus");
const personPlansSubtitle = document.getElementById("personPlansSubtitle");
const closePersonPlansModalBtn = document.getElementById("closePersonPlansModal");
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
  station: {              // Station counts panel (Saijo by default in UI)
    lat: null,
    lon: null,
    x: null,
    y: null,
    radiusM: 500,
    binSec: 3600,
    beforeSimId: null,
    afterSimId: null,
  },
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

function wgs84ToAtlantis(lat, lon) {
  try {
    const [x, y] = proj4("EPSG:4326", "EPSG:6671", [lon, lat]);
    return [x, y];
  } catch (e) {
    console.error("Projection failed:", e, lat, lon);
    return [null, null];
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
        if (!res.ok) throw new Error(data?.error || "集計に失敗しました。");
        const best = data?.bestBusPlan;
        if (!best) {
          if (out) out.textContent = "バス利用者は見つかりませんでした。";
          return;
        }
        const lines = [
          `人物ID: ${best.personId}`,
          `プラン番号: ${best.planIndex}`,
          `クライアントスコア: ${best.clientScore?.toFixed?.(2) ?? "-"}`,
          `MATSimスコア: ${best.matsimScore ?? "-"}`,
          `サーバースコア: ${best.serverScore ?? "-"}`,
          "",
          "行動:",
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
  if (!res.ok) throw new Error(data?.error || "集計に失敗しました。");
  return data;
}

function renderFullSummary(summary) {
  const statusEl = document.getElementById("fullSummaryStatus");
  const preEl = document.getElementById("fullSummaryPre");
  if (!preEl) return;

  if (!summary || typeof summary !== "object") {
    if (statusEl) statusEl.textContent = "全体集計を表示できません。";
    preEl.textContent = "";
    return;
  }

  const lines = [];
  if (typeof summary.personCount === "number") lines.push(`人数: ${summary.personCount}`);
  if (typeof summary.selectedPlanCount === "number") lines.push(`選択中プラン数: ${summary.selectedPlanCount}`);
  if (typeof summary.avgClientScore === "number") lines.push(`平均クライアントスコア（選択中）: ${summary.avgClientScore.toFixed(2)}`);

  const best = summary.bestPlan;
  if (best) {
    lines.push("");
    lines.push("最良プラン（全員対象）:");
    lines.push(`  人物ID: ${best.personId ?? "-"}`);
    lines.push(`  プラン番号: ${best.planIndex ?? "-"}`);
    lines.push(`  クライアントスコア: ${best.clientScore?.toFixed?.(2) ?? "-"}`);
    lines.push(`  MATSimスコア: ${best.matsimScore ?? "-"}`);
    lines.push(`  サーバースコア: ${best.serverScore ?? "-"}`);
  }

  const bestBus = summary.bestBusPlan;
  if (bestBus) {
    lines.push("");
    lines.push("最良バスプラン（全員対象）:");
    lines.push(`  人物ID: ${bestBus.personId ?? "-"}`);
    lines.push(`  プラン番号: ${bestBus.planIndex ?? "-"}`);
    lines.push(`  クライアントスコア: ${bestBus.clientScore?.toFixed?.(2) ?? "-"}`);
    lines.push(`  MATSimスコア: ${bestBus.matsimScore ?? "-"}`);
    lines.push(`  サーバースコア: ${bestBus.serverScore ?? "-"}`);
  }

  if (statusEl) statusEl.textContent = "全体集計を表示しました。";
  preEl.textContent = lines.join("\n");
}

async function computeAndShowFullSummary() {
  const sel = document.getElementById("simulationSelect");
  const simId = sel && sel.value;
  const statusEl = document.getElementById("fullSummaryStatus");
  const preEl = document.getElementById("fullSummaryPre");
  if (!statusEl || !preEl) return;

  if (!simId) {
    statusEl.textContent = "先にシミュレーションを選択してください。";
    preEl.textContent = "";
    return;
  }

  statusEl.textContent = "バックエンドで全体集計を計算中…";
  preEl.textContent = "";
  try {
    const summary = await fetchFullSummary(simId, getWeights());
    renderFullSummary(summary);
  } catch (e) {
    console.error(e);
    statusEl.textContent = "全体集計に失敗しました。";
    preEl.textContent = e?.message || "エラー";
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
  if (analysisActions) {
    analysisActions.classList.toggle("dtsb-actions--analysis-open", !!open);
  }
  if (toggleAnalysisBtn) {
    toggleAnalysisBtn.textContent = open ? "▲ 解析パネルを閉じる" : "▼ 解析パネルを開く";
  }
  if (window.reflowAnalysisPanel) window.reflowAnalysisPanel();
}
toggleAnalysisBtn?.addEventListener("click", () => setAnalysisOpen(!UI.analysisOpen));
// restore now
setAnalysisOpen(!!UI.analysisOpen);
applyWeightsToInputs();

function getActiveSimulationId() {
  return String(simulationSelect?.value || "");
}

function getLoadedSimulationId() {
  const key = String(UI.datasetKey || "");
  if (key.startsWith("pub:")) return key.slice(4);
  return getActiveSimulationId();
}

function setPersonPlansModalOpen(open) {
  if (!personPlansModal) return;
  personPlansModal.hidden = !open;
  personPlansModal.setAttribute("aria-hidden", open ? "false" : "true");
  document.body.classList.toggle("dtsb-modal-open", !!open);
}

function setPersonPlansModalStatus(text, tone = "") {
  if (!personPlansModalStatus) return;
  personPlansModalStatus.textContent = text || "";
  personPlansModalStatus.dataset.tone = tone || "";
}

function closePersonPlansModal() {
  setPersonPlansModalOpen(false);
}

function formatPlanStepLine(step, idx) {
  if (!step) return "";
  if (step.kind === "activity") {
    return `${idx}. [ACT] ${step.type ?? "-"}  ${step.startTime ?? "-"} → ${step.endTime ?? "-"}  dur=${formatSec(step.durationSec)}`;
  }
  return `${idx}. [LEG] ${step.mode ?? "-"}  dep=${step.depTime ?? "-"}  tt=${formatSec(step.durationSec)}`;
}

function createPlanMetaChip(label, value, tone = "") {
  const chip = document.createElement("span");
  chip.className = "dtsb-plan-card__chip";
  if (tone) chip.dataset.tone = tone;
  chip.textContent = `${label}: ${value}`;
  return chip;
}

function renderPersonPlansModal(personId, payload) {
  if (!personPlansModalBody) return;

  const plans = Array.isArray(payload?.plans) ? payload.plans : [];
  const selectedIdx = Number.isInteger(payload?.selectedPlanIndex) ? payload.selectedPlanIndex : 0;
  personPlansModalBody.innerHTML = "";
  if (personPlansSubtitle) {
    personPlansSubtitle.textContent = `${personId} のプラン候補をオンデマンドで表示しています。`;
  }

  if (!plans.length) {
    setPersonPlansModalStatus("この人物に利用可能なプランはありません。", "error");
    return;
  }

  const grid = document.createElement("div");
  grid.className = "dtsb-plan-grid";

  plans.forEach((plan, idx) => {
    const card = document.createElement("article");
    card.className = "dtsb-plan-card";
    if (idx === selectedIdx || plan?.selected) card.dataset.state = "selected";

    const head = document.createElement("div");
    head.className = "dtsb-plan-card__head";

    const titleWrap = document.createElement("div");
    titleWrap.className = "dtsb-plan-card__titlewrap";

    const title = document.createElement("h4");
    title.className = "dtsb-plan-card__title";
    title.textContent = `Plan #${idx}`;
    titleWrap.appendChild(title);

    const subtitle = document.createElement("p");
    subtitle.className = "dtsb-plan-card__subtitle";
    subtitle.textContent = (idx === selectedIdx || plan?.selected)
      ? "現在の選択プラン"
      : "代替プラン";
    titleWrap.appendChild(subtitle);

    const drawBtn = document.createElement("button");
    drawBtn.type = "button";
    drawBtn.className = "btn dtsb-plan-card__draw";
    drawBtn.textContent = "地図表示";
    drawBtn.addEventListener("click", () => {
      clearMapGraphics();
      if (plan && Array.isArray(plan.steps)) {
        drawPlanOnMap({ personId }, plan);
      }
    });

    head.appendChild(titleWrap);
    head.appendChild(drawBtn);

    const chips = document.createElement("div");
    chips.className = "dtsb-plan-card__chips";
    chips.appendChild(createPlanMetaChip("MATSim", plan?.matsimScore?.toFixed?.(3) ?? "-"));
    chips.appendChild(createPlanMetaChip("Server", plan?.serverScore?.toFixed?.(2) ?? "-"));
    chips.appendChild(createPlanMetaChip("Client", computeScoreClient(plan, getWeights()).toFixed(2), "accent"));
    chips.appendChild(createPlanMetaChip("Steps", Array.isArray(plan?.steps) ? plan.steps.length : 0));
    if (idx === selectedIdx || plan?.selected) {
      chips.appendChild(createPlanMetaChip("State", "Selected", "selected"));
    }

    const stepsPre = document.createElement("pre");
    stepsPre.className = "dtsb-plan-card__steps";
    const stepLines = Array.isArray(plan?.steps)
      ? plan.steps.map((step, stepIdx) => formatPlanStepLine(step, stepIdx)).filter(Boolean)
      : [];
    stepsPre.textContent = stepLines.length ? stepLines.join("\n") : "ステップ情報はありません。";

    card.appendChild(head);
    card.appendChild(chips);
    card.appendChild(stepsPre);
    grid.appendChild(card);
  });

  personPlansModalBody.appendChild(grid);
  setPersonPlansModalStatus(
    plans.length === 1
      ? "この人物は 1 プランのみです。"
      : `${plans.length} 件のプラン候補を表示しています。`,
    "ready"
  );
}

async function openPersonPlansModal(personId) {
  const simId = getLoadedSimulationId();
  if (!simId) {
    alert("先にシミュレーションを選択してください。");
    return;
  }
  if (!personPlansModalBody) return;

  personPlansModalBody.innerHTML = "";
  if (personPlansSubtitle) personPlansSubtitle.textContent = `${personId} のプラン候補を読み込み中です。`;
  setPersonPlansModalStatus("プラン候補を読み込み中…", "loading");
  setPersonPlansModalOpen(true);

  try {
    const res = await fetch(`/api/simulations/${encodeURIComponent(simId)}/persons/${encodeURIComponent(personId)}/plans`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || "プラン詳細の取得に失敗しました。");
    }
    renderPersonPlansModal(personId, data);
  } catch (err) {
    console.error(err);
    if (personPlansSubtitle) personPlansSubtitle.textContent = `${personId} のプラン候補を取得できませんでした。`;
    setPersonPlansModalStatus(err?.message || "プラン詳細の取得に失敗しました。", "error");
    personPlansModalBody.innerHTML = "";
  }
}

closePersonPlansModalBtn?.addEventListener("click", closePersonPlansModal);
personPlansModal?.querySelectorAll("[data-close-person-plans]").forEach((el) => {
  el.addEventListener("click", closePersonPlansModal);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && personPlansModal && !personPlansModal.hidden) {
    closePersonPlansModal();
  }
});

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
        <td><span class="badge">プランなし</span></td>
        <td class="muted">該当なし</td>
      `;
      plansTableBody.appendChild(tr);
      return;
    }

    const selectedIdx = preferredSelectedIndex(p);
    const selected = p.plans[selectedIdx] || p.plans[0];
    const tr = document.createElement("tr");

    // Actions
    const btnDraw = document.createElement("button");
    btnDraw.type = "button";
    btnDraw.className = "btn";
    btnDraw.textContent = "地図表示";
    btnDraw.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearMapGraphics();
      const plan = p.plans[selectedIdx] || p.plans[0];
      if (plan && Array.isArray(plan.steps)) {
        drawPlanOnMap(p, plan);
      }
    });

    const btnDetails = document.createElement("button");
    btnDetails.type = "button";
    btnDetails.className = "btn secondary";
    btnDetails.textContent = "詳細";
    btnDetails.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPersonPlansModal(p.personId);
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
      <td>${selected?.selected ? '<span class="badge">選択中</span>' : ''}</td>
    `;
    const tdActions = document.createElement("td");
    tdActions.appendChild(actions);

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
    const idx = preferredSelectedIndex(p);
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
  downloadSimulationBtn.title = canDownload ? '元のシミュレーション zip をダウンロード' : 'ダウンロード可能な Azure Blob がありません';
}

if (simulationSelect) {
  simulationSelect.addEventListener('change', updateDownloadButtonState);
}

if (downloadSimulationBtn) {
  const originalDownloadLabel = downloadSimulationBtn.textContent || 'ダウンロード';
  downloadSimulationBtn.addEventListener('click', async () => {
    const selectedId = simulationSelect?.value;
    if (!selectedId) return;
    downloadSimulationBtn.disabled = true;
    downloadSimulationBtn.textContent = '準備中...';
    try {
      const res = await fetch(`/api/simulations/${selectedId}/blob-url`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.downloadUrl) {
        throw new Error(data?.error || 'ダウンロードリンクを取得できません。');
      }
      window.open(data.downloadUrl, '_blank', 'noopener');
    } catch (err) {
      console.error('Download link error', err);
      alert(err?.message || 'ダウンロードリンクの取得に失敗しました。');
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
      opt.textContent = '公開済みシミュレーションはありません';
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

    // Mirror list into the station compare selects if present.
    const beforeSel = document.getElementById("stationBeforeSimSelect");
    const afterSel = document.getElementById("stationAfterSimSelect");
    function fillCompareSelect(target) {
      if (!target) return;
      target.innerHTML = "";
      list.forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = `${s.name} — ${s.id.slice(0, 8)}`;
        target.appendChild(opt);
      });
    }
    fillCompareSelect(beforeSel);
    fillCompareSelect(afterSel);

    if (beforeSel && UI.station?.beforeSimId) beforeSel.value = UI.station.beforeSimId;
    if (afterSel && UI.station?.afterSimId) afterSel.value = UI.station.afterSimId;
  } catch (e) {
    console.error('Failed to load simulations', e);
    if (downloadSimulationBtn) downloadSimulationBtn.disabled = true;
  }
}


document.getElementById('loadSimulationBtn')?.addEventListener('click', async () => {
  const sel = document.getElementById('simulationSelect');
  if (!sel || !sel.value) return alert('シミュレーションを選択してください。');
  const id = sel.value;
  const spinner = document.getElementById('loadSimSpinner');
  spinner && (spinner.style.display = 'inline');
  statusMsg.textContent = '';
  try {
    const res = await fetch(`/api/simulations/${id}/data?limit=1000`);
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (data?.error?.includes('No cached data')) {
        alert('⚠️ このシミュレーションはまだ管理者によって解析されていません。');
      } else {
        alert(data?.error || '読み込みに失敗しました。');
      }
      return;
    }

    const parsed = data;
    if (!Array.isArray(parsed)) throw new Error('サーバーが不正な JSON を返しました。');
    window.__PARSED__ = parsed;
    __ALL_PERSONS__ = parsed;
    const dsKey = `pub:${id}`;
    await Persist.idbPut(dsKey, parsed);
    UI.datasetKey = dsKey;
    Persist.saveUI(UI);
    applyFilterAndRender();
    statusMsg.textContent = `${__ALL_PERSONS__.length}人中 ${__FILTERED_PERSONS__.length}人を読み込みました（フィルタ適用後）`;
    redrawMapFromFiltered();
    computeAndShowFullSummary();
  } catch (err) {
    console.error(err);
    alert('読み込みに失敗しました。');
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
        statusMsg.textContent = `キャッシュから ${__ALL_PERSONS__.length}人中 ${__FILTERED_PERSONS__.length}人を復元しました。「地図に表示」で確認できます。`;
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
    alert("シミュレーションデータが読み込まれていません。先に公開済みシミュレーションを読み込んでください。");
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
  statusMsg.textContent = `${__ALL_PERSONS__.length}人中 ${shown}人を地図に表示しました。`;
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
  const STORY_FALLBACK_MARKER = "AIサービスが利用できないため、ローカル要約で表示しています。";
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
      if (!resSummary.ok) throw new Error(summary?.error || "集計に失敗しました。");
      const best = summary?.bestPlan;
      if (!best || !Array.isArray(best.steps)) {
        alert("利用可能なプランがありません。");
        return;
      }
      picked = {
        personId: best.personId,
        planIndex: best.planIndex,
        planSteps: best.steps,
        meta: { kind: "bestPlan" },
      };
    }

    // Use same-origin so it works on Azure App Service and locally.
    const res = await fetch("/story", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personId: picked.personId,
        plan: { steps: picked.planSteps },
        weights,
        lang: "ja", // set to "en" if you add a language toggle later
      }),
    });
    const story = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(story?.error || "AIストーリー生成に失敗しました。");
    if (String(story?.one_liner || "").includes(STORY_FALLBACK_MARKER)) {
      throw new Error("AIバックエンドがローカル代替テキストを返したため、ストーリーは保存しませんでした。");
    }

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
    localStorage.removeItem("matsim-ai-story");
    const msg = e && e.message ? String(e.message) : "";
    alert(msg ? `AIストーリー生成に失敗しました。\n${msg}` : "AIストーリー生成に失敗しました。");
  }
});


// ================================
// Station counts (Saijo area)
// ================================
(() => {
  const beforeSel = document.getElementById("stationBeforeSimSelect");
  const afterSel = document.getElementById("stationAfterSimSelect");
  const pickBtn = document.getElementById("stationPickBtn");
  const latInput = document.getElementById("stationLat");
  const lonInput = document.getElementById("stationLon");
  const radiusInput = document.getElementById("stationRadiusM");
  const personLimitSel = document.getElementById("stationPersonLimit");
  const binSel = document.getElementById("stationBinSec");
  const computeBtn = document.getElementById("stationComputeBtn");
  const statusEl = document.getElementById("stationCountsStatus");
  const outEl = document.getElementById("stationCountsOut");

  if (!pickBtn || !latInput || !lonInput || !radiusInput || !personLimitSel || !binSel || !computeBtn || !outEl) return;

  let pickMode = false;
  let circleLayer = null;

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }

  function formatHHMM(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  function updateCircle() {
    const lat = Number(latInput.value);
    const lon = Number(lonInput.value);
    const radiusM = Number(radiusInput.value || 0);
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(radiusM) || radiusM <= 0) return;
    if (!window.map || !window.L) return;
    const latlng = [lat, lon];
    if (!circleLayer) {
      circleLayer = window.L.circle(latlng, { radius: radiusM, color: "#00B3FF", weight: 2, fillOpacity: 0.08 });
      circleLayer.addTo(window.map);
    } else {
      circleLayer.setLatLng(latlng);
      circleLayer.setRadius(radiusM);
    }
  }

  function persistStation() {
    UI.station = UI.station || {};
    UI.station.lat = latInput.value ? Number(latInput.value) : null;
    UI.station.lon = lonInput.value ? Number(lonInput.value) : null;
    UI.station.radiusM = Number(radiusInput.value || 500);
    UI.station.personLimit = personLimitSel.value ? Number(personLimitSel.value) : null;
    UI.station.binSec = Number(binSel.value || 3600);
    UI.station.beforeSimId = beforeSel?.value || null;
    UI.station.afterSimId = afterSel?.value || null;
    Persist.saveUI(UI);
  }

  function applyStationFromUI() {
    const st = UI.station || {};
    if (st.lat != null) latInput.value = String(st.lat);
    if (st.lon != null) lonInput.value = String(st.lon);
    if (st.radiusM != null) radiusInput.value = String(st.radiusM);
    if (st.personLimit != null) personLimitSel.value = String(st.personLimit);
    if (st.binSec != null) binSel.value = String(st.binSec);
    updateCircle();
  }

  applyStationFromUI();
  beforeSel?.addEventListener("change", persistStation);
  afterSel?.addEventListener("change", persistStation);
  latInput.addEventListener("input", () => { persistStation(); updateCircle(); });
  lonInput.addEventListener("input", () => { persistStation(); updateCircle(); });
  radiusInput.addEventListener("input", () => { persistStation(); updateCircle(); });
  personLimitSel.addEventListener("change", persistStation);
  binSel.addEventListener("change", persistStation);

  pickBtn.addEventListener("click", () => {
    pickMode = !pickMode;
    pickBtn.textContent = pickMode ? "地図をクリック…" : "地図から選択";
    setStatus(pickMode ? "駅の位置を設定するには地図をクリックしてください。" : "");
  });

  if (window.map) {
    window.map.on("click", (e) => {
      if (!pickMode) return;
      const lat = e?.latlng?.lat;
      const lon = e?.latlng?.lng;
      if (!isFinite(lat) || !isFinite(lon)) return;
      latInput.value = String(lat);
      lonInput.value = String(lon);
      pickMode = false;
      pickBtn.textContent = "地図から選択";
      persistStation();
      updateCircle();
      setStatus("駅の位置を更新しました。");
    });
  }

  async function fetchStationCounts(simId, centerX, centerY, radiusM, binSec, personLimit) {
    const body = {
      centerX,
      centerY,
      radiusM,
      binSec,
      ...(personLimit ? { person_limit: personLimit } : {}),
    };

    async function postJson(url) {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      return { res: r, data: d };
    }

    // Kick off (or hit cache)
    let { res, data } = await postJson(`/api/simulations/${simId}/station-counts`);
    if (!res.ok) throw new Error(data?.error || "駅周辺人数の集計に失敗しました。");

    // If async job, poll status until result is ready.
    const startedAt = Date.now();
    while (true) {
      const status = String(data?.status || "");
      if (status === "succeeded" && data?.result) return data.result;
      if (status === "failed") throw new Error(data?.error || "駅周辺人数の集計に失敗しました。");

      // 202 running/idle
      if (Date.now() - startedAt > 30 * 60 * 1000) {
        throw new Error("駅周辺人数の集計がタイムアウトしました。");
      }
      await new Promise(r => setTimeout(r, 1500));
      ({ res, data } = await postJson(`/api/simulations/${simId}/station-counts/status`));
      if (!res.ok) throw new Error(data?.error || "駅周辺人数の状態確認に失敗しました。");
    }
  }

  function peakInfo(arr) {
    let best = { value: -1, idx: -1 };
    if (!Array.isArray(arr)) return best;
    arr.forEach((v, i) => {
      const n = Number(v || 0);
      if (n > best.value) best = { value: n, idx: i };
    });
    return best;
  }

  function renderCompare(before, after) {
    const binSec = Number(before?.binSec || after?.binSec || binSel.value || 3600);
    const a = Array.isArray(before?.presentByBin) ? before.presentByBin : [];
    const b = Array.isArray(after?.presentByBin) ? after.presentByBin : [];
    const n = Math.max(a.length, b.length);

    const pv = Number(before?.uniqueVisitors || 0);
    const av = Number(after?.uniqueVisitors || 0);

    const pPeak = peakInfo(a);
    const aPeak = peakInfo(b);

    const lines = [];
    lines.push(`訪問者数: 変更前=${pv} 変更後=${av} 差分=${av - pv}`);
    lines.push(`ピーク人数: 変更前=${pPeak.value} @${formatHHMM(pPeak.idx * binSec)} 変更後=${aPeak.value} @${formatHHMM(aPeak.idx * binSec)}`);
    lines.push("");
    lines.push("時刻,変更前人数,変更後人数,差分");
    for (let i = 0; i < n; i++) {
      const bv = Number(a[i] || 0);
      const nv = Number(b[i] || 0);
      lines.push(`${formatHHMM(i * binSec)},${bv},${nv},${nv - bv}`);
      if (i >= 47) break; // keep it compact
    }
    outEl.textContent = lines.join("\n");
  }

  computeBtn.addEventListener("click", async () => {
    const beforeId = beforeSel?.value;
    const afterId = afterSel?.value;
    if (!beforeId || !afterId) {
      alert("変更前と変更後のシミュレーションを両方選択してください。");
      return;
    }

    const lat = Number(latInput.value);
    const lon = Number(lonInput.value);
    const radiusM = Number(radiusInput.value || 500);
    const binSec = Number(binSel.value || 3600);
    const personLimit = personLimitSel.value ? Number(personLimitSel.value) : null;
    if (!isFinite(lat) || !isFinite(lon)) {
      alert("駅の緯度・経度を設定してください（または地図から選択してください）。");
      return;
    }
    if (!isFinite(radiusM) || radiusM <= 0) {
      alert("半径は 0 より大きい値にしてください。");
      return;
    }

    const [x, y] = wgs84ToAtlantis(lat, lon);
    if (x == null || y == null) {
      alert("座標変換に失敗しました（proj4）。");
      return;
    }

    UI.station.x = x;
    UI.station.y = y;
    UI.station.beforeSimId = beforeId;
    UI.station.afterSimId = afterId;
    UI.station.radiusM = radiusM;
    UI.station.personLimit = personLimit;
    UI.station.binSec = binSec;
    Persist.saveUI(UI);

    setStatus(personLimit ? `駅周辺人数を計算中（先頭 ${personLimit} 人）…` : "駅周辺人数をイベントから計算中…");
    outEl.textContent = "";

    try {
      const [before, after] = await Promise.all([
        fetchStationCounts(beforeId, x, y, radiusM, binSec, personLimit),
        fetchStationCounts(afterId, x, y, radiusM, binSec, personLimit),
      ]);
      renderCompare(before, after);
      setStatus("完了しました。");
    } catch (e) {
      console.error(e);
      setStatus("失敗しました。");
      outEl.textContent = e?.message || "エラー";
    }
  });
})();
