// Adjust the orange bars (入力) based on user input (routeParams)
// Works on results.html and results_graph.html after charts are created.
(function(){
  function getParams(){
    try { return JSON.parse(localStorage.getItem('routeParams')||'null'); } catch { return null; }
  }

  function clamp(x, min, max){ return Math.min(max, Math.max(min, x)); }

  // Try to obtain a Chart instance by global name or by canvas id
  function getChartBy(idOrName){
    try { if (window[idOrName]) return window[idOrName]; } catch {}
    try {
      const el = document.getElementById(idOrName);
      if (!el || !window.Chart) return null;
      if (typeof window.Chart.getChart === 'function') {
        return window.Chart.getChart(el) || window.Chart.getChart(idOrName) || null;
      }
      const inst = window.Chart.instances || {};
      for (const k in inst) {
        const c = inst[k];
        if (c && c.canvas === el) return c;
      }
    } catch {}
    return null;
  }

  function applyIfChart(idOrName, updater){
    const chart = getChartBy(idOrName);
    if (!chart || !chart.data || !chart.data.datasets || !chart.data.datasets[0]) return;
    try { updater(chart); chart.update(); } catch {}
  }

  function run(){
    const p = getParams();
    if (!p) return; // nothing to do
    const oldF = Math.max(1, Number(p.oldFrequency||0));
    const newF = Math.max(1, Number(p.newFrequency||0));
    const ratio = newF / oldF; // >= 0
    const brt = !!p.brtExclusive;
    const deltaWaitMin = ((60/oldF) - (60/newF)) / 2; // minutes

    // timeChart: index 0 現在, 1 入力
    applyIfChart('timeChart', (c) => {
      const cur = Number(c.data.datasets[0].data?.[0] || 0);
      const suggest = cur - Math.max(0, deltaWaitMin); // reduce by waiting time improvement
      c.data.datasets[0].data[1] = clamp(Math.round(suggest*10)/10, 0, 1e6);
    });

    // passengersChart: assume proportional to frequency (tempered)
    applyIfChart('passengersChart', (c) => {
      const cur = Number(c.data.datasets[0].data?.[0] || 0);
      const factor = 1 + 0.5*(ratio-1); // half sensitivity
      c.data.datasets[0].data[1] = clamp(Math.round(cur*factor), 0, 1e9);
    });

    // accidentChart: assume BRT lowers incidents by ~10%
    applyIfChart('accidentChart', (c) => {
      const cur = Number(c.data.datasets[0].data?.[0] || 0);
      const factor = brt ? 0.9 : 1.0;
      c.data.datasets[0].data[1] = clamp(Math.round(cur*factor*10)/10, 0, 1e9);
    });

    // trafficjamChart: assume BRT reduces congestion ~15%
    applyIfChart('trafficjamChart', (c) => {
      const cur = Number(c.data.datasets[0].data?.[0] || 0);
      const factor = brt ? 0.85 : 1.0;
      c.data.datasets[0].data[1] = clamp(Math.round(cur*factor*10)/10, 0, 1e9);
    });

    // costChart: assume cost scales with frequency
    applyIfChart('costChart', (c) => {
      const cur = Number(c.data.datasets[0].data?.[0] || 0);
      c.data.datasets[0].data[1] = clamp(Math.round(cur*ratio), 0, 1e12);
    });

    // exchangeChart: boost with frequency moderately
    applyIfChart('exchangeChart', (c) => {
      const cur = Number(c.data.datasets[0].data?.[0] || 0);
      const factor = 1 + 0.2*(ratio-1);
      c.data.datasets[0].data[1] = clamp(Math.round(cur*factor*10)/10, 0, 1e9);
    });
  }

  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run);
})();

