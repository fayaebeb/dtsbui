// Aggregations and charts for simulations (computed on backend from full dataset)
(function () {
  function onReady(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  const CACHE_KEY = 'dtsb.aggCompareCache.v2';
  const ROUTE_SOURCE_TO_SIM_ID = {
    'bus_route/baseline_transitSchedule_cr24_1.xml': '096896b54be24ffbb0cbee53dde6fd9f',
    'bus_route/brt_transitSchedule_brt24_2.xml': '67eb5392da3a4202906f46f7b808b888',
    'bus_route/net_expansion_transitSchedule_cr40_3.xml': '18c774153bad4ee0aae34a8dcbb7f03b',
    'bus_route/output_transitSchedule_brt40_4.xml': '10862aa9ea9d4fd18c1b91b980b66439'
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
    host.style.marginTop = '16px';
    host.style.minWidth = '0';

    host.innerHTML = `
    <div class="c-box">
      <details id="aggDetails" class="c-details" open>
        <summary class="c-details__summary">集計比較</summary>

        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin:8px 0;">
          <label style="display:flex; gap:6px; align-items:center;">
            <input type="radio" name="aggMode" value="frequency" checked>
            <span class="muted">運航頻度変更前後</span>
          </label>
          <label style="display:flex; gap:6px; align-items:center;">
            <input type="radio" name="aggMode" value="sim">
            <span class="muted">シミュレーション2本を比較</span>
          </label>
        </div>

        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:8px 0;">
          <label id="aggPreWrap" style="display:flex; gap:6px; align-items:center; min-width:0; flex:1 1 260px;">
            <span class="muted">比較前</span>
            <select id="aggPreSelect" class="c-input" style="min-width:0; width:100%;"></select>
          </label>
          <label id="aggPostWrap" style="display:flex; gap:6px; align-items:center; min-width:0; flex:1 1 260px;">
            <span class="muted">比較後</span>
            <select id="aggPostSelect" class="c-input" style="min-width:0; width:100%;"></select>
          </label>
          <label style="display:flex; gap:6px; align-items:center; min-width:0; flex:0 1 160px;">
            <span class="muted">対象人数</span>
            <select id="aggPersonLimit" class="c-input" style="min-width:0; width:100%;">
              <option value="">全員</option>
              <option value="1000">1000</option>
            </select>
          </label>
          <button id="aggCompareBtn" type="button" class="btn">比較する</button>
          <span id="aggStatus" class="muted" style="min-width:0; flex:1 1 180px;"></span>
        </div>

        <div id="aggCards"
             style="display:flex; gap:12px; flex-wrap:wrap; margin:8px 0;"></div>

        <div id="aggCharts" style="display:none; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:16px; min-width:0;">
          <div class="c-chart" style="--chartAspect:auto; height:220px;"><canvas id="chartActPeople"></canvas></div>
          <div class="c-chart" style="--chartAspect:auto; height:220px;"><canvas id="chartActTime"></canvas></div>
          <div class="c-chart" style="--chartAspect:auto; height:220px;"><canvas id="chartActAvg"></canvas></div>
          <div class="c-chart" style="--chartAspect:auto; height:220px;"><canvas id="chartModeTime"></canvas></div>
          <div class="c-chart" style="--chartAspect:auto; height:220px;"><canvas id="chartModeAvg"></canvas></div>
          <div class="c-chart" style="--chartAspect:auto; height:220px;"><canvas id="chartPt"></canvas></div>
          <div id="ptRouteTable" style="max-height:240px; overflow:auto; border:1px solid #eee; border-radius:6px;"></div>
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
        scrollBox.style.scrollbarGutter = 'stable both-edges';
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

  function card(label, value) {
    const div = document.createElement('div');
    div.style.cssText =
      'min-width:180px; padding:10px 12px; background:#fff; border:1px solid #e5e7f3; border-radius:8px; box-shadow:0 1px 2px rgba(0,0,0,0.04);';
    div.innerHTML = `<div style="font-size:12px; color:#666;">${label}</div><div class="u-en" style="font-size:18px; font-weight:700;">${value}</div>`;
    return div;
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
      cards.appendChild(card('影響を受けた人数', `${fmt(Number(meta.changedPeople))}`));
    } else {
      cards.appendChild(card('人数', `${fmt(pre.totalPeople)} → ${fmt(post.totalPeople)}`));
    }
    cards.appendChild(card('1人あたり平均移動時間', `${hhmmss(fmt(pre.avgTravelSec))} → ${hhmmss(fmt(post.avgTravelSec))}`));
    cards.appendChild(card('1人あたり平均効用', `${fmt(pre.avgUtility).toFixed(2)} → ${fmt(post.avgUtility).toFixed(2)}`));
    cards.appendChild(card('公共交通利用者数', `${fmt(pre.ptUsers)} → ${fmt(post.ptUsers)}`));

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

    const commonBar = {
      type: 'bar',
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true } }
      }
    };

    upsertChart('chartActPeople', {
      ...commonBar,
      data: { labels: actLabels, datasets: [
        { label: `${preName}: 人数`, data: actPeoplePre, backgroundColor: '#31599E' },
        { label: `${postName}: 人数`, data: actPeoplePost, backgroundColor: '#F5813C' },
      ] }
    });
    upsertChart('chartActTime', {
      ...commonBar,
      data: { labels: actLabels, datasets: [
        { label: `${preName}: 活動時間 (h)`, data: actTimePre, backgroundColor: '#31599E' },
        { label: `${postName}: 活動時間 (h)`, data: actTimePost, backgroundColor: '#F5813C' },
      ] }
    });
    upsertChart('chartActAvg', {
      ...commonBar,
      data: { labels: actLabels, datasets: [
        { label: `${preName}: 1人あたり平均活動時間 (h)`, data: actAvgPre, backgroundColor: '#31599E' },
        { label: `${postName}: 1人あたり平均活動時間 (h)`, data: actAvgPost, backgroundColor: '#F5813C' },
      ] }
    });
    upsertChart('chartModeTime', {
      ...commonBar,
      data: { labels: modeLabels, datasets: [
        { label: `${preName}: 移動時間 (h)`, data: modeTimePre, backgroundColor: '#8E44AD' },
        { label: `${postName}: 移動時間 (h)`, data: modeTimePost, backgroundColor: '#27ae60' },
      ] }
    });
    upsertChart('chartModeAvg', {
      ...commonBar,
      data: { labels: modeLabels, datasets: [
        { label: `${preName}: 1人あたり平均時間 (h)`, data: modeAvgPre, backgroundColor: '#8E44AD' },
        { label: `${postName}: 1人あたり平均時間 (h)`, data: modeAvgPost, backgroundColor: '#27ae60' },
      ] }
    });
    upsertChart('chartPt', {
      type: 'bar',
      data: {
        labels: ['公共交通利用', '非利用'],
        datasets: [
          { label: preName, data: [fmt(pre.ptUsers), Math.max(0, fmt(pre.totalPeople) - fmt(pre.ptUsers))], backgroundColor: '#31599E' },
          { label: postName, data: [fmt(post.ptUsers), Math.max(0, fmt(post.totalPeople) - fmt(post.ptUsers))], backgroundColor: '#F5813C' },
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true } }
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
        ptHost.innerHTML = '<div style="color:#666; padding:8px;">路線別の公共交通利用集計は利用できません。</div>';
      } else {
        const html = [
          '<table class="u-en" style="width:100%; border-collapse:collapse; font-size:12px;">',
          `<thead><tr>
            <th style="text-align:left; padding:6px; border-bottom:1px solid #eee;">公共交通路線</th>
            <th style="text-align:right; padding:6px; border-bottom:1px solid #eee;">${preName} 利用者数</th>
            <th style="text-align:right; padding:6px; border-bottom:1px solid #eee;">${postName} 利用者数</th>
            <th style="text-align:right; padding:6px; border-bottom:1px solid #eee;">${preName} 乗車回数</th>
            <th style="text-align:right; padding:6px; border-bottom:1px solid #eee;">${postName} 乗車回数</th>
          </tr></thead>`,
          '<tbody>' + rows.map(r => `<tr>
            <td style="padding:6px; border-bottom:1px solid #f5f5f5;">${r.rid}</td>
            <td style="padding:6px; text-align:right; border-bottom:1px solid #f5f5f5;">${r.preUsers}</td>
            <td style="padding:6px; text-align:right; border-bottom:1px solid #f5f5f5;">${r.postUsers}</td>
            <td style="padding:6px; text-align:right; border-bottom:1px solid #f5f5f5;">${r.preTrips}</td>
            <td style="padding:6px; text-align:right; border-bottom:1px solid #f5f5f5;">${r.postTrips}</td>
          </tr>`).join('') + '</tbody>',
          '</table>'
        ].join('');
        ptHost.innerHTML = html;
      }
    }
  }

  onReady(async () => {
    const host = ensurePanel();
    const status = document.getElementById('aggStatus');
    const charts = document.getElementById('aggCharts');
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
      return;
    }

    const eligible = sims.filter(s => s.has_cache);
    if (!eligible.length) {
      if (charts) charts.style.display = 'none';
      host.querySelector('#aggCards').innerHTML = '<div style="color:#666;">解析済みのシミュレーションがありません。</div>';
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
    if (status) status.textContent = '準備完了';

    function getMode() {
      const picked = modeEls.find((r) => r.checked);
      return picked ? picked.value : 'frequency';
    }

    function setControlsForMode(mode) {
      if (mode === 'frequency') {
        // Frequency compare uses one selected simulation internally; hide sim-vs-sim controls.
        if (preWrap) preWrap.style.display = 'none';
        if (postWrap) postWrap.style.display = 'none';
        if (preSel) preSel.disabled = true;
        postSel.disabled = true;
      } else {
        if (preWrap) preWrap.style.display = 'flex';
        if (postWrap) postWrap.style.display = 'flex';
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
        if (status) status.textContent = `キャッシュを表示中（使用人数: ${cached.data.pre?.totalPeople ?? 0}人, 変更対象: ${cached.data.changedPeople ?? 0}人）`;
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
        if (status) status.textContent = `キャッシュを表示中（使用人数: ${cached.data.pre?.totalPeople ?? 0}人）`;
      }
    })();

    async function run() {
      const preId = preSel.value;
      const postId = postSel.value;
      const preName = simulationDisplayName(eligible.find(s => s.id === preId)?.name) || '比較前';
      const postName = simulationDisplayName(eligible.find(s => s.id === postId)?.name) || '比較後';
      const personLimit = (() => {
        const raw = (limitSel && limitSel.value) ? String(limitSel.value) : '';
        const n = parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 ? n : null;
      })();
      if (status) status.textContent = '集計中…';
      emitCompareReady({ ready: false, reason: 'computing' });
      try {
        const mode = getMode();
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
            if (status) status.textContent = `キャッシュを表示中（使用人数: ${cached.data.pre?.totalPeople ?? 0}人, 変更対象: ${cached.data.changedPeople ?? 0}人）`;
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
          if (status) status.textContent = `比較完了（使用人数: ${resp.pre?.totalPeople ?? 0}人, 変更対象: ${resp.changedPeople ?? 0}人）`;
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
          return;
        }

        // Sim-vs-sim compare cache to avoid duplicate fetch when moving between pages.
        const cached = getCachedCompare();
        if (cached && cached.mode === 'sim' && cached.preId === preId && cached.postId === postId && cached.personLimit === personLimit && cached.data?.pre && cached.data?.post) {
          renderCharts(cached.data.pre, cached.data.post, { preName, postName });
          if (status) status.textContent = `キャッシュを表示中（使用人数: ${cached.data.pre?.totalPeople ?? 0}人）`;
          emitCompareReady({
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
        if (status) status.textContent = `比較完了（使用人数: ${cmp.pre?.totalPeople ?? 0}人）`;
        setCachedCompare({ mode: 'sim', preId, postId, personLimit, data: cmp, savedAt: Date.now() });
        emitCompareReady({
          ready: true,
          source: 'fresh',
          mode: 'sim',
          preId,
          postId,
          personLimit,
        });
      } catch (e) {
        console.error(e);
        if (status) status.textContent = e?.message || '失敗しました';
        emitCompareReady({ ready: false, reason: 'failed', error: e?.message || '失敗しました' });
      }
    }

    btn.addEventListener('click', run);
    // Do not auto-run on page load or selection changes; let the user decide
    // when to compute since this can be expensive for large datasets.
  });
})();
