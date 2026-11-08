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
const { fetchCalendarEvents, isFomcDecision } = require('../lib/calendar');
const { fetchMacroCards } = require('../lib/macro-cards');
const { releaseAwareTtl } = require('../lib/release-watch');

async function handleEvent(event) {
  try {
    const params = event.queryStringParameters || {};

    // ?view=macro → card Macro USA / Europa / Lavoro costruite dagli ultimi dati già usciti
    // (attuale, atteso, precedente), invece dei valori scritti a mano di luglio. Vedi lib/macro-cards.js.
    if (params.view === 'macro') {
      const cards = await fetchMacroCards();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + await releaseAwareTtl(900, 120) },   // 15 min; poco dopo un dato importante scade prima, così la card mostra il numero appena uscito
        body: JSON.stringify({ generatedAt: new Date().toISOString(), source: 'TradingView Economic Calendar', ...cards }),
      };
    }

    // ?view=fomc → le prossime decisioni sui tassi della Fed dal calendario live, fino a 150 giorni avanti (il "Prossimo FOMC" della sezione Banche centrali:
    // la finestra di 45 giorni degli eventi chiave non bastava nei giorni subito dopo una riunione, quando la successiva è più lontana).
    if (params.view === 'fomc') {
      const now = Date.now();
      const events = await fetchCalendarEvents({ from: new Date(now - 3 * 3600e3).toISOString(), to: new Date(now + 150 * 86400e3).toISOString(), countries: 'US' });
      const next = events.filter(isFomcDecision).filter(e => new Date(e.date).getTime() > now - 3 * 3600e3);
      const seen = new Set(), meetings = [];
      for (const e of next) { const d = e.date.slice(0, 10); if (!seen.has(d)) { seen.add(d); meetings.push({ date: e.date, title: e.title, forecast: e.forecast, previous: e.previous, actual: e.actual, unit: e.unit }); } }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + await releaseAwareTtl(1800, 300) },
        body: JSON.stringify({ generatedAt: new Date().toISOString(), source: 'TradingView Economic Calendar', meetings: meetings.slice(0, 4) }),
      };
    }

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
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + await releaseAwareTtl(900, 120) },
      body: JSON.stringify({ generatedAt: new Date().toISOString(), from, to, count: events.length, events }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

module.exports = toVercelHandler(handleEvent);
