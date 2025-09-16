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

    if (busRoutesLayer) {
      map.removeLayer(busRoutesLayer);
      busRoutesLayer = null;
      buildBusRoutesLayer().then(addBusLayerToMap);
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
function ensureDynRoutePanel() {
  const container = document.querySelector('.c-box__route-wrap .c-box__route-content.js-parameter-content.current');
  if (!container) return;
  if (!document.getElementById('dynRouteContainer')) {
    container.innerHTML = `
      <div id="dynRouteContainer" class="c-route" style="padding:8px 0;">
        <p class="muted" style="margin:0 0 8px;">地図上のバス路線をクリックすると詳細を表示します。</p>
        <div id="dynRouteDetails" class="c-route__setting"></div>
        <div style="margin-top:8px; display:flex; gap:8px;">
          <button id="clearRouteBtn" type="button" class="c-btn__small" style="display:inline-flex;align-items:center;justify-content:center;line-height:1;height:32px;padding:0 12px;">
            クリア
          </button>
        </div>
      </div>
    `;
  }
}
ensureDynRoutePanel();

// ================================
// Bus routes derived from transitSchedule
// ================================
let busRoutesLayer = null;
let busOverlayAdded = false;
let busFitDone = false;
let selectedRouteLayer = null;
let routeStatsMap = new Map();

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

async function buildBusRoutesLayer() {
  if (busRoutesLayer) return busRoutesLayer;

  const resp = await fetch('output_transitSchedule.xml');
  if (!resp.ok) {
    console.warn("Failed to load output_transitSchedule.xml:", resp.status, resp.statusText);
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

      const depInWindow = depTimes
        .map(t => ({ t, s: parseTimeHHMMSS(t) }))
        .filter(o => o.s != null && inMorningWindow(o.s))
        .sort((a, b) => mod24s(a.s) - mod24s(b.s));

      const count0609 = depInWindow.length;
      const samples = depInWindow.slice(0, 4).map(o => o.t);

      routeStatsMap.set(routeId, { lineId, routeId, systemId, count0609, samples });

      let latlngs = latlngsFromLinks(rn);
      if (!latlngs.length) latlngs = latlngsFromStops(rn);

      if (latlngs.length >= 2) {
        features.push({
          type: 'Feature',
          properties: { lineId, routeId, systemId, count0609, samples },
          geometry: { type: 'LineString', coordinates: latlngs.map(([lat, lng]) => [lng, lat]) }
        });
      }
    });
  });

  console.log("Bus route features:", features.length);

  const fc = { type: 'FeatureCollection', features };
  busRoutesLayer = L.geoJSON(fc, {
    pane: 'linePane', // ← draw in the visible base pane
    style: { color: '#FF6600', weight: 4, opacity: 1 },
    onEachFeature: (feature, layer) => {
      const p = feature.properties || {};
      const title = p.systemId ? `系統${p.systemId}` : (p.routeId || 'route');
      const tip = `${title}<br>06–09: ${p.count0609}本`;
      layer.bindTooltip(tip, { permanent: false, direction: 'top', className: 'l-contents__map-route' });
      layer.on('click', () => selectRoute(layer, p));
      layer.on('mouseover', () => { if (layer !== selectedRouteLayer) layer.setStyle({ weight: 6, opacity: 1 }); });
      layer.on('mouseout', () => { if (layer !== selectedRouteLayer) layer.setStyle({ weight: 4, opacity: 1 }); });
    }
  });

  if (!busOverlayAdded) {
    overlayLayers["バス路線"] = busRoutesLayer;
    layerControl.addOverlay(busRoutesLayer, "バス路線");
    busOverlayAdded = true;
  }

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
  const wrap = document.getElementById('dynRouteDetails');
  if (!wrap) return;
  if (!info) { wrap.innerHTML = ''; return; }
  const lineName = info.lineId || '(不明)';
  const routeName = info.routeId || '(不明)';
  const freq = info.count0609 ?? 0;
  const samples = (info.samples || []).join(', ');
  wrap.innerHTML = `
    <dl class="c-route__setting">
      <dt>路線名</dt><dd>${lineName}</dd>
      <dt>ルートID</dt><dd>${routeName}</dd>
      <dt>運行頻度（06:00–09:59）</dt><dd>${freq} 本</dd>
      <dt>出発時刻サンプル</dt><dd>${samples || '—'}</dd>
    </dl>
  `;
  document.getElementById('dynRouteContainer')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearSelection() {
  if (selectedRouteLayer) {
    try { selectedRouteLayer.setStyle({ color: '#FF6600', weight: 4, opacity: 1 }); } catch { }
    selectedRouteLayer = null;
  }
  renderRouteDetails(null);
}

function selectRoute(layer, props) {
  if (selectedRouteLayer && selectedRouteLayer !== layer) {
    try { selectedRouteLayer.setStyle({ color: '#FF6600', weight: 4, opacity: 1 }); } catch { }
  }
  selectedRouteLayer = layer;
  try { layer.setStyle({ color: '#00B3FF', weight: 6, opacity: 1 }); } catch { }
  renderRouteDetails(props);
}

document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'clearRouteBtn') clearSelection();
});

map.on('click', (e) => {
  const hitShape = e.originalEvent.target.closest?.('.leaflet-interactive');
  if (!hitShape) clearSelection();
});

// Toggle bus route layer with checkbox #toggleBusRoutes
const busToggle = document.getElementById('toggleBusRoutes');
if (busToggle) {
  busToggle.addEventListener('change', async (e) => {
    if (e.target.checked) {
      const layer = await buildBusRoutesLayer();
      addBusLayerToMap(layer);
    } else {
      if (busRoutesLayer) map.removeLayer(busRoutesLayer);
      clearSelection();
    }
  });
}

// Build once; only add to map if the custom toggle is on
buildBusRoutesLayer().then(layer => {
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
