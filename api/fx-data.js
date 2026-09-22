// api/fx-data.js
//
// Serverless Function (Vercel): cambi valuta in tempo reale.
// Usa frankfurter.app — API gratuita, gestita dalla Banca Centrale Europea,
// nessuna chiave richiesta, nessun limite pratico di utilizzo.
//
// Raggiungibile su: https://tuosito.vercel.app/api/fx-data

const { toVercelHandler } = require('../lib/vercel-adapter');

async function handleEvent(event) {
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY,CHF,AUD,CAD');
    if (!res.ok) throw new Error(`Frankfurter API error: ${res.status}`);
    const data = await res.json();

    const rates = data.rates;

    // DXY PROXY — stima interna con la formula ufficiale ICE, ma senza il peso SEK (non disponibile
    // gratuitamente su questa API): il peso mancante (~4,2%) viene redistribuito proporzionalmente
    // sulle altre 5 valute. Etichettato sempre come "proxy", MAI come il dato DXY ufficiale ICE.
    let dxyProxy = null;
    if (rates.EUR && rates.JPY && rates.GBP && rates.CAD && rates.CHF) {
      const eurusd = 1 / rates.EUR;
      const usdcad = rates.CAD;
      dxyProxy = (
        50.14348112 *
        Math.pow(eurusd, -0.576 / 0.958) *
        Math.pow(rates.JPY, 0.136 / 0.958) *
        Math.pow(1 / rates.GBP, -0.119 / 0.958) *
        Math.pow(usdcad, 0.091 / 0.958) *
        Math.pow(rates.CHF, 0.036 / 0.958)
      ).toFixed(2);
    }

    const result = {
      updatedAt: new Date().toISOString(),
      date: data.date,
      source: 'Frankfurter.app (dati BCE) — cambi ufficiali',
      data: {
        EURUSD: rates.EUR ? (1 / rates.EUR).toFixed(4) : null,
        GBPUSD: rates.GBP ? (1 / rates.GBP).toFixed(4) : null,
        USDJPY: rates.JPY ? rates.JPY.toFixed(2) : null,
        USDCHF: rates.CHF ? rates.CHF.toFixed(4) : null,
        AUDUSD: rates.AUD ? (1 / rates.AUD).toFixed(4) : null,
        USDCAD: rates.CAD ? rates.CAD.toFixed(4) : null,
        DXYProxy: dxyProxy,
        dxyIsProxy: true,
      },
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300', // cache 5 minuti
      },
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
}

module.exports = toVercelHandler(handleEvent);
