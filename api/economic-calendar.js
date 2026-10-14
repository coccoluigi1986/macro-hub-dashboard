// api/economic-calendar.js
//
// Serverless Function (Vercel): calendario economico REALE (non più testo scritto a mano in
// index.html). Il fetch dell'endpoint TradingView e la normalizzazione stanno in lib/calendar.js
// (condivisi con api/narrative.js).
//
// Query: ?from=<ISO>&to=<ISO>&countries=US,EU,GB,... (countries opzionale)
// Risposta: { generatedAt, from, to, count, events: [{ id, title, country, currency, date,
//   importance: 'alto'|'medio'|'basso', previous, forecast, actual, unit, scale, period,
//   source, comment }] }
// Raggiungibile su: https://tuosito.vercel.app/api/economic-calendar?from=...&to=...

const { toVercelHandler } = require('../lib/vercel-adapter');
const { fetchCalendarEvents } = require('../lib/calendar');

async function handleEvent(event) {
  try {
    const params = event.queryStringParameters || {};
    const from = params.from;
    const to = params.to;
    if (!from || !to) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Parametri richiesti mancanti: from, to (ISO 8601)' }) };
    }

    const events = await fetchCalendarEvents({ from, to, countries: params.countries });

    return {
      statusCode: 200,
      // 15 min: le stime di consenso cambiano raramente infragiornata; abbastanza breve da
      // riflettere gli "actual" appena pubblicati senza restare congelati per ore.
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' },
      body: JSON.stringify({ generatedAt: new Date().toISOString(), from, to, count: events.length, events }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

module.exports = toVercelHandler(handleEvent);
