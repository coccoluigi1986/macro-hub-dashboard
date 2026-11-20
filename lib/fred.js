// lib/fred.js
//
// Dati macro USA REALI e ufficiali dalla Federal Reserve Economic Data (FRED) — gratuita.
// Usato sia da api/fred-data.js (card macro, "Cosa prezza il mercato") sia da api/narrative.js
// (grounding delle analisi AI: l'AI deve citare solo numeri veri, non inventarli).
//
// SETUP: Vercel → Project settings → Environment Variables → FRED_API_KEY
// (chiave gratuita su https://fred.stlouisfed.org/docs/api/api_key.html).

const SERIES = {
  cpi_yoy:        'CPIAUCSL',   // CPI headline (indice, va trasformato in % YoY)
  core_cpi_yoy:   'CPILFESL',   // Core CPI (indice)
  unemployment:   'UNRATE',     // Tasso di disoccupazione (%)
  nfp:            'PAYEMS',     // Occupati non agricoli (migliaia, va calcolata la variazione mensile)
  fed_funds:      'DFF',        // Tasso Fed Funds effettivo giornaliero
  fed_target_up:  'DFEDTARU',   // Target range Fed — limite superiore
  fed_target_lo:  'DFEDTARL',   // Target range Fed — limite inferiore
  gdp:            'GDPC1',      // PIL REALE trimestrale (chained dollars) — NON usare 'GDP' (nominale, include inflazione)
  ppi_yoy:        'PPIFIS',     // Producer Price Index — Final Demand (la serie "PPI" standard citata dai media/trader)
  // ---- serie per "Cosa prezza il mercato" (sentiero Fed implicito, breakeven, curva) ----
  tbill_3m:       'DTB3',       // T-Bill 3 mesi — vs Fed funds effettivo = sentiero Fed atteso a 3 mesi
  treasury_1y:    'DGS1',       // Treasury 1 anno — vs Fed funds effettivo = sentiero Fed atteso a 12 mesi
  breakeven_5y:   'T5YIE',      // Inflazione media attesa dal mercato a 5 anni
  breakeven_10y:  'T10YIE',     // Inflazione media attesa dal mercato a 10 anni
  real_10y:       'DFII10',     // Rendimento reale TIPS a 10 anni
  nominal_10y:    'DGS10',      // Treasury 10 anni nominale
  curve_10y2y:    'T10Y2Y',     // Spread 10Y-2Y (già in punti percentuali, va convertito in pb)
};

const { fredFetch } = require('./fred-fetch');

async function fetchSeries(seriesId, apiKey) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=16`;   // 16: bastano a coprire un mese mancante nell'anno su anno
  const res = await fredFetch(url);
  if (!res.ok) throw new Error(`FRED error for ${seriesId}: ${res.status}`);
  const data = await res.json();
  return data.observations || [];
}

// Variazione % anno-su-anno da una serie mensile (indice), CALCOLATA PER DATA: ogni mese si confronta con lo stesso mese dell'anno prima.
// Prima si leggeva "l'osservazione numero 12", ma FRED a volte ha righe vuote (".") e il conto per posizione sbaglia o manca: ottobre 2025 non è mai stato
// pubblicato (shutdown del governo USA), quindi per ottobre 2026 l'anno su anno non esiste e il CPI risultava null. Si usa l'ultimo mese che ha il confronto
// (come le fonti ufficiali: Core CPI 2,6% di settembre). Le osservazioni arrivano dalla più recente alla più vecchia.
function yoyPoint(observations) {
  const v = (o) => (o && o.value !== undefined && o.value !== '.' ? parseFloat(o.value) : NaN);
  const by = new Map(observations.map((o) => [o.date.slice(0, 7), o]));
  for (const o of observations) {
    const latest = v(o); if (isNaN(latest)) continue;
    const year = +o.date.slice(0, 4) - 1, base = by.get(year + o.date.slice(4, 7)), yearAgo = v(base);
    if (!isNaN(yearAgo) && yearAgo !== 0) return { date: o.date, value: (((latest - yearAgo) / yearAgo) * 100).toFixed(1) };
  }
  return null;
}
function yoyChange(observations) { const p = yoyPoint(observations); return p ? p.value : null; }

// Calcola la crescita PIL trimestrale annualizzata (convenzione BEA) da due trimestri consecutivi.
// Usa la serie GDPC1 (PIL reale, chained dollars) — coerente con il modo in cui media e consensus
// di mercato riportano sempre la crescita del PIL. Non usare mai la serie 'GDP' (nominale): include
// l'inflazione e darebbe numeri molto più alti e non comparabili con le attese di consensus.
function gdpAnnualizedQoQ(observations) {
  if (observations.length < 2) return null;
  const latest = parseFloat(observations[0].value);
  const prev = parseFloat(observations[1].value);
  if (isNaN(latest) || isNaN(prev) || prev === 0) return null;
  const rate = (Math.pow(latest / prev, 4) - 1) * 100;
  return rate.toFixed(1);
}

// Calcola variazione mensile assoluta (per NFP, es. +23K)
function monthlyDelta(observations) {
  if (observations.length < 2) return null;
  const latest = parseFloat(observations[0].value);
  const prev = parseFloat(observations[1].value);
  if (isNaN(latest) || isNaN(prev)) return null;
  return Math.round(latest - prev); // in migliaia per PAYEMS
}

// Ultimo valore numerico disponibile in una serie (FRED a volte pubblica "." per i giorni senza rilevazione)
function latestValue(observations) {
  const obs = observations.find(o => o.value !== '.' && o.value !== undefined);
  if (!obs) return null;
  const v = parseFloat(obs.value);
  return isNaN(v) ? null : v;
}

// Cache in memoria per l'istanza serverless "calda": più sezioni AI chiedono lo stesso snapshot
// a pochi secondi di distanza, inutile rifare ~17 chiamate a FRED ogni volta.
let _cache = null;
const CACHE_MS = 30 * 60 * 1000;

async function fetchFredSnapshot(apiKey) {
  if (_cache && Date.now() - _cache.at < CACHE_MS) return _cache.data;

  const [cpi, coreCpi, unemployment, nfp, fedFunds, fedUp, fedLo, gdp, ppi,
    tbill3m, treasury1y, breakeven5y, breakeven10y, real10y, nominal10y, curve10y2y] = await Promise.all([
    fetchSeries(SERIES.cpi_yoy, apiKey),
    fetchSeries(SERIES.core_cpi_yoy, apiKey),
    fetchSeries(SERIES.unemployment, apiKey),
    fetchSeries(SERIES.nfp, apiKey),
    fetchSeries(SERIES.fed_funds, apiKey),
    fetchSeries(SERIES.fed_target_up, apiKey),
    fetchSeries(SERIES.fed_target_lo, apiKey),
    fetchSeries(SERIES.gdp, apiKey),
    fetchSeries(SERIES.ppi_yoy, apiKey),
    fetchSeries(SERIES.tbill_3m, apiKey),
    fetchSeries(SERIES.treasury_1y, apiKey),
    fetchSeries(SERIES.breakeven_5y, apiKey),
    fetchSeries(SERIES.breakeven_10y, apiKey),
    fetchSeries(SERIES.real_10y, apiKey),
    fetchSeries(SERIES.nominal_10y, apiKey),
    fetchSeries(SERIES.curve_10y2y, apiKey),
  ]);

  const effFunds = latestValue(fedFunds);
  const tbill3mVal = latestValue(tbill3m);
  const treasury1yVal = latestValue(treasury1y);
  const curveVal = latestValue(curve10y2y);

  const data = {
    cpiYoY: yoyChange(cpi),
    cpiDate: (yoyPoint(cpi) || {}).date || cpi[0]?.date || null,   // il mese a cui si riferisce l'anno su anno
    coreCpiYoY: yoyChange(coreCpi),
    unemploymentRate: unemployment[0]?.value || null,
    unemploymentDate: unemployment[0]?.date || null,
    nfpChangeThousands: monthlyDelta(nfp),
    nfpDate: nfp[0]?.date || null,
    fedFundsRate: fedFunds[0]?.value || null,
    fedTargetUpper: latestValue(fedUp),
    fedTargetLower: latestValue(fedLo),
    gdpAnnualizedQoQ: gdpAnnualizedQoQ(gdp),
    gdpDate: gdp[0]?.date || null,
    ppiYoY: yoyChange(ppi),
    // ---- "Cosa prezza il mercato" ----
    fedPathBps3m: (tbill3mVal !== null && effFunds !== null) ? Math.round((tbill3mVal - effFunds) * 100 * 10) / 10 : null,
    fedPathBps12m: (treasury1yVal !== null && effFunds !== null) ? Math.round((treasury1yVal - effFunds) * 100 * 10) / 10 : null,
    breakeven5y: latestValue(breakeven5y),
    breakeven10y: latestValue(breakeven10y),
    real10y: latestValue(real10y),
    nominal10y: latestValue(nominal10y),
    curve10y2yBps: curveVal !== null ? Math.round(curveVal * 100 * 10) / 10 : null,
  };
  _cache = { at: Date.now(), data };
  return data;
}

module.exports = { fetchFredSnapshot };
