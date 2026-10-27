// lib/sahm.js
//
// Sahm Rule: indicatore di recessione USA basato sulla disoccupazione.
//
// Definizione (Claudia Sahm): differenza tra la media a 3 mesi del tasso di disoccupazione e il MINIMO delle medie a 3 mesi
// dei 12 mesi PRECEDENTI. Quando la differenza raggiunge 0,50 punti percentuali il segnale "scatta": in passato è coinciso
// con l'inizio di quasi tutte le recessioni USA. Un valore negativo significa che la media attuale è sotto il minimo dell'anno.
// I dati sono quelli ufficiali FRED: UNRATE (disoccupazione mensile) e, come controllo, SAHMREALTIME (la serie ufficiale in
// tempo reale della Federal Reserve di St. Louis). Se un mese manca (es. ottobre 2025, shutdown USA) la media usa i mesi
// disponibili (almeno 2 su 3): è lo stesso criterio che si ritrova nei valori FRED.
// Usato da api/fred-data.js (?view=sahm).

const WATCH = 0.30, TRIGGER = 0.50;

// unrate: [{date:'YYYY-MM-DD', value:number|null}] in ordine crescente di data; realtime: stesso formato (serie SAHMREALTIME)
function computeSahm(unrate, realtime) {
  const mo = unrate.map((o) => ({ m: o.date.slice(0, 7), v: (o.value == null || isNaN(o.value)) ? null : o.value }));
  const ma = mo.map((o, i) => {
    if (i < 2) return null;
    const w = [mo[i].v, mo[i - 1].v, mo[i - 2].v].filter((x) => x != null);
    return w.length >= 2 ? w.reduce((a, b) => a + b, 0) / w.length : null;
  });
  const calc = (i) => {
    if (mo[i].v == null || ma[i] == null) return null;
    const prev = [];
    for (let k = i - 12; k < i; k++) if (k >= 0 && ma[k] != null) prev.push({ m: mo[k].m, v: ma[k] });
    if (prev.length < 6) return null;
    const min = Math.min(...prev.map((p) => p.v));
    const minAt = prev.filter((p) => p.v <= min + 1e-9).pop();
    return { i, m: mo[i].m, value: ma[i] - min, ma3: ma[i], min, minMonth: minAt.m };
  };
  const all = mo.map((_, i) => calc(i)).filter(Boolean);
  if (!all.length) return null;
  const last = all[all.length - 1];
  const used = [last.i - 2, last.i - 1, last.i].map((k) => ({ m: mo[k].m, v: mo[k].v }));
  const rt = (realtime || []).filter((o) => o.value != null && !isNaN(o.value)).pop();
  const state = last.value >= TRIGGER ? 'triggered' : last.value >= WATCH ? 'watch' : 'none';
  return {
    month: last.m, value: last.value, ma3: last.ma3, ma3Months: used, minMa3: last.min, minMonth: last.minMonth,
    unrate: mo[last.i].v, threshold: TRIGGER, watch: WATCH, state,
    fredRealtime: rt ? { value: rt.value, month: rt.date.slice(0, 7) } : null,
    history: all.slice(-24).map((p) => ({ m: p.m, v: p.value })),
  };
}

// Le osservazioni FRED mancanti arrivano come "." (es. ottobre 2025): diventano null
async function fetchObservations(seriesId, apiKey, query) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&${query}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED error for ${seriesId}: ${res.status}`);
  const data = await res.json();
  return (data.observations || []).map((o) => ({ date: o.date, value: o.value === '.' || o.value === '' ? null : parseFloat(o.value) }));
}

async function getSahm(apiKey) {
  // UNRATE: ~4 anni di dati bastano per le 24 medie dello storico più i 12 mesi precedenti la prima
  const start = new Date(Date.UTC(new Date().getUTCFullYear() - 4, 0, 1)).toISOString().slice(0, 10);
  const [unrate, realtime] = await Promise.all([
    fetchObservations('UNRATE', apiKey, `sort_order=asc&observation_start=${start}`),
    // la serie ufficiale serve solo come controllo: se non risponde la Sahm Rule resta calcolabile
    fetchObservations('SAHMREALTIME', apiKey, 'sort_order=desc&limit=6').then((o) => o.reverse()).catch(() => []),
  ]);
  const s = computeSahm(unrate, realtime);
  if (!s) throw new Error('dati UNRATE insufficienti per calcolare la Sahm Rule');
  return { updatedAt: new Date().toISOString(), source: 'FRED (UNRATE, SAHMREALTIME)', ...s };
}

module.exports = { getSahm, computeSahm, WATCH, TRIGGER };
