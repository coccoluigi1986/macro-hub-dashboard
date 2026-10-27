// api/fred-data.js
//
// Serverless Function (Vercel): recupera dati macro USA REALI e ufficiali
// dalla Federal Reserve Economic Data (FRED) — gratuita, nessun costo.
// La logica (serie, calcoli YoY/PIL annualizzato, cache) sta in lib/fred.js, condivisa con
// api/narrative.js.
//
// SETUP RICHIESTO:
// 1. Registrati gratis su https://fred.stlouisfed.org/docs/api/api_key.html
// 2. Su Vercel: Project settings → Environment Variables → aggiungi FRED_API_KEY con la tua chiave
// 3. Questa funzione sarà raggiungibile su: https://tuosito.vercel.app/api/fred-data
//
// ?view=fedwatch → probabilità di taglio / invariato / rialzo dei tassi Fed ricavate dai future Fed Funds (lib/fedwatch.js).
// ?view=sahm → Sahm Rule (segnale di recessione USA dalla disoccupazione, lib/sahm.js).
// Stanno qui perché il piano gratuito di Vercel consente al massimo 12 funzioni e sono tutte usate.

const { toVercelHandler } = require('../lib/vercel-adapter');
const { fetchFredSnapshot } = require('../lib/fred');
const { getFedWatch } = require('../lib/fedwatch');
const { getSahm } = require('../lib/sahm');

async function handleEvent(event) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'FRED_API_KEY non configurata nelle Environment Variables di Vercel' }),
    };
  }

  const params = (event && event.queryStringParameters) || {};
  if (params.view === 'fedwatch') {
    try {
      const fw = await getFedWatch(apiKey);
      // 5 minuti: i future si muovono durante la giornata, ma non servono aggiornamenti al secondo
      return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }, body: JSON.stringify(fw) };
    } catch (err) {
      // errore: cache brevissima, così un problema transitorio non resta "congelato"
      return { statusCode: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' }, body: JSON.stringify({ error: err.message }) };
    }
  }

  if (params.view === 'sahm') {
    try {
      const sahm = await getSahm(apiKey);
      // 1 ora: la disoccupazione esce una volta al mese
      return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }, body: JSON.stringify(sahm) };
    } catch (err) {
      return { statusCode: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' }, body: JSON.stringify({ error: err.message }) };
    }
  }

  try {
    const data = await fetchFredSnapshot(apiKey);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600', // cache 1 ora, questi dati non cambiano più spesso
      },
      body: JSON.stringify({
        updatedAt: new Date().toISOString(),
        source: 'FRED (Federal Reserve Bank of St. Louis) — dati ufficiali pubblici',
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
