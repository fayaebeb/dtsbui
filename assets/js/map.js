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
const routeCheckbox = document.getElementById('data_root');
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
  'bus_route/output_transitSchedule_brt40_4.xml': '21f892bd-34a6-443d-82e4-1c41ab8bec82'
};
let currentBusRouteSource = BUS_ROUTE_SOURCES[0];

function getSimulationIdForCurrentBusSource() {
  return BUS_ROUTE_SOURCE_TO_SIM_ID[currentBusRouteSource] || null;
}

// ================================
// Index network link geometry
// ================================
let linkGeom = new Map();

function normId(v) {
  return String(v ?? "").replace(/^link:/i, '').replace(/^pt_/, '').trim();
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
    if (routeCheckbox?.checked) routeA.addTo(map);

    busRouteLayerCache.clear();
    if (busRoutesLayer && map.hasLayer(busRoutesLayer)) {
      map.removeLayer(busRoutesLayer);
      busRoutesLayer = null;
      clearSelection();
    }
    if (document.getElementById('toggleBusRoutes')?.checked) {
      const source = currentBusRouteSource;
      buildBusRoutesLayer({ source, forceRebuild: true }).then(layer => {
        if (source !== currentBusRouteSource) return;
        if (!document.getElementById('toggleBusRoutes')?.checked) return;
        addBusLayerToMap(layer);
        updateBusRouteViewForTimeMode();
      });
    }
  });

function routeCheckboxChange() {
  if (routeCheckbox?.checked) routeA?.addTo(map);
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

function bindDynRoutePanel() {
  if (window.__dynRoutePanelBound) return;
  window.__dynRoutePanelBound = true;

  document.getElementById('clearRouteBtn')?.addEventListener('click', () => clearSelection());

  const slider = document.querySelector('#dynFreqRange .js-range-slider');
  if (slider) slider.addEventListener('input', updateDynFreqUi);

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
    setDynSaveStatus(true);
  });
}

ensureDynRoutePanel();
bindDynRoutePanel();
renderRouteDetails(null);

// ================================
// Bus routes derived from transitSchedule
// ================================
let busRoutesLayer = null;
let busFitDone = false;
let selectedRouteLayer = null;
let routeStatsMap = new Map();
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
  const mode = getBusTimeMode();
  if (mode === 'all') return info.countAll ?? info.count0609 ?? 0;
  return info.count0609 ?? info.countAll ?? 0;
}

function getBusSamples(info) {
  const mode = getBusTimeMode();
  if (mode === 'all') return (info.samplesAll || info.samples || []);
  return (info.samples0609 || info.samples || []);
}

function getBusFreqLabel() {
  return getBusTimeMode() === 'all' ? '運行頻度（終日）' : '運行頻度（06:00–09:59）';
}

function getBusHourRangeLabel() {
  return getBusTimeMode() === 'all' ? '終日' : '6～9時台';
}

function getBusTooltip(props) {
  const title = props.systemId ? `系統${props.systemId}` : (props.routeId || 'route');
  const label = getBusTimeMode() === 'all' ? '終日' : '06–09';
  const freq = getBusFreq(props);
  return `${title}<br>${label}: ${freq}本`;
}

function getBusLineWeight(info) {
  const freq = info.countAll ?? info.count0609 ?? 0;
  if (freq >= 100) return 16;      // very frequent
  if (freq >= 50) return 9;       // frequent
  if (freq >= 20) return 4;       // moderate
  return 1.5;                     // low frequency
}

function getBusRouteColor(info) {
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

function km2deg(xy) {
  const [x, y] = xy;
  if (typeof proj4 === 'function') {
    try {
      const [lon, lat] = proj4('EPSG:6671', 'EPSG:4326', [x, y]);
      if (isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return [lat, lon];
    } catch (e) { }
  }
  if (isFinite(x) && isFinite(y) && Math.abs(y) <= 90 && Math.abs(x) <= 180) return [y, x];
  return [31.5, 132.5];
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

  const stops = new Map();
  const stopNodes = dom.querySelectorAll('transitStops > stopFacility, transitStops > transitStopFacility');
  stopNodes.forEach(node => {
    const id = String(node.getAttribute('id') || '');
    if (!id) return;
    const x = parseFloat(node.getAttribute('x'));
    const y = parseFloat(node.getAttribute('y'));
    const ll = km2deg([x, y]);
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
  routeStatsMap.clear();

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

      routeStatsMap.set(routeId, stats);

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
  if (!map.hasLayer(layer)) layer.addTo(map);
  try { layer.bringToFront(); } catch (e) { }
  if (!busFitDone) {
    try {
      const b = layer.getBounds();
      if (b.isValid()) {
        console.log("Fitting to bus layer bounds:", b.toBBoxString());
        map.fitBounds(b, { padding: [20, 20] });
        busFitDone = true;
      }
    } catch { }
  }
  console.log("Bus layer added?", map.hasLayer(layer));
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
      if (busRoutesLayer) map.removeLayer(busRoutesLayer);
      clearSelection();
    }
  });
}

// Build once; only add to map if the custom toggle is on
initBusRouteSourceButtons();
buildBusRoutesLayer({ source: currentBusRouteSource }).then(layer => {
  if (document.getElementById('toggleBusRoutes')?.checked) addBusLayerToMap(layer);
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
