// lib/yahoo.js
//
// Client minimale per l'endpoint pubblico "chart" di Yahoo Finance — non è un'API ufficialmente
// documentata da Yahoo per uso di terzi, ma è l'endpoint pubblico ampiamente usato da strumenti
// come la libreria yfinance, stabile da anni, gratuito e senza chiave. Usato al posto di Twelve
// Data per i simboli che il piano gratuito di Twelve Data collegato a questo progetto non copre
// più (indici, oro/argento, VIX, WTI rispondono "not available with your plan" sia su /quote sia
// su /time_series — verificato direttamente). Richiede uno User-Agent da browser, altrimenti
// risponde 429.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchYahooChart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  // Un nuovo tentativo su 429 / 5xx: con tante richieste insieme (prezzi, correlazioni, analisi AI) Yahoo ne rifiuta qualcuna per un attimo,
  // e senza ripetere la card restava "—" fino al giro successivo.
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status !== 429 && res.status < 500) break;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
  }
  if (!res.ok) throw new Error(`Yahoo Finance error ${res.status} per ${symbol}`);
  const json = await res.json();
  const result = json.chart && json.chart.result && json.chart.result[0];
  if (!result) throw new Error(`Yahoo Finance: nessun dato per ${symbol}`);
  return result;
}

// Prezzo attuale + variazione % del giorno per un singolo simbolo.
async function fetchYahooQuote(symbol) {
  const result = await fetchYahooChart(symbol, '2d', '1d');
  const meta = result.meta || {};
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : null;
  let changePercent = meta.regularMarketChangePercent != null ? meta.regularMarketChangePercent : null;
  // A volte Yahoo manda per un simbolo una variazione "ferma" che contraddice le sue stesse chiusure giornaliere (visto il 13-14 nov 2026 sul dollaro DX-Y.NYB:
  // −0,001% mentre le chiusure davano 103,17 → 103,41 = +0,23%, e EUR/USD scendeva dello 0,29%). Se l'ultima chiusura coincide col prezzo (quindi la serie è
  // coerente) e la variazione di Yahoo si discosta di più di 0,15 punti da quella delle due ultime chiusure, vale quella delle chiusure. Negli altri casi non cambia nulla.
  const closes = ((result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || []).filter((c) => c != null);
  if (price != null && closes.length >= 2) {
    const last = closes[closes.length - 1], prev = closes[closes.length - 2];
    const barPct = prev ? ((last - prev) / prev) * 100 : null;
    if (barPct != null && Math.abs(last - price) / price < 0.0005 && (changePercent == null || Math.abs(changePercent - barPct) > 0.15)) changePercent = Math.round(barPct * 1000) / 1000;
  }
  return {
    price,
    changePercent,
    previousClose: meta.chartPreviousClose != null ? meta.chartPreviousClose : null,
  };
}

// Serie storica giornaliera {data ISO -> chiusura} per un simbolo, ultimi ~2 mesi — abbastanza
// per una correlazione a 30 giorni di trading con margine per weekend/festivi.
async function fetchYahooSeries(symbol) {
  const result = await fetchYahooChart(symbol, '2mo', '1d');
  const series = new Map();
  const timestamps = result.timestamp || [];
  const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
  timestamps.forEach((t, i) => {
    const c = closes[i];
    if (c != null) series.set(new Date(t * 1000).toISOString().slice(0, 10), c);
  });
  return series;
}

module.exports = { fetchYahooQuote, fetchYahooSeries };
