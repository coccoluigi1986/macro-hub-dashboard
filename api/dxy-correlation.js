// api/dxy-correlation.js
//
// Serverless Function (Vercel): correlazione REALE a 30 giorni tra il DXY e ogni asset
// mostrato in "Mercati — Asset Monitor", calcolata su serie storiche vere invece delle
// stime scritte a mano che c'erano prima nel campo "corr" di marketData.
//
// METODOLOGIA: correlazione di Pearson sui RENDIMENTI GIORNALIERI (variazione % giorno
// su giorno, non sui livelli di prezzo) degli ultimi 30 giorni di trading in comune tra
// la serie del DXY e quella dell'asset. Si usano i rendimenti e non i livelli perché due
// serie di prezzo non stazionarie con lo stesso trend darebbero correlazioni spurie anche
// senza nessun legame reale giorno per giorno.
//
// FONTI:
// - Frankfurter.app (dati BCE, gratis, nessuna chiave) per la serie storica giornaliera
//   del DXY proxy e dei cambi EUR/USD, GBP/USD — stessa formula ICE già usata
//   (in versione "solo oggi") da fx-data.js.
// - Twelve Data (time_series) per indici, metalli, petrolio, VIX — stessa API key già
//   usata da market-data.js.
// - Financial Modeling Prep (treasury-rates) per lo yield US 10Y, che Twelve Data non
//   copre sul piano gratuito.
//
// SETUP RICHIESTO (in aggiunta a TWELVEDATA_API_KEY, già configurata per market-data.js):
// 1. Registrati gratis su https://site.financialmodelingprep.com (piano Free)
// 2. Su Vercel: Project settings → Environment Variables → aggiungi FMP_API_KEY
// 3. Raggiungibile su: https://tuosito.vercel.app/api/dxy-correlation
//
// Se FMP_API_KEY non è configurata, tutto il resto funziona lo stesso: manca solo la
// correlazione per l'US 10Y Yield (data.us10y torna con un errore esplicito).

const { toVercelHandler } = require('../lib/vercel-adapter');

const TD_SYMBOLS = {
  sp500:  'SPX',
  nasdaq: 'NDX',
  dow:    'DJI',
  gold:   'XAU/USD',
  silver: 'XAG/USD',
  wti:    'WTI/USD',
  vix:    'VIX',
};

const LOOKBACK_DAYS = 30;        // finestra di correlazione richiesta (giorni di trading in comune)
const FETCH_CALENDAR_DAYS = 60;  // margine di giorni di calendario richiesti alle fonti, per compensare weekend/festivi e disallineamenti fra mercati
const TD_OUTPUTSIZE = LOOKBACK_DAYS + 25; // margine di sedute richieste a Twelve Data

function isoDate(d) { return d.toISOString().slice(0, 10); }

// Serie storica del DXY proxy + dei cambi EUR/USD, GBP/USD dalla stessa fonte, giorno per
// giorno, con la formula ICE ufficiale (peso SEK mancante redistribuito sulle altre 5
// valute) — identica a quella "snapshot" di fx-data.js ma calcolata per ogni data.
async function fetchDxyProxySeries() {
  const end = new Date();
  const start = new Date(end.getTime() - FETCH_CALENDAR_DAYS * 24 * 3600 * 1000);
  const url = `https://api.frankfurter.app/${isoDate(start)}..${isoDate(end)}?from=USD&to=EUR,GBP,JPY,CHF,AUD,CAD`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Frankfurter API error: ${res.status}`);
  const json = await res.json();

  const dxy = new Map();
  const eurusd = new Map();
  const gbpusd = new Map();

  Object.entries(json.rates || {}).forEach(([date, r]) => {
    if (!(r.EUR && r.JPY && r.GBP && r.CAD && r.CHF)) return;
    const e = 1 / r.EUR;
    const level = (
      50.14348112 *
      Math.pow(e, -0.576 / 0.958) *
      Math.pow(r.JPY, 0.136 / 0.958) *
      Math.pow(1 / r.GBP, -0.119 / 0.958) *
      Math.pow(r.CAD, 0.091 / 0.958) *
      Math.pow(r.CHF, 0.036 / 0.958)
    );
    dxy.set(date, level);
    eurusd.set(date, e);
    gbpusd.set(date, 1 / r.GBP);
  });

  return { dxy, eurusd, gbpusd };
}

// Serie storiche indici/metalli/petrolio/VIX da Twelve Data (richiesta unica, batch per simbolo).
async function fetchTwelveDataSeries(apiKey) {
  const symbolList = Object.values(TD_SYMBOLS).join(',');
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbolList)}&interval=1day&outputsize=${TD_OUTPUTSIZE}&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Twelve Data time_series error: ${res.status}`);
  const raw = await res.json();

  const out = {};
  Object.entries(TD_SYMBOLS).forEach(([key, sym]) => {
    // Con più simboli nella stessa richiesta, Twelve Data risponde con un oggetto per simbolo;
    // con un solo simbolo risponderebbe direttamente con {meta, values, status} — copriamo entrambi.
    const entry = raw[sym] || (raw.meta && raw.meta.symbol === sym ? raw : null);
    const series = new Map();
    if (entry && Array.isArray(entry.values)) {
      entry.values.forEach(v => {
        const c = parseFloat(v.close);
        if (!isNaN(c) && v.datetime) series.set(v.datetime.slice(0, 10), c);
      });
    }
    out[key] = series;
  });
  return out;
}

// Serie storica dello yield US 10Y da FMP (Twelve Data non lo copre sul piano gratuito).
async function fetchTreasurySeries(apiKey) {
  const end = new Date();
  const start = new Date(end.getTime() - FETCH_CALENDAR_DAYS * 24 * 3600 * 1000);
  const url = `https://financialmodelingprep.com/stable/treasury-rates?from=${isoDate(start)}&to=${isoDate(end)}&apikey=${apiKey}`;
  const res = await fetch(url);
  const series = new Map();
  if (!res.ok) return series;
  const raw = await res.json();
  if (Array.isArray(raw)) {
    raw.forEach(r => { if (r.date && r.year10 != null) series.set(r.date, r.year10); });
  }
  return series;
}

// Trasforma una serie di livelli {data -> valore} in una serie di rendimenti % giorno su giorno.
function dailyReturns(levelSeries) {
  const entries = [...levelSeries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const rets = new Map();
  for (let i = 1; i < entries.length; i++) {
    const [, c0] = entries[i - 1];
    const [d1, c1] = entries[i];
    if (c0 && c1 != null) rets.set(d1, (c1 - c0) / c0);
  }
  return rets;
}

function pearson(a, b) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    sa += a[i]; sb += b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i];
  }
  const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
  if (!den) return null;
  return (n * sab - sa * sb) / den;
}

// Allinea due serie di rendimenti sulle date in comune e calcola la correlazione sugli ultimi
// LOOKBACK_DAYS punti in comune. Richiede almeno 10 punti per considerare il dato affidabile.
function correlate(dxyRets, assetRets) {
  const common = [...dxyRets.keys()].filter(d => assetRets.has(d)).sort();
  const recent = common.slice(-LOOKBACK_DAYS);
  if (recent.length < 10) return { corr: null, n: recent.length };
  const a = recent.map(d => dxyRets.get(d));
  const b = recent.map(d => assetRets.get(d));
  return { corr: pearson(a, b), n: recent.length };
}

async function handleEvent(event) {
  const tdKey = process.env.TWELVEDATA_API_KEY;
  const fmpKey = process.env.FMP_API_KEY;
  if (!tdKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'TWELVEDATA_API_KEY non configurata nelle Environment Variables di Vercel' }),
    };
  }

  try {
    const [{ dxy, eurusd, gbpusd }, tdSeries, treasurySeries] = await Promise.all([
      fetchDxyProxySeries(),
      fetchTwelveDataSeries(tdKey),
      fmpKey ? fetchTreasurySeries(fmpKey) : Promise.resolve(new Map()),
    ]);

    const dxyRets = dailyReturns(dxy);
    const data = {};
    const warnings = [];

    const priceSeries = {
      sp500: tdSeries.sp500, nasdaq: tdSeries.nasdaq, dow: tdSeries.dow,
      gold: tdSeries.gold, silver: tdSeries.silver, wti: tdSeries.wti, vix: tdSeries.vix,
      eurusd, gbpusd,
    };
    Object.entries(priceSeries).forEach(([key, series]) => {
      if (!series || series.size === 0) {
        data[key] = { corr: null, n: 0, error: 'Serie storica non disponibile' };
        warnings.push(key);
        return;
      }
      const { corr, n } = correlate(dxyRets, dailyReturns(series));
      data[key] = { corr: corr == null ? null : Number(corr.toFixed(2)), n };
      if (corr == null) warnings.push(key);
    });

    if (treasurySeries.size) {
      const { corr, n } = correlate(dxyRets, dailyReturns(treasurySeries));
      data.us10y = { corr: corr == null ? null : Number(corr.toFixed(2)), n };
      if (corr == null) warnings.push('us10y');
    } else {
      data.us10y = { corr: null, n: 0, error: fmpKey ? 'Serie storica non disponibile' : 'FMP_API_KEY non configurata' };
      warnings.push('us10y');
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600', // cache 1 ora, una correlazione a 30g non cambia sensibilmente infragiornata
      },
      body: JSON.stringify({
        updatedAt: new Date().toISOString(),
        source: 'Correlazione di Pearson sui rendimenti giornalieri — DXY proxy (Frankfurter/BCE) vs Twelve Data + FMP treasury-rates',
        lookbackDays: LOOKBACK_DAYS,
        parseWarning: warnings.length ? `Correlazione non calcolabile per: ${warnings.join(', ')}` : null,
        data,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
}

module.exports = toVercelHandler(handleEvent);
