var map = L.map('map', { minZoom: 9 }).setView([31.5, 132.5], 8);

const baseLayers = {
  "標準地図": L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'),
  "ダークモード": L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png')
};
baseLayers["標準地図"].addTo(map);

const overlayLayers = {};
const layerControl = L.control.layers(baseLayers, overlayLayers, { collapsed: false }).addTo(map);

const panes = [
  'rectanglePane', 'populationPane', 'linePane', 'circles',
  'commentaryPane', 'meshPane', 'selectRosen', 'selectStop'
];
panes.forEach((pane, index) => {
  const p = map.createPane(pane);
  p.style.zIndex = 430 + index * 10;
});

let routeA;
let busRoutesLayer = null;
const routeCheckbox = document.getElementById('data_root');
const selectedRouteToggle = document.getElementById('data_selected_route');
const BUS_ROUTE_SOURCES = [
  'bus_route/baseline_transitSchedule_cr24_1.xml',
  'bus_route/brt_transitSchedule_brt24_2.xml',
  'bus_route/net_expansion_transitSchedule_cr40_3.xml',
  'bus_route/output_transitSchedule_brt40_4.xml'
];
const BUS_ROUTE_SOURCE_TO_SIM_ID = {
  'bus_route/baseline_transitSchedule_cr24_1.xml': '096896b54be24ffbb0cbee53dde6fd9f',
  'bus_route/brt_transitSchedule_brt24_2.xml': '67eb5392da3a4202906f46f7b808b888',
  'bus_route/net_expansion_transitSchedule_cr40_3.xml': '18c774153bad4ee0aae34a8dcbb7f03b',
  'bus_route/output_transitSchedule_brt40_4.xml': '10862aa9ea9d4fd18c1b91b980b66439'
};
let currentBusRouteSource = BUS_ROUTE_SOURCES[0];
const IS_RESULTS_PAGE = /\/results(?:_graph)?\.html$/i.test(window.location.pathname || '');
const DISABLE_BASE_ROUTE_LAYER_ON_PAGE = /\/results\.html$/i.test(window.location.pathname || '');
const DEFAULT_BUS_CRS = 'EPSG:6671';
const BUS_CRS_FALLBACKS = [DEFAULT_BUS_CRS, 'EPSG:2445'];
let currentBusCrs = DEFAULT_BUS_CRS;

function readGlobalRouteParams() {
  try {
    return JSON.parse(localStorage.getItem('routeParams') || 'null');
  } catch {
    return null;
  }
}

let persistedRouteParams = readGlobalRouteParams();
if (persistedRouteParams?.sourcePath && BUS_ROUTE_SOURCES.includes(persistedRouteParams.sourcePath)) {
  currentBusRouteSource = persistedRouteParams.sourcePath;
}

function getSimulationIdForCurrentBusSource() {
  return BUS_ROUTE_SOURCE_TO_SIM_ID[currentBusRouteSource] || null;
}

function shouldShowBusRoutesNow() {
  const busToggle = document.getElementById('toggleBusRoutes');
  if (busToggle) return !!busToggle.checked;
  if (IS_RESULTS_PAGE) return selectedRouteToggle ? !!selectedRouteToggle.checked : true;
  return false;
}

// ================================
// Index network link geometry
// ================================
let linkGeom = new Map();

function normId(v) {
  return String(v ?? "").replace(/^link:/i, '').replace(/^pt_/, '').trim();
}

function ensureBusProjDefs() {
  if (typeof proj4 !== 'function') return;
  try {
    // JGD2011 / Japan Plane Rectangular CS III
    proj4.defs('EPSG:6671', '+proj=tmerc +lat_0=36 +lon_0=132.1666666666667 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs');
    // JGD2000 / Japan Plane Rectangular CS III
    proj4.defs('EPSG:2445', '+proj=tmerc +lat_0=36 +lon_0=132.1666666666667 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs');
  } catch (e) { }
}

fetch("matsim_data/network_bus_and_rail_up.geojson")
  .then(res => res.json())
  .then(data => {
    console.log("MATSim network loaded:", data.features.length);

    data.features.forEach(f => {
      const idRaw = f.properties && (f.properties.id ?? f.properties.linkId ?? f.id);
      const id = normId(idRaw);
      if (!id) return;
      if (f.geometry && f.geometry.type === 'LineString') {
        const coords = f.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        linkGeom.set(id, coords);
      }
    });
    console.log("Indexed link geometries:", linkGeom.size);

    routeA = L.geoJSON(data, {
      pane: "linePane",
      style: { color: "#31599E", weight: 2, opacity: 0.8 },
      onEachFeature: (feature, layer) => {
        const info = feature.properties?.id ?? feature.id ?? "Unknown";
        layer.bindTooltip(`Link ID: ${info}`, { permanent: false, direction: "top", className: "l-contents__map-route" });
        layer.on('mouseover', () => layer.setStyle({ weight: 4, color: "#1C3D6E" }));
        layer.on('mouseout', () => layer.setStyle({ weight: 2, color: "#31599E" }));
      }
    });

    map.fitBounds(routeA.getBounds());
    if (!DISABLE_BASE_ROUTE_LAYER_ON_PAGE && routeCheckbox?.checked) routeA.addTo(map);

    busRouteLayerCache.clear();
    if (busRoutesLayer && map.hasLayer(busRoutesLayer)) {
      map.removeLayer(busRoutesLayer);
      busRoutesLayer = null;
      clearSelection();
    }
    // Re-fit once real link geometry is ready (prevents sticking to fallback view).
    busFitDone = false;
    if (shouldShowBusRoutesNow()) {
      const source = currentBusRouteSource;
      buildBusRoutesLayer({ source, forceRebuild: true }).then(layer => {
        if (source !== currentBusRouteSource) return;
        if (!shouldShowBusRoutesNow()) return;
        addBusLayerToMap(layer);
        if (IS_RESULTS_PAGE) focusSavedRouteIfAny();
        updateBusRouteViewForTimeMode();
      });
    }
  });

function routeCheckboxChange() {
  if (DISABLE_BASE_ROUTE_LAYER_ON_PAGE) {
    routeA?.remove();
    return;
  }

  const checked = !!routeCheckbox?.checked;
  if (checked) routeA?.addTo(map);
  else routeA?.remove();
}
routeCheckboxChange();
routeCheckbox?.addEventListener('change', routeCheckboxChange);

// ================================
// Dynamic panel
// ================================
let selectedRouteInfo = null;
let dynControlsVisible = false;

function setDynControlsVisibility(visible, opts = {}) {
  const controls = document.getElementById('dynRouteControls');
  const shouldScroll = !!opts.scroll;

  dynControlsVisible = !!visible;
  if (controls) {
    controls.hidden = !dynControlsVisible;
    // Be robust even if some CSS overrides the UA [hidden] rule.
    controls.style.display = dynControlsVisible ? '' : 'none';
  }

  if (dynControlsVisible && shouldScroll) {
    // Make the "something happened" obvious, especially inside scroll containers.
    controls?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function ensureDynRoutePanel() {
  return document.getElementById('dynRouteContainer');
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setDynSaveStatus(show) {
  const el = document.getElementById('dynSaveStatus');
  if (!el) return;
  el.hidden = !show;
  if (show) setTimeout(() => { el.hidden = true; }, 1200);
}

function dynRouteStorageKey(info) {
  const routeId = info?.routeId ? String(info.routeId) : '';
  return routeId ? `dtsb.routeParams.${routeId}` : 'routeParams';
}

function readDynSavedParams(info) {
  try {
    const key = dynRouteStorageKey(info);
    const txt = localStorage.getItem(key) || localStorage.getItem('routeParams');
    return txt ? JSON.parse(txt) : null;
  } catch {
    return null;
  }
}

function writeDynSavedParams(info, payload) {
  try {
    localStorage.setItem(dynRouteStorageKey(info), JSON.stringify(payload));
    // Compatibility: also store the latest route params under a stable key so
    // results pages can read it without knowing the selected routeId.
    localStorage.setItem('routeParams', JSON.stringify(payload));
  } catch { }
}

function updateDynFreqUi() {
  const slider = document.querySelector('#dynFreqRange .js-range-slider');
  if (!slider) return;
  const v = Number(slider.value || 0);
  const def = Number(slider.dataset.default || 0);
  const val = document.querySelector('#dynFreqRange .js-range-value');
  const diff = document.querySelector('#dynFreqRange .js-range-diff');
  if (val) val.textContent = String(v);
  if (diff) diff.textContent = `(${v - def >= 0 ? '+' : ''}${v - def})`;
  const view = document.getElementById('dynRouteFreqView');
  if (view) view.textContent = `${v} 本`;
}

function routeParamsMatchSelectedRoute(saved, info) {
  if (!saved || !info) return false;
  if (saved.routeId != null && info.routeId != null && String(saved.routeId) !== String(info.routeId)) return false;
  if (saved.lineId != null && info.lineId != null && String(saved.lineId) !== String(info.lineId)) return false;
  if (saved.sourcePath && currentBusRouteSource && String(saved.sourcePath) !== String(currentBusRouteSource)) return false;
  return true;
}

function isSelectedRouteSaveCurrent() {
  if (!selectedRouteInfo) return false;
  const saved = readDynSavedParams(selectedRouteInfo);
  if (!routeParamsMatchSelectedRoute(saved, selectedRouteInfo)) return false;

  const slider = document.querySelector('#dynFreqRange .js-range-slider');
  const currentFreq = Number(slider?.value ?? getBusFreq(selectedRouteInfo) ?? 0);
  const currentBrt = !!document.getElementById('dynBrtToggle')?.checked;
  return Number(saved?.newFrequency) === currentFreq && !!saved?.brtExclusive === currentBrt;
}

function updateInputMissionBoard() {
  const mini = document.getElementById('missionBoardMini');
  const stepLabel = document.getElementById('missionBoardStepLabel');
  const copy = document.getElementById('missionBoardCopy');
  const progress = document.getElementById('missionBoardProgress');
  const stageCards = [
    document.getElementById('missionStageCard1'),
    document.getElementById('missionStageCard2'),
    document.getElementById('missionStageCard3')
  ];

  if (!mini && !stepLabel && !copy && !progress && stageCards.every(card => !card)) return;

  const hasSource = !!currentBusRouteSource;
  const hasSelection = !!selectedRouteInfo;
  const hasSavedChange = hasSelection && isSelectedRouteSaveCurrent();
  const step = hasSavedChange ? 3 : hasSelection ? 2 : hasSource ? 1 : 0;
  const displayStep = Math.max(1, step);
  const progressPercent = displayStep === 1 ? 34 : displayStep === 2 ? 68 : 100;
  const stepText = `STEP ${displayStep} / 3`;

  if (mini) mini.textContent = stepText;
  if (stepLabel) stepLabel.textContent = stepText;
  if (progress) progress.style.setProperty('--progress', `${progressPercent}%`);

  if (copy) {
    copy.textContent = hasSavedChange
      ? '変更を保存しました。結果ステージへ進んで効果を確認できます。'
      : hasSelection
        ? '路線を選択しました。運航頻度や専用レーンを調整して保存します。'
        : '路線を選んで、朝の運行頻度を調整し、結果ステージへ進みます。';
  }

  stageCards.forEach((card, index) => {
    if (!card) return;
    const cardStep = index + 1;
    const state = cardStep < displayStep ? 'done' : cardStep === displayStep ? 'current' : 'todo';
    card.dataset.state = state;
    if (state === 'current') card.setAttribute('aria-current', 'step');
    else card.removeAttribute('aria-current');
  });
}

function bindDynRoutePanel() {
  if (window.__dynRoutePanelBound) return;
  window.__dynRoutePanelBound = true;

  document.getElementById('clearRouteBtn')?.addEventListener('click', () => clearSelection());

  const slider = document.querySelector('#dynFreqRange .js-range-slider');
  if (slider) {
    slider.addEventListener('input', updateDynFreqUi);
    slider.addEventListener('input', updateInputMissionBoard);
  }

  document.getElementById('dynBrtToggle')?.addEventListener('change', updateInputMissionBoard);

  document.getElementById('applyDynParamsBtn')?.addEventListener('click', () => {
    if (!selectedRouteInfo) return;
    const newFreq = Number(document.querySelector('#dynFreqRange .js-range-slider')?.value || 0);
    const brt = !!document.getElementById('dynBrtToggle')?.checked;
    const simId = getSimulationIdForCurrentBusSource();
    const payload = {
      routeId: selectedRouteInfo.routeId,
      lineId: selectedRouteInfo.lineId,
      systemId: selectedRouteInfo.systemId,
      sourcePath: currentBusRouteSource,
      simulationId: simId,
      timeMode: getBusTimeMode(),
      oldFrequency: getBusFreq(selectedRouteInfo),
      newFrequency: newFreq,
      brtExclusive: brt,
      ts: Date.now()
    };
    writeDynSavedParams(selectedRouteInfo, payload);
    persistedRouteParams = payload;
    setDynSaveStatus(true);
    updateInputMissionBoard();
  });
}

ensureDynRoutePanel();
bindDynRoutePanel();
renderRouteDetails(null);
updateInputMissionBoard();

// ================================
// Bus routes derived from transitSchedule
// ================================
let busFitDone = false;
let selectedRouteLayer = null;
let busRouteLayerCache = new Map();

function setActiveBusRouteSourceButton(sourcePath) {
  const wrap = document.getElementById('busRouteSourceButtons');
  if (!wrap) return;
  const buttons = wrap.querySelectorAll('[data-bus-route-source]');
  buttons.forEach(btn => {
    const isActive = btn.getAttribute('data-bus-route-source') === sourcePath;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function initBusRouteSourceButtons() {
  const wrap = document.getElementById('busRouteSourceButtons');
  if (!wrap) return;
  const buttons = Array.from(wrap.querySelectorAll('[data-bus-route-source]'));
  if (!buttons.length) return;

  const activeBtn = buttons.find(btn => btn.classList.contains('is-active')) || buttons[0];
  const initialSource = activeBtn.getAttribute('data-bus-route-source');
  if (initialSource && BUS_ROUTE_SOURCES.includes(initialSource)) {
    currentBusRouteSource = initialSource;
  }
  setActiveBusRouteSourceButton(currentBusRouteSource);

  buttons.forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const source = btn.getAttribute('data-bus-route-source');
      if (!source || !BUS_ROUTE_SOURCES.includes(source)) return;
      if (source === currentBusRouteSource) return;
      currentBusRouteSource = source;
      setActiveBusRouteSourceButton(currentBusRouteSource);
      clearSelection();
      updateInputMissionBoard();
      if (busRoutesLayer && map.hasLayer(busRoutesLayer)) map.removeLayer(busRoutesLayer);
      busRoutesLayer = null;

      if (document.getElementById('toggleBusRoutes')?.checked) {
        const selectedSource = currentBusRouteSource;
        const layer = await buildBusRoutesLayer({ source: selectedSource });
        if (selectedSource !== currentBusRouteSource) return;
        if (!document.getElementById('toggleBusRoutes')?.checked) return;
        addBusLayerToMap(layer);
        updateBusRouteViewForTimeMode();
      }
    });
  });
}

function parseTimeHHMMSS(t) {
  const m = /^([0-9]{2,}):([0-9]{2}):([0-9]{2})$/.exec(t || "");
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}
function mod24s(sec) { return ((sec % 86400) + 86400) % 86400; }
function inMorningWindow(sec) {
  const t = mod24s(sec);
  return t >= 6 * 3600 && t <= (9 * 3600 + 59 * 60 + 59);
}

function getBusTimeMode() {
  return '0609';
}

function getBusFreq(info) {
  const overridden = getOverriddenRouteFrequency(info);
  if (overridden != null) return overridden;
  const mode = getBusTimeMode();
  if (mode === 'all') return info.countAll ?? info.count0609 ?? 0;
  return info.count0609 ?? info.countAll ?? 0;
}

function getBusSamples(info) {
  const mode = getBusTimeMode();
  if (mode === 'all') return (info.samplesAll || info.samples || []);
  return (info.samples0609 || info.samples || []);
}

function getBusTooltip(props) {
  const title = props.systemId ? `系統${props.systemId}` : (props.routeId || 'route');
  const label = getBusTimeMode() === 'all' ? '終日' : '06–09';
  const freq = getBusFreq(props);
  const oldFreq = getSavedOldFrequency(props);
  if (oldFreq != null && oldFreq !== freq) {
    return `${title}<br>${label}: ${freq}本（変更前 ${oldFreq}本）`;
  }
  return `${title}<br>${label}: ${freq}本`;
}

function getBusLineWeight(info) {
  const freq = getBusFreq(info);
  if (freq >= 100) return 16;      // very frequent
  if (freq >= 50) return 9;       // frequent
  if (freq >= 20) return 4;       // moderate
  return 1.5;                     // low frequency
}

const BUS_ROUTE_FAMILY_COLORS = {
  brt: '#FF0000',
  communitybus: '#008000',
  erailwaybus: '#0000FF',
  geiyo: '#0000FF',
  jrbus: '#0000FF'
};

const HIDDEN_ROUTE_FAMILIES = new Set(['jrtrain', 'shinkansen']);

function routeFamilyFromId(v) {
  const m = String(v || '').trim().match(/^([A-Za-z]+)_/);
  return m ? m[1].toLowerCase() : '';
}

function getBusRouteFamily(info) {
  return routeFamilyFromId(info?.routeId) || routeFamilyFromId(info?.lineId) || '';
}

function getOverriddenRouteFrequency(info) {
  const rp = persistedRouteParams;
  if (!rp || rp.newFrequency == null) return null;
  if (rp.sourcePath && rp.sourcePath !== currentBusRouteSource) return null;
  const routeId = String(info?.routeId || '');
  if (!routeId || routeId !== String(rp.routeId || '')) return null;
  const n = Number(rp.newFrequency);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function getSavedOldFrequency(info) {
  const rp = persistedRouteParams;
  if (!rp || rp.oldFrequency == null) return null;
  if (rp.sourcePath && rp.sourcePath !== currentBusRouteSource) return null;
  const routeId = String(info?.routeId || '');
  if (!routeId || routeId !== String(rp.routeId || '')) return null;
  const n = Number(rp.oldFrequency);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function shouldShowBusRoute(info) {
  const family = getBusRouteFamily(info);
  return !HIDDEN_ROUTE_FAMILIES.has(family);
}

function getBusRouteColor(info) {
  const family = getBusRouteFamily(info);
  const fixedColor = BUS_ROUTE_FAMILY_COLORS[family];
  if (fixedColor) return fixedColor;

  const key = String(info?.routeId || info?.lineId || info?.systemId || '');
  const palette = [
    '#E76F51', '#2A9D8F', '#1D3557', '#F4A261',
    '#457B9D', '#43AA8B', '#E63946', '#577590',
    '#8AB17D', '#FF7F11', '#3A86FF', '#6D597A'
  ];
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % palette.length;
  return palette[idx];
}

function updateBusRouteViewForTimeMode() {
  if (busRoutesLayer) {
    busRoutesLayer.eachLayer(layer => {
      const p = layer.feature?.properties || {};
      const tip = getBusTooltip(p);
      layer.unbindTooltip();
      layer.bindTooltip(tip, { permanent: false, direction: 'top', className: 'l-contents__map-route' });
    });
  }
  if (selectedRouteLayer && selectedRouteLayer.feature) {
    renderRouteDetails(selectedRouteLayer.feature.properties);
  }
}

function km2deg(xy, sourceCrs = currentBusCrs || DEFAULT_BUS_CRS) {
  const [x, y] = xy;
  ensureBusProjDefs();
  if (typeof proj4 === 'function' && isFinite(x) && isFinite(y)) {
    const crsCandidates = [sourceCrs, ...BUS_CRS_FALLBACKS].filter((v, i, a) => v && a.indexOf(v) === i);
    for (const crs of crsCandidates) {
      try {
        // Try [x,y] first, then swapped axis as a fallback.
        const p1 = proj4(crs, 'EPSG:4326', [x, y]);
        const p2 = proj4(crs, 'EPSG:4326', [y, x]);
        const candidates = [[p1[1], p1[0]], [p2[1], p2[0]]];
        for (const [lat, lon] of candidates) {
          const finite = isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
          const nearJapan = lat >= 20 && lat <= 50 && lon >= 120 && lon <= 155;
          if (finite && nearJapan) return [lat, lon];
        }
      } catch (e) { }
    }
  }
  if (isFinite(x) && isFinite(y) && Math.abs(y) <= 90 && Math.abs(x) <= 180) return [y, x];
  return null;
}

async function buildBusRoutesLayer(opts = {}) {
  const source = opts.source || currentBusRouteSource;
  const forceRebuild = !!opts.forceRebuild;

  if (!forceRebuild && busRoutesLayer && busRoutesLayer.__sourcePath === source) {
    return busRoutesLayer;
  }

  if (!forceRebuild && busRouteLayerCache.has(source)) {
    busRoutesLayer = busRouteLayerCache.get(source);
    return busRoutesLayer;
  }

  const resp = await fetch(source);
  if (!resp.ok) {
    console.warn("Failed to load bus route schedule:", source, resp.status, resp.statusText);
    return L.layerGroup();
  }
  const xmlText = await resp.text();
  const dom = new DOMParser().parseFromString(xmlText, 'application/xml');
  const xmlCrs = dom.querySelector('attributes > attribute[name="coordinateReferenceSystem"]')?.textContent?.trim();
  if (xmlCrs) currentBusCrs = xmlCrs;

  const stops = new Map();
  const stopNodes = dom.querySelectorAll('transitStops > stopFacility, transitStops > transitStopFacility');
  stopNodes.forEach(node => {
    const id = String(node.getAttribute('id') || '');
    if (!id) return;
    const linkRef = normId(node.getAttribute('linkRefId') || '');
    const x = parseFloat(node.getAttribute('x'));
    const y = parseFloat(node.getAttribute('y'));
    let ll = null;
    if (linkRef) {
      const seg = linkGeom.get(linkRef) || linkGeom.get(String(+linkRef)) || linkGeom.get(linkRef.replace(/^pt_/, ''));
      if (seg && seg.length) ll = seg[Math.floor(seg.length / 2)];
    }
    if (!ll) ll = km2deg([x, y]);
    if (ll) stops.set(id, ll);
  });
  console.log("Parsed stops:", stops.size);

  function childEls(parent, selector) {
    return Array.from(parent.children).filter(el => el.matches(selector));
  }

  function latlngsFromLinks(routeNode) {
    const routeEl = childEls(routeNode, 'route')[0];
    if (!routeEl) return [];
    const linkEls = Array.from(routeEl.getElementsByTagName('link'));
    const out = [];
    for (const l of linkEls) {
      const refRaw = l.getAttribute('refId') || '';
      const ref = normId(refRaw);
      const seg = linkGeom.get(ref) || linkGeom.get(String(+ref)) || linkGeom.get(ref.replace(/^pt_/, ''));
      if (seg && seg.length) out.push(...seg);
    }
    return out;
  }

  function latlngsFromStops(routeNode) {
    const rp = childEls(routeNode, 'routeProfile')[0];
    if (!rp) return [];
    const stopEls = Array.from(rp.getElementsByTagName('stop'));
    return stopEls.map(s => stops.get(String(s.getAttribute('refId') || ''))).filter(Boolean);
  }

  const features = [];

  const lineNodes = dom.getElementsByTagName('transitLine');
  console.log("Transit lines found:", lineNodes.length);

  Array.from(lineNodes).forEach(lineNode => {
    const lineId = String(lineNode.getAttribute('id') || '');
    const routeNodes = childEls(lineNode, 'transitRoute');

    routeNodes.forEach(rn => {
      const tm = childEls(rn, 'transportMode')[0];
      const mode = (tm?.textContent || '').trim().toLowerCase();
      if (mode !== 'bus') return;

      const routeId = String(rn.getAttribute('id') || '');
      if (!shouldShowBusRoute({ routeId, lineId })) return;
      const systemMatch = routeId.match(/系統(\d+)/);
      const systemId = systemMatch ? systemMatch[1] : '';

      const depParent = childEls(rn, 'departures')[0];
      const depEls = depParent ? Array.from(depParent.getElementsByTagName('departure')) : [];
      const depTimes = depEls.map(d => d.getAttribute('departureTime')).filter(Boolean);

      const depAll = depTimes
        .map(t => ({ t, s: parseTimeHHMMSS(t) }))
        .filter(o => o.s != null)
        .sort((a, b) => mod24s(a.s) - mod24s(b.s));

      const depMorning = depAll.filter(o => inMorningWindow(o.s));

      const countAll = depAll.length;
      const count0609 = depMorning.length;
      const samplesAll = depAll.slice(0, 4).map(o => o.t);
      const samples0609 = depMorning.slice(0, 4).map(o => o.t);

      const stats = {
        lineId, routeId, systemId, countAll, count0609, samplesAll, samples0609,
        baseColor: getBusRouteColor({ routeId, lineId, systemId })
      };

      let latlngs = latlngsFromLinks(rn);
      if (!latlngs.length) latlngs = latlngsFromStops(rn);

      if (latlngs.length >= 2) {
        features.push({
          type: 'Feature',
          properties: stats,
          geometry: { type: 'LineString', coordinates: latlngs.map(([lat, lng]) => [lng, lat]) }
        });
      }
    });
  });

  console.log("Bus route features:", features.length);

  const fc = { type: 'FeatureCollection', features };
  busRoutesLayer = L.geoJSON(fc, {
    pane: 'linePane', // ← draw in the visible base pane
    style: feature => {
      const p = feature?.properties || {};
      return {
        color: p.baseColor || getBusRouteColor(p),
        weight: getBusLineWeight(p),
        opacity: 1
      };
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties || {};
      const tip = getBusTooltip(p);
      layer.bindTooltip(tip, { permanent: false, direction: 'top', className: 'l-contents__map-route' });
      layer.on('click', () => selectRoute(layer, p));
      layer.on('mouseover', () => {
        if (layer !== selectedRouteLayer) {
          const w = getBusLineWeight(p);
          layer.setStyle({ weight: w + 2, opacity: 1 });
        }
      });
      layer.on('mouseout', () => {
        if (layer !== selectedRouteLayer) {
          const w = getBusLineWeight(p);
          layer.setStyle({ weight: w, opacity: 1 });
        }
      });
    }
  });

  busRoutesLayer.__sourcePath = source;
  busRouteLayerCache.set(source, busRoutesLayer);
  return busRoutesLayer;
}

function addBusLayerToMap(layer) {
  if (!layer) return;
  if (IS_RESULTS_PAGE) {
    removeAllBusRouteLayersFromMap(layer);
  }
  if (!map.hasLayer(layer)) layer.addTo(map);
  try { layer.bringToFront(); } catch (e) { }
  if (!busFitDone) {
    try {
      const b = layer.getBounds();
      if (b.isValid()) {
        const c = b.getCenter();
        const latSpan = Math.abs(b.getNorth() - b.getSouth());
        const lngSpan = Math.abs(b.getEast() - b.getWest());
        const nearFallbackCenter = Math.abs(c.lat - 31.5) < 0.05 && Math.abs(c.lng - 132.5) < 0.05;
        const tinyExtent = latSpan < 0.05 && lngSpan < 0.05;
        // Skip fitting to fallback-derived "ocean" bounds; wait for proper geometry.
        if (nearFallbackCenter && tinyExtent) {
          console.log("Skipping fallback bus-layer fit.");
          return;
        }
        console.log("Fitting to bus layer bounds:", b.toBBoxString());
        map.fitBounds(b, { padding: [20, 20] });
        busFitDone = true;
      }
    } catch { }
  }
  console.log("Bus layer added?", map.hasLayer(layer));
}

function removeAllBusRouteLayersFromMap(exceptLayer = null) {
  if (busRoutesLayer && busRoutesLayer !== exceptLayer && map.hasLayer(busRoutesLayer)) {
    map.removeLayer(busRoutesLayer);
  }

  busRouteLayerCache.forEach(layer => {
    if (layer && layer !== exceptLayer && map.hasLayer(layer)) {
      map.removeLayer(layer);
    }
  });

  const stray = [];
  map.eachLayer(layer => {
    if (layer && layer !== exceptLayer && layer.__sourcePath && BUS_ROUTE_SOURCES.includes(layer.__sourcePath)) {
      stray.push(layer);
    }
  });
  stray.forEach(layer => map.removeLayer(layer));
}

function renderRouteDetails(info) {
  ensureDynRoutePanel();
  bindDynRoutePanel();

  const badge = document.getElementById('dynRouteSummaryBadge');
  const empty = document.getElementById('dynRouteEmpty');
  const details = document.getElementById('dynRouteDetails');
  const applyBtn = document.getElementById('applyDynParamsBtn');

  if (!details) return;

  if (!info) {
    selectedRouteInfo = null;
    if (badge) {
      badge.dataset.state = 'empty';
      badge.textContent = '未選択';
    }
    if (empty) empty.hidden = false;
    details.hidden = true;
    details.innerHTML = '';
    if (applyBtn) applyBtn.disabled = true;
    setDynControlsVisibility(false);
    updateInputMissionBoard();
    return;
  }

  selectedRouteInfo = info;

  const systemId = info.systemId ? `系統${escapeHtml(info.systemId)}` : '';
  const lineName = escapeHtml(info.lineId || '(不明)');
  const routeName = escapeHtml(info.routeId || '(不明)');
  const freqAll = info.countAll ?? info.count0609 ?? 0;
  const freqSelected = getBusFreq(info);
  const samples = escapeHtml((getBusSamples(info) || []).join(', ') || '—');

  if (badge) {
    badge.dataset.state = 'selected';
    badge.textContent = systemId || '選択中';
  }
  if (empty) empty.hidden = true;
  details.hidden = false;
  details.innerHTML = `
    <dt>路線ID</dt><dd>${lineName}</dd>
    <dt>経路ID</dt><dd>${routeName}</dd>
    <dt>運行頻度（06:00–09:59）</dt><dd id="dynRouteFreqView">${freqSelected} 本</dd>
    <dt>運行頻度（終日）</dt><dd>${freqAll} 本</dd>
    <dt>出発サンプル</dt><dd>${samples}</dd>
  `;

  const slider = document.querySelector('#dynFreqRange .js-range-slider');
  if (slider) {
    slider.value = String(freqSelected);
    slider.dataset.default = String(freqSelected);
    slider.dataset.saved = String(freqSelected);
    // Keep the value bubble centered and UI in sync (simulation.js binds on `input`).
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const saved = readDynSavedParams(info);
  const brtToggle = document.getElementById('dynBrtToggle');
  if (brtToggle) brtToggle.checked = !!saved?.brtExclusive;
  if (applyBtn) applyBtn.disabled = false;
  // Always show controls when a route is selected.
  setDynControlsVisibility(true, { scroll: true });
  setDynSaveStatus(false);
  updateDynFreqUi();
  updateInputMissionBoard();

  document.getElementById('dynRouteContainer')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearSelection() {
  if (selectedRouteLayer) {
    try {
      const p = selectedRouteLayer.feature?.properties || {};
      const w = getBusLineWeight(p);
      selectedRouteLayer.setStyle({ color: p.baseColor || getBusRouteColor(p), weight: w, opacity: 1 });
    } catch { }
    selectedRouteLayer = null;
  }
  selectedRouteInfo = null;
  renderRouteDetails(null);
}

function selectRoute(layer, props) {
  if (selectedRouteLayer && selectedRouteLayer !== layer) {
    try {
      const pPrev = selectedRouteLayer.feature?.properties || {};
      const wPrev = getBusLineWeight(pPrev);
      selectedRouteLayer.setStyle({ color: pPrev.baseColor || getBusRouteColor(pPrev), weight: wPrev, opacity: 1 });
    } catch { }
  }
  selectedRouteLayer = layer;
  selectedRouteInfo = props || null;
  try {
    const w = getBusLineWeight(props || {});
    layer.setStyle({ color: '#00B3FF', weight: w + 2, opacity: 1 });
  } catch { }
  renderRouteDetails(props);
}

function focusSavedRouteIfAny() {
  if (!busRoutesLayer || !persistedRouteParams?.routeId) return;
  const targetRouteId = String(persistedRouteParams.routeId);
  let targetLayer = null;
  busRoutesLayer.eachLayer(layer => {
    if (targetLayer) return;
    const rid = String(layer?.feature?.properties?.routeId || '');
    if (rid === targetRouteId) targetLayer = layer;
  });
  if (targetLayer) selectRoute(targetLayer, targetLayer.feature?.properties || {});
}

map.on('click', (e) => {
  const hitShape = e.originalEvent.target.closest?.('.leaflet-interactive');
  if (!hitShape) clearSelection();
});

// Toggle bus route layer with checkbox #toggleBusRoutes
const busToggle = document.getElementById('toggleBusRoutes');
if (busToggle) {
  busToggle.addEventListener('change', async (e) => {
    if (e.target.checked) {
      const source = currentBusRouteSource;
      const layer = await buildBusRoutesLayer({ source });
      if (source !== currentBusRouteSource) return;
      addBusLayerToMap(layer);
      updateBusRouteViewForTimeMode();
    } else {
      removeAllBusRouteLayersFromMap();
      clearSelection();
    }
  });
}

if (selectedRouteToggle) {
  selectedRouteToggle.addEventListener('change', async (e) => {
    if (e.target.checked) {
      const source = currentBusRouteSource;
      const layer = await buildBusRoutesLayer({ source });
      if (source !== currentBusRouteSource) return;
      addBusLayerToMap(layer);
      if (IS_RESULTS_PAGE) focusSavedRouteIfAny();
      updateBusRouteViewForTimeMode();
    } else {
      removeAllBusRouteLayersFromMap();
      clearSelection();
    }
  });
}

// Build once; only add to map if the custom toggle is on
initBusRouteSourceButtons();
buildBusRoutesLayer({ source: currentBusRouteSource }).then(layer => {
  const hasBusToggle = !!document.getElementById('toggleBusRoutes');
  if (hasBusToggle) {
    if (document.getElementById('toggleBusRoutes')?.checked) addBusLayerToMap(layer);
    return;
  }

  if (IS_RESULTS_PAGE && shouldShowBusRoutesNow()) {
    addBusLayerToMap(layer);
    focusSavedRouteIfAny();
  }
});

// ================================
// Misc UI
// ================================
let rectangle;
function updateRectangle() {
  const bounds = map.getBounds();
  if (!rectangle) {
    rectangle = L.rectangle(bounds, {
      color: "#333", fillColor: "#000", fillOpacity: 0.15,
      dashArray: '5, 5', weight: 1, pane: 'rectanglePane'
    }).addTo(map);
  } else {
    rectangle.setBounds(bounds);
  }
}
updateRectangle();
map.on('moveend zoomend', updateRectangle);
window.addEventListener('resize', updateRectangle);

const populationCheckbox = document.querySelector('.js-population');
let populationLayer = null;

function getColor(d) {
  return d > 7000 ? "#800026" :
    d > 5000 ? "#BD0026" :
      d > 2000 ? "#E31A1C" :
        d > 1000 ? "#FC4E2A" :
          d > 600 ? "#FD8D3C" :
            d > 300 ? "#FE9E43" :
              d > 200 ? "#FEB24C" :
                d > 100 ? "#FEC560" :
                  d > 50 ? "#FED976" :
                    d > 10 ? "#FEE086" : "#FFF3BE";
}

function geoJsonStyle(feature) {
  const selectYear = 'PTN_' + document.querySelector('.l-contents__map-year .range').value;
  return { fillColor: getColor(feature.properties[selectYear]), weight: 0.5, opacity: 0.5, color: "white", dashArray: "2", fillOpacity: 0.4 };
}

function showPopulationData() {
  fetch("assets/data/jinnkousuikei_v3.zip")
    .then(res => res.arrayBuffer())
    .then(buffer => JSZip.loadAsync(buffer))
    .then(zip => zip.file("jinnkousuikei_v3.geojson").async("string"))
    .then(geojsonStr => {
      const data = JSON.parse(geojsonStr);
      if (populationLayer) map.removeLayer(populationLayer);
      populationLayer = L.geoJSON(data, { style: geoJsonStyle, pane: 'populationPane' }).addTo(map);
    });
}

function removePopulationData() {
  if (populationLayer) { map.removeLayer(populationLayer); populationLayer = null; }
}

populationCheckbox?.addEventListener('change', () => {
  populationCheckbox.checked ? showPopulationData() : removePopulationData();
});

const rangeYearInput = document.querySelector('.js-year');
const currentYearValue = document.querySelector('.js-year-current');
const minYearValue = parseInt(rangeYearInput.min);
const maxYearValue = parseInt(rangeYearInput.max);
const minYearTxt = document.querySelector('.js-year-min');
const maxYearTxt = document.querySelector('.js-year-max');

function yearRange(year) {
  currentYearValue.textContent = year;
  const percent = (year - minYearValue) / (maxYearValue - minYearValue);
  currentYearValue.style.left = `${percent * rangeYearInput.offsetWidth}px`;
  minYearTxt.classList.toggle('hide', year === minYearValue);
  maxYearTxt.classList.toggle('hide', year === maxYearValue);
}
rangeYearInput.addEventListener('input', () => {
  const year = parseInt(rangeYearInput.value);
  yearRange(year);
  if (populationCheckbox?.checked) showPopulationData();
});
yearRange(parseInt(rangeYearInput.value));

// Add this near the bottom of map.js (only once)
// ========== Bind reset handler for dynamic panel ==========
if (!window.__dynResetBound) {
  document.addEventListener('click', (e) => {
    const resetBtn = e.target.closest('.js-reset[data-reset]');
    if (!resetBtn) return;

    // Limit to dynamic panel
    const dynPanel = document.getElementById('dynRouteContainer');
    if (!dynPanel || !dynPanel.contains(resetBtn)) return;

    e.preventDefault();

    const target = resetBtn.getAttribute('data-reset');
    if (target === 'dyn_frequency' || target === 'dyn_frequency_0609') {
      const wrap = document.getElementById('dynFreqRange');
      const slider = wrap?.querySelector('.js-range-slider');
      if (!wrap || !slider) return;

      const def = Number(slider.getAttribute('data-default') || 0);
      slider.value = def;

      // Sync UI via input event
      slider.dispatchEvent(new Event('input', { bubbles: true }));

      const valEl = wrap.querySelector('.js-range-value');
      const diffEl = wrap.querySelector('.js-range-diff');
      if (valEl) valEl.textContent = String(def);
      if (diffEl) diffEl.textContent = '(+0)';

      const view = document.getElementById('dynRouteFreqView');
      if (view) view.textContent = `${def} 本`;
    }
  });
  window.__dynResetBound = true;
}
