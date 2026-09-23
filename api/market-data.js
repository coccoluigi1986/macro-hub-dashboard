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
// Raggiungibile su: https://tuosito.vercel.app/api/market-data

const { toVercelHandler } = require('../lib/vercel-adapter');
const { fetchYahooQuote } = require('../lib/yahoo');

const SYMBOLS = {
  sp500:  '^GSPC',   // S&P 500
  nasdaq: '^NDX',    // Nasdaq 100
  dow:    '^DJI',    // Dow Jones Industrial Average
  gold:   'GC=F',    // Oro futures (COMEX)
  silver: 'SI=F',    // Argento futures (COMEX)
  wti:    'CL=F',    // Petrolio WTI futures (NYMEX)
  vix:    '^VIX',    // Indice di volatilità CBOE
  eurusd: 'EURUSD=X',
};

async function handleEvent() {
  try {
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
