// Lightweight route-based simulation for results.html
// Reads saved params from localStorage (set in map.js), loads a published dataset,
// adjusts utilities based on frequency change, and shows people whose chosen plan flips.

(function(){
  const ROUTE_KEY = 'routeParams';

  function $(sel){ return document.querySelector(sel); }

  function projAtlantisToWGS84(x, y){
    try {
      if (typeof proj4 === 'function') {
        proj4.defs("EPSG:6671", "+proj=tmerc +lat_0=36 +lon_0=132.1666666666667 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs");
        const p = proj4("EPSG:6671", "EPSG:4326", [x, y]);
        return [p[1], p[0]]; // [lat, lon]
      }
    } catch {}
    // fallback: treat as [lon,lat]
    return [y, x];
  }

  function drawPlanOnMap(map, person, plan){
    if (!plan || !Array.isArray(plan.steps)) return;
    const pts = [];
    (plan.steps||[]).forEach(s => {
      if (!s) return;
      if (s.kind === 'activity' && s.x != null && s.y != null){
        const ll = projAtlantisToWGS84(s.x, s.y);
        pts.push(ll);
        const marker = L.circleMarker(ll, { radius: 4, color: '#31599E', fillOpacity: 0.8 })
          .bindPopup(`<strong>${s.type||''}</strong><br>${person.personId||''}<br>${s.startTime||''} - ${s.endTime||''}`);
        marker.addTo(map);
      }
    });
    if (pts.length >= 2){
      L.polyline(pts, { color: '#00B3FF', weight: 2 }).addTo(map);
    }
  }

  async function loadFirstPublishedDataset(){
    const res = await fetch('/api/simulations');
    const list = await res.json();
    const first = Array.isArray(list) ? list.find(s => s.has_cache) || list[0] : null;
    if (!first) throw new Error('No published simulations');
    const res2 = await fetch(`/api/simulations/${first.id}/data`);
    if (!res2.ok) throw new Error('Failed to load dataset');
    const persons = await res2.json();
    return { id: first.id, persons };
  }

  function bestIndexByServerScore(plans){
    if (!plans || !plans.length) return 0;
    let best = 0; let bestVal = plans[0].serverScore ?? 0;
    for (let i=1;i<plans.length;i++){
      const v = plans[i].serverScore ?? 0;
      if (v < bestVal){ bestVal = v; best = i; }
    }
    return best;
  }

  function recomputeWithFrequency(person, params){
    // Prefer precise matching using transitRouteId parsed from plans.
    const oldF = Math.max(1, Number(params.oldFrequency||0));
    const newF = Math.max(1, Number(params.newFrequency||0));
    const deltaWaitMin = ((60/oldF) - (60/newF)) / 2; // minutes
    const walkCoeffPerSec = 0.5; // matches DEFAULT_WEIGHTS.leg.walk in server (per second)
    const deltaScore = - (deltaWaitMin * 60) * walkCoeffPerSec; // subtract waiting time counted as walk

    const beforeIdx = Number.isInteger(person.selectedPlanIndex) ? person.selectedPlanIndex : bestIndexByServerScore(person.plans);
    const adjusted = (person.plans||[]).map(pl => {
      const steps = pl.steps||[];
      const routeId = params.routeId || '';
      const hasAnyPt = steps.some(s => s && s.kind==='leg' && s.mode==='pt');
      const supportsIds = steps.some(s => s && s.kind==='leg' && s.mode==='pt' && typeof s.transitRouteId !== 'undefined');
      const hasExact = routeId && steps.some(s => s && s.kind==='leg' && s.mode==='pt' && s.transitRouteId === routeId);
      // If the dataset has transitRouteId, only affect exact matches.
      // Otherwise, fall back to treating any PT plan as affected.
      const affected = supportsIds ? hasExact : hasAnyPt;
      const base = pl.serverScore ?? 0;
      return affected ? (base + deltaScore) : base;
    });
    let afterIdx = 0; let best = adjusted[0] ?? 0;
    for (let i=1;i<adjusted.length;i++){
      if (adjusted[i] < best){ best = adjusted[i]; afterIdx = i; }
    }
    return { beforeIdx, afterIdx, adjustedScores: adjusted };
  }

  function ensureResultPanel(){
    let panel = document.getElementById('routeSimPanel');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'routeSimPanel';
    panel.style.cssText = 'position:absolute; right:16px; bottom:16px; z-index:9999; background:#fff; border:1px solid #ddd; border-radius:8px; padding:10px; width:320px; max-height:50vh; overflow:auto; box-shadow:0 4px 12px rgba(0,0,0,0.15); font-size:12px;';
    panel.innerHTML = '<div style="font-weight:700; margin-bottom:6px;">Route Simulation</div><div id="routeSimStatus">準備中...</div><ul id="routeSimList" style="margin:8px 0 0; padding-left:16px;"></ul>';
    const host = document.querySelector('.l-contents__map') || document.body;
    host.appendChild(panel);
    return panel;
  }

  window.addEventListener('load', async () => {
    let paramsRaw = null;
    try { paramsRaw = localStorage.getItem(ROUTE_KEY); } catch {}
    if (!paramsRaw) return;
    let params = null;
    try { params = JSON.parse(paramsRaw); } catch { return; }

    const statusEl = ensureResultPanel().querySelector('#routeSimStatus');
    const listEl = ensureResultPanel().querySelector('#routeSimList');
    if (statusEl) statusEl.textContent = `対象経路: ${params.routeId || '(不明)'} / 変更: ${params.oldFrequency||0}→${params.newFrequency||0}`;

    try {
      const { persons } = await loadFirstPublishedDataset();
      const changed = [];
      persons.forEach(p => {
        const r = recomputeWithFrequency(p, params);
        if (r.afterIdx !== r.beforeIdx) changed.push({ person: p, beforeIdx: r.beforeIdx, afterIdx: r.afterIdx });
      });

      if (!changed.length){
        if (statusEl) statusEl.textContent += ' / 変更された選択はありません';
        return;
      }
      if (statusEl) statusEl.textContent += ` / 変更人数: ${changed.length}`;

      // Render clickable list; clicking draws schedule on map
      changed.slice(0, 100).forEach(item => {
        const li = document.createElement('li');
        li.style.cursor = 'pointer';
        li.textContent = `${item.person.personId} : ${item.beforeIdx}→${item.afterIdx}`;
        li.onclick = () => {
          const m = window.map; // leaflet map from map.js
          if (!m) return;
          // Draw the new chosen plan
          const plan = item.person.plans[item.afterIdx] || item.person.plans[0];
          drawPlanOnMap(m, item.person, plan);
        };
        listEl.appendChild(li);
      });
    } catch (e) {
      if (statusEl) statusEl.textContent = 'データの取得に失敗しました';
      // keep silent
    }
  });
})();
