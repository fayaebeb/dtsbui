// Aggregations and charts for simulations (computed on backend from full dataset)
(function () {
  function onReady(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  const CACHE_KEY = 'dtsb.aggCompareCache.v2';
  const ROUTE_SOURCE_TO_SIM_ID = {
    'bus_route/baseline_transitSchedule_cr24_1.xml': '096896b54be24ffbb0cbee53dde6fd9f',
    'bus_route/brt_transitSchedule_brt24_2.xml': '67eb5392da3a4202906f46f7b808b888',
    'bus_route/net_expansion_transitSchedule_cr40_3.xml': '18c774153bad4ee0aae34a8dcbb7f03b',
    'bus_route/output_transitSchedule_brt40_4.xml': '1e42e937-c0d9-445b-ae12-ba7ac8a66924'
  };

  async function fetchSimulations() {
    const res = await fetch('/api/simulations');
    const sims = await res.json();
    return Array.isArray(sims) ? sims : [];
  }

  async function fetchCompare(preId, postId, personLimit) {
    const res = await fetch('/api/simulations/compare-aggregates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pre_id: preId,
        post_id: postId,
        top_routes: 12,
        ...(personLimit ? { person_limit: personLimit } : {})
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || '比較に失敗しました。');
    return data;
  }

  async function fetchFrequencyCompare(simId, params, personLimit) {
    const res = await fetch(`/api/simulations/${simId}/frequency-compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(params || {}),
        ...(personLimit ? { person_limit: personLimit } : {})
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || '運航頻度比較に失敗しました。');
    return data;
  }

  function loadRouteParams() {
    try { return JSON.parse(localStorage.getItem('routeParams') || 'null'); } catch { return null; }
  }

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function getCachedCompare() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      return safeJsonParse(raw);
    } catch {
      return null;
    }
  }

  function setCachedCompare(entry) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(entry)); } catch { }
  }

  function routeSignature(params, personLimit) {
    if (!params) return '';
    const rid = params.routeId || '';
    const oldF = params.oldFrequency ?? '';
    const newF = params.newFrequency ?? '';
    const ts = params.ts ?? '';
    const mode = params.timeMode ?? '';
    const lim = personLimit ? String(personLimit) : 'all';
    return `${rid}|${oldF}|${newF}|${mode}|${ts}|${lim}`;
  }

  function simulationDisplayName(name) {
    const labelMap = {
      'output_curr_2024.zip': 'CURR24',
      'output_BRT_2024.zip': 'BRT24',
      'output_curr_2040.zip': 'CURR40',
      '2040_BRT_v2.zip': 'BRT40',
    };
    return labelMap[String(name || '')] || name || 'シミュレーション';
  }

  function emitWindowEvent(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (e) {
      console.warn(`Failed to emit ${name}`, e);
    }
  }

  function resolveFrequencySimulationId(params, eligible, fallbackId) {
    const fromSource = params?.sourcePath ? ROUTE_SOURCE_TO_SIM_ID[String(params.sourcePath)] : null;
    const simId = params?.simulationId || fromSource || fallbackId || null;
    const isEligible = !!simId && eligible.some(s => s.id === simId);
    return { simId, isEligible };
  }

  function hhmmss(totalSec) {
    const s = Math.max(0, Math.round(totalSec || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }

  const PANEL_IDS = {
    frequency: {
      cards: 'freqCards',
      charts: 'freqCharts',
      status: 'freqStatus',
      actPeople: 'freqChartActPeople',
      actTime: 'freqChartActTime',
      actAvg: 'freqChartActAvg',
      modeTime: 'freqChartModeTime',
      modeAvg: 'freqChartModeAvg',
      pt: 'freqChartPt',
      ptRouteTable: 'freqPtRouteTable',
    },
    sim: {
      cards: 'aggCards',
      charts: 'aggCharts',
      status: 'aggStatus',
      actPeople: 'chartActPeople',
      actTime: 'chartActTime',
      actAvg: 'chartActAvg',
      modeTime: 'chartModeTime',
      modeAvg: 'chartModeAvg',
      pt: 'chartPt',
      ptRouteTable: 'ptRouteTable',
    },
  };

  function panelIds(mode) {
    return mode === 'frequency' ? PANEL_IDS.frequency : PANEL_IDS.sim;
  }

  function personLimitOptions() {
    return `
      <option value="">全員</option>
      <option value="1000">1000</option>
    `;
  }

  function chartGridHtml(ids) {
    return `
      <div id="${ids.charts}" class="dtsb-chart-grid" style="display:none;">
        <section class="dtsb-chart-card">
          <div class="dtsb-chart-card__head">
            <span class="dtsb-chart-card__eyebrow">Activity</span>
            <h3 class="dtsb-chart-card__title">活動ごとの人数</h3>
          </div>
          <div class="dtsb-chart-card__body c-chart"><canvas id="${ids.actPeople}"></canvas></div>
        </section>
        <section class="dtsb-chart-card">
          <div class="dtsb-chart-card__head">
            <span class="dtsb-chart-card__eyebrow">Activity</span>
            <h3 class="dtsb-chart-card__title">活動ごとの合計時間</h3>
          </div>
          <div class="dtsb-chart-card__body c-chart"><canvas id="${ids.actTime}"></canvas></div>
        </section>
        <section class="dtsb-chart-card">
          <div class="dtsb-chart-card__head">
            <span class="dtsb-chart-card__eyebrow">Activity</span>
            <h3 class="dtsb-chart-card__title">1人あたり活動時間</h3>
          </div>
          <div class="dtsb-chart-card__body c-chart"><canvas id="${ids.actAvg}"></canvas></div>
        </section>
        <section class="dtsb-chart-card">
          <div class="dtsb-chart-card__head">
            <span class="dtsb-chart-card__eyebrow">Mode</span>
            <h3 class="dtsb-chart-card__title">交通手段ごとの移動時間</h3>
          </div>
          <div class="dtsb-chart-card__body c-chart"><canvas id="${ids.modeTime}"></canvas></div>
        </section>
        <section class="dtsb-chart-card">
          <div class="dtsb-chart-card__head">
            <span class="dtsb-chart-card__eyebrow">Mode</span>
            <h3 class="dtsb-chart-card__title">1人あたり移動時間</h3>
          </div>
          <div class="dtsb-chart-card__body c-chart"><canvas id="${ids.modeAvg}"></canvas></div>
        </section>
        <section class="dtsb-chart-card">
          <div class="dtsb-chart-card__head">
            <span class="dtsb-chart-card__eyebrow">Transit</span>
            <h3 class="dtsb-chart-card__title">公共交通利用の内訳</h3>
          </div>
          <div class="dtsb-chart-card__body c-chart"><canvas id="${ids.pt}"></canvas></div>
        </section>
        <section class="dtsb-chart-card dtsb-chart-card--table">
          <div class="dtsb-chart-card__head">
            <span class="dtsb-chart-card__eyebrow">Transit</span>
            <h3 class="dtsb-chart-card__title">路線別利用比較</h3>
          </div>
          <div class="dtsb-chart-card__body" id="${ids.ptRouteTable}"></div>
        </section>
      </div>
    `;
  }

  function panelMode() {
    const mount = document.getElementById('aggPanelMount');
    const mode = mount?.dataset?.aggPanelMode || document.body?.dataset?.aggPanelMode || 'full';
    return ['full', 'frequency', 'frequency-result'].includes(mode) ? mode : 'full';
  }

  function ensurePanel() {
    let host = document.getElementById('aggPanel');
    if (host) return host;

    const mode = panelMode();
    const frequencyOnly = mode === 'frequency' || mode === 'frequency-result';
    const resultOnly = mode === 'frequency-result';
    const frequencyControls = resultOnly ? '' : `
          <div class="dtsb-compare-controls dtsb-compare-controls--compact">
            <label class="dtsb-compare-field dtsb-compare-field--compact">
              <span class="dtsb-compare-field__label dtsb-compare-field__label--compact">対象人数</span>
              <select id="freqPersonLimit" class="dtsb-compare-field__input dtsb-compare-field__input--compact">
                ${personLimitOptions()}
              </select>
            </label>
          </div>
    `;
    const frequencyActions = resultOnly ? `
          <div class="dtsb-compare-actions dtsb-compare-actions--compact">
            <span id="freqStatus" class="dtsb-compare-status" data-tone="neutral"></span>
          </div>
    ` : `
          <div class="dtsb-compare-actions dtsb-compare-actions--compact">
            <button id="freqCompareBtn" type="button" class="btn dtsb-compare-btn">比較する</button>
            <span id="freqStatus" class="dtsb-compare-status" data-tone="neutral"></span>
          </div>
    `;
    const simPanel = frequencyOnly ? '' : `
    <div class="c-box dtsb-compare-shell">
      <details id="aggDetails" class="c-details dtsb-compare-details" open>
        <summary class="c-details__summary">集計比較</summary>
        <div class="dtsb-compare-panel__body">
          <p class="dtsb-compare-panel__intro">シミュレーション2本を比較し、同じ指標セットで差を確認できます。</p>

          <div class="dtsb-compare-controls dtsb-compare-controls--compact">
            <div id="aggSimPairWrap" class="dtsb-compare-field dtsb-compare-field--compact dtsb-compare-field--pair-equal">
              <label class="dtsb-compare-subfield">
                <span class="dtsb-compare-field__label dtsb-compare-field__label--compact">比較前</span>
                <select id="aggPreSelect" class="dtsb-compare-field__input dtsb-compare-field__input--compact"></select>
              </label>
              <label class="dtsb-compare-subfield">
                <span class="dtsb-compare-field__label dtsb-compare-field__label--compact">比較後</span>
                <select id="aggPostSelect" class="dtsb-compare-field__input dtsb-compare-field__input--compact"></select>
              </label>
            </div>
            <label class="dtsb-compare-field dtsb-compare-field--compact">
              <span class="dtsb-compare-field__label dtsb-compare-field__label--compact">対象人数</span>
              <select id="aggPersonLimit" class="dtsb-compare-field__input dtsb-compare-field__input--compact">
                ${personLimitOptions()}
              </select>
            </label>
          </div>

          <div class="dtsb-compare-actions dtsb-compare-actions--compact">
            <button id="aggCompareBtn" type="button" class="btn dtsb-compare-btn">比較する</button>
            <span id="aggStatus" class="dtsb-compare-status" data-tone="neutral"></span>
          </div>

          <div id="aggCards" class="dtsb-compare-cards"></div>
          ${chartGridHtml(PANEL_IDS.sim)}
        </div>
      </details>
    </div>
    `;

    host = document.createElement('section');
    host.id = 'aggPanel';
    host.className = 'dtsb-fun-panel dtsb-fun-panel--agg dtsb-compare-panel';
    host.dataset.aggPanelMode = mode;
    host.style.marginTop = '16px';
    host.style.minWidth = '0';
    host.style.display = 'grid';
    host.style.gap = '12px';

    host.innerHTML = `
    <div class="c-box dtsb-compare-shell">
      <details id="freqDetails" class="c-details dtsb-compare-details" open>
        <summary class="c-details__summary">運航頻度変更前後</summary>
        <div class="dtsb-compare-panel__body">
          <p class="dtsb-compare-panel__intro">入力画面で保存した運航頻度設定を使って、変更前後の集計差を確認できます。</p>

          ${frequencyControls}
          ${frequencyActions}

          <div id="freqCards" class="dtsb-compare-cards"></div>
          ${chartGridHtml(PANEL_IDS.frequency)}
        </div>
      </details>
    </div>
    ${simPanel}
  `;

    const gridContainer =
      // Prefer inserting into the scrollable chart grid on results_graph.html
      document.querySelector('.l-contents__data .c-area__grid.c-area__scroll') ||
      null;
    const mount = document.getElementById('aggPanelMount');
    const titleBar = document.querySelector('.l-contents__data .l-contents__main-tit');
    const fallbackContainer =
      // Fallbacks for other pages/layouts
      document.querySelector('.l-contents__data .c-box.c-area__scroll') ||
      document.querySelector('.l-contents__data') ||
      document.querySelector('.l-contents__map') ||
      document.body;

    if (gridContainer && gridContainer.classList?.contains('c-area__grid')) {
      host.style.marginTop = '0';
      host.style.marginBottom = '12px';
      host.style.gridColumn = '1 / -1';
      if (typeof gridContainer.prepend === 'function') gridContainer.prepend(host);
      else gridContainer.insertBefore(host, gridContainer.firstChild);
    } else if (mount) {
      host.style.marginTop = '8px';
      mount.appendChild(host);
      const scrollBox = mount.closest('.c-area__scroll');
      if (scrollBox) {
        // On touch devices :hover doesn't reliably switch overflow to auto.
        // Keep this container scrollable so expanded Aggregations won't overflow vertically.
        scrollBox.style.overflowY = 'auto';
        scrollBox.style.overflowX = 'hidden';
        scrollBox.style.scrollbarGutter = 'stable';
        scrollBox.style.webkitOverflowScrolling = 'touch';
        scrollBox.style.paddingBottom = '120px';
      }
    } else if (titleBar && titleBar.parentElement) {
      host.style.marginTop = '8px';
      titleBar.insertAdjacentElement('afterend', host);
    } else {
      if (typeof fallbackContainer.prepend === 'function') fallbackContainer.prepend(host);
      else fallbackContainer.insertBefore(host, fallbackContainer.firstChild);
    }

    [
      { id: 'freqDetails', key: 'freqDetailsOpen' },
      { id: 'aggDetails', key: 'aggDetailsOpen' },
    ].forEach(({ id, key }) => {
      const details = host.querySelector(`#${id}`);
      if (!details) return;
      const saved = localStorage.getItem(key);
      if (saved != null) details.open = saved === '1';
      details.addEventListener('toggle', () => localStorage.setItem(key, details.open ? '1' : '0'));
    });

    return host;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function card(label, value, note) {
    const div = document.createElement('div');
    div.className = 'dtsb-stat-card';
    div.innerHTML = `<div class="dtsb-stat-card__label">${escapeHtml(label)}</div><div class="dtsb-stat-card__value u-en">${escapeHtml(value)}</div>${note ? `<div class="dtsb-stat-card__note">${escapeHtml(note)}</div>` : ''}`;
    return div;
  }

  function formatSignedDelta(value, decimals = 0) {
    const factor = 10 ** decimals;
    let rounded = Math.round((Number(value) || 0) * factor) / factor;
    if (Object.is(rounded, -0)) rounded = 0;
    const absText = decimals > 0 ? Math.abs(rounded).toFixed(decimals) : String(Math.abs(Math.round(rounded)));
    if (rounded > 0) return `+${absText}`;
    if (rounded < 0) return `-${absText}`;
    return decimals > 0 ? (0).toFixed(decimals) : '0';
  }

  function formatCount(value) {
    return Math.round(Number(value) || 0).toLocaleString('ja-JP');
  }

  function metricDeltaCard(label, preValue, postValue, options = {}) {
    const formatter = options.formatter || ((value) => String(value));
    const delta = options.delta ?? ((Number(postValue) || 0) - (Number(preValue) || 0));
    const div = document.createElement('div');
    div.className = 'dtsb-stat-card dtsb-stat-card--delta';
    div.innerHTML = `
      <div class="dtsb-stat-card__label">${escapeHtml(label)}</div>
      <div class="dtsb-stat-card__change u-en">
        <span class="dtsb-stat-card__change-number">${escapeHtml(formatSignedDelta(delta, options.deltaDecimals || 0))}</span>
        ${options.unit ? `<span class="dtsb-stat-card__change-unit">${escapeHtml(options.unit)}</span>` : ''}
      </div>
      <div class="dtsb-stat-card__comparison u-en">${escapeHtml(formatter(preValue))} → ${escapeHtml(formatter(postValue))}</div>
      ${options.note ? `<div class="dtsb-stat-card__note">${escapeHtml(options.note)}</div>` : ''}
    `;
    return div;
  }

  function bigNumberCard(label, value, unit, note) {
    const div = document.createElement('div');
    div.className = 'dtsb-stat-card dtsb-stat-card--delta';
    div.innerHTML = `
      <div class="dtsb-stat-card__label">${escapeHtml(label)}</div>
      <div class="dtsb-stat-card__change u-en">
        <span class="dtsb-stat-card__change-number">${escapeHtml(formatCount(value))}</span>
        ${unit ? `<span class="dtsb-stat-card__change-unit">${escapeHtml(unit)}</span>` : ''}
      </div>
      ${note ? `<div class="dtsb-stat-card__note">${escapeHtml(note)}</div>` : ''}
    `;
    return div;
  }

  function setStatus(text, tone, mode = 'sim') {
    const el = document.getElementById(panelIds(mode).status);
    if (!el) return;
    el.textContent = text || '';
    el.dataset.tone = tone || 'neutral';
  }

  function setPanelMessage(html, mode) {
    const ids = panelIds(mode);
    const cards = document.getElementById(ids.cards);
    const charts = document.getElementById(ids.charts);
    if (cards) cards.innerHTML = html || '';
    if (charts) charts.style.display = 'none';
  }

  function upsertChart(canvasId, config) {
    const el = document.getElementById(canvasId);
    if (!el) return null;
    const existing = window.Chart && window.Chart.getChart ? window.Chart.getChart(el) : null;
    if (existing) existing.destroy();
    // eslint-disable-next-line no-undef
    return new Chart(el, config);
  }

  function unionKeys(a, b) {
    const out = new Set();
    Object.keys(a || {}).forEach(k => out.add(k));
    Object.keys(b || {}).forEach(k => out.add(k));
    return Array.from(out);
  }

  function renderCharts(pre, post, meta) {
    const ids = panelIds(meta?.mode);
    const cards = document.getElementById(ids.cards);
    const charts = document.getElementById(ids.charts);
    if (!cards || !charts) return;
    cards.innerHTML = '';
    charts.style.display = 'grid';

    const preName = meta?.preName || '比較前';
    const postName = meta?.postName || '比較後';
    const fmt = (n) => (typeof n === 'number' ? n : 0);
    const hasChangedPeople = Number.isFinite(Number(meta?.changedPeople));
    if (hasChangedPeople) {
      cards.appendChild(bigNumberCard('影響を受けた人数', fmt(Number(meta.changedPeople)), '人', '運航頻度変更で影響を受けた人'));
    } else {
      cards.appendChild(metricDeltaCard('比較対象人数', fmt(pre.totalPeople), fmt(post.totalPeople), {
        formatter: formatCount,
        unit: '人',
        note: `${preName} と ${postName} の比較対象`
      }));
    }
    cards.appendChild(metricDeltaCard('1人あたり平均移動時間', fmt(pre.avgTravelSec), fmt(post.avgTravelSec), {
      delta: Math.round(fmt(post.avgTravelSec)) - Math.round(fmt(pre.avgTravelSec)),
      formatter: hhmmss,
      unit: '秒',
      note: '移動時間が短いほど良好'
    }));
    cards.appendChild(metricDeltaCard('1人あたり平均効用', fmt(pre.avgUtility), fmt(post.avgUtility), {
      formatter: (value) => Number(value || 0).toFixed(2),
      deltaDecimals: 2,
      note: '行動全体の満足度指標'
    }));
    cards.appendChild(metricDeltaCard('公共交通利用者数', fmt(pre.ptUsers), fmt(post.ptUsers), {
      formatter: formatCount,
      unit: '人',
      note: '公共交通を使った人数'
    }));

    const actLabels = unionKeys(pre.actStats, post.actStats);
    const actPeoplePre = actLabels.map(k => fmt(pre.actStats?.[k]?.people));
    const actPeoplePost = actLabels.map(k => fmt(post.actStats?.[k]?.people));
    const actTimePre = actLabels.map(k => Math.round((fmt(pre.actStats?.[k]?.timeSec) / 3600) * 10) / 10);
    const actTimePost = actLabels.map(k => Math.round((fmt(post.actStats?.[k]?.timeSec) / 3600) * 10) / 10);
    const actAvgPre = actLabels.map(k => {
      const ppl = Math.max(1, fmt(pre.actStats?.[k]?.people));
      const hours = fmt(pre.actStats?.[k]?.timeSec) / 3600;
      return Math.round((hours / ppl) * 10) / 10;
    });
    const actAvgPost = actLabels.map(k => {
      const ppl = Math.max(1, fmt(post.actStats?.[k]?.people));
      const hours = fmt(post.actStats?.[k]?.timeSec) / 3600;
      return Math.round((hours / ppl) * 10) / 10;
    });

    const modeLabels = unionKeys(pre.modeStats, post.modeStats);
    const modeTimePre = modeLabels.map(k => Math.round((fmt(pre.modeStats?.[k]?.timeSec) / 3600) * 10) / 10);
    const modeTimePost = modeLabels.map(k => Math.round((fmt(post.modeStats?.[k]?.timeSec) / 3600) * 10) / 10);
    const modeAvgPre = modeLabels.map(k => {
      const ppl = Math.max(1, fmt(pre.modeStats?.[k]?.people));
      const hours = fmt(pre.modeStats?.[k]?.timeSec) / 3600;
      return Math.round((hours / ppl) * 10) / 10;
    });
    const modeAvgPost = modeLabels.map(k => {
      const ppl = Math.max(1, fmt(post.modeStats?.[k]?.people));
      const hours = fmt(post.modeStats?.[k]?.timeSec) / 3600;
      return Math.round((hours / ppl) * 10) / 10;
    });

    const commonLegend = {
      display: true,
      labels: {
        usePointStyle: true,
        pointStyle: 'rectRounded',
        boxWidth: 10,
        boxHeight: 10,
        padding: 14,
        color: '#33425c',
        font: { weight: '700' }
      }
    };
    const commonScales = {
      x: {
        grid: { display: false },
        ticks: { color: '#5f6f88', font: { weight: '600' } }
      },
      y: {
        beginAtZero: true,
        grid: { color: 'rgba(95, 111, 228, 0.12)' },
        ticks: { color: '#5f6f88', precision: 0 }
      }
    };
    const commonBar = {
      type: 'bar',
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: commonScales,
        plugins: {
          legend: commonLegend,
          tooltip: {
            backgroundColor: '#1f2d4a',
            padding: 10,
            cornerRadius: 12,
          }
        }
      }
    };
    const barDataset = (label, data, color) => ({
      label,
      data,
      backgroundColor: color,
      borderRadius: 10,
      maxBarThickness: 24,
    });

    upsertChart(ids.actPeople, {
      ...commonBar,
      data: { labels: actLabels, datasets: [
        barDataset(`${preName}: 人数`, actPeoplePre, '#4F64D9'),
        barDataset(`${postName}: 人数`, actPeoplePost, '#8E4DD8'),
      ] }
    });
    upsertChart(ids.actTime, {
      ...commonBar,
      data: { labels: actLabels, datasets: [
        barDataset(`${preName}: 活動時間 (h)`, actTimePre, '#4F64D9'),
        barDataset(`${postName}: 活動時間 (h)`, actTimePost, '#8E4DD8'),
      ] }
    });
    upsertChart(ids.actAvg, {
      ...commonBar,
      data: { labels: actLabels, datasets: [
        barDataset(`${preName}: 1人あたり平均活動時間 (h)`, actAvgPre, '#4F64D9'),
        barDataset(`${postName}: 1人あたり平均活動時間 (h)`, actAvgPost, '#8E4DD8'),
      ] }
    });
    upsertChart(ids.modeTime, {
      ...commonBar,
      data: { labels: modeLabels, datasets: [
        barDataset(`${preName}: 移動時間 (h)`, modeTimePre, '#6A52D6'),
        barDataset(`${postName}: 移動時間 (h)`, modeTimePost, '#9B63E9'),
      ] }
    });
    upsertChart(ids.modeAvg, {
      ...commonBar,
      data: { labels: modeLabels, datasets: [
        barDataset(`${preName}: 1人あたり平均時間 (h)`, modeAvgPre, '#6A52D6'),
        barDataset(`${postName}: 1人あたり平均時間 (h)`, modeAvgPost, '#9B63E9'),
      ] }
    });
    upsertChart(ids.pt, {
      type: 'bar',
      data: {
        labels: ['公共交通利用', '非利用'],
        datasets: [
          barDataset(preName, [fmt(pre.ptUsers), Math.max(0, fmt(pre.totalPeople) - fmt(pre.ptUsers))], '#4F64D9'),
          barDataset(postName, [fmt(post.ptUsers), Math.max(0, fmt(post.totalPeople) - fmt(post.ptUsers))], '#8E4DD8'),
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: commonScales,
        plugins: {
          legend: commonLegend,
          tooltip: {
            backgroundColor: '#1f2d4a',
            padding: 10,
            cornerRadius: 12,
          }
        }
      }
    });

    // PT per-route top list (merge pre/post by route id)
    const ptHost = document.getElementById(ids.ptRouteTable);
    if (ptHost) {
      const preRows = Array.isArray(pre.ptRoutesTop) ? pre.ptRoutesTop : [];
      const postRows = Array.isArray(post.ptRoutesTop) ? post.ptRoutesTop : [];
      const map = new Map();
      preRows.forEach(r => map.set(r.rid, { rid: r.rid, preUsers: r.users || 0, preTrips: r.trips || 0, postUsers: 0, postTrips: 0 }));
      postRows.forEach(r => {
        const cur = map.get(r.rid) || { rid: r.rid, preUsers: 0, preTrips: 0, postUsers: 0, postTrips: 0 };
        cur.postUsers = r.users || 0;
        cur.postTrips = r.trips || 0;
        map.set(r.rid, cur);
      });
      const rows = Array.from(map.values())
        .sort((a, b) => ((b.preUsers + b.postUsers) - (a.preUsers + a.postUsers)) || ((b.preTrips + b.postTrips) - (a.preTrips + a.postTrips)))
        .slice(0, 12);

      if (!rows.length) {
        ptHost.innerHTML = '<div class="dtsb-compare-table__empty">路線別の公共交通利用集計は利用できません。</div>';
      } else {
        const html = [
          '<table class="u-en dtsb-compare-table">',
          `<thead><tr>
            <th>公共交通路線</th>
            <th>${preName} 利用者数</th>
            <th>${postName} 利用者数</th>
            <th>${preName} 乗車回数</th>
            <th>${postName} 乗車回数</th>
          </tr></thead>`,
          '<tbody>' + rows.map(r => `<tr>
            <td>${r.rid}</td>
            <td>${r.preUsers}</td>
            <td>${r.postUsers}</td>
            <td>${r.preTrips}</td>
            <td>${r.postTrips}</td>
          </tr>`).join('') + '</tbody>',
          '</table>'
        ].join('');
        ptHost.innerHTML = html;
      }
    }
  }

  onReady(async () => {
    const host = ensurePanel();
    const preSel = document.getElementById('aggPreSelect');
    const postSel = document.getElementById('aggPostSelect');
    const simLimitSel = document.getElementById('aggPersonLimit');
    const freqLimitSel = document.getElementById('freqPersonLimit');
    const simBtn = document.getElementById('aggCompareBtn');
    const freqBtn = document.getElementById('freqCompareBtn');

    function emitCompareReady(detail) {
      try {
        window.__dtsbCompareReady = detail;
        window.dispatchEvent(new CustomEvent('dtsb:compare-ready', { detail }));
      } catch (e) {
        console.warn('Failed to emit compare-ready event', e);
      }
    }

    emitCompareReady({ ready: false, reason: 'await_compare' });

    let sims = [];
    try {
      sims = await fetchSimulations();
    } catch (e) {
      console.error(e);
      ['frequency', 'sim'].forEach((mode) => {
        setPanelMessage('<div style="color:#666;">シミュレーション一覧の読み込みに失敗しました。</div>', mode);
        setStatus('シミュレーション一覧の読み込みに失敗しました。', 'error', mode);
      });
      return;
    }

    const eligible = sims.filter(s => s.has_cache);
    if (!eligible.length) {
      ['frequency', 'sim'].forEach((mode) => {
        setPanelMessage('<div style="color:#666;">解析済みのシミュレーションがありません。</div>', mode);
        setStatus('解析済みのシミュレーションがありません。', 'error', mode);
      });
      return;
    }

    function fillSelect(sel, items) {
      if (!sel) return;
      sel.innerHTML = '';
      items.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${simulationDisplayName(s.name)} — ${s.id.slice(0, 8)}`;
        sel.appendChild(opt);
      });
    }

    fillSelect(preSel, eligible);
    fillSelect(postSel, eligible);
    if (eligible.length >= 2 && postSel) postSel.value = eligible[1].id;
    setStatus('準備完了', 'ready', 'frequency');
    if (simBtn) setStatus('準備完了', 'ready', 'sim');

    function getPersonLimit(mode) {
      const sel = mode === 'frequency' ? freqLimitSel : simLimitSel;
      const raw = (sel && sel.value) ? String(sel.value) : '';
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) return n;
      if (mode === 'frequency') {
        const fromQuery = Number(new URLSearchParams(window.location.search).get('freq_person_limit') || 0);
        if (Number.isFinite(fromQuery) && fromQuery > 0) return fromQuery;
        const fromRouteParams = Number(loadRouteParams()?.personLimit || 0);
        if (Number.isFinite(fromRouteParams) && fromRouteParams > 0) return fromRouteParams;
      }
      return null;
    }

    function setPersonLimit(mode, personLimit) {
      const sel = mode === 'frequency' ? freqLimitSel : simLimitSel;
      if (sel) sel.value = personLimit ? String(personLimit) : '';
    }

    // Restore cached results (no recompute) so navigating between results.html
    // and results_graph.html doesn't "lose" the last computed graphs.
    (function restoreCachedView() {
      const cached = getCachedCompare();
      if (!cached || !cached.data?.pre || !cached.data?.post) return;

      const personLimit = cached.personLimit || null;

      if (cached.mode === 'frequency') {
        const params = loadRouteParams();
        const sigNow = routeSignature(params, personLimit);
        if (!cached.simId || !eligible.some(s => s.id === cached.simId)) return;
        if (!cached.sig || cached.sig !== sigNow) return;

        setPersonLimit('frequency', personLimit);

        const name = simulationDisplayName(eligible.find(s => s.id === cached.simId)?.name);
        renderCharts(cached.data.pre, cached.data.post, {
          mode: 'frequency',
          preName: `${name}（変更前）`,
          postName: `${name}（変更後）`,
          changedPeople: Number(cached.data.changedPeople || 0),
        });
        setStatus(`キャッシュを表示中（使用人数: ${cached.data.pre?.totalPeople ?? 0}人, 変更対象: ${cached.data.changedPeople ?? 0}人）`, 'neutral', 'frequency');
        return;
      }

      if (cached.mode === 'sim') {
        if (!preSel || !postSel) return;
        if (!cached.preId || !cached.postId) return;
        if (!eligible.some(s => s.id === cached.preId) || !eligible.some(s => s.id === cached.postId)) return;

        setPersonLimit('sim', personLimit);
        preSel.value = cached.preId;
        postSel.value = cached.postId;

        const preName = simulationDisplayName(eligible.find(s => s.id === cached.preId)?.name) || '比較前';
        const postName = simulationDisplayName(eligible.find(s => s.id === cached.postId)?.name) || '比較後';
        renderCharts(cached.data.pre, cached.data.post, { mode: 'sim', preName, postName });
        setStatus(`キャッシュを表示中（使用人数: ${cached.data.pre?.totalPeople ?? 0}人）`, 'neutral', 'sim');
      }
    })();

    async function run(mode = 'frequency') {
      const preId = preSel?.value || eligible[0]?.id || '';
      const postId = postSel?.value || eligible[1]?.id || preId;
      const preName = simulationDisplayName(eligible.find(s => s.id === preId)?.name) || '比較前';
      const postName = simulationDisplayName(eligible.find(s => s.id === postId)?.name) || '比較後';
      const personLimit = getPersonLimit(mode);
      if (mode === 'sim' && (!preSel || !postSel)) {
        setStatus('集計比較はこの画面では利用できません。', 'error', mode);
        return;
      }
      setStatus('集計中…', 'loading', mode);
      emitCompareReady({ ready: false, reason: 'computing', mode });
      emitWindowEvent('dtsb:agg-compare-started', { mode, personLimit });
      try {
        if (mode === 'frequency') {
          const params = loadRouteParams();
          if (!params || params.oldFrequency == null || params.newFrequency == null) {
            throw new Error('routeParams が見つかりません。先に index.html で運航頻度を保存してください。');
          }
          const resolved = resolveFrequencySimulationId(params, eligible, preId);
          if (!resolved.simId) {
            throw new Error('運航頻度比較に必要なシミュレーションIDが routeParams にありません。');
          }
          if (!resolved.isEligible) {
            throw new Error(`対応するシミュレーションが利用できないか未解析です: ${resolved.simId}`);
          }
          const freqSimId = resolved.simId;
          // Avoid recomputing when navigating between results.html and results_graph.html
          // by using a localStorage cache keyed on simulation + routeParams.
          const sig = routeSignature(params, personLimit);
          const cached = getCachedCompare();
          if (cached && cached.mode === 'frequency' && cached.simId === freqSimId && cached.sig === sig && cached.personLimit === personLimit && cached.data?.pre && cached.data?.post) {
            const name = simulationDisplayName(eligible.find(s => s.id === freqSimId)?.name);
            renderCharts(cached.data.pre, cached.data.post, {
              mode: 'frequency',
              preName: `${name}（変更前）`,
              postName: `${name}（変更後）`,
              changedPeople: Number(cached.data.changedPeople || 0),
            });
            setStatus(`キャッシュを表示中（使用人数: ${cached.data.pre?.totalPeople ?? 0}人, 変更対象: ${cached.data.changedPeople ?? 0}人）`, 'neutral', 'frequency');
            emitCompareReady({
              ready: true,
              source: 'cache',
              mode: 'frequency',
              simId: freqSimId,
              params: {
                routeId: params.routeId,
                oldFrequency: Number(params.oldFrequency),
                newFrequency: Number(params.newFrequency),
                personLimit,
              },
            });
            emitWindowEvent('dtsb:agg-compare-completed', {
              ready: true,
              source: 'cache',
              mode: 'frequency',
              simId: freqSimId,
              params: {
                routeId: params.routeId,
                oldFrequency: Number(params.oldFrequency),
                newFrequency: Number(params.newFrequency),
                personLimit,
              },
            });
            return;
          }
          const resp = await fetchFrequencyCompare(freqSimId, {
            routeId: params.routeId,
            oldFrequency: params.oldFrequency,
            newFrequency: params.newFrequency,
          }, personLimit);
          const name = simulationDisplayName(eligible.find(s => s.id === freqSimId)?.name);
          renderCharts(resp.pre, resp.post, {
            mode: 'frequency',
            preName: `${name}（変更前）`,
            postName: `${name}（変更後）`,
            changedPeople: Number(resp.changedPeople || 0),
          });
          setStatus(`比較完了（使用人数: ${resp.pre?.totalPeople ?? 0}人, 変更対象: ${resp.changedPeople ?? 0}人）`, 'success', 'frequency');
          setCachedCompare({ mode: 'frequency', simId: freqSimId, sig, personLimit, data: resp, savedAt: Date.now() });
          emitCompareReady({
            ready: true,
            source: 'fresh',
            mode: 'frequency',
            simId: freqSimId,
            params: {
              routeId: params.routeId,
              oldFrequency: Number(params.oldFrequency),
              newFrequency: Number(params.newFrequency),
              personLimit,
            },
          });
          emitWindowEvent('dtsb:agg-compare-completed', {
            ready: true,
            source: 'fresh',
            mode: 'frequency',
            simId: freqSimId,
            params: {
              routeId: params.routeId,
              oldFrequency: Number(params.oldFrequency),
              newFrequency: Number(params.newFrequency),
              personLimit,
            },
          });
          return;
        }

        // Sim-vs-sim compare cache to avoid duplicate fetch when moving between pages.
        const cached = getCachedCompare();
        if (cached && cached.mode === 'sim' && cached.preId === preId && cached.postId === postId && cached.personLimit === personLimit && cached.data?.pre && cached.data?.post) {
          renderCharts(cached.data.pre, cached.data.post, { mode: 'sim', preName, postName });
          setStatus(`キャッシュを表示中（使用人数: ${cached.data.pre?.totalPeople ?? 0}人）`, 'neutral', 'sim');
          emitCompareReady({
            ready: true,
            source: 'cache',
            mode: 'sim',
            preId,
            postId,
            personLimit,
          });
          emitWindowEvent('dtsb:agg-compare-completed', {
            ready: true,
            source: 'cache',
            mode: 'sim',
            preId,
            postId,
            personLimit,
          });
          return;
        }
        const cmp = await fetchCompare(preId, postId, personLimit);
        renderCharts(cmp.pre, cmp.post, { mode: 'sim', preName, postName });
        setStatus(`比較完了（使用人数: ${cmp.pre?.totalPeople ?? 0}人）`, 'success', 'sim');
        setCachedCompare({ mode: 'sim', preId, postId, personLimit, data: cmp, savedAt: Date.now() });
        emitCompareReady({
          ready: true,
          source: 'fresh',
          mode: 'sim',
          preId,
          postId,
          personLimit,
        });
        emitWindowEvent('dtsb:agg-compare-completed', {
          ready: true,
          source: 'fresh',
          mode: 'sim',
          preId,
          postId,
          personLimit,
        });
      } catch (e) {
        console.error(e);
        setStatus(e?.message || '失敗しました', 'error', mode);
        emitCompareReady({ ready: false, reason: 'failed', error: e?.message || '失敗しました' });
        emitWindowEvent('dtsb:agg-compare-failed', {
          mode,
          personLimit,
          error: e?.message || '失敗しました',
        });
      }
    }

    freqBtn?.addEventListener('click', () => run('frequency'));
    simBtn?.addEventListener('click', () => run('sim'));
    window.__dtsbAggCompare = {
      run,
      runFrequency: () => run('frequency'),
      runSim: () => run('sim'),
    };
    if (host?.dataset?.aggPanelMode === 'frequency-result') {
      run('frequency');
    }
    // Full/input modes do not auto-run; result-only mode runs once so the
    // results page can render the frequency-change output directly.
  });
})();
