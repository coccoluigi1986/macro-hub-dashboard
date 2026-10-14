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

const { toVercelHandler } = require('../lib/vercel-adapter');
const { fetchFredSnapshot } = require('../lib/fred');

async function handleEvent() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'FRED_API_KEY non configurata nelle Environment Variables di Vercel' }),
    };
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
