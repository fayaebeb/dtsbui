// Aggregations and charts for simulations (computed on backend from full dataset)
(function () {
  function onReady(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  const CACHE_KEY = 'dtsb.aggCompareCache.v2';

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
    if (!res.ok) throw new Error(data?.error || 'compare failed');
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
    if (!res.ok) throw new Error(data?.error || 'frequency compare failed');
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
        <summary class="c-details__summary">Aggregations (all persons, backend)</summary>

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
          <label class="muted">Pre</label>
          <select id="aggPreSelect" class="c-input" style="min-width:260px;"></select>
          <label class="muted">Post</label>
          <select id="aggPostSelect" class="c-input" style="min-width:260px;"></select>
          <label class="muted">Persons</label>
          <select id="aggPersonLimit" class="c-input" style="min-width:120px;">
            <option value="">All</option>
            <option value="1000">1000</option>
          </select>
          <button id="aggCompareBtn" type="button" class="btn">Compare</button>
          <span id="aggStatus" class="muted"></span>
        </div>

        <div id="aggCards"
             style="display:flex; gap:12px; flex-wrap:wrap; margin:8px 0;"></div>

        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:16px;">
          <div class="c-chart"><canvas id="chartActPeople"></canvas></div>
          <div class="c-chart"><canvas id="chartActTime"></canvas></div>
          <div class="c-chart"><canvas id="chartActAvg"></canvas></div>
          <div class="c-chart"><canvas id="chartModeTime"></canvas></div>
          <div class="c-chart"><canvas id="chartModeAvg"></canvas></div>
          <div class="c-chart"><canvas id="chartPt"></canvas></div>
          <div class="c-chart">
            <div id="ptRouteTable" style="max-height:240px; overflow:auto; border:1px solid #eee; border-radius:6px;"></div>
          </div>
        </div>
      </details>
    </div>
  `;

    const container =
      // Prefer inserting into the scrollable chart grid on results_graph.html
      document.querySelector('.l-contents__data .c-area__grid.c-area__scroll') ||
      // Fallbacks for other pages/layouts
      document.querySelector('.l-contents__data .c-box.c-area__scroll') ||
      document.querySelector('.l-contents__data') ||
      document.querySelector('.l-contents__map') ||
      document.body;

    if (container && container.classList?.contains('c-area__grid')) {
      host.style.marginTop = '0';
      host.style.marginBottom = '12px';
      host.style.gridColumn = '1 / -1';
      if (typeof container.prepend === 'function') container.prepend(host);
      else container.insertBefore(host, container.firstChild);
    } else {
      container.appendChild(host);
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
    cards.innerHTML = '';

    const preName = meta?.preName || 'Pre';
    const postName = meta?.postName || 'Post';
    const fmt = (n) => (typeof n === 'number' ? n : 0);

    cards.appendChild(card('People', `${fmt(pre.totalPeople)} → ${fmt(post.totalPeople)}`));
    cards.appendChild(card('Avg travel / person', `${hhmmss(fmt(pre.avgTravelSec))} → ${hhmmss(fmt(post.avgTravelSec))}`));
    cards.appendChild(card('Avg utility / person', `${fmt(pre.avgUtility).toFixed(2)} → ${fmt(post.avgUtility).toFixed(2)}`));
    cards.appendChild(card('PT users', `${fmt(pre.ptUsers)} → ${fmt(post.ptUsers)}`));

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
      options: { responsive: true, plugins: { legend: { display: true } } }
    };

    upsertChart('chartActPeople', {
      ...commonBar,
      data: { labels: actLabels, datasets: [
        { label: `${preName}: People`, data: actPeoplePre, backgroundColor: '#31599E' },
        { label: `${postName}: People`, data: actPeoplePost, backgroundColor: '#F5813C' },
      ] }
    });
    upsertChart('chartActTime', {
      ...commonBar,
      data: { labels: actLabels, datasets: [
        { label: `${preName}: Activity time (h)`, data: actTimePre, backgroundColor: '#31599E' },
        { label: `${postName}: Activity time (h)`, data: actTimePost, backgroundColor: '#F5813C' },
      ] }
    });
    upsertChart('chartActAvg', {
      ...commonBar,
      data: { labels: actLabels, datasets: [
        { label: `${preName}: Avg act time/person (h)`, data: actAvgPre, backgroundColor: '#31599E' },
        { label: `${postName}: Avg act time/person (h)`, data: actAvgPost, backgroundColor: '#F5813C' },
      ] }
    });
    upsertChart('chartModeTime', {
      ...commonBar,
      data: { labels: modeLabels, datasets: [
        { label: `${preName}: Travel time (h)`, data: modeTimePre, backgroundColor: '#8E44AD' },
        { label: `${postName}: Travel time (h)`, data: modeTimePost, backgroundColor: '#27ae60' },
      ] }
    });
    upsertChart('chartModeAvg', {
      ...commonBar,
      data: { labels: modeLabels, datasets: [
        { label: `${preName}: Avg time/person (h)`, data: modeAvgPre, backgroundColor: '#8E44AD' },
        { label: `${postName}: Avg time/person (h)`, data: modeAvgPost, backgroundColor: '#27ae60' },
      ] }
    });
    upsertChart('chartPt', {
      type: 'bar',
      data: {
        labels: ['PT users', 'Non-PT'],
        datasets: [
          { label: preName, data: [fmt(pre.ptUsers), Math.max(0, fmt(pre.totalPeople) - fmt(pre.ptUsers))], backgroundColor: '#31599E' },
          { label: postName, data: [fmt(post.ptUsers), Math.max(0, fmt(post.totalPeople) - fmt(post.ptUsers))], backgroundColor: '#F5813C' },
        ]
      },
      options: { responsive: true, plugins: { legend: { display: true } } }
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
        ptHost.innerHTML = '<div style="color:#666; padding:8px;">PT per-route counts unavailable.</div>';
      } else {
        const html = [
          '<table class="u-en" style="width:100%; border-collapse:collapse; font-size:12px;">',
          `<thead><tr>
            <th style="text-align:left; padding:6px; border-bottom:1px solid #eee;">PT Route</th>
            <th style="text-align:right; padding:6px; border-bottom:1px solid #eee;">${preName} Users</th>
            <th style="text-align:right; padding:6px; border-bottom:1px solid #eee;">${postName} Users</th>
            <th style="text-align:right; padding:6px; border-bottom:1px solid #eee;">${preName} Trips</th>
            <th style="text-align:right; padding:6px; border-bottom:1px solid #eee;">${postName} Trips</th>
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
    const preSel = document.getElementById('aggPreSelect');
    const postSel = document.getElementById('aggPostSelect');
    const limitSel = document.getElementById('aggPersonLimit');
    const btn = document.getElementById('aggCompareBtn');
    const modeEls = Array.from(document.querySelectorAll('input[name="aggMode"]'));

    let sims = [];
    try {
      sims = await fetchSimulations();
    } catch (e) {
      console.error(e);
      host.querySelector('#aggCards').innerHTML = '<div style="color:#666;">Failed to load simulations list.</div>';
      return;
    }

    const eligible = sims.filter(s => s.has_cache);
    if (!eligible.length) {
      host.querySelector('#aggCards').innerHTML = '<div style="color:#666;">No parsed simulations available.</div>';
      return;
    }

    function fillSelect(sel, items) {
      sel.innerHTML = '';
      items.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.name} — ${s.id.slice(0, 8)}`;
        sel.appendChild(opt);
      });
    }

    fillSelect(preSel, eligible);
    fillSelect(postSel, eligible);
    if (eligible.length >= 2) postSel.value = eligible[1].id;
    if (status) status.textContent = 'Ready. Choose options and click Compare.';

    function getMode() {
      const picked = modeEls.find((r) => r.checked);
      return picked ? picked.value : 'frequency';
    }

    function setControlsForMode(mode) {
      if (mode === 'frequency') {
        // Only need one simulation; keep post select visible but disabled for clarity.
        postSel.disabled = true;
      } else {
        postSel.disabled = false;
      }
    }

    function setMode(mode) {
      modeEls.forEach((r) => { r.checked = (r.value === mode); });
      setControlsForMode(mode);
    }

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

        const name = eligible.find(s => s.id === cached.simId)?.name || 'Simulation';
        renderCharts(cached.data.pre, cached.data.post, {
          preName: `${name} (before)`,
          postName: `${name} (after)`,
        });
        if (status) status.textContent = `Cached (people used: ${cached.data.pre?.totalPeople ?? 0}, changed: ${cached.data.changedPeople ?? 0})`;
        return;
      }

      if (cached.mode === 'sim') {
        if (!cached.preId || !cached.postId) return;
        if (!eligible.some(s => s.id === cached.preId) || !eligible.some(s => s.id === cached.postId)) return;

        setMode('sim');
        preSel.value = cached.preId;
        postSel.value = cached.postId;

        const preName = eligible.find(s => s.id === cached.preId)?.name || 'Pre';
        const postName = eligible.find(s => s.id === cached.postId)?.name || 'Post';
        renderCharts(cached.data.pre, cached.data.post, { preName, postName });
        if (status) status.textContent = `Cached (people used: ${cached.data.pre?.totalPeople ?? 0})`;
      }
    })();

    async function run() {
      const preId = preSel.value;
      const postId = postSel.value;
      const preName = eligible.find(s => s.id === preId)?.name || 'Pre';
      const postName = eligible.find(s => s.id === postId)?.name || 'Post';
      const personLimit = (() => {
        const raw = (limitSel && limitSel.value) ? String(limitSel.value) : '';
        const n = parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 ? n : null;
      })();
      if (status) status.textContent = 'Computing…';
      try {
        const mode = getMode();
        setControlsForMode(mode);
        if (mode === 'frequency') {
          const params = loadRouteParams();
          if (!params || params.oldFrequency == null || params.newFrequency == null) {
            throw new Error('routeParams not found. Save 運航頻度 in index.html first.');
          }
          // Avoid recomputing when navigating between results.html and results_graph.html
          // by using a localStorage cache keyed on simulation + routeParams.
          const sig = routeSignature(params, personLimit);
          const cached = getCachedCompare();
          if (cached && cached.mode === 'frequency' && cached.simId === preId && cached.sig === sig && cached.personLimit === personLimit && cached.data?.pre && cached.data?.post) {
            const name = eligible.find(s => s.id === preId)?.name || 'Simulation';
            renderCharts(cached.data.pre, cached.data.post, {
              preName: `${name} (before)`,
              postName: `${name} (after)`,
            });
            if (status) status.textContent = `Cached (people used: ${cached.data.pre?.totalPeople ?? 0}, changed: ${cached.data.changedPeople ?? 0})`;
            return;
          }
          const resp = await fetchFrequencyCompare(preId, {
            routeId: params.routeId,
            oldFrequency: params.oldFrequency,
            newFrequency: params.newFrequency,
          }, personLimit);
          const name = eligible.find(s => s.id === preId)?.name || 'Simulation';
          renderCharts(resp.pre, resp.post, {
            preName: `${name} (before)`,
            postName: `${name} (after)`,
          });
          if (status) status.textContent = `OK (people used: ${resp.pre?.totalPeople ?? 0}, changed: ${resp.changedPeople ?? 0})`;
          setCachedCompare({ mode: 'frequency', simId: preId, sig, personLimit, data: resp, savedAt: Date.now() });
          return;
        }

        // Sim-vs-sim compare cache to avoid duplicate fetch when moving between pages.
        const cached = getCachedCompare();
        if (cached && cached.mode === 'sim' && cached.preId === preId && cached.postId === postId && cached.personLimit === personLimit && cached.data?.pre && cached.data?.post) {
          renderCharts(cached.data.pre, cached.data.post, { preName, postName });
          if (status) status.textContent = `Cached (people used: ${cached.data.pre?.totalPeople ?? 0})`;
          return;
        }
        const cmp = await fetchCompare(preId, postId, personLimit);
        renderCharts(cmp.pre, cmp.post, { preName, postName });
        if (status) status.textContent = `OK (people used: ${cmp.pre?.totalPeople ?? 0})`;
        setCachedCompare({ mode: 'sim', preId, postId, personLimit, data: cmp, savedAt: Date.now() });
      } catch (e) {
        console.error(e);
        if (status) status.textContent = e?.message || 'Failed';
      }
    }

    btn.addEventListener('click', run);
    // Do not auto-run on page load or selection changes; let the user decide
    // when to compute since this can be expensive for large datasets.
  });
})();
