// api/cot-data.js
//
// Serverless Function (Vercel): dati REALI del COT Report tramite l'API pubblica
// ufficiale della CFTC (Socrata Open Data, "Public Reporting Environment") —
// dato pubblico, nessuna chiave richiesta, nessun limite pratico di utilizzo.
// Il fetch e il calcolo dei percentili stanno in lib/cot.js (condiviso con api/narrative.js).
//
// FUNZIONALITÀ: parametro ?date=YYYY-MM-DD nell'URL della funzione.
// Se omesso, restituisce l'ULTIMO report disponibile (sempre vero "ultimo dato", mai
// bloccato su una data fissa). Se specificato, restituisce il report più recente
// pubblicato in corrispondenza o prima di quella data (il COT esce solo il venerdì,
// quindi una data qualsiasi viene automaticamente "agganciata" al report corretto).
//
// Esempi di chiamata:
//   /api/cot-data                → ultimo dato disponibile
//   /api/cot-data?date=2026-07-15 → dato più recente fino al 15 luglio 2026

const { toVercelHandler } = require('../lib/vercel-adapter');
const { fetchCotSnapshot } = require('../lib/cot');

async function handleEvent(event) {
  try {
    const dateParam = event.queryStringParameters && event.queryStringParameters.date
      ? event.queryStringParameters.date
      : null;

    if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Parametro "date" non valido, usa il formato YYYY-MM-DD.' }) };
    }

    const { latestReportDate, data, errors } = await fetchCotSnapshot(dateParam);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': dateParam ? 'public, max-age=86400' : 'public, max-age=3600',
      },
      body: JSON.stringify({
        updatedAt: new Date().toISOString(),
        requestedDate: dateParam,
        latestReportDate,
        source: 'CFTC Public Reporting Environment (Socrata API) — dato pubblico ufficiale',
        parseWarning: errors.length ? `Alcuni contratti non trovati: ${errors.join(' | ')}` : null,
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
