// BOZZA — "Ciclo di mercato" di ogni asset, calcolato SOLO da prezzi giornalieri reali (Yahoo Finance) con regole oggettive e scritte (poi diventa lib/cycle.js).
//
// FASE DEL CICLO (le quattro fasi classiche: accumulazione → rialzo → distribuzione → ribasso), da tre fatti misurabili:
//   prezzo sopra/sotto la media a 200 giorni · prezzo sopra/sotto la media a 50 giorni · media a 50 giorni in salita/discesa (rispetto a 20 giorni prima)
//   • RIALZO         prezzo sopra la 200 e sopra la 50, con la 50 in salita
//   • DISTRIBUZIONE  prezzo ancora sopra la 200 ma il rialzo perde forza (sotto la 50 o con la 50 che non sale più)
//   • RIBASSO        prezzo sotto la 200 e sotto la 50, con la 50 in discesa
//   • ACCUMULAZIONE  prezzo ancora sotto la 200 ma il ribasso si ferma (sopra la 50 o con la 50 che non scende più)
// POSIZIONE sul ciclo (0–100, le quattro zone della barra): dentro la fase, quanto è avanzato il prezzo —
//   accumulazione: dal minimo di 52 settimane verso la media a 200 · rialzo: distanza sopra la 200 rispetto a una "distanza normale" per quell'asset (dalla sua volatilità)
//   distribuzione: calo dal massimo di 52 settimane verso la media a 200 · ribasso: discesa dalla 200 verso il minimo di 52 settimane
// CONFERME: cinque controlli indipendenti, ognuno +1 (a favore del rialzo), 0 (neutro) o −1 (a favore del ribasso):
//   trend di fondo (prezzo vs media 200) · trend medio (prezzo vs 50 e inclinazione) · momentum (RSI a 14 giorni) · slancio a 3 mesi (in rapporto alla volatilità) · posizione nel range annuale
// Non è un consiglio d'investimento: è una lettura oggettiva dei prezzi, da usare come filtro insieme al resto.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ASSETS = [
  { key: 'sp500', name: 'S&P 500', sym: '^GSPC', grp: 'Indici', cot: 'sp500', rt: 'sp500', mi: 'S&P 500' },
  { key: 'nasdaq', name: 'Nasdaq 100', sym: '^NDX', grp: 'Indici', cot: 'nasdaq', rt: 'nasdaq', mi: 'Nasdaq 100' },
  { key: 'dow', name: 'Dow Jones', sym: '^DJI', grp: 'Indici', cot: 'dow', mi: 'Dow Jones' },
  { key: 'russell', name: 'Russell 2000', sym: '^RUT', grp: 'Indici', cot: 'russell' },
  { key: 'gold', name: 'Oro', sym: 'GC=F', grp: 'Materie prime', cot: 'gold', rt: 'gold', mi: 'Gold Futures' },
  { key: 'silver', name: 'Argento', sym: 'SI=F', grp: 'Materie prime', cot: 'silver', rt: 'silver', mi: 'Silver Futures' },
  { key: 'wti', name: 'Petrolio WTI', sym: 'CL=F', grp: 'Materie prime', cot: 'wti', mi: 'WTI Crude Oil' },
  { key: 'brent', name: 'Brent', sym: 'BZ=F', grp: 'Materie prime', cot: 'brent' },
  { key: 'eurusd', name: 'EUR/USD', sym: 'EURUSD=X', grp: 'Valute', cot: 'eur', rt: 'eurusd', mi: 'EUR/USD' },
  { key: 'gbpusd', name: 'GBP/USD', sym: 'GBPUSD=X', grp: 'Valute', cot: 'gbp', rt: 'gbpusd', mi: 'GBP/USD' },
  { key: 'usdjpy', name: 'USD/JPY', sym: 'JPY=X', grp: 'Valute' },
  { key: 'dxy', name: 'Dollaro (DXY)', sym: 'DX-Y.NYB', grp: 'Valute', cot: 'dxy', rt: 'dxy', mi: 'DXY' },
  { key: 'us10y', name: 'Rendimento US 10Y', sym: '^TNX', grp: 'Tassi', mi: 'US 10Y Yield' },
  { key: 'btc', name: 'Bitcoin', sym: 'BTC-USD', grp: 'Crypto', cot: 'bitcoin' },
];
const PHASE = { acc: 'Accumulazione', up: 'Rialzo', dist: 'Distribuzione', down: 'Ribasso' };
const ZONE = { acc: 0, up: 25, dist: 50, down: 75 };

async function bars(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`;
  let res;
  for (let i = 0; i < 3; i++) {
    res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  if (!res.ok) throw new Error(`Yahoo ${res.status} per ${sym}`);
  const r = (await res.json()).chart.result[0], q = r.indicators.quote[0], out = [];
  r.timestamp.forEach((t, i) => { if (q.close[i] != null && q.high[i] != null && q.low[i] != null) out.push({ d: new Date(t * 1000).toISOString().slice(0, 10), c: q.close[i], h: q.high[i], l: q.low[i] }); });
  if (out.length < 215) throw new Error(`storico troppo corto per ${sym} (${out.length} giorni)`);
  return out;
}

const sma = (a, n, end = a.length) => { let s = 0; for (let i = end - n; i < end; i++) s += a[i]; return s / n; };
const std = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1)); };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r1 = (x) => Math.round(x * 10) / 10;
function rsi(c, n = 14) {
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function atr(b, n = 14) {
  const tr = b.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c))));
  let a = tr.slice(1, n + 1).reduce((x, y) => x + y, 0) / n;
  for (let i = n + 1; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}

function analyse(a, b) {
  const c = b.map((x) => x.c), P = c[c.length - 1], n = c.length;
  const s50 = sma(c, 50), s200 = sma(c, 200), s50ago = sma(c, 50, n - 20), slope = s50 / s50ago - 1;
  const rets = c.slice(1).map((x, i) => Math.log(x / c[i])), sd = std(rets.slice(-63)), sdYear = std(rets), sigAnn = sd * Math.sqrt(252);
  const hi = Math.max(...b.slice(-252).map((x) => x.h)), lo = Math.min(...b.slice(-252).map((x) => x.l)), rangePos = (P - lo) / (hi - lo);
  const RSI = rsi(c), roc63 = P / c[n - 64] - 1, z = roc63 / (sd * Math.sqrt(63)), A = atr(b);
  const volRatio = std(rets.slice(-20)) / sdYear;
  const above200 = P > s200, above50 = P > s50;
  const phase = above200 ? (above50 && slope > 0 ? 'up' : 'dist') : (!above50 && slope < 0 ? 'down' : 'acc');
  let f;
  if (phase === 'acc') f = clamp((P - lo) / (s200 - lo), 0, 1);
  else if (phase === 'up') f = clamp((P / s200 - 1) / Math.max(0.06, sigAnn * 0.9), 0, 1);
  else if (phase === 'dist') f = clamp((hi - P) / (hi - s200), 0, 1);
  else f = clamp((s200 - P) / (s200 - lo), 0, 1);
  const p = clamp(ZONE[phase] + 25 * f, 2, 98);
  const g200 = P / s200 - 1;
  const factors = [
    { id: 'trend200', label: 'Trend di fondo', v: g200 > 0.005 ? 1 : g200 < -0.005 ? -1 : 0, value: (g200 >= 0 ? '+' : '−') + Math.abs(g200 * 100).toFixed(1).replace('.', ',') + '% dalla media 200', rule: 'Prezzo sopra la media a 200 giorni = trend di fondo rialzista, sotto = ribassista (tolleranza ±0,5%).' },
    { id: 'trend50', label: 'Trend medio', v: above50 && slope > 0 ? 1 : !above50 && slope < 0 ? -1 : 0, value: (above50 ? 'sopra' : 'sotto') + ' la media 50, ' + (slope > 0 ? 'in salita' : 'in discesa'), rule: 'Rialzista se il prezzo è sopra la media a 50 giorni e questa sale; ribassista se è sotto e scende; negli altri casi misto.' },
    { id: 'rsi', label: 'Momentum (RSI)', v: RSI > 55 ? 1 : RSI < 45 ? -1 : 0, value: 'RSI ' + RSI.toFixed(0), rule: 'RSI a 14 giorni: oltre 55 forza compratrice, sotto 45 forza venditrice, in mezzo equilibrio. Oltre 70 ipercomprato, sotto 30 ipervenduto.' },
    { id: 'roc', label: 'Slancio a 3 mesi', v: z > 0.5 ? 1 : z < -0.5 ? -1 : 0, value: (roc63 >= 0 ? '+' : '−') + Math.abs(roc63 * 100).toFixed(1).replace('.', ',') + '% in 3 mesi', rule: 'Variazione a 3 mesi in rapporto alla volatilità tipica dell\'asset: oltre +0,5 volte il movimento normale rialzista, sotto −0,5 ribassista.' },
    { id: 'range', label: 'Posizione nel range annuale', v: rangePos > 0.66 ? 1 : rangePos < 0.33 ? -1 : 0, value: Math.round(rangePos * 100) + '% del range di 52 sett.', rule: 'Dove si trova il prezzo tra il minimo (0%) e il massimo (100%) di 52 settimane: nel terzo alto rialzista, nel terzo basso ribassista.' },
  ];
  const score = factors.reduce((s, x) => s + x.v, 0), bull = factors.filter((x) => x.v > 0).length, bear = factors.filter((x) => x.v < 0).length;
  const bias = score >= 2 ? 'up' : score <= -2 ? 'down' : 'mixed';
  const dec = P >= 1000 ? 0 : P >= 100 ? 1 : P >= 10 ? 2 : 4;
  return {
    key: a.key, name: a.name, sym: a.sym, grp: a.grp, cot: a.cot || null, rt: a.rt || null, mi: a.mi || null, asof: b[b.length - 1].d,
    price: P, d1: (P / c[n - 2] - 1) * 100, phase, phaseLabel: PHASE[phase], p: r1(p), bias, score, bull, bear,
    factors, rsi: r1(RSI), roc63: r1(roc63 * 100), rangePos: r1(rangePos * 100), volRatio: r1(volRatio), sigAnn: r1(sigAnn * 100), slope50: r1(slope * 100),
    levels: { sma50: +s50.toFixed(dec + 0), sma200: +s200.toFixed(dec + 0), hi52: +hi.toFixed(dec + 0), lo52: +lo.toFixed(dec + 0), atr: +A.toFixed(dec + 1), atrPct: r1((A / P) * 100) },
    spark: c.slice(-60).map((x) => +x.toFixed(dec + 2)),
  };
}

async function getCycle() {
  const errors = [];
  const out = await Promise.all(ASSETS.map(async (a) => { try { return analyse(a, await bars(a.sym)); } catch (e) { errors.push(`${a.key}: ${e.message}`); return null; } }));
  return { generatedAt: new Date().toISOString(), assets: out.filter(Boolean), errors };
}

module.exports = { getCycle, analyse, ASSETS, PHASE };
