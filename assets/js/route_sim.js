// Lightweight route-based simulation for results.html
// Reads saved params from localStorage (set in map.js), loads a published dataset,
// adjusts utilities based on frequency change, and shows people whose chosen plan flips.

(function () {
  const ROUTE_KEY = 'routeParams';
  const COLLAPSE_KEY = 'routeSimCollapsed';
  const ROUTE_SOURCE_TO_SIM_ID = {
    'bus_route/baseline_transitSchedule_cr24_1.xml': '096896b54be24ffbb0cbee53dde6fd9f',
    'bus_route/brt_transitSchedule_brt24_2.xml': '67eb5392da3a4202906f46f7b808b888',
    'bus_route/net_expansion_transitSchedule_cr40_3.xml': '18c774153bad4ee0aae34a8dcbb7f03b',
    'bus_route/output_transitSchedule_brt40_4.xml': '21f892bd-34a6-443d-82e4-1c41ab8bec82'
  };

  function $(sel) { return document.querySelector(sel); }

  function projAtlantisToWGS84(x, y) {
    try {
      if (typeof proj4 === 'function') {
        proj4.defs("EPSG:6671", "+proj=tmerc +lat_0=36 +lon_0=132.1666666666667 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs");
        const p = proj4("EPSG:6671", "EPSG:4326", [x, y]);
        return [p[1], p[0]]; // [lat, lon]
      }
    } catch { }
    // fallback: treat as [lon,lat]
    return [y, x];
  }

  function drawPlanOnMap(map, person, plan) {
    if (!plan || !Array.isArray(plan.steps)) return;
    const pts = [];
    (plan.steps || []).forEach(s => {
      if (!s) return;
      if (s.kind === 'activity' && s.x != null && s.y != null) {
        const ll = projAtlantisToWGS84(s.x, s.y);
        pts.push(ll);
        const marker = L.circleMarker(ll, { radius: 4, color: '#31599E', fillOpacity: 0.8 })
          .bindPopup(`<strong>${s.type || ''}</strong><br>${person.personId || ''}<br>${s.startTime || ''} - ${s.endTime || ''}`);
        marker.addTo(map);
      }
    });
    if (pts.length >= 2) {
      L.polyline(pts, { color: '#00B3FF', weight: 2 }).addTo(map);
    }
  }

  async function fetchSimulations() {
    const res = await fetch('/api/simulations');
    const sims = await res.json().catch(() => []);
    return Array.isArray(sims) ? sims : [];
  }

  function resolveFrequencySimulationId(params, eligible) {
    const fromSource = params?.sourcePath ? ROUTE_SOURCE_TO_SIM_ID[String(params.sourcePath)] : null;
    const simId = params?.simulationId || fromSource || null;
    const isEligible = !!simId && eligible.some(s => s.id === simId);
    return { simId, isEligible };
  }

  async function fetchFrequencyCompare(simId, params) {
    const res = await fetch(`/api/simulations/${simId}/frequency-compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routeId: params.routeId,
        oldFrequency: params.oldFrequency,
        newFrequency: params.newFrequency,
        includeMostImpactedSteps: true
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'frequency compare failed');
    return data;
  }

  function ensureResultPanel() {
    let panel = document.getElementById('routeSimPanel');
    if (panel) return panel;

    // collapsed state (persisted)
    let collapsed = false;
    try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { }

    panel = document.createElement('div');
    panel.id = 'routeSimPanel';
    panel.style.cssText = [
      'position:absolute',
      'right:16px',
      'bottom:16px',
      'z-index:9999',
      'background:#fff',
      'border:1px solid #ddd',
      'border-radius:8px',
      'width:320px',
      'box-shadow:0 4px 12px rgba(0,0,0,0.15)',
      'font-size:12px',
      'overflow:hidden'
    ].join(';') + ';';

    // Header (create BEFORE using it)
    const header = document.createElement('div');
    header.style.cssText = [
      'display:flex',
      'align-items:center',
      'justify-content:space-between',
      'gap:8px',
      'padding:10px',
      'cursor:pointer',
      'font-weight:700',
      'user-select:none',
      'background:#f8f9fb'
    ].join(';') + ';';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-controls', 'routeSimContent');
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

    const title = document.createElement('div');
    title.textContent = 'Route Simulation';

    const toggle = document.createElement('span');
    toggle.id = 'routeSimToggleIcon';
    toggle.setAttribute('aria-hidden', 'true');
    toggle.style.cssText = 'font-size:12px;';
    toggle.textContent = collapsed ? '▶' : '▼';

    header.appendChild(title);
    header.appendChild(toggle);

    // Content area
    const content = document.createElement('div');
    content.id = 'routeSimContent';
    content.style.cssText = [
      'padding:10px',
      'max-height:50vh',
      'overflow:auto',
      'transition:max-height 0.15s ease'
    ].join(';') + ';';

    content.innerHTML = `
    <div id="routeSimStatus">準備中...</div>
    <ul id="routeSimList" style="margin:8px 0 0; padding-left:16px;"></ul>
  `;

    if (collapsed) content.style.display = 'none';

    function setCollapsed(next) {
      const isCollapsed = !!next;
      content.style.display = isCollapsed ? 'none' : 'block';
      toggle.textContent = isCollapsed ? '▶' : '▼';
      header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      try { localStorage.setItem(COLLAPSE_KEY, isCollapsed ? '1' : '0'); } catch { }
    }

    header.addEventListener('click', () => setCollapsed(content.style.display !== 'none'));
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(content.style.display !== 'none'); }
      if (e.key === 'ArrowDown') setCollapsed(false);
      if (e.key === 'ArrowUp') setCollapsed(true);
    });

    panel.appendChild(header);
    panel.appendChild(content);

    const host = document.querySelector('.l-contents__map') || document.body;
    host.appendChild(panel);
    return panel;
  }


  window.addEventListener('load', async () => {
  // Always create the panel shell so it's visible
  const panel = ensureResultPanel();
  const statusEl = panel.querySelector('#routeSimStatus');
  const listEl = panel.querySelector('#routeSimList');

  // Read saved params
  let paramsRaw = null;
  try { paramsRaw = localStorage.getItem(ROUTE_KEY); } catch {}

  if (!paramsRaw) {
    if (statusEl) statusEl.textContent = '設定が見つかりません（map で経路を設定してください）';
    return; // panel stays visible
  }

  let params = null;
  try { params = JSON.parse(paramsRaw); }
  catch {
    if (statusEl) statusEl.textContent = '設定の読み取りに失敗しました';
    return;
  }

  if (statusEl) statusEl.textContent =
    `対象経路: ${params.routeId || '(不明)'} / 変更: ${params.oldFrequency || 0}→${params.newFrequency || 0}`;

  try {
    const sims = await fetchSimulations();
    const eligible = sims.filter(s => s && s.has_cache);
    const resolved = resolveFrequencySimulationId(params, eligible);
    if (!resolved.simId) {
      if (statusEl) statusEl.textContent += ' / 対象シミュレーションが特定できません';
      return;
    }
    if (!resolved.isEligible) {
      if (statusEl) statusEl.textContent += ' / 対象シミュレーションが未公開または未解析です';
      return;
    }

    const cmp = await fetchFrequencyCompare(resolved.simId, params);
    const changedPeople = Number(cmp?.changedPeople || 0);
    const changedSample = Array.isArray(cmp?.changedSample) ? cmp.changedSample : [];

    if (!changedPeople) {
      if (statusEl) statusEl.textContent += ' / 変更された選択はありません';
      return;
    }
    if (statusEl) statusEl.textContent += ` / 変更人数: ${changedPeople}`;

    changedSample.slice(0, 100).forEach(item => {
      const li = document.createElement('li');
      li.textContent = `${item.personId || ''} : ${item.before}→${item.after}`;
      listEl.appendChild(li);
    });

    const most = cmp?.mostImpacted;
    if (
      most &&
      Array.isArray(most.afterPlanSteps) &&
      most.afterPlanSteps.length
    ) {
      const li = document.createElement('li');
      li.style.cursor = 'pointer';
      li.textContent = `Most impacted: ${most.personId || ''} : ${most.beforePlanIndex}→${most.afterPlanIndex}`;
      li.onclick = () => {
        const m = window.map;
        if (!m) return;
        drawPlanOnMap(m, { personId: most.personId }, { steps: most.afterPlanSteps });
      };
      listEl.insertBefore(li, listEl.firstChild);
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = e?.message || 'データの取得に失敗しました';
  }
});
})();
