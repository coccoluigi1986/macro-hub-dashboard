// lib/heatmap.js
//
// Dati per la pagina "Heatmap azioni": le azioni di S&P 500 e Nasdaq-100 con prezzo, variazione del giorno e capitalizzazione REALI, e per ognuna l'azienda e il settore GICS.
//  · La composizione degli indici e i settori stanno in lib/heatmap-data.json (istantanea ricavata da Wikipedia, dal Nasdaq e da Yahoo; si rigenera con bozze/heatmap/costruisci-dati.js
//    quando cambiano gli indici, circa ogni trimestre). I prezzi non sono mai scritti a mano: arrivano ogni volta dalla rete.
//  · Nasdaq-100: elenco quotato del Nasdaq (api.nasdaq.com, una sola chiamata) e, se non risponde, Yahoo Finance.
//  · S&P 500: Yahoo Finance (finestre da 50 titoli). Se Yahoo non dà la capitalizzazione in tempo reale si usa prezzo × azioni in circolazione dell'istantanea.
//
// Usato da api/market-data.js con ?view=heatmap&index=sp500|nasdaq100.

const DATA = require('./heatmap-data.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

let _crumb = null;   // { cookie, crumb, at }: Yahoo richiede un cookie e un "crumb" per l'elenco di quotazioni
async function yahooSession(force) {
  if (!force && _crumb && Date.now() - _crumb.at < 25 * 60 * 1000) return _crumb;
  const f = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(6000) });
  const cookie = (f.headers.getSetCookie ? f.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
  const r = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, cookie }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('crumb Yahoo ' + r.status);
  _crumb = { cookie, crumb: await r.text(), at: Date.now() };
  return _crumb;
}
async function yahooQuotes(symbols) {
  const out = {};
  const batches = []; for (let i = 0; i < symbols.length; i += 50) batches.push(symbols.slice(i, i + 50));
  let sess = await yahooSession(false);
  const one = async (part, retry) => {
    const r = await fetch('https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + part.join(',') + '&crumb=' + encodeURIComponent(sess.crumb), { headers: { 'User-Agent': UA, cookie: sess.cookie }, signal: AbortSignal.timeout(8000) });
    if ((r.status === 401 || r.status === 403) && !retry) { sess = await yahooSession(true); return one(part, true); }
    if (!r.ok) throw new Error('quote Yahoo ' + r.status);
    const j = await r.json();
    for (const q of (j.quoteResponse && j.quoteResponse.result) || []) out[q.symbol] = { p: q.regularMarketPrice, c: q.regularMarketChangePercent, cap: q.marketCap, t: q.regularMarketTime };
  };
  await Promise.all(batches.map((b) => one(b, false).catch(() => {})));
  return out;
}
const num = (s) => { const n = Number(String(s || '').replace(/[$,%+\s,]/g, '')); return isFinite(n) && String(s || '').trim() !== '' ? n : null; };
async function nasdaqList() {
  const r = await fetch('https://api.nasdaq.com/api/quote/list-type/nasdaq100', { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Nasdaq ' + r.status);
  const j = await r.json(); const out = {};
  for (const x of j.data.data.rows) out[x.symbol.replace(/\./g, '-').toUpperCase()] = { p: num(x.lastSalePrice), c: num(x.percentageChange), cap: num(x.marketCap) };
  return out;
}

const _cache = {};
async function getHeatmap(index) {
  const key = index === 'nasdaq100' ? 'nasdaq100' : 'sp500';
  if (_cache[key] && Date.now() - _cache[key].at < 90 * 1000) return _cache[key].out;
  const members = DATA[key], symbols = members.map((m) => m.s);
  let quotes = {}, source = '';
  if (key === 'nasdaq100') { try { quotes = await nasdaqList(); source = 'Nasdaq'; } catch (e) { /* si ripiega su Yahoo */ } }
  if (!Object.keys(quotes).length) { quotes = await yahooQuotes(symbols); source = 'Yahoo Finance'; }
  else { // il Nasdaq non include qualche titolo o prezzo: si completa con Yahoo solo se serve
    const miss = symbols.filter((s) => !quotes[s] || quotes[s].c == null);
    if (miss.length) { try { Object.assign(quotes, await yahooQuotes(miss)); } catch (e) { /* restano grigi */ } }
  }
  let ts = 0;
  const items = members.map((m) => {
    const q = quotes[m.s] || {}, sh = DATA.shares[m.s] || 0;
    const cap = q.cap > 0 ? q.cap : (q.p > 0 && sh > 0 ? q.p * sh : sh);   // ultima risorsa: la sola istantanea, per non perdere il titolo
    if (q.t && q.t > ts) ts = q.t;
    return { s: m.s, n: m.n, sec: m.sec, ind: m.ind || '', p: q.p == null ? null : +Number(q.p).toFixed(2), c: q.c == null ? null : +Number(q.c).toFixed(2), cap: Math.round(cap || 0) };
  });
  const out = { index: key, source, generatedAt: new Date().toISOString(), marketTime: ts ? new Date(ts * 1000).toISOString() : null, composizione: { dal: DATA.asOf, fonte: DATA.fonte }, count: items.length, withData: items.filter((i) => i.c != null).length, items };
  if (out.withData > items.length * 0.5) _cache[key] = { at: Date.now(), out };
  return out;
}
// ---------- scheda di una singola azione: tutti i dati reali, il grafico a un anno e gli indicatori calcolati sul grafico ----------
const ALL = {}; [...DATA.sp500, ...DATA.nasdaq100].forEach((m) => { ALL[m.s] = m; });
const symOk = (s) => /^[A-Z0-9-]{1,8}$/.test(String(s || '')) && !!ALL[s];   // solo i titoli dei due indici: l'endpoint non fa da ponte per simboli qualsiasi
const media = (a, n) => (a.length >= n ? a.slice(-n).reduce((s, x) => s + x, 0) / n : null);
function rsi14(c) {   // RSI di Wilder a 14 giorni: sotto 30 il titolo ha ceduto molto in fretta (ipervenduto), sopra 70 è salito molto in fretta (ipercomprato)
  const n = 14; if (c.length <= n) return null;
  let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
async function chart1y(symbol) {
  const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=1y&interval=1d', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error('grafico Yahoo ' + r.status);
  const j = await r.json(), res = j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.timestamp) throw new Error('grafico non disponibile');
  const q = res.indicators.quote[0], pts = [];
  for (let i = 0; i < res.timestamp.length; i++) if (q.close[i] != null) pts.push({ t: res.timestamp[i] * 1000, c: q.close[i] });
  return { pts, meta: res.meta || {} };
}
async function quoteFull(symbol) {
  let sess = await yahooSession(false);
  const go = () => fetch('https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(symbol) + '&crumb=' + encodeURIComponent(sess.crumb), { headers: { 'User-Agent': UA, cookie: sess.cookie }, signal: AbortSignal.timeout(8000) });
  let r = await go(); if (r.status === 401 || r.status === 403) { sess = await yahooSession(true); r = await go(); }
  if (!r.ok) throw new Error('quote Yahoo ' + r.status);
  const j = await r.json(); return (j.quoteResponse && j.quoteResponse.result && j.quoteResponse.result[0]) || null;
}
const _stock = {};
async function getStock(symbol) {
  if (!symOk(symbol)) throw new Error('simbolo non valido');
  if (_stock[symbol] && Date.now() - _stock[symbol].at < 90 * 1000) return _stock[symbol].out;
  const [q, ch] = await Promise.all([quoteFull(symbol).catch(() => null), chart1y(symbol)]);
  const pts = ch.pts, cl = pts.map((p) => p.c), last = cl[cl.length - 1], m = ch.meta, me = ALL[symbol];
  const pr = q && q.regularMarketPrice != null ? q.regularMarketPrice : (m.regularMarketPrice != null ? m.regularMarketPrice : last);
  const perf = (n) => (cl.length > n && cl[cl.length - 1 - n] > 0 ? (last / cl[cl.length - 1 - n] - 1) * 100 : null);
  const yr = new Date().getUTCFullYear(); let base = null; for (let i = pts.length - 1; i >= 0; i--) { if (new Date(pts[i].t).getUTCFullYear() < yr) { base = pts[i].c; break; } }
  const ytd = base ? (last / base - 1) * 100 : (pts.length ? (last / pts[0].c - 1) * 100 : null);
  const rets = []; for (let i = 1; i < cl.length; i++) rets.push(Math.log(cl[i] / cl[i - 1]));
  const mu = rets.reduce((s, x) => s + x, 0) / (rets.length || 1), vol = rets.length > 20 ? Math.sqrt(rets.reduce((s, x) => s + (x - mu) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252) * 100 : null;
  const hi = q && q.fiftyTwoWeekHigh != null ? q.fiftyTwoWeekHigh : Math.max(...cl), lo = q && q.fiftyTwoWeekLow != null ? q.fiftyTwoWeekLow : Math.min(...cl);
  const nowS = Date.now() / 1000, nx = q ? [q.earningsTimestampStart, q.earningsTimestamp, q.earningsTimestampEnd].filter((x) => x && x > nowS).sort((a, b) => a - b)[0] : null;
  const rnd = (v, d) => (v == null || !isFinite(v) ? null : +Number(v).toFixed(d));
  const out = {
    symbol, name: me.n, sec: me.sec, ind: me.ind || '', exchange: (q && q.fullExchangeName) || m.fullExchangeName || '', currency: (q && q.currency) || m.currency || 'USD', marketState: q ? q.marketState : null,
    time: new Date(((q && q.regularMarketTime) || m.regularMarketTime || nowS) * 1000).toISOString(), generatedAt: new Date().toISOString(),
    price: rnd(pr, 2), change: rnd(q ? q.regularMarketChange : null, 2), changePct: rnd(q ? q.regularMarketChangePercent : null, 2), prevClose: rnd(q ? q.regularMarketPreviousClose : m.chartPreviousClose, 2),
    open: rnd(q ? q.regularMarketOpen : null, 2), dayHigh: rnd(q ? q.regularMarketDayHigh : m.regularMarketDayHigh, 2), dayLow: rnd(q ? q.regularMarketDayLow : m.regularMarketDayLow, 2),
    volume: q ? q.regularMarketVolume : m.regularMarketVolume, avgVol3m: q ? q.averageDailyVolume3Month : null, avgVol10d: q ? q.averageDailyVolume10Day : null,
    wk52High: rnd(hi, 2), wk52Low: rnd(lo, 2), ma50: rnd(media(cl, 50), 2), ma200: rnd(media(cl, 200), 2),
    cap: q && q.marketCap ? q.marketCap : Math.round(pr * (DATA.shares[symbol] || 0)), shares: (q && q.sharesOutstanding) || DATA.shares[symbol] || null,
    pe: rnd(q ? q.trailingPE : null, 1), fpe: rnd(q ? q.forwardPE : null, 1), eps: rnd(q ? q.epsTrailingTwelveMonths : null, 2), feps: rnd(q ? q.epsForward : null, 2), pb: rnd(q ? q.priceToBook : null, 1),
    divRate: rnd(q ? q.dividendRate : null, 2), divYield: rnd(q ? q.dividendYield : null, 2), rating: q && q.averageAnalystRating ? q.averageAnalystRating : null,
    nextEarnings: nx ? new Date(nx * 1000).toISOString() : null,
    perf: { w1: rnd(perf(5), 2), m1: rnd(perf(21), 2), m3: rnd(perf(63), 2), m6: rnd(perf(126), 2), ytd: rnd(ytd, 2), y1: rnd(pts.length > 200 ? (last / pts[0].c - 1) * 100 : null, 2) },
    rsi: rnd(rsi14(cl), 0), vol: rnd(vol, 0), hist: pts.map((p) => [Math.round(p.t / 1000), rnd(p.c, 2)]),
  };
  _stock[symbol] = { at: Date.now(), out };
  return out;
}
// ultime notizie sul titolo (Yahoo Finance, ricerca per sigla): si tengono solo i titoli che nominano davvero l'azienda o la sigla, non i comunicati stampa; titoli tradotti in italiano
const _news = {};
async function getStockNews(symbol) {
  if (!symOk(symbol)) throw new Error('simbolo non valido');
  if (_news[symbol] && Date.now() - _news[symbol].at < 5 * 60 * 1000) return _news[symbol].out;
  const r = await fetch('https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(symbol) + '&quotesCount=0&newsCount=12&lang=en-US', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('notizie Yahoo ' + r.status);
  const j = await r.json();
  const nome = String(ALL[symbol].n || '').replace(/,?\s+(Inc\.?|Corporation|Corp\.?|Co\.?|Company|Ltd\.?|plc|Holdings?|Group|Class [A-C]).*$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim();
  const re = new RegExp('\\b(' + (nome.length > 2 ? nome + '|' : '') + symbol.replace('-', '[-.]') + ')\\b', 'i');
  const items = (j.news || []).filter((n) => n && n.title && re.test(n.title) && !/(pr newswire|globenewswire|business wire|accesswire)/i.test(n.publisher || '')).slice(0, 6);
  let tr = new Map(); try { const { translateAll } = require('./news-feed'); const m = await translateAll(items.map((n) => n.title), 4000); tr = m; } catch (e) { /* titoli in inglese */ }
  const out = { symbol, generatedAt: new Date().toISOString(), items: items.map((n) => ({ title: tr.get(n.title) || n.title, orig: n.title, source: n.publisher || '', url: n.link, published: new Date(n.providerPublishTime * 1000).toISOString(), it: tr.has(n.title) })) };
  _news[symbol] = { at: Date.now(), out };
  return out;
}
module.exports = { getHeatmap, getStock, getStockNews };
