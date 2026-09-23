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
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
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
  return {
    price: meta.regularMarketPrice != null ? meta.regularMarketPrice : null,
    changePercent: meta.regularMarketChangePercent != null ? meta.regularMarketChangePercent : null,
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
