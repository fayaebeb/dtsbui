// Station-area frequency compare UI for results.html
(function () {
  function onReady(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }

  const CACHE_KEY = 'dtsb.stationCompareCache.v1';
  const AGG_CACHE_KEY = 'dtsb.aggCompareCache.v2';
  const DEFAULT_STATION = '西条駅';
  const DEFAULT_RADIUS = 500;
  const DEFAULT_BIN_SEC = 3600;
  const ROUTE_SOURCE_TO_SIM_ID = {
    'bus_route/baseline_transitSchedule_cr24_1.xml': '096896b54be24ffbb0cbee53dde6fd9f',
    'bus_route/brt_transitSchedule_brt24_2.xml': '67eb5392da3a4202906f46f7b808b888',
    'bus_route/net_expansion_transitSchedule_cr40_3.xml': '18c774153bad4ee0aae34a8dcbb7f03b',
    'bus_route/output_transitSchedule_brt40_4.xml': '1e42e937-c0d9-445b-ae12-ba7ac8a66924'
  };
  const PEOPLE_BIN_STEP_MS = 1200;
  const PEOPLE_MAX_MARKERS_PER_SERIES = 140;
  let latestCompareContext = null;
  let stationOverlay = null;
  let latestStationArea = null;
  let peopleAnimationTimer = null;
  let peopleAnimationState = null;

  function getCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch { return {}; }
  }

  function setCache(cache) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache || {})); } catch { }
  }

  function getAggCache() {
    try { return JSON.parse(localStorage.getItem(AGG_CACHE_KEY) || 'null'); } catch { return null; }
  }

  function loadRouteParams() {
    try { return JSON.parse(localStorage.getItem('routeParams') || 'null'); } catch { return null; }
  }

  function buildStandaloneFrequencyContext() {
    const params = loadRouteParams();
    if (!params || params.oldFrequency == null || params.newFrequency == null) return null;
    const routeId = String(params.routeId || '');
    if (!routeId) return null;

    const cached = getAggCache();
    const simId = params.simulationId || ROUTE_SOURCE_TO_SIM_ID[String(params.sourcePath || '')] || cached?.simId || null;
    if (!simId) return null;

    const cachedParams = cached?.data?.params || {};
    const cacheMatches =
      cached &&
      cached.mode === 'frequency' &&
      cached.simId === simId &&
      String(cachedParams.routeId || '') === routeId &&
      Number(cachedParams.oldFrequency) === Number(params.oldFrequency) &&
      Number(cachedParams.newFrequency) === Number(params.newFrequency);
    const personLimit =
      cacheMatches
        ? (cached.personLimit ?? cached.data?.params?.personLimit ?? null)
        : null;

    return {
      ready: true,
      source: cached ? 'cache' : 'routeParams',
      mode: 'frequency',
      simId,
      params: {
        routeId,
        oldFrequency: Number(params.oldFrequency),
        newFrequency: Number(params.newFrequency),
        personLimit,
      },
    };
  }

  function emitWindowEvent(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (e) {
      console.warn(`Failed to emit ${name}`, e);
    }
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
    host.className = 'dtsb-fun-panel dtsb-fun-panel--station dtsb-compare-panel';
    host.style.minWidth = '0';
    host.innerHTML = `
      <div class="c-box dtsb-compare-shell">
        <details class="c-details dtsb-compare-details" open>
          <summary class="c-details__summary">西条駅周辺人数</summary>
          <div class="dtsb-compare-panel__body">
            <p class="dtsb-compare-panel__intro">駅周辺の滞在人数と時間帯ピークを見比べて、頻度変更の影響がどこに集中したかを確認できます。</p>

            <div class="dtsb-compare-controls dtsb-compare-controls--compact">
              <div class="dtsb-compare-field dtsb-compare-field--compact dtsb-compare-field--pair">
                <label class="dtsb-compare-subfield">
                  <span class="dtsb-compare-field__label dtsb-compare-field__label--compact">駅名</span>
                  <input id="stationCompareName" class="dtsb-compare-field__input dtsb-compare-field__input--compact" type="text" value="${DEFAULT_STATION}" />
                </label>
                <label class="dtsb-compare-subfield">
                  <span class="dtsb-compare-field__label dtsb-compare-field__label--compact">半径</span>
                  <select id="stationCompareRadius" class="dtsb-compare-field__input dtsb-compare-field__input--compact">
                    <option value="300">300 m</option>
                    <option value="500" selected>500 m</option>
                    <option value="800">800 m</option>
                  </select>
                </label>
              </div>
              <div class="dtsb-compare-field dtsb-compare-field--compact dtsb-compare-field--toggles">
                <span class="dtsb-compare-field__label dtsb-compare-field__label--compact">表示</span>
                <label class="dtsb-compare-toggle dtsb-compare-toggle--compact">
                  <input id="stationOverlayToggle" type="checkbox" checked>
                  <span class="dtsb-compare-toggle__switch" aria-hidden="true"></span>
                  <span class="dtsb-compare-toggle__text dtsb-compare-toggle__text--compact">地図表示</span>
                </label>
                <label class="dtsb-compare-toggle dtsb-compare-toggle--compact">
                  <input id="stationPeopleToggle" type="checkbox" checked>
                  <span class="dtsb-compare-toggle__switch" aria-hidden="true"></span>
                  <span class="dtsb-compare-toggle__text dtsb-compare-toggle__text--compact">人数アニメ</span>
                </label>
              </div>
            </div>

            <div class="dtsb-compare-actions dtsb-compare-actions--compact">
              <button id="stationCompareBtn" type="button" class="btn dtsb-compare-btn" disabled>計算する</button>
              <span id="stationCompareStatus" class="dtsb-compare-status" data-tone="neutral">比較結果を確認したら、このボタンで西条駅周辺人数を計算できます。</span>
            </div>

            <div id="stationPeopleLegend" class="muted"></div>
            <div id="stationPeopleControls" class="station-people-controls" style="display:none;">
              <button id="stationPeoplePlayPause" type="button" class="btn station-people-controls__play">一時停止</button>
              <input id="stationPeopleSlider" class="station-people-controls__slider" type="range" min="0" max="0" step="1" value="0" />
              <span id="stationPeopleTimeLabel" class="station-people-controls__label">00:00</span>
            </div>

            <div id="stationCompareCards" class="dtsb-compare-cards"></div>

            <div id="stationCompareChartWrap" class="dtsb-chart-grid" style="display:none;">
              <section class="dtsb-chart-card">
                <div class="dtsb-chart-card__head">
                  <span class="dtsb-chart-card__eyebrow">Station</span>
                  <h3 class="dtsb-chart-card__title">時間帯ごとの周辺人数</h3>
                </div>
                <div class="dtsb-chart-card__body c-chart">
                  <canvas id="stationCompareChart"></canvas>
                </div>
              </section>
            </div>

            <div id="stationCompareMeta"></div>
          </div>
        </details>
      </div>
    `;

    const mount = document.getElementById('stationCompareMount');
    const fallback = document.getElementById('aggPanelMount')?.parentElement || document.body;
    if (mount) mount.appendChild(host);
    else fallback.appendChild(host);
    return host;
  }

  function card(label, value, note) {
    const div = document.createElement('div');
    div.className = 'dtsb-stat-card';
    div.innerHTML = `<div class="dtsb-stat-card__label">${label}</div><div class="dtsb-stat-card__value u-en">${value}</div>${note ? `<div class="dtsb-stat-card__note">${note}</div>` : ''}`;
    return div;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setStatus(text, tone) {
    const el = document.getElementById('stationCompareStatus');
    if (!el) return;
    el.textContent = text || '';
    el.dataset.tone = tone || 'neutral';
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
    if (peopleAnimationTimer) {
      clearInterval(peopleAnimationTimer);
      peopleAnimationTimer = null;
    }
    peopleAnimationState = null;
    setPeopleControlsVisible(false);
    setPeopleControlState({ hour: 0, bins: 1, playing: false });
    if (!stationOverlay || !window.map || typeof window.map.removeLayer !== 'function') return;
    try { window.map.removeLayer(stationOverlay); } catch { }
    stationOverlay = null;
  }

  function isOverlayEnabled() {
    return !!document.getElementById('stationOverlayToggle')?.checked;
  }

  function isPeopleAnimationEnabled() {
    return !!document.getElementById('stationPeopleToggle')?.checked;
  }

  function setPeopleControlsVisible(visible) {
    const wrap = document.getElementById('stationPeopleControls');
    if (!wrap) return;
    wrap.style.display = visible ? 'grid' : 'none';
  }

  function setPeopleControlState(state) {
    const slider = document.getElementById('stationPeopleSlider');
    const label = document.getElementById('stationPeopleTimeLabel');
    const btn = document.getElementById('stationPeoplePlayPause');
    if (!slider || !label || !btn) return;

    const bins = Math.max(1, toNonNegativeInt(state?.bins));
    const hour = Math.max(0, toNonNegativeInt(state?.hour) % bins);
    const playing = !!state?.playing;

    slider.min = '0';
    slider.max = String(Math.max(0, bins - 1));
    slider.value = String(hour);
    label.textContent = `${String(hour).padStart(2, '0')}:00`;
    btn.textContent = playing ? '一時停止' : '再生';
  }

  function stopPeopleAnimationTimer() {
    if (!peopleAnimationTimer) return;
    clearInterval(peopleAnimationTimer);
    peopleAnimationTimer = null;
  }

  function startPeopleAnimationTimer() {
    stopPeopleAnimationTimer();
    if (!peopleAnimationState || !peopleAnimationState.playing || peopleAnimationState.bins <= 0) return;
    peopleAnimationTimer = setInterval(() => {
      if (!peopleAnimationState || !peopleAnimationState.playing) return;
      const nextHour = (peopleAnimationState.hour + 1) % peopleAnimationState.bins;
      renderPeopleFrame(nextHour);
    }, PEOPLE_BIN_STEP_MS);
  }

  function setPeopleLegend(state) {
    const el = document.getElementById('stationPeopleLegend');
    if (!el) return;
    if (!state || typeof state !== 'object') {
      el.innerHTML = '';
      return;
    }
    const bins = Math.max(1, toNonNegativeInt(state.bins));
    const hour = Math.max(0, toNonNegativeInt(state.hour) % bins);
    const preReal = toNonNegativeInt(state.preReal);
    const postReal = toNonNegativeInt(state.postReal);
    const preVisible = toNonNegativeInt(state.preVisible);
    const postVisible = toNonNegativeInt(state.postVisible);
    const preSample = preReal > preVisible ? `<span class="station-people-note">表示 ${preVisible}/${preReal}</span>` : '';
    const postSample = postReal > postVisible ? `<span class="station-people-note">表示 ${postVisible}/${postReal}</span>` : '';
    const delta = postReal - preReal;
    const deltaSign = delta > 0 ? '+' : '';
    const deltaClass = delta > 0 ? 'station-people-chip--up' : (delta < 0 ? 'station-people-chip--down' : '');
    const progressPct = (((hour + 1) / bins) * 100).toFixed(2);

    el.innerHTML = `
      <div class="station-people-legend">
        <span class="station-people-hour">${String(hour).padStart(2, '0')}:00</span>
        <span class="station-people-chip station-people-chip--before">変更前 <strong>${preReal}</strong>${preSample}</span>
        <span class="station-people-chip station-people-chip--after">変更後 <strong>${postReal}</strong>${postSample}</span>
        <span class="station-people-chip ${deltaClass}">差分 <strong>${deltaSign}${delta}</strong></span>
      </div>
      <span class="station-people-track"><span class="station-people-track-fill" style="width:${progressPct}%;"></span></span>
    `;
  }

  function toNonNegativeInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(0, Math.round(n));
  }

  function peakCount(arr) {
    return (Array.isArray(arr) ? arr : []).reduce((max, v) => Math.max(max, toNonNegativeInt(v)), 0);
  }

  function effectiveBinCount(...series) {
    let lastNonZero = -1;
    let longest = 0;
    for (const arr of series) {
      if (!Array.isArray(arr)) continue;
      longest = Math.max(longest, arr.length);
      for (let i = arr.length - 1; i >= 0; i -= 1) {
        if (toNonNegativeInt(arr[i]) > 0) {
          lastNonZero = Math.max(lastNonZero, i);
          break;
        }
      }
    }
    return lastNonZero >= 0 ? (lastNonZero + 1) : longest;
  }

  function buildSeededRandom(seedText) {
    const src = String(seedText || 'station-seed');
    let seed = 0;
    for (let i = 0; i < src.length; i += 1) seed = ((seed * 31) + src.charCodeAt(i)) >>> 0;
    if (!seed) seed = 123456789;
    return function seeded() {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  function randomPointInRadius(lat, lng, radiusM, rand) {
    const theta = (Math.PI * 2 * rand());
    const distM = Math.sqrt(rand()) * radiusM;
    const latDelta = (distM * Math.sin(theta)) / 111320;
    const lngScale = Math.max(0.1, Math.cos((lat * Math.PI) / 180));
    const lngDelta = (distM * Math.cos(theta)) / (111320 * lngScale);
    return [lat + latDelta, lng + lngDelta];
  }

  function createPeoplePool(group, lat, lng, radiusM, count, seedLabel, className) {
    if (!window.L || !group) return [];
    const rand = buildSeededRandom(seedLabel);
    const pool = [];
    for (let i = 0; i < count; i += 1) {
      const size = 5 + Math.floor(rand() * 5);
      const pulseSec = (1.1 + rand() * 1.7).toFixed(2);
      const delaySec = (-rand() * 2).toFixed(2);
      const marker = L.marker(randomPointInRadius(lat, lng, radiusM, rand), {
        pane: 'selectStop',
        interactive: false,
        keyboard: false,
        opacity: 0,
        icon: L.divIcon({
          className: className,
          iconSize: [size, size],
          iconAnchor: [Math.round(size / 2), Math.round(size / 2)],
          html: `<span class="station-person__dot" style="--pulse:${pulseSec}s; --delay:${delaySec}s;"><span class="station-person__core"></span></span>`,
        }),
      });
      pool.push(marker);
      group.addLayer(marker);
    }
    return pool;
  }

  function applyPeopleCount(pool, value) {
    const visible = Math.min(pool.length, toNonNegativeInt(value));
    for (let i = 0; i < pool.length; i += 1) pool[i].setOpacity(i < visible ? 1 : 0);
    return visible;
  }

  function renderPeopleFrame(hour) {
    if (!peopleAnimationState || !peopleAnimationState.bins) return;
    const bins = peopleAnimationState.bins;
    const normalizedHour = ((Number(hour) % bins) + bins) % bins;
    peopleAnimationState.hour = normalizedHour;

    const preReal = toNonNegativeInt(peopleAnimationState.preBins[normalizedHour] || 0);
    const postReal = toNonNegativeInt(peopleAnimationState.postBins[normalizedHour] || 0);
    const preVisible = applyPeopleCount(peopleAnimationState.prePool, preReal);
    const postVisible = applyPeopleCount(peopleAnimationState.postPool, postReal);
    setPeopleLegend({
      hour: normalizedHour,
      bins,
      preReal,
      postReal,
      preVisible,
      postVisible,
    });
    setPeopleControlState({
      hour: normalizedHour,
      bins,
      playing: peopleAnimationState.playing,
    });
  }

  function startPeopleAnimation(group, station, latlng, radiusM) {
    const preBins = Array.isArray(station?.pre?.presentByBin) ? station.pre.presentByBin : [];
    const postBins = Array.isArray(station?.post?.presentByBin) ? station.post.presentByBin : [];
    const bins = effectiveBinCount(preBins, postBins);
    if (!bins || !isPeopleAnimationEnabled()) {
      setPeopleLegend(null);
      setPeopleControlsVisible(false);
      return;
    }

    const centerLat = Number(latlng[0]);
    const centerLng = Number(latlng[1]);
    const prePeak = peakCount(preBins);
    const postPeak = peakCount(postBins);
    const prePoolSize = Math.min(PEOPLE_MAX_MARKERS_PER_SERIES, prePeak || 0);
    const postPoolSize = Math.min(PEOPLE_MAX_MARKERS_PER_SERIES, postPeak || 0);

    const prePool = createPeoplePool(
      group,
      centerLat,
      centerLng,
      radiusM,
      prePoolSize,
      `${station.stationName || DEFAULT_STATION}:${radiusM}:pre`,
      'station-person-marker station-person-marker--before',
    );
    const postPool = createPeoplePool(
      group,
      centerLat,
      centerLng,
      radiusM,
      postPoolSize,
      `${station.stationName || DEFAULT_STATION}:${radiusM}:post`,
      'station-person-marker station-person-marker--after',
    );

    if (!prePool.length && !postPool.length) {
      setPeopleLegend(null);
      setPeopleControlsVisible(false);
      return;
    }

    peopleAnimationState = {
      preBins,
      postBins,
      prePool,
      postPool,
      bins,
      hour: 0,
      playing: true,
    };
    setPeopleControlsVisible(true);
    renderPeopleFrame(0);
    startPeopleAnimationTimer();
  }

  function buildStationRing(lat, lng, radiusM, steps = 64) {
    const out = [];
    const latRadius = radiusM / 111320;
    const lngScale = Math.max(0.1, Math.cos((lat * Math.PI) / 180));
    const lngRadius = radiusM / (111320 * lngScale);
    const n = Math.max(16, Number(steps) || 64);
    for (let i = 0; i < n; i += 1) {
      const theta = (Math.PI * 2 * i) / n;
      out.push([
        lat + (Math.sin(theta) * latRadius),
        lng + (Math.cos(theta) * lngRadius),
      ]);
    }
    return out;
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
    const ring = buildStationRing(Number(latlng[0]), Number(latlng[1]), radius);
    const preBins = Array.isArray(station?.pre?.presentByBin) ? station.pre.presentByBin : [];
    const postBins = Array.isArray(station?.post?.presentByBin) ? station.post.presentByBin : [];
    const prePeak = peakCount(preBins);
    const postPeak = peakCount(postBins);
    const scalePeak = Math.max(prePeak, postPeak, 1);
    const preAuraRadius = Math.max(radius * 0.24, radius * (0.24 + (0.66 * (prePeak / scalePeak))));
    const postAuraRadius = Math.max(radius * 0.24, radius * (0.24 + (0.66 * (postPeak / scalePeak))));
    const group = L.layerGroup();
    const beforeAura = L.circle(latlng, {
      radius: preAuraRadius,
      color: '#4F64D9',
      weight: 1,
      opacity: 0.45,
      fillColor: '#4F64D9',
      fillOpacity: 0.07,
      interactive: false,
      pane: 'selectStop',
    });
    const afterAura = L.circle(latlng, {
      radius: postAuraRadius,
      color: '#8E4DD8',
      weight: 1,
      opacity: 0.5,
      fillColor: '#8E4DD8',
      fillOpacity: 0.08,
      interactive: false,
      pane: 'selectStop',
    });
    const area = L.polygon(ring, {
      color: '#8E4DD8',
      weight: 2,
      opacity: 0.9,
      dashArray: '10 6',
      fillColor: '#8E4DD8',
      fillOpacity: 0.05,
      pane: 'selectStop',
    });
    const center = L.circleMarker(latlng, {
      radius: 7,
      color: '#8E4DD8',
      weight: 2,
      fillColor: '#ffffff',
      fillOpacity: 1,
      pane: 'selectStop',
    });

    area.bindTooltip(`${label} / ピーク ${prePeak}→${postPeak}`, { permanent: false, direction: 'top', className: 'l-contents__map-route' });
    center.bindTooltip(label, { permanent: false, direction: 'top', className: 'l-contents__map-route' });
    group.addLayer(beforeAura);
    group.addLayer(afterAura);
    group.addLayer(area);
    group.addLayer(center);
    group.addTo(window.map);
    try { area.bringToFront(); } catch { }
    startPeopleAnimation(group, station, latlng, radius);
    try { center.bringToFront(); } catch { }
    stationOverlay = group;
  }

  function fitMapToStation(station) {
    if (!station || !window.L || !window.map) return;
    if (typeof window.km2deg !== 'function') return;
    const latlng = window.km2deg([Number(station.centerX), Number(station.centerY)]);
    if (!Array.isArray(latlng) || latlng.length !== 2) return;
    const radius = Number(station.radiusM || DEFAULT_RADIUS);
    const ring = buildStationRing(Number(latlng[0]), Number(latlng[1]), radius);
    const bounds = L.latLngBounds(ring);
    try { window.map.fitBounds(bounds.pad(0.35)); } catch { }
  }

  function syncStationOverlay() {
    if (latestStationArea && isOverlayEnabled()) {
      renderStationOverlay(latestStationArea);
      return;
    }
    setPeopleLegend(null);
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
    const n = effectiveBinCount(preBins, postBins);
    const labels = Array.from({ length: n }, (_, i) => `${String(i).padStart(2, '0')}:00`);
    const peak = (arr) => arr.reduce((max, v) => Math.max(max, Number(v) || 0), 0);

    cards.innerHTML = '';
    cards.appendChild(card('訪問者数', `${Number(pre.uniqueVisitors || 0)} → ${Number(post.uniqueVisitors || 0)}`, '駅周辺を訪れたユニーク人数'));
    cards.appendChild(card('時間帯ピーク人数', `${peak(preBins)} → ${peak(postBins)}`, 'もっとも混雑した時間帯の人数'));
    cards.appendChild(card('一致した停留所数', `${Number(station.matchCount || 0)}`, '周辺判定に使われた停留所'));
    latestStationArea = station || null;
    syncStationOverlay();
    fitMapToStation(station);

    wrap.style.display = n ? 'grid' : 'none';
    if (n) {
      upsertChart('stationCompareChart', {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: '変更前',
              data: labels.map((_, i) => Number(preBins[i] || 0)),
              borderColor: '#4F64D9',
              backgroundColor: 'rgba(79,100,217,0.16)',
              pointBackgroundColor: '#4F64D9',
              pointBorderWidth: 0,
              pointRadius: 2.5,
              pointHoverRadius: 4,
              tension: 0.25,
              fill: true,
            },
            {
              label: '変更後',
              data: labels.map((_, i) => Number(postBins[i] || 0)),
              borderColor: '#8E4DD8',
              backgroundColor: 'rgba(142,77,216,0.16)',
              pointBackgroundColor: '#8E4DD8',
              pointBorderWidth: 0,
              pointRadius: 2.5,
              pointHoverRadius: 4,
              tension: 0.25,
              fill: true,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: true,
              labels: {
                usePointStyle: true,
                pointStyle: 'circle',
                boxWidth: 10,
                padding: 14,
                color: '#33425c',
                font: { weight: '700' },
              }
            },
            tooltip: {
              backgroundColor: '#1f2d4a',
              padding: 10,
              cornerRadius: 12,
            }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: '#5f6f88', maxRotation: 0, autoSkip: true },
            },
            y: {
              beginAtZero: true,
              grid: { color: 'rgba(95, 111, 228, 0.12)' },
              ticks: { precision: 0, color: '#5f6f88' },
            },
          },
        },
      });
    }

    const matchedStops = Array.isArray(station.matchedStops) ? station.matchedStops : [];
    const stopNames = matchedStops.slice(0, 4).map((s) => String(s.name || s.id || '')).filter(Boolean);
    meta.innerHTML = [
      `${station.stationName || DEFAULT_STATION} / 半径 ${Number(station.radiusM || DEFAULT_RADIUS)}m`,
      stopNames.length ? `参照停留所: ${stopNames.join(', ')}` : '',
      latestCompareContext?.params?.personLimit ? `サンプル人数: ${latestCompareContext.params.personLimit}` : '',
    ].filter(Boolean).map((item) => `<span class="dtsb-meta-chip">${escapeHtml(item)}</span>`).join('');
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
    if (!res.ok) throw new Error(data?.error || '駅周辺比較に失敗しました。');
    if (!data || !data.stationArea) throw new Error('応答に stationArea がありません。');
    return data;
  }

  async function runStationCompare(options = {}) {
    const ctx = latestCompareContext || buildStandaloneFrequencyContext();
    if (!ctx || ctx.mode !== 'frequency' || !ctx.simId) {
      setStatus('index.html で運航頻度設定を保存してください。');
      emitWindowEvent('dtsb:station-compare-failed', {
        auto: !!options.auto,
        error: 'index.html で運航頻度設定を保存してください。',
      });
      return null;
    }
    latestCompareContext = ctx;

    const stationName = String(document.getElementById('stationCompareName')?.value || DEFAULT_STATION).trim() || DEFAULT_STATION;
    const radiusM = Number(document.getElementById('stationCompareRadius')?.value || DEFAULT_RADIUS);
    const sig = compareSignature(ctx, stationName, radiusM);
    const btn = document.getElementById('stationCompareBtn');

    setStatus('計算中…', 'loading');
    if (btn) btn.disabled = true;
    emitWindowEvent('dtsb:station-compare-started', {
      auto: !!options.auto,
      ctx,
      stationName,
      radiusM,
    });
    try {
      const cache = getCache();
      const cached = cache[sig];
      if (cached && cached.stationArea) {
        renderStationCompare(cached);
        setStatus('キャッシュを表示中', 'neutral');
        emitWindowEvent('dtsb:station-compare-completed', {
          auto: !!options.auto,
          cached: true,
          ctx,
          stationName,
          radiusM,
          data: cached,
        });
        return cached;
      }
      const data = await fetchStationCompare(ctx, stationName, radiusM);
      cache[sig] = data;
      setCache(cache);
      renderStationCompare(data);
      setStatus('計算完了', 'success');
      emitWindowEvent('dtsb:station-compare-completed', {
        auto: !!options.auto,
        cached: false,
        ctx,
        stationName,
        radiusM,
        data,
      });
      return data;
    } catch (err) {
      console.error(err);
      const error = err && err.message ? String(err.message) : '失敗しました';
      setStatus(error, 'error');
      emitWindowEvent('dtsb:station-compare-failed', {
        auto: !!options.auto,
        ctx,
        stationName,
        radiusM,
        error,
      });
      return null;
    } finally {
      setButtonEnabled(!!((latestCompareContext || buildStandaloneFrequencyContext())?.simId));
    }
  }

  function onCompareReady(detail) {
    latestCompareContext = (detail && detail.ready && detail.mode === 'frequency') ? detail : buildStandaloneFrequencyContext();
    const cards = document.getElementById('stationCompareCards');
    const meta = document.getElementById('stationCompareMeta');
    const wrap = document.getElementById('stationCompareChartWrap');
    if (!latestCompareContext || latestCompareContext.mode !== 'frequency') {
      if (cards) cards.innerHTML = '';
      if (meta) meta.textContent = '';
      if (wrap) wrap.style.display = 'none';
      setPeopleLegend(null);
      latestStationArea = null;
      clearStationOverlay();
      setButtonEnabled(false);
      setStatus('index.html で運航頻度設定を保存すると、西条駅周辺の変更前後を単独で計算できます。', 'neutral');
      return;
    }
    if (cards) cards.innerHTML = '';
    if (meta) meta.textContent = '';
    if (wrap) wrap.style.display = 'none';
    setPeopleLegend(null);
    latestStationArea = null;
    clearStationOverlay();
    setButtonEnabled(true);
    setStatus('準備完了。比較のあとに「計算する」を押してください。', 'ready');
  }

  onReady(() => {
    ensurePanel();
    document.getElementById('stationCompareBtn')?.addEventListener('click', runStationCompare);
    document.getElementById('stationOverlayToggle')?.addEventListener('change', syncStationOverlay);
    document.getElementById('stationPeopleToggle')?.addEventListener('change', syncStationOverlay);
    document.getElementById('stationPeopleSlider')?.addEventListener('input', (ev) => {
      if (!peopleAnimationState) return;
      peopleAnimationState.playing = false;
      stopPeopleAnimationTimer();
      const hour = Number(ev?.target?.value || 0);
      renderPeopleFrame(hour);
    });
    document.getElementById('stationPeoplePlayPause')?.addEventListener('click', () => {
      if (!peopleAnimationState) return;
      peopleAnimationState.playing = !peopleAnimationState.playing;
      setPeopleControlState({
        hour: peopleAnimationState.hour,
        bins: peopleAnimationState.bins,
        playing: peopleAnimationState.playing,
      });
      if (peopleAnimationState.playing) startPeopleAnimationTimer();
      else stopPeopleAnimationTimer();
    });
    window.addEventListener('dtsb:compare-ready', (ev) => onCompareReady(ev && ev.detail));
    if (window.__dtsbCompareReady && window.__dtsbCompareReady.ready) {
      onCompareReady(window.__dtsbCompareReady);
    } else {
      onCompareReady(null);
    }
    window.__dtsbStationCompare = { run: runStationCompare };
  });
})();
