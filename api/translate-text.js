// api/translate-text.js
//
// Serverless Function (Vercel): traduce in italiano un singolo paragrafo di testo — usata dal
// Calendario Economico per tradurre la descrizione dettagliata di ogni evento (fornita in
// inglese da TradingView) SOLO quando l'utente apre effettivamente quella riga, non per tutti
// gli eventi della pagina — molto più economico e veloce che tradurre in blocco centinaia di
// righe quasi mai lette per intero.
//
// Query: ?text=<testo inglese URL-encoded>
// Risposta: { translated: "<testo in italiano>" } — se la chiave manca o la chiamata fallisce,
// { translated: null } cosicché il client possa mostrare semplicemente il testo originale.
// Raggiungibile su: https://tuosito.vercel.app/api/translate-text?text=...

const { claudeText } = require('../lib/claude');
const { toVercelHandler } = require('../lib/vercel-adapter');

const SYS = 'Sei un traduttore professionale specializzato in economia e finanza. Traduci il testo '
  + 'fornito dall\'inglese all\'italiano in modo naturale e preciso, mantenendo il tono tecnico. '
  + 'Lascia invariati acronimi, nomi propri di istituzioni ed enti (es. "Federal Reserve", "ONS", '
  + '"CFTC") e ticker. Restituisci SOLO il testo tradotto, senza virgolette, prefazioni o note.';

// Cache in-memoria per il ciclo di vita dell'istanza serverless (spesso "warm" tra una richiesta
// e l'altra) — le descrizioni di TradingView si ripetono moltissimo (stesso identico testo per lo
// stesso indicatore su decine di date diverse), quindi evita traduzioni ripetute quando capita.
const cache = new Map();
const MAX_CACHE = 500;

async function handleEvent(event) {
  try {
    const params = event.queryStringParameters || {};
    const text = (params.text || '').trim();
    if (!text) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Parametro richiesto mancante: text' }) };
    }

    if (cache.has(text)) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
        body: JSON.stringify({ translated: cache.get(text) }),
      };
    }

    let translated = null;
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        translated = await claudeText({ system: SYS, prompt: text, maxTokens: 700 });
        if (cache.size >= MAX_CACHE) cache.clear();
        cache.set(text, translated);
      } catch (e) {
        console.warn('translate-text AI failed:', e.message);
      }
    }

    return {
      statusCode: 200,
      // 24h: è una traduzione di un testo statico, non cambia mai per lo stesso input.
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
      body: JSON.stringify({ translated }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

module.exports = toVercelHandler(handleEvent);
