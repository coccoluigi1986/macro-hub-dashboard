// api/market-data.js
//
// Serverless Function (Vercel): prezzi di mercato REALI (indici, metalli, petrolio, VIX, EUR/USD)
// da Yahoo Finance — nessuna chiave richiesta.
//
// STORIA DI QUESTO FILE:
// - v1 usava ETF come proxy per gli indici (SPY per S&P 500, ecc.) — sbagliato, il prezzo di un
//   ETF non è il valore dell'indice.
// - v2 usava Twelve Data con i ticker diretti degli indici (SPX/NDX/DJI). Il piano gratuito
//   collegato a questo progetto ha smesso di coprirli: risponde "not available with your plan"
//   per indici, oro, argento, VIX e WTI, lasciando solo EUR/USD funzionante — verificato
//   direttamente controllando le risposte reali dell'endpoint.
// - v3 (questa): Yahoo Finance (endpoint pubblico "chart", vedi lib/yahoo.js), che copre tutti
//   questi simboli senza bisogno di alcuna chiave.
//
// ?view=volatility → volatilità reale per asset (candele orarie, per ora del giorno e per giorno della settimana), lib/volatility.js.
// Sta qui perché il piano gratuito di Vercel consente al massimo 12 funzioni e sono tutte usate.
//
// Raggiungibile su: https://tuosito.vercel.app/api/market-data

const { toVercelHandler } = require('../lib/vercel-adapter');
const { fetchYahooQuote } = require('../lib/yahoo');
const { fetchPositioning } = require('../lib/positioning');
const { getVolatility } = require('../lib/volatility');

const SYMBOLS = {
  sp500:  '^GSPC',   // S&P 500
  nasdaq: '^NDX',    // Nasdaq 100
  dow:    '^DJI',    // Dow Jones Industrial Average
  gold:   'GC=F',    // Oro futures (COMEX)
  silver: 'SI=F',    // Argento futures (COMEX)
  wti:    'CL=F',    // Petrolio WTI futures (NYMEX)
  vix:    '^VIX',    // Indice di volatilità CBOE
  eurusd: 'EURUSD=X',
  gbpusd: 'GBPUSD=X',
  dxy:    'DX-Y.NYB', // US Dollar Index reale (ICE) — il "proxy" da cambi BCE di fx-data.js sta ~7 punti sotto
  us10y:  '^TNX',    // Rendimento Treasury 10Y, già in % (5.19 = 5,19%)
  brent:  'BZ=F',    // Brent futures
  usdjpy: 'JPY=X',    // USD/JPY (prima da Frankfurter/BCE tramite fx-data.js, rimosso per il limite di 12 funzioni)
  russell:'^RUT',    // Russell 2000
};

async function handleEvent(event) {
  const params = (event && event.queryStringParameters) || {};
  if (params.view === 'volatility') {
    try {
      const vol = await getVolatility();
      // 1 ora: il profilo di volatilità cambia lentamente; se qualche asset non ha risposto, cache breve per riprovare presto
      const maxAge = vol.assets.some((x) => x.error) ? 120 : 3600;
      return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + maxAge }, body: JSON.stringify(vol) };
    } catch (err) {
      // errore: cache brevissima, così un problema transitorio non resta "congelato"
      return { statusCode: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' }, body: JSON.stringify({ error: err.message }) };
    }
  }
  try {
    // Fear & Greed (CNN) e AAII, insieme ai prezzi: fetchPositioning non lancia mai, ogni indicatore
    // non raggiungibile torna semplicemente null.
    const positioningPromise = fetchPositioning();
    const entries = await Promise.all(
      Object.entries(SYMBOLS).map(async ([key, sym]) => {
        try {
          const q = await fetchYahooQuote(sym);
          if (q.price === null) return [key, { error: `Prezzo mancante nella risposta per ${sym}.` }];
          return [key, q];
        } catch (e) {
          return [key, { error: e.message }];
        }
      })
    );
    const data = Object.fromEntries(entries);
    const errors = entries.filter(([, v]) => v.error).map(([k, v]) => `${k} (${SYMBOLS[k]}): ${v.error}`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=120',
      },
      body: JSON.stringify({
        updatedAt: new Date().toISOString(),
        source: 'Yahoo Finance (endpoint pubblico "chart")',
        parseWarning: errors.length ? `Simboli non disponibili: ${errors.join(' | ')}` : null,
        data,
        positioning: await positioningPromise,
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
