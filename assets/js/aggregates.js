// Aggregations and charts for persons dataset (parsed from plans.xml)
(function () {
  function onReady(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }

  async function loadPersonsFallback() {
    try {
      if (Array.isArray(window.__PARSED__) && window.__PARSED__.length) return window.__PARSED__;
      const res = await fetch('/api/simulations');
      const sims = await res.json();
      const sel = Array.isArray(sims) ? (sims.find(s => s.has_cache) || sims[0]) : null;
      if (!sel) return [];
      const res2 = await fetch(`/api/simulations/${sel.id}/data`);
      if (!res2.ok) return [];
      return await res2.json();
    } catch { return []; }
  }

  function pickSelectedPlan(p) {
    if (!p || !Array.isArray(p.plans) || p.plans.length === 0) return null;
    const idx = Number.isInteger(p.selectedPlanIndex) ? p.selectedPlanIndex : 0;
    return p.plans[idx] || p.plans[0] || null;
  }

  function aggregate(persons) {
    const out = {
      totalPeople: persons.length,
      totalTravelSec: 0,
      avgTravelSec: 0,
      totalUtility: 0,
      avgUtility: 0,
      ptUsers: 0,
      // ptRoutes: { routeId: { users:Set<string>, trips:number } }
      ptRoutes: {},
      // actStats: { type: { people:Set<string>, time:sec } }
      actStats: {},
      // modeStats: { mode: { time:sec, people:Set<string> } }
      modeStats: {}
    };

    persons.forEach(p => {
      const pl = pickSelectedPlan(p);
      if (!pl) return;
      out.totalUtility += (pl.serverScore || 0);
      let personTravel = 0;
      let usedPt = false;
      const seenActs = new Set();
      const seenModes = new Set();
      (pl.steps || []).forEach(s => {
        if (!s) return;
        if (s.kind === 'leg') {
          const d = s.durationSec || 0;
          personTravel += d;
          const m = s.mode || '__other__';
          if (!out.modeStats[m]) out.modeStats[m] = { time: 0, people: new Set() };
          out.modeStats[m].time += d;
          seenModes.add(m);
          if (m === 'pt') {
            usedPt = true;
            const rid = s.transitRouteId || s.transitLineId || s.ptStartLink || null;
            if (rid) {
              if (!out.ptRoutes[rid]) out.ptRoutes[rid] = { users: new Set(), trips: 0 };
              out.ptRoutes[rid].trips += 1;
              out.ptRoutes[rid].users.add(p.personId);
            }
          }
        } else if (s.kind === 'activity') {
          const d = s.durationSec || 0;
          const t = s.type || '__other__';
          if (!out.actStats[t]) out.actStats[t] = { people: new Set(), time: 0 };
          out.actStats[t].time += d;
          seenActs.add(t);
        }
      });
      out.totalTravelSec += personTravel;
      if (usedPt) out.ptUsers += 1;
      // mark distinct person in sets once
      seenActs.forEach(t => out.actStats[t].people.add(p.personId));
      seenModes.forEach(m => out.modeStats[m].people.add(p.personId));
    });

    out.avgTravelSec = out.totalPeople ? out.totalTravelSec / out.totalPeople : 0;
    out.avgUtility = out.totalPeople ? out.totalUtility / out.totalPeople : 0;
    return out;
  }

  function hhmmss(totalSec) {
    const s = Math.max(0, Math.round(totalSec));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }

  function ensurePanel() {
    let host = document.getElementById('aggPanel');
    if (host) return host;

    host = document.createElement('section');
    host.id = 'aggPanel';
    host.style.marginTop = '16px';

    host.innerHTML = `
    <div class="c-box">
      <details id="aggDetails" class="c-details" open>
        <summary class="c-details__summary">Aggregations (plans.xml)</summary>

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
      document.querySelector('.l-contents__data') ||
      document.querySelector('.l-contents__map') ||
      document.body;

    container.appendChild(host);

    const details = host.querySelector('#aggDetails');
    const KEY = 'aggDetailsOpen';

    const saved = localStorage.getItem(KEY);
    if (saved === '0') {
      details.removeAttribute('open');
    } else if (saved === null && window.matchMedia('(max-height: 800px)').matches) {
      details.removeAttribute('open');
    }

    details.addEventListener('toggle', () => {
      localStorage.setItem(KEY, details.open ? '1' : '0');
    });

    return host;
  }


  function card(label, value) {
    const div = document.createElement('div');
    div.style.cssText = 'flex:0 0 auto; min-width:180px; padding:10px 12px; background:#fff; border:1px solid #e5e7f3; border-radius:8px; box-shadow:0 1px 2px rgba(0,0,0,0.04);';
    div.innerHTML = `<div style="font-size:12px; color:#666;">${label}</div><div class="u-en" style="font-size:18px; font-weight:700;">${value}</div>`;
    return div;
  }

  function renderCharts(data) {
    const cards = document.getElementById('aggCards');
    cards.innerHTML = '';
    cards.appendChild(card('Total people', data.totalPeople));
    cards.appendChild(card('Total travel time', hhmmss(data.totalTravelSec)));
    cards.appendChild(card('Avg travel time / person', hhmmss(data.avgTravelSec)));
    cards.appendChild(card('Total utility', data.totalUtility.toFixed(2)));
    cards.appendChild(card('Avg utility / person', data.avgUtility.toFixed(2)));
    cards.appendChild(card('PT users (people)', data.ptUsers));

    const actLabels = Object.keys(data.actStats);
    const actPeople = actLabels.map(k => data.actStats[k].people.size);
    const actTime = actLabels.map(k => Math.round((data.actStats[k].time || 0) / 3600 * 10) / 10); // hours
    const actAvg = actLabels.map(k => {
      const ppl = data.actStats[k].people.size || 1;
      const hours = (data.actStats[k].time || 0) / 3600;
      return Math.round((hours / ppl) * 10) / 10;
    });
    const modeLabels = Object.keys(data.modeStats);
    const modeTime = modeLabels.map(k => Math.round((data.modeStats[k].time || 0) / 3600 * 10) / 10); // hours
    const modeAvg = modeLabels.map(k => {
      const ppl = data.modeStats[k].people.size || 1;
      const hours = (data.modeStats[k].time || 0) / 3600;
      return Math.round((hours / ppl) * 10) / 10;
    });

    const commonBar = {
      type: 'bar',
      options: { responsive: true, plugins: { legend: { display: false } } }
    };
    new Chart(document.getElementById('chartActPeople'), {
      ...commonBar,
      data: { labels: actLabels, datasets: [{ label: 'People per activity', data: actPeople, backgroundColor: '#31599E' }] }
    });
    new Chart(document.getElementById('chartActTime'), {
      ...commonBar,
      data: { labels: actLabels, datasets: [{ label: 'Activity time (hours)', data: actTime, backgroundColor: '#F5813C' }] }
    });
    new Chart(document.getElementById('chartActAvg'), {
      ...commonBar,
      data: { labels: actLabels, datasets: [{ label: 'Avg activity time per person (hours)', data: actAvg, backgroundColor: '#f39c12' }] }
    });
    new Chart(document.getElementById('chartModeTime'), {
      ...commonBar,
      data: { labels: modeLabels, datasets: [{ label: 'Travel time by mode (hours)', data: modeTime, backgroundColor: '#8E44AD' }] }
    });
    new Chart(document.getElementById('chartModeAvg'), {
      ...commonBar,
      data: { labels: modeLabels, datasets: [{ label: 'Avg travel time per person by mode (hours)', data: modeAvg, backgroundColor: '#27ae60' }] }
    });
    new Chart(document.getElementById('chartPt'), {
      type: 'bar',
      data: { labels: ['PT users', 'Non-PT'], datasets: [{ label: 'PT usage', data: [data.ptUsers, Math.max(0, data.totalPeople - data.ptUsers)], backgroundColor: ['#2ECC71', '#BDC3C7'] }] },
      options: { responsive: true, plugins: { legend: { display: false } } }
    });

    // PT per-route top list
    const ptHost = document.getElementById('ptRouteTable');
    if (ptHost) {
      const rows = Object.entries(data.ptRoutes || {})
        .map(([rid, rec]) => ({ rid, users: rec.users?.size || 0, trips: rec.trips || 0 }))
        .filter(r => r.users > 0 || r.trips > 0)
        .sort((a, b) => (b.users - a.users) || (b.trips - a.trips))
        .slice(0, 12);
      if (!rows.length) {
        ptHost.innerHTML = '<div style="color:#666; padding:8px;">PT per-route counts unavailable (no route IDs in dataset).</div>';
      } else {
        const html = [
          '<table class="u-en" style="width:100%; border-collapse:collapse; font-size:12px;">',
          '<thead><tr><th style="text-align:left; padding:6px; border-bottom:1px solid #eee;">PT Route</th><th style="text-align:right; padding:6px; border-bottom:1px solid #eee;">Users</th><th style="text-align:right; padding:6px; border-bottom:1px solid #eee;">Trips</th></tr></thead>',
          '<tbody>' + rows.map(r => `<tr><td style="padding:6px; border-bottom:1px solid #f5f5f5;">${r.rid}</td><td style="padding:6px; text-align:right; border-bottom:1px solid #f5f5f5;">${r.users}</td><td style="padding:6px; text-align:right; border-bottom:1px solid #f5f5f5;">${r.trips}</td></tr>`).join('') + '</tbody>',
          '</table>'
        ].join('');
        ptHost.innerHTML = html;
      }
    }
  }

  onReady(async () => {
    const host = ensurePanel();
    const persons = await loadPersonsFallback();
    if (!Array.isArray(persons) || !persons.length) {
      host.querySelector('#aggCards').innerHTML = '<div style="color:#666;">No dataset loaded.</div>';
      return;
    }
    const agg = aggregate(persons);
    renderCharts(agg);
  });
})();
