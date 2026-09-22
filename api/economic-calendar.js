// api/economic-calendar.js
//
// Serverless Function (Vercel): calendario economico REALE (non più testo scritto a mano in
// index.html) — usa l'endpoint pubblico non ufficiale che alimenta il calendario economico
// embeddabile di TradingView. Nessuna API key richiesta, ma richiede l'header Origin di un
// dominio tradingview.com altrimenti risponde 403 — per questo la chiamata passa da qui
// (server) e non direttamente dal browser.
//
// Query: ?from=<ISO>&to=<ISO>&countries=US,EU,GB,... (countries opzionale)
// Risposta: { generatedAt, from, to, count, events: [{ id, title, country, currency, date,
//   importance: 'alto'|'medio'|'basso', previous, forecast, actual, unit, scale, period,
//   source, comment }] }
// Raggiungibile su: https://tuosito.vercel.app/api/economic-calendar?from=...&to=...

const { toVercelHandler } = require('../lib/vercel-adapter');

const TV_URL = 'https://economic-calendar.tradingview.com/events';
const DEFAULT_COUNTRIES = 'US,EU,GB,JP,CN,AU,CA,CH';

// Mappatura confermata via test diretto sull'endpoint: -1 = basso impatto, 0 = medio, 1 = alto
// (es. "Unemployment Rate" USA e "FOMC Minutes" risultano importance 1, dati secondari -1).
const IMPORTANCE_MAP = { '1': 'alto', '0': 'medio', '-1': 'basso' };

async function handleEvent(event) {
  try {
    const params = event.queryStringParameters || {};
    const from = params.from;
    const to = params.to;
    if (!from || !to) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Parametri richiesti mancanti: from, to (ISO 8601)' }) };
    }
    const countries = params.countries || DEFAULT_COUNTRIES;

    const url = `${TV_URL}?${new URLSearchParams({ from, to, countries }).toString()}`;
    const res = await fetch(url, {
      headers: {
        // Origin obbligatorio: senza questo header l'endpoint risponde 403.
        Origin: 'https://in.tradingview.com',
        'User-Agent': 'Mozilla/5.0 (compatible; macro-hub-dashboard/1.0)',
      },
    });
    if (!res.ok) throw new Error(`TradingView calendar error ${res.status}`);
    const data = await res.json();
    const raw = Array.isArray(data.result) ? data.result : [];

    const events = raw
      .filter((e) => e && e.title && e.date)
      .map((e) => ({
        id: e.id,
        title: e.title,
        country: e.country || null,
        currency: e.currency || null,
        date: e.date,
        importance: IMPORTANCE_MAP[String(e.importance)] || 'basso',
        previous: e.previous != null ? e.previous : null,
        forecast: e.forecast != null ? e.forecast : null,
        actual: e.actual != null ? e.actual : null,
        unit: e.unit || '',
        scale: e.scale || '',
        period: e.period || '',
        source: e.source || '',
        comment: e.comment || '',
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

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
