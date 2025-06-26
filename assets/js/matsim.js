(function(global){
  'use strict';
  async function fetchCsv(url){
    const res = await fetch(url);
    if(!res.ok) throw new Error('Failed to load '+url);
    if(url.endsWith('.gz')){
      if('DecompressionStream' in window && res.body){
        const ds = new DecompressionStream('gzip');
        const stream = res.body.pipeThrough(ds);
        return await new Response(stream).text();
      }else{
        throw new Error('Gzip decompression not supported');
      }
    }
    return await res.text();
  }
  function parseCsv(text){
    const lines = text.trim().split(/\r?\n/);
    const headers = lines.shift().split(',');
    return lines.map(line => {
      const cols = line.split(',');
      const obj = {};
      headers.forEach((h,i)=>{obj[h]=cols[i];});
      return obj;
    });
  }
  function computeTripMetrics(trips){
    let total=0,count=0;
    trips.forEach(t=>{
      let dur = parseFloat(t.duration);
      if(isNaN(dur)){
        const dep=parseFloat(t.departureTime||t.departure_time||t.depTime);
        const arr=parseFloat(t.arrivalTime||t.arrival_time||t.arrTime);
        if(!isNaN(dep)&&!isNaN(arr)) dur = arr-dep;
      }
      if(!isNaN(dur)){
        total += dur;
        count++;
      }
    });
    return {tripCount: trips.length, averageTravelTime: count?total/count:0};
  }
  global.MATSim = {
    loadTripMetrics: async function(url){
      const text = await fetchCsv(url);
      const trips = parseCsv(text);
      return computeTripMetrics(trips);
    }
  };
})(this);
