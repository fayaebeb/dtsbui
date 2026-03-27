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

  function ensurePanel() {
    let host = document.getElementById('aggPanel');
    if (host) return host;

    host = document.createElement('section');
    host.id = 'aggPanel';
    host.className = 'dtsb-fun-panel dtsb-fun-panel--agg dtsb-compare-panel';
    host.style.marginTop = '16px';
    host.style.minWidth = '0';

    host.innerHTML = `
    <div class="c-box dtsb-compare-shell">
      <details id="aggDetails" class="c-details dtsb-compare-details" open>
        <summary class="c-details__summary">集計比較</summary>
        <div class="dtsb-compare-panel__body">
          <p class="dtsb-compare-panel__intro">運航頻度を変えた前後差、または2つの解析結果を同じ指標セットで比較できます。</p>

          <div class="dtsb-compare-mode" role="radiogroup" aria-label="集計比較モード">
            <label class="dtsb-compare-mode__option">
              <input type="radio" name="aggMode" value="frequency" checked>
              <span>運航頻度変更前後</span>
            </label>
            <label class="dtsb-compare-mode__option">
              <input type="radio" name="aggMode" value="sim">
              <span>シミュレーション2本を比較</span>
            </label>
          </div>

          <div class="dtsb-compare-controls dtsb-compare-controls--compact">
            <div id="aggSimPairWrap" class="dtsb-compare-field dtsb-compare-field--compact dtsb-compare-field--pair-equal">
              <label id="aggPreWrap" class="dtsb-compare-subfield">
                <span class="dtsb-compare-field__label dtsb-compare-field__label--compact">比較前</span>
                <select id="aggPreSelect" class="dtsb-compare-field__input dtsb-compare-field__input--compact"></select>
              </label>
              <label id="aggPostWrap" class="dtsb-compare-subfield">
                <span class="dtsb-compare-field__label dtsb-compare-field__label--compact">比較後</span>
                <select id="aggPostSelect" class="dtsb-compare-field__input dtsb-compare-field__input--compact"></select>
              </label>
            </div>
            <label class="dtsb-compare-field dtsb-compare-field--compact">
              <span class="dtsb-compare-field__label dtsb-compare-field__label--compact">対象人数</span>
              <select id="aggPersonLimit" class="dtsb-compare-field__input dtsb-compare-field__input--compact">
                <option value="">全員</option>
                <option value="1000">1000</option>
              </select>
            </label>
          </div>

          <div class="dtsb-compare-actions dtsb-compare-actions--compact">
            <button id="aggCompareBtn" type="button" class="btn dtsb-compare-btn">比較する</button>
            <span id="aggStatus" class="dtsb-compare-status" data-tone="neutral"></span>
          </div>

          <div id="aggCards" class="dtsb-compare-cards"></div>

          <div id="aggCharts" class="dtsb-chart-grid" style="display:none;">
            <section class="dtsb-chart-card">
              <div class="dtsb-chart-card__head">
                <span class="dtsb-chart-card__eyebrow">Activity</span>
                <h3 class="dtsb-chart-card__title">活動ごとの人数</h3>
              </div>
              <div class="dtsb-chart-card__body c-chart"><canvas id="chartActPeople"></canvas></div>
            </section>
            <section class="dtsb-chart-card">
              <div class="dtsb-chart-card__head">
                <span class="dtsb-chart-card__eyebrow">Activity</span>
                <h3 class="dtsb-chart-card__title">活動ごとの合計時間</h3>
              </div>
              <div class="dtsb-chart-card__body c-chart"><canvas id="chartActTime"></canvas></div>
            </section>
            <section class="dtsb-chart-card">
              <div class="dtsb-chart-card__head">
                <span class="dtsb-chart-card__eyebrow">Activity</span>
                <h3 class="dtsb-chart-card__title">1人あたり活動時間</h3>
              </div>
              <div class="dtsb-chart-card__body c-chart"><canvas id="chartActAvg"></canvas></div>
            </section>
            <section class="dtsb-chart-card">
              <div class="dtsb-chart-card__head">
                <span class="dtsb-chart-card__eyebrow">Mode</span>
                <h3 class="dtsb-chart-card__title">交通手段ごとの移動時間</h3>
              </div>
              <div class="dtsb-chart-card__body c-chart"><canvas id="chartModeTime"></canvas></div>
            </section>
            <section class="dtsb-chart-card">
              <div class="dtsb-chart-card__head">
                <span class="dtsb-chart-card__eyebrow">Mode</span>
                <h3 class="dtsb-chart-card__title">1人あたり移動時間</h3>
              </div>
              <div class="dtsb-chart-card__body c-chart"><canvas id="chartModeAvg"></canvas></div>
            </section>
            <section class="dtsb-chart-card">
              <div class="dtsb-chart-card__head">
                <span class="dtsb-chart-card__eyebrow">Transit</span>
                <h3 class="dtsb-chart-card__title">公共交通利用の内訳</h3>
              </div>
              <div class="dtsb-chart-card__body c-chart"><canvas id="chartPt"></canvas></div>
            </section>
            <section class="dtsb-chart-card dtsb-chart-card--table">
              <div class="dtsb-chart-card__head">
                <span class="dtsb-chart-card__eyebrow">Transit</span>
                <h3 class="dtsb-chart-card__title">路線別利用比較</h3>
              </div>
              <div class="dtsb-chart-card__body" id="ptRouteTable"></div>
            </section>
          </div>
        </div>
      </details>
    </div>
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

    const details = host.querySelector('#aggDetails');
    const KEY = 'aggDetailsOpen';

    const saved = localStorage.getItem(KEY);
    if (saved != null) details.open = saved === '1';
    details.addEventListener('toggle', () => localStorage.setItem(KEY, details.open ? '1' : '0'));

    return host;
  }

  function card(label, value, note) {
    const div = document.createElement('div');
    div.className = 'dtsb-stat-card';
    div.innerHTML = `<div class="dtsb-stat-card__label">${label}</div><div class="dtsb-stat-card__value u-en">${value}</div>${note ? `<div class="dtsb-stat-card__note">${note}</div>` : ''}`;
    return div;
  }

  function setStatus(text, tone) {
    const el = document.getElementById('aggStatus');
    if (!el) return;
    el.textContent = text || '';
    el.dataset.tone = tone || 'neutral';
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
    const cards = document.getElementById('aggCards');
    const charts = document.getElementById('aggCharts');
    cards.innerHTML = '';
    if (charts) charts.style.display = 'grid';

    const preName = meta?.preName || '比較前';
    const postName = meta?.postName || '比較後';
    const fmt = (n) => (typeof n === 'number' ? n : 0);
    const hasChangedPeople = Number.isFinite(Number(meta?.changedPeople));
    if (hasChangedPeople) {
      cards.appendChild(card('影響を受けた人数', `${fmt(Number(meta.changedPeople))}`, '運航頻度変更で影響を受けた人'));
    } else {
      cards.appendChild(card('比較対象人数', `${fmt(pre.totalPeople)} → ${fmt(post.totalPeople)}`, `${preName} と ${postName} の比較対象`));
    }
    cards.appendChild(card('1人あたり平均移動時間', `${hhmmss(fmt(pre.avgTravelSec))} → ${hhmmss(fmt(post.avgTravelSec))}`, '移動時間が短いほど良好'));
    cards.appendChild(card('1人あたり平均効用', `${fmt(pre.avgUtility).toFixed(2)} → ${fmt(post.avgUtility).toFixed(2)}`, '行動全体の満足度指標'));
    cards.appendChild(card('公共交通利用者数', `${fmt(pre.ptUsers)} → ${fmt(post.ptUsers)}`, '公共交通を使った人数'));

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

    upsertChart('chartActPeople', {
      ...commonBar,
      data: { labels: actLabels, datasets: [
        barDataset(`${preName}: 人数`, actPeoplePre, '#4F64D9'),
        barDataset(`${postName}: 人数`, actPeoplePost, '#8E4DD8'),
      ] }
    });
    upsertChart('chartActTime', {
      ...commonBar,
      data: { labels: actLabels, datasets: [
        barDataset(`${preName}: 活動時間 (h)`, actTimePre, '#4F64D9'),
        barDataset(`${postName}: 活動時間 (h)`, actTimePost, '#8E4DD8'),
      ] }
    });
    upsertChart('chartActAvg', {
      ...commonBar,
      data: { labels: actLabels, datasets: [
        barDataset(`${preName}: 1人あたり平均活動時間 (h)`, actAvgPre, '#4F64D9'),
        barDataset(`${postName}: 1人あたり平均活動時間 (h)`, actAvgPost, '#8E4DD8'),
      ] }
    });
    upsertChart('chartModeTime', {
      ...commonBar,
      data: { labels: modeLabels, datasets: [
        barDataset(`${preName}: 移動時間 (h)`, modeTimePre, '#6A52D6'),
        barDataset(`${postName}: 移動時間 (h)`, modeTimePost, '#9B63E9'),
      ] }
    });
    upsertChart('chartModeAvg', {
      ...commonBar,
      data: { labels: modeLabels, datasets: [
        barDataset(`${preName}: 1人あたり平均時間 (h)`, modeAvgPre, '#6A52D6'),
        barDataset(`${postName}: 1人あたり平均時間 (h)`, modeAvgPost, '#9B63E9'),
      ] }
    });
    upsertChart('chartPt', {
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
    const ptHost = document.getElementById('ptRouteTable');
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
    const charts = document.getElementById('aggCharts');
    const simPairWrap = document.getElementById('aggSimPairWrap');
    const preWrap = document.getElementById('aggPreWrap');
    const postWrap = document.getElementById('aggPostWrap');
    const preSel = document.getElementById('aggPreSelect');
    const postSel = document.getElementById('aggPostSelect');
    const limitSel = document.getElementById('aggPersonLimit');
    const btn = document.getElementById('aggCompareBtn');
    const modeEls = Array.from(document.querySelectorAll('input[name="aggMode"]'));

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
      if (charts) charts.style.display = 'none';
      host.querySelector('#aggCards').innerHTML = '<div style="color:#666;">シミュレーション一覧の読み込みに失敗しました。</div>';
      setStatus('シミュレーション一覧の読み込みに失敗しました。', 'error');
      return;
    }

    const eligible = sims.filter(s => s.has_cache);
    if (!eligible.length) {
      if (charts) charts.style.display = 'none';
      host.querySelector('#aggCards').innerHTML = '<div style="color:#666;">解析済みのシミュレーションがありません。</div>';
      setStatus('解析済みのシミュレーションがありません。', 'error');
      return;
    }

    function fillSelect(sel, items) {
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
    if (eligible.length >= 2) postSel.value = eligible[1].id;
    setStatus('準備完了', 'ready');

    function getMode() {
      const picked = modeEls.find((r) => r.checked);
      return picked ? picked.value : 'frequency';
    }

    function setControlsForMode(mode) {
      if (mode === 'frequency') {
        // Frequency compare uses one selected simulation internally; hide sim-vs-sim controls.
        if (simPairWrap) simPairWrap.style.display = 'none';
        if (preSel) preSel.disabled = true;
        postSel.disabled = true;
      } else {
        if (simPairWrap) simPairWrap.style.display = 'grid';
        if (preSel) preSel.disabled = false;
        postSel.disabled = false;
      }
    }

    function setMode(mode) {
      modeEls.forEach((r) => { r.checked = (r.value === mode); });
      setControlsForMode(mode);
    }

    // Apply initial mode UI and keep controls in sync when radio selection changes.
    setControlsForMode(getMode());
    modeEls.forEach((r) => r.addEventListener('change', () => setControlsForMode(getMode())));

    // Restore cached results (no recompute) so navigating between results.html
    // and results_graph.html doesn't "lose" the last computed graphs.
    (function restoreCachedView() {
      const cached = getCachedCompare();
      if (!cached || !cached.data?.pre || !cached.data?.post) return;

      const personLimit = cached.personLimit || null;
      if (limitSel) limitSel.value = personLimit ? String(personLimit) : '';

      if (cached.mode === 'frequency') {
        const params = loadRouteParams();
        const sigNow = routeSignature(params, personLimit);
        if (!cached.simId || !eligible.some(s => s.id === cached.simId)) return;
        if (!cached.sig || cached.sig !== sigNow) return;

        setMode('frequency');
        preSel.value = cached.simId;

        const name = simulationDisplayName(eligible.find(s => s.id === cached.simId)?.name);
        renderCharts(cached.data.pre, cached.data.post, {
          preName: `${name}（変更前）`,
          postName: `${name}（変更後）`,
          changedPeople: Number(cached.data.changedPeople || 0),
        });
        setStatus(`キャッシュを表示中（使用人数: ${cached.data.pre?.totalPeople ?? 0}人, 変更対象: ${cached.data.changedPeople ?? 0}人）`, 'neutral');
        return;
      }

      if (cached.mode === 'sim') {
        if (!cached.preId || !cached.postId) return;
        if (!eligible.some(s => s.id === cached.preId) || !eligible.some(s => s.id === cached.postId)) return;

        setMode('sim');
        preSel.value = cached.preId;
        postSel.value = cached.postId;

        const preName = simulationDisplayName(eligible.find(s => s.id === cached.preId)?.name) || '比較前';
        const postName = simulationDisplayName(eligible.find(s => s.id === cached.postId)?.name) || '比較後';
        renderCharts(cached.data.pre, cached.data.post, { preName, postName });
        setStatus(`キャッシュを表示中（使用人数: ${cached.data.pre?.totalPeople ?? 0}人）`, 'neutral');
      }
    })();

    async function run() {
      const preId = preSel.value;
      const postId = postSel.value;
      const preName = simulationDisplayName(eligible.find(s => s.id === preId)?.name) || '比較前';
      const postName = simulationDisplayName(eligible.find(s => s.id === postId)?.name) || '比較後';
      const mode = getMode();
      const personLimit = (() => {
        const raw = (limitSel && limitSel.value) ? String(limitSel.value) : '';
        const n = parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 ? n : null;
      })();
      setStatus('集計中…', 'loading');
      emitCompareReady({ ready: false, reason: 'computing', mode });
      emitWindowEvent('dtsb:agg-compare-started', { mode, personLimit });
      try {
        setControlsForMode(mode);
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
          preSel.value = freqSimId;
          // Avoid recomputing when navigating between results.html and results_graph.html
          // by using a localStorage cache keyed on simulation + routeParams.
          const sig = routeSignature(params, personLimit);
          const cached = getCachedCompare();
          if (cached && cached.mode === 'frequency' && cached.simId === freqSimId && cached.sig === sig && cached.personLimit === personLimit && cached.data?.pre && cached.data?.post) {
            const name = simulationDisplayName(eligible.find(s => s.id === freqSimId)?.name);
            renderCharts(cached.data.pre, cached.data.post, {
              preName: `${name}（変更前）`,
              postName: `${name}（変更後）`,
              changedPeople: Number(cached.data.changedPeople || 0),
            });
            setStatus(`キャッシュを表示中（使用人数: ${cached.data.pre?.totalPeople ?? 0}人, 変更対象: ${cached.data.changedPeople ?? 0}人）`, 'neutral');
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
            preName: `${name}（変更前）`,
            postName: `${name}（変更後）`,
            changedPeople: Number(resp.changedPeople || 0),
          });
          setStatus(`比較完了（使用人数: ${resp.pre?.totalPeople ?? 0}人, 変更対象: ${resp.changedPeople ?? 0}人）`, 'success');
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
          renderCharts(cached.data.pre, cached.data.post, { preName, postName });
          setStatus(`キャッシュを表示中（使用人数: ${cached.data.pre?.totalPeople ?? 0}人）`, 'neutral');
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
        renderCharts(cmp.pre, cmp.post, { preName, postName });
        setStatus(`比較完了（使用人数: ${cmp.pre?.totalPeople ?? 0}人）`, 'success');
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
        setStatus(e?.message || '失敗しました', 'error');
        emitCompareReady({ ready: false, reason: 'failed', error: e?.message || '失敗しました' });
        emitWindowEvent('dtsb:agg-compare-failed', {
          mode,
          personLimit,
          error: e?.message || '失敗しました',
        });
      }
    }

    btn.addEventListener('click', run);
    window.__dtsbAggCompare = { run };
    // Do not auto-run on page load or selection changes; let the user decide
    // when to compute since this can be expensive for large datasets.
  });
})();
