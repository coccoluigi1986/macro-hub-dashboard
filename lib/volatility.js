// lib/volatility.js
//
// Volatilità REALE per asset, calcolata sulle candele orarie degli ultimi 6 mesi di Yahoo Finance (lo stesso endpoint pubblico
// "chart" già usato dalla dashboard, nessuna chiave). Per ogni asset:
//  - escursione media per ORA DEL GIORNO (ora italiana): media di (massimo − minimo) di ogni candela oraria, nelle stesse ore dei vari giorni;
//  - escursione media per GIORNO DELLA SETTIMANA: media di (massimo − minimo) della giornata, lunedì-venerdì;
//  - escursione media giornaliera (ATR): media di (massimo − minimo) su quattro periodi — 1 settimana, 4 settimane, 10 settimane e 6 mesi —
//    in pips / punti, in % del prezzo attuale e in dollari per 1 lotto/contratto standard. Le 10 settimane (50 giornate di mercato) sono
//    la stessa definizione e la stessa finestra usate da Mataf e sono il periodo predefinito (campi di primo livello);
//  - andamento recente (ultime chiusure giornaliere) e l'escursione di oggi finora.
// Le giornate sono quelle di calendario in ora italiana.
// PULIZIA DEI DATI: nelle ore subito dopo la chiusura di New York (17:00-20:00 ora di New York) i prezzi di Yahoo hanno spread molto
// larghi e creano "code" finte nelle candele (sulle coppie incrociate fino a 28 pips su una candela che ne fa 6): quelle ore non entrano
// nell'escursione giornaliera; nel grafico orario si scarta solo la candela delle 17:00 (la peggiore). Con questa pulizia i valori delle
// 28 coppie Forex si discostano in media del 5% dai valori pubblicati da Mataf (19 coppie entro il 5%, 25 entro il 10%). Nessun dato è scritto a mano: se Yahoo non risponde per un asset, la riga
// resta con l'errore e non si inventa nulla.
// Usato da api/market-data.js (?view=volatility).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TZ = 'Europe/Rome';
const MIN_DAY_BARS = 6;      // una giornata con meno candele (festivo, chiusura anticipata) non entra nelle medie
const MIN_HOUR_DAYS = 5;     // un'ora con meno giorni di dati è considerata "mercato chiuso"
// periodi della media (giornate di mercato): 10 settimane = la finestra di Mataf, quella predefinita
const PERIODS = [{ k: '1w', days: 5, label: '1 settimana' }, { k: '4w', days: 20, label: '4 settimane' }, { k: '10w', days: 50, label: '10 settimane' }, { k: '26w', days: 130, label: '6 mesi' }];
const DEFAULT_PERIOD = '10w';
const QUIET_NY = new Set([17, 18, 19]);   // ore di New York dopo la chiusura: spread larghi, code finte
const ROLLOVER_NY = 17;

// Forex: 28 incroci dei maggiori. pip = 0,0001 (0,01 se la valuta di quotazione è lo yen); 1 lotto = 100.000 unità.
const FX = ['AUDCAD', 'AUDCHF', 'AUDJPY', 'AUDNZD', 'AUDUSD', 'CADCHF', 'CADJPY', 'CHFJPY', 'EURAUD', 'EURCAD', 'EURCHF', 'EURGBP', 'EURJPY', 'EURNZD', 'EURUSD',
  'GBPAUD', 'GBPCAD', 'GBPCHF', 'GBPJPY', 'GBPNZD', 'GBPUSD', 'NZDCAD', 'NZDCHF', 'NZDJPY', 'NZDUSD', 'USDCAD', 'USDCHF', 'USDJPY'];
// Altri asset: simbolo Yahoo, unità mostrata, moltiplicatore del contratto standard per i dollari (null = non ha senso)
const OTHERS = [
  { key: 'XAUUSD', name: 'Oro (XAU/USD)', sym: 'GC=F', cls: 'met', unit: 'punti', usdPer: 100 },        // future COMEX: 100 once
  { key: 'XAGUSD', name: 'Argento (XAG/USD)', sym: 'SI=F', cls: 'met', unit: 'punti', usdPer: 5000 },   // future COMEX: 5.000 once
  { key: 'WTI', name: 'Petrolio WTI', sym: 'CL=F', cls: 'met', unit: 'punti', usdPer: 1000 },           // future NYMEX: 1.000 barili
  { key: 'US500', name: 'S&P 500 (future)', sym: 'ES=F', cls: 'idx', unit: 'punti', usdPer: 50 },       // E-mini: 50 $ a punto
  { key: 'US100', name: 'Nasdaq 100 (future)', sym: 'NQ=F', cls: 'idx', unit: 'punti', usdPer: 20 },    // E-mini: 20 $ a punto
  { key: 'US30', name: 'Dow Jones (future)', sym: 'YM=F', cls: 'idx', unit: 'punti', usdPer: 5 },       // E-mini: 5 $ a punto
  { key: 'DXY', name: 'Dollar Index (DXY)', sym: 'DX-Y.NYB', cls: 'oth', unit: 'punti', usdPer: 1000 },  // ICE: 1.000 $ a punto
  { key: 'VIX', name: 'VIX', sym: '^VIX', cls: 'oth', unit: 'punti', usdPer: null },
  { key: 'US10Y', name: 'Rendimento Treasury 10 anni', sym: '^TNX', cls: 'oth', unit: 'bp', scale: 100, usdPer: null },   // quotato in %: 0,05 = 5 punti base
];
const fxAsset = (p) => ({ key: p, name: p.slice(0, 3) + '/' + p.slice(3), sym: p + '=X', cls: 'fx', unit: 'pips', pair: p, pip: p.endsWith('JPY') ? 0.01 : 0.0001 });
const ASSETS = [...FX.map(fxAsset), ...OTHERS];

const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short' });
const DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit' });
const nyHour = (tsSec) => parseInt(nyFmt.format(new Date(tsSec * 1000)), 10);
function localParts(tsSec) {
  const o = {}; fmt.formatToParts(new Date(tsSec * 1000)).forEach((p) => { o[p.type] = p.value; });
  return { date: `${o.year}-${o.month}-${o.day}`, hour: parseInt(o.hour, 10), dow: DOW[o.weekday] };
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round = (v, d) => (v == null || !isFinite(v) ? null : Number(v.toFixed(d)));

async function fetchHourly(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=6mo&interval=1h`;
  let res;
  for (let i = 0; i < 2; i++) {
    res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const j = await res.json();
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) throw new Error('nessun dato');
  const q = r.indicators.quote[0];
  const bars = [];
  r.timestamp.forEach((t, i) => { if (q.high[i] != null && q.low[i] != null && q.close[i] != null) bars.push({ t, h: q.high[i], l: q.low[i], c: q.close[i] }); });
  return bars;
}

// calcolo puro (testabile): barre orarie -> statistiche per ogni periodo, nell'unità di prezzo
function computeStats(bars, scale = 1, nowMs = Date.now()) {
  const days = new Map();   // data locale -> { dow, bars: [{hour, range, close}] }
  bars.forEach((b) => {
    const p = localParts(b.t);
    if (!days.has(p.date)) days.set(p.date, { dow: p.dow, bars: [] });
    days.get(p.date).bars.push({ hour: p.hour, ny: nyHour(b.t), range: (b.h - b.l) * scale, hi: b.h, lo: b.l, close: b.c });
  });
  const dates = [...days.keys()].sort();
  const today = localParts(nowMs / 1000).date;   // oggi (ora italiana): la giornata in corso non entra nelle medie
  const daily = dates.map((d) => {
    const x = days.get(d), ok = x.bars.filter((b) => !QUIET_NY.has(b.ny));   // ore dopo la chiusura di New York escluse
    const hi = ok.length ? Math.max(...ok.map((b) => b.hi)) : null, lo = ok.length ? Math.min(...ok.map((b) => b.lo)) : null;
    return { date: d, dow: x.dow, n: ok.length, range: hi == null ? null : (hi - lo) * scale, close: x.bars[x.bars.length - 1].close, complete: d !== today && x.dow < 5 && ok.length >= MIN_DAY_BARS };
  });
  const done = daily.filter((d) => d.complete);
  const price = bars[bars.length - 1].c;
  const periods = {};
  PERIODS.forEach((p) => {
    const win = done.slice(-p.days);
    if (!win.length) { periods[p.k] = null; return; }
    const byHour = Array.from({ length: 24 }, () => []), byDow = Array.from({ length: 5 }, () => []);
    win.forEach((d) => { days.get(d.date).bars.forEach((b) => { if (b.ny !== ROLLOVER_NY) byHour[b.hour].push(b.range); }); byDow[d.dow].push(d.range); });
    const minHour = Math.max(2, Math.min(MIN_HOUR_DAYS, Math.ceil(win.length * 0.6)));
    const avgRange = mean(win.map((d) => d.range));
    // andamento: chiusure giornaliere del periodo (almeno le ultime 20 giornate), al massimo 40 punti
    const sp = daily.filter((d) => d.dow < 5).slice(-Math.max(p.days, 20)), step = Math.ceil(sp.length / 40);
    const spark = sp.filter((_, i) => (sp.length - 1 - i) % step === 0).map((d) => d.close);
    periods[p.k] = {
      days: win.length, avgRange,
      avgPct: (avgRange / scale) / price * 100,   // escursione media / prezzo attuale, come Mataf
      hours: byHour.map((a) => (a.length >= minHour ? mean(a) : null)),
      weekdays: byDow.map((a) => (a.length >= 1 ? mean(a) : null)),
      spark,
    };
  });
  const td = daily.find((d) => d.date === today);
  return { price, periods, today: td && td.dow < 5 && td.range != null ? { range: td.range, bars: td.n } : null };
}

async function inBatches(items, n, fn) {
  const out = []; for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(fn))); return out;
}

async function getVolatility() {
  const raw = await inBatches(ASSETS, 10, async (a) => {
    try { return { a, st: computeStats(await fetchHourly(a.sym), a.scale || (a.pip ? 1 / a.pip : 1)) }; }
    catch (e) { return { a, error: e.message }; }
  });
  // prezzi per convertire il valore del pip in dollari (le valute di quotazione che non sono il dollaro)
  const px = {}; raw.forEach((r) => { if (r.st && r.a.pair) px[r.a.pair] = r.st.price; });
  const q2usd = (q) => ({ USD: 1, JPY: px.USDJPY && 1 / px.USDJPY, CHF: px.USDCHF && 1 / px.USDCHF, CAD: px.USDCAD && 1 / px.USDCAD, AUD: px.AUDUSD, NZD: px.NZDUSD, GBP: px.GBPUSD, EUR: px.EURUSD }[q] || null);
  const assets = raw.map(({ a, st, error }) => {
    if (!st || !st.periods[DEFAULT_PERIOD]) return { key: a.key, name: a.name, cls: a.cls, unit: a.unit, error: error || 'non disponibile' };
    const dec = a.pair ? 1 : a.unit === 'bp' ? 1 : 2;
    const usdOf = (avg) => {
      // FX: avg è in pips: valore di 1 pip per lotto = 100.000 × pip, in valuta di quotazione → dollari
      if (a.pair) { const v = q2usd(a.pair.slice(3)); return v ? avg * (100000 * a.pip) * v : null; }
      return a.usdPer ? avg * a.usdPer : null;
    };
    const periods = {};
    PERIODS.forEach((p) => {
      const s = st.periods[p.k]; if (!s) return;
      periods[p.k] = { days: s.days, avgRange: round(s.avgRange, dec), avgPct: round(s.avgPct, 2), usd: round(usdOf(s.avgRange), 2), hours: s.hours.map((v) => round(v, dec + 1)), weekdays: s.weekdays.map((v) => round(v, dec + 1)), spark: s.spark.map((v) => round(v, 5)) };
    });
    return {
      key: a.key, name: a.name, cls: a.cls, unit: a.unit,
      price: round(st.price, a.pair && a.pair.endsWith('JPY') ? 3 : a.pair ? 5 : 2),
      ...periods[DEFAULT_PERIOD],   // i campi di primo livello restano quelli delle 10 settimane (compatibilità con le pagine già aperte)
      today: st.today ? { range: round(st.today.range, dec), bars: st.today.bars } : null,
      periods,
    };
  });
  return { updatedAt: new Date().toISOString(), tz: TZ, window: 'ultime 10 settimane (50 giornate di mercato)', defaultPeriod: DEFAULT_PERIOD, periodi: PERIODS.map(({ k, days, label }) => ({ k, days, label })), source: 'Yahoo Finance (candele orarie)', assets };
}

module.exports = { getVolatility, computeStats, ASSETS, PERIODS };
