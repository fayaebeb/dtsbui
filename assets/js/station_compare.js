// Station-area frequency compare UI for results.html
(function () {
  function onReady(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }

  const CACHE_KEY = 'dtsb.stationCompareCache.v1';
  const DEFAULT_STATION = '西条駅';
  const DEFAULT_RADIUS = 500;
  const DEFAULT_BIN_SEC = 3600;
  let latestCompareContext = null;
  let stationOverlay = null;
  let latestStationArea = null;

  function getCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch { return {}; }
  }

  function setCache(cache) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache || {})); } catch { }
  }

  function compareSignature(ctx, stationName, radiusM) {
    if (!ctx || ctx.mode !== 'frequency') return '';
    const p = ctx.params || {};
    return [
      ctx.simId || '',
      p.routeId || '',
      p.oldFrequency ?? '',
      p.newFrequency ?? '',
      p.personLimit ?? 'all',
      stationName || '',
      radiusM || '',
    ].join('|');
  }

  function ensurePanel() {
    let host = document.getElementById('stationComparePanel');
    if (host) return host;

    host = document.createElement('section');
    host.id = 'stationComparePanel';
    host.style.minWidth = '0';
    host.innerHTML = `
      <div class="c-box">
        <details class="c-details" open>
          <summary class="c-details__summary">西条駅周辺人数</summary>
          <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:8px 0;">
            <label style="display:flex; gap:6px; align-items:center; min-width:0;">
              <span class="muted">Station</span>
              <input id="stationCompareName" class="c-input" type="text" value="${DEFAULT_STATION}" style="min-width:0; width:140px;" />
            </label>
            <label style="display:flex; gap:6px; align-items:center; min-width:0;">
              <span class="muted">Radius</span>
              <select id="stationCompareRadius" class="c-input" style="min-width:0; width:120px;">
                <option value="300">300 m</option>
                <option value="500" selected>500 m</option>
                <option value="800">800 m</option>
              </select>
            </label>
            <label style="display:flex; gap:6px; align-items:center; min-width:0;">
              <input id="stationOverlayToggle" type="checkbox" checked>
              <span class="muted">Show on map</span>
            </label>
            <button id="stationCompareBtn" type="button" class="btn" disabled>Calculate</button>
            <span id="stationCompareStatus" class="muted" style="min-width:0; flex:1 1 220px;">先にAggregationsで運航頻度変更前後のCompareを実行してください。</span>
          </div>
          <div id="stationCompareCards" style="display:flex; gap:12px; flex-wrap:wrap; margin:8px 0;"></div>
          <div style="height:240px; display:none;" id="stationCompareChartWrap">
            <canvas id="stationCompareChart"></canvas>
          </div>
          <div id="stationCompareMeta" class="muted" style="margin-top:8px; font-size:12px;"></div>
        </details>
      </div>
    `;

    const mount = document.getElementById('stationCompareMount');
    const fallback = document.getElementById('aggPanelMount')?.parentElement || document.body;
    if (mount) mount.appendChild(host);
    else fallback.appendChild(host);
    return host;
  }

  function card(label, value) {
    const div = document.createElement('div');
    div.style.cssText =
      'min-width:180px; padding:10px 12px; background:#fff; border:1px solid #e5e7f3; border-radius:8px; box-shadow:0 1px 2px rgba(0,0,0,0.04);';
    div.innerHTML = `<div style="font-size:12px; color:#666;">${label}</div><div class="u-en" style="font-size:18px; font-weight:700;">${value}</div>`;
    return div;
  }

  function setStatus(text) {
    const el = document.getElementById('stationCompareStatus');
    if (el) el.textContent = text || '';
  }

  function setButtonEnabled(enabled) {
    const btn = document.getElementById('stationCompareBtn');
    if (btn) btn.disabled = !enabled;
  }

  function upsertChart(canvasId, config) {
    const el = document.getElementById(canvasId);
    if (!el || !window.Chart || !window.Chart.getChart) return null;
    const existing = window.Chart.getChart(el);
    if (existing) existing.destroy();
    return new Chart(el, config);
  }

  function clearStationOverlay() {
    if (!stationOverlay || !window.map || typeof window.map.removeLayer !== 'function') return;
    try { window.map.removeLayer(stationOverlay); } catch { }
    stationOverlay = null;
  }

  function isOverlayEnabled() {
    return !!document.getElementById('stationOverlayToggle')?.checked;
  }

  function renderStationOverlay(station) {
    clearStationOverlay();
    if (!station || !window.L || !window.map) return;
    if (typeof window.km2deg !== 'function') return;
    if (!isOverlayEnabled()) return;

    const latlng = window.km2deg([Number(station.centerX), Number(station.centerY)]);
    if (!Array.isArray(latlng) || latlng.length !== 2) return;

    const radius = Number(station.radiusM || DEFAULT_RADIUS);
    const label = `${station.stationName || DEFAULT_STATION} / ${radius}m`;
    const group = L.layerGroup();
    const circle = L.circle(latlng, {
      radius,
      color: '#F5813C',
      weight: 2,
      opacity: 0.95,
      fillColor: '#F5813C',
      fillOpacity: 0.08,
      pane: 'selectStop',
    });
    const center = L.circleMarker(latlng, {
      radius: 6,
      color: '#F5813C',
      weight: 3,
      fillColor: '#ffffff',
      fillOpacity: 1,
      pane: 'selectStop',
    });

    circle.bindTooltip(label, { permanent: false, direction: 'top', className: 'l-contents__map-route' });
    center.bindTooltip(label, { permanent: false, direction: 'top', className: 'l-contents__map-route' });
    group.addLayer(circle);
    group.addLayer(center);
    group.addTo(window.map);
    try { circle.bringToFront(); center.bringToFront(); } catch { }
    stationOverlay = group;
  }

  function fitMapToStation(station) {
    if (!station || !window.L || !window.map) return;
    if (typeof window.km2deg !== 'function') return;
    const latlng = window.km2deg([Number(station.centerX), Number(station.centerY)]);
    if (!Array.isArray(latlng) || latlng.length !== 2) return;
    const radius = Number(station.radiusM || DEFAULT_RADIUS);
    const bounds = L.circle(latlng, { radius }).getBounds();
    try { window.map.fitBounds(bounds.pad(0.35)); } catch { }
  }

  function syncStationOverlay() {
    if (latestStationArea && isOverlayEnabled()) {
      renderStationOverlay(latestStationArea);
      return;
    }
    clearStationOverlay();
  }

  function renderStationCompare(data) {
    const cards = document.getElementById('stationCompareCards');
    const meta = document.getElementById('stationCompareMeta');
    const wrap = document.getElementById('stationCompareChartWrap');
    if (!cards || !meta || !wrap) return;

    const station = data && data.stationArea;
    const pre = station && station.pre ? station.pre : {};
    const post = station && station.post ? station.post : {};
    const preBins = Array.isArray(pre.presentByBin) ? pre.presentByBin : [];
    const postBins = Array.isArray(post.presentByBin) ? post.presentByBin : [];
    const n = Math.max(preBins.length, postBins.length);
    const labels = Array.from({ length: n }, (_, i) => `${String(i).padStart(2, '0')}:00`);
    const peak = (arr) => arr.reduce((max, v) => Math.max(max, Number(v) || 0), 0);

    cards.innerHTML = '';
    cards.appendChild(card('Unique visitors', `${Number(pre.uniqueVisitors || 0)} → ${Number(post.uniqueVisitors || 0)}`));
    cards.appendChild(card('Peak present / hour', `${peak(preBins)} → ${peak(postBins)}`));
    cards.appendChild(card('Matched stops', `${Number(station.matchCount || 0)}`));
    latestStationArea = station || null;
    syncStationOverlay();
    fitMapToStation(station);

    wrap.style.display = n ? 'block' : 'none';
    if (n) {
      upsertChart('stationCompareChart', {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Before',
              data: labels.map((_, i) => Number(preBins[i] || 0)),
              borderColor: '#31599E',
              backgroundColor: 'rgba(49,89,158,0.15)',
              tension: 0.25,
              fill: false,
            },
            {
              label: 'After',
              data: labels.map((_, i) => Number(postBins[i] || 0)),
              borderColor: '#F5813C',
              backgroundColor: 'rgba(245,129,60,0.18)',
              tension: 0.25,
              fill: false,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: true } },
          scales: {
            y: { beginAtZero: true, ticks: { precision: 0 } },
          },
        },
      });
    }

    const matchedStops = Array.isArray(station.matchedStops) ? station.matchedStops : [];
    const stopNames = matchedStops.slice(0, 4).map((s) => String(s.name || s.id || '')).filter(Boolean);
    meta.textContent = [
      `${station.stationName || DEFAULT_STATION} / 半径 ${Number(station.radiusM || DEFAULT_RADIUS)}m`,
      stopNames.length ? `resolved from: ${stopNames.join(', ')}` : '',
      latestCompareContext?.params?.personLimit ? `persons sample: ${latestCompareContext.params.personLimit}` : '',
    ].filter(Boolean).join(' / ');
  }

  async function fetchStationCompare(ctx, stationName, radiusM) {
    const params = ctx && ctx.params ? ctx.params : {};
    const body = {
      routeId: params.routeId,
      oldFrequency: params.oldFrequency,
      newFrequency: params.newFrequency,
      stationName,
      radiusM,
      binSec: DEFAULT_BIN_SEC,
    };
    if (params.personLimit != null) body.person_limit = params.personLimit;

    const res = await fetch(`/api/simulations/${ctx.simId}/frequency-compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'station compare failed');
    if (!data || !data.stationArea) throw new Error('stationArea missing in response');
    return data;
  }

  async function runStationCompare() {
    if (!latestCompareContext || latestCompareContext.mode !== 'frequency' || !latestCompareContext.simId) {
      setStatus('運航頻度変更前後のCompare結果が必要です。');
      return;
    }

    const stationName = String(document.getElementById('stationCompareName')?.value || DEFAULT_STATION).trim() || DEFAULT_STATION;
    const radiusM = Number(document.getElementById('stationCompareRadius')?.value || DEFAULT_RADIUS);
    const sig = compareSignature(latestCompareContext, stationName, radiusM);
    const btn = document.getElementById('stationCompareBtn');

    setStatus('Computing…');
    if (btn) btn.disabled = true;
    try {
      const cache = getCache();
      const cached = cache[sig];
      if (cached && cached.stationArea) {
        renderStationCompare(cached);
        setStatus('Cached');
        return;
      }
      const data = await fetchStationCompare(latestCompareContext, stationName, radiusM);
      cache[sig] = data;
      setCache(cache);
      renderStationCompare(data);
      setStatus('OK');
    } catch (err) {
      console.error(err);
      setStatus(err && err.message ? String(err.message) : 'Failed');
    } finally {
      setButtonEnabled(!!(latestCompareContext && latestCompareContext.mode === 'frequency' && latestCompareContext.ready));
    }
  }

  function onCompareReady(detail) {
    latestCompareContext = detail && detail.ready ? detail : null;
    const cards = document.getElementById('stationCompareCards');
    const meta = document.getElementById('stationCompareMeta');
    const wrap = document.getElementById('stationCompareChartWrap');
    if (!latestCompareContext || latestCompareContext.mode !== 'frequency') {
      if (cards) cards.innerHTML = '';
      if (meta) meta.textContent = '';
      if (wrap) wrap.style.display = 'none';
      latestStationArea = null;
      clearStationOverlay();
      setButtonEnabled(false);
      setStatus('運航頻度変更前後のCompareを実行すると、西条駅周辺の before / after を計算できます。');
      return;
    }
    if (cards) cards.innerHTML = '';
    if (meta) meta.textContent = '';
    if (wrap) wrap.style.display = 'none';
    latestStationArea = null;
    clearStationOverlay();
    setButtonEnabled(true);
    setStatus('Ready. radius を選んで Calculate を押してください。');
  }

  onReady(() => {
    ensurePanel();
    document.getElementById('stationCompareBtn')?.addEventListener('click', runStationCompare);
    document.getElementById('stationOverlayToggle')?.addEventListener('change', syncStationOverlay);
    window.addEventListener('dtsb:compare-ready', (ev) => onCompareReady(ev && ev.detail));
    if (window.__dtsbCompareReady && window.__dtsbCompareReady.ready) {
      onCompareReady(window.__dtsbCompareReady);
    } else {
      onCompareReady(null);
    }
  });
})();
