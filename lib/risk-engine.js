// lib/risk-engine.js
//
// BIAS RISK-ON / RISK-OFF CALCOLATO DAI PREZZI (non da un modello di linguaggio).
//
// PERCHÉ. Il verdetto veniva scritto dall'AI ogni 3 ore, e ogni area geografica del CDN (Vercel) tiene la sua copia: due utenti con lo stesso link, o lo stesso utente in momenti diversi,
// potevano ricevere due generazioni diverse dello stesso verdetto (RISK-OFF in una, RISK-ON nell'altra) senza che il mercato fosse cambiato. Qui il verdetto è una FORMULA SUI PREZZI:
// gli stessi prezzi danno sempre lo stesso risultato, per tutti, in ogni momento. L'AI continua a scrivere i commenti (titolo, motivi, direzione degli asset), ma l'etichetta e il punteggio
// non sono più una sua opinione: le vengono dati come fatto (vedi lib/market-context.js) e la pagina mostra sempre quelli.
//
// FORMULA (punteggio 0-100: 0 = risk-off estremo, 100 = risk-on estremo, 50 = neutro). Si parte da 50 e si sommano quattro contributi, ognuno con un massimo:
//   1) AZIONARIO  : media delle variazioni di oggi di S&P 500, Nasdaq 100 e Dow Jones; 10 punti per ogni 1%, massimo ±35.
//   2) VIX (livello): sotto 19 = calma (aggiunge fino a +15), sopra 19 = tensione (toglie 1,8 punti per ogni punto di VIX, fino a -25).
//   3) VIX (oggi)  : il VIX che sale di oggi toglie punti (0,4 per ogni 1%), che scende ne aggiunge; massimo ±8.
//   4) DOLLARO     : un dollaro (DXY) in rialzo di oggi è un segnale di fuga dal rischio: -6 punti per ogni +1%, massimo ±6.
// ETICHETTA: fino a 38 = RISK-OFF, da 62 = RISK-ON, in mezzo = NEUTRALE (la zona centrale larga evita che piccoli movimenti facciano oscillare il verdetto).
//
// Se mancano i dati essenziali (almeno due indici azionari e il VIX) non si inventa nulla: torna null e la pagina usa l'ultima lettura disponibile.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
const OFF_MAX = 38, ON_MIN = 62;

function labelOf(score) { return score <= OFF_MAX ? 'RISK-OFF' : score >= ON_MIN ? 'RISK-ON' : 'NEUTRALE'; }

// q: { sp500, nasdaq, dow, vix, dxy } con { price, changePercent } (la forma di /api/market-data)
function riskFromQuotes(q) {
  q = q || {};
  const get = (o, f) => (o ? num(o[f]) : null);   // sempre un numero oppure null (mai undefined/NaN)
  const eqs = ['sp500', 'nasdaq', 'dow'].map((k) => get(q[k], 'changePercent')).filter((x) => x !== null);
  const vix = get(q.vix, 'price'), vixPct = get(q.vix, 'changePercent'), dxyPct = get(q.dxy, 'changePercent');
  if (eqs.length < 2 || vix === null) return null;
  const eq = eqs.reduce((a, b) => a + b, 0) / eqs.length;
  const parts = {
    equity: clamp(eq * 10, -35, 35),
    vixLevel: clamp((19 - vix) * 1.8, -25, 15),
    vixMove: vixPct === null ? 0 : clamp(-vixPct * 0.4, -8, 8),
    dollar: dxyPct === null ? 0 : clamp(-dxyPct * 6, -6, 6),
  };
  const score = Math.round(clamp(50 + parts.equity + parts.vixLevel + parts.vixMove + parts.dollar, 0, 100));
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    score, label: labelOf(score),
    parts: { equity: r1(parts.equity), vixLevel: r1(parts.vixLevel), vixMove: r1(parts.vixMove), dollar: r1(parts.dollar) },
    inputs: { equityPct: Math.round(eq * 100) / 100, vix, vixPct, dxyPct },
    method: 'prezzi',
  };
}

// ---------- STABILITÀ DURANTE LA GIORNATA ----------
// Provato su un mese di dati a 5 minuti (backtest-intraday): la formula applicata al singolo istante faceva cambiare etichetta fino a 9 volte in una seduta (il punteggio balla attorno a una
// soglia per un singolo tick), cioè lo stesso "RISK-OFF → RISK-ON → RISK-OFF" segnalato dagli utenti. Per questo l'etichetta usa DUE accorgimenti, entrambi calcolati dai dati (non da uno
// stato salvato), quindi identici per tutti:
//   1) MEDIA SULL'ULTIMA ORA: il punteggio è la media delle ultime 12 rilevazioni a 5 minuti (un tick isolato non sposta più nulla);
//   2) ISTERESI: si entra in RISK-OFF a ≤38 ma se ne esce solo sopra 42; in RISK-ON si entra a ≥62 e se ne esce sotto 58. Lo stato si ricostruisce scorrendo la serie di oggi dall'inizio.
// Risultato sullo stesso mese: al massimo 2 cambi per seduta (media 0,7), e sono movimenti veri (es. il 19 nov. da +62 a 3 con l'S&P 500 che passa da positivo a -2%).
const WINDOW = 12, MARGIN = 4, SLOT = 300000, LOOKBACK = 6 * 3600000;

function stateOf(s, st) {
  if (st === 'RISK-OFF') return s > OFF_MAX + MARGIN ? (s >= ON_MIN ? 'RISK-ON' : 'NEUTRALE') : 'RISK-OFF';
  if (st === 'RISK-ON') return s < ON_MIN - MARGIN ? (s <= OFF_MAX ? 'RISK-OFF' : 'NEUTRALE') : 'RISK-ON';
  return labelOf(s);
}

// S: { sp500, nasdaq, dow, vix, dxy } con { bars: [{ t: ms, c: chiusura }], prev: chiusura precedente } (candele a 5 minuti della seduta di oggi, come da Yahoo)
function riskFromSeries(S) {
  S = S || {};
  const last = (o) => (o && o.bars && o.bars.length ? o.bars[o.bars.length - 1].t : 0);
  const T = Math.max(0, ...Object.values(S).map(last)); if (!T || !S.vix) return null;
  const at = (o, t) => { if (!o || !o.bars) return null; let v = null; for (let i = 0; i < o.bars.length; i++) { if (o.bars[i].t <= t) v = o.bars[i].c; else break; } return v; };
  const pct = (o, t) => { const v = at(o, t); return v == null || !o.prev ? null : (v / o.prev - 1) * 100; };
  const series = []; let rLast = null;
  for (let t = Math.floor((T - LOOKBACK) / SLOT) * SLOT; t <= T; t += SLOT) {
    const vv = at(S.vix, t); if (vv == null || !S.vix.prev) continue;
    const q = { vix: { price: vv, changePercent: (vv / S.vix.prev - 1) * 100 } };
    for (const k of ['sp500', 'nasdaq', 'dow']) { const p = pct(S[k], t); if (p !== null) q[k] = { changePercent: p }; }
    const dp = pct(S.dxy, t); if (dp !== null) q.dxy = { changePercent: dp };
    const r = riskFromQuotes(q); if (r) { series.push(r.score); rLast = r; }
  }
  if (!series.length || !rLast) return null;
  let st = null, sm = 0;
  for (let i = 0; i < series.length; i++) { const w = series.slice(Math.max(0, i - WINDOW + 1), i + 1); sm = w.reduce((a, b) => a + b, 0) / w.length; st = stateOf(sm, st); }
  return { ...rLast, score: Math.round(sm), label: st, rawScore: rLast.score, asof: new Date(T).toISOString(), method: 'prezzi · media 1 ora + isteresi', samples: series.length };
}

// Legge le candele a 5 minuti di oggi da Yahoo e calcola il verdetto. Se qualche fonte manca ma restano i dati essenziali si usa quello che c'è; se non basta torna null.
async function getRisk() {
  const { fetchYahooChart } = require('./yahoo');
  const SYM = { sp500: '^GSPC', nasdaq: '^NDX', dow: '^DJI', vix: '^VIX', dxy: 'DX-Y.NYB' };
  const S = {};
  await Promise.all(Object.entries(SYM).map(async ([k, s]) => {
    try {
      const r = await fetchYahooChart(s, '1d', '5m'); const ts = r.timestamp || [], cl = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
      const bars = []; ts.forEach((t, i) => { if (cl[i] != null) bars.push({ t: t * 1000, c: cl[i] }); });
      const prev = r.meta && (r.meta.chartPreviousClose != null ? r.meta.chartPreviousClose : r.meta.previousClose);
      if (bars.length && prev) S[k] = { bars, prev };
    } catch (e) { /* una fonte mancante non blocca le altre */ }
  }));
  return riskFromSeries(S);
}

// Una frase pronta per i prompt dell'AI: il verdetto è un FATTO, non da rimettere in discussione.
function riskFact(r) {
  if (!r) return '';
  const f = (x, d = 1) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d).replace('.', ',') + '%';
  return `REGIME DI RISCHIO DI OGGI (calcolato dai prezzi, uguale per tutti: NON modificarlo né proporne un altro): ${r.label} ${r.score}/100 — azionario ${f(r.inputs.equityPct)} (media S&P 500/Nasdaq 100/Dow), VIX ${String(r.inputs.vix.toFixed(1)).replace('.', ',')}`
    + (r.inputs.vixPct != null ? ` (${f(r.inputs.vixPct)})` : '') + (r.inputs.dxyPct != null ? `, dollaro ${f(r.inputs.dxyPct, 2)}` : '')
    + `. Il commento deve essere coerente con ${r.label}; non scrivere etichette diverse (RISK-ON/RISK-OFF/NEUTRALE) riferite al mercato di oggi.`;
}

module.exports = { riskFromQuotes, riskFromSeries, getRisk, riskFact, labelOf, OFF_MAX, ON_MIN };
