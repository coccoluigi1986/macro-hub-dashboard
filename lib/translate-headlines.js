// lib/translate-headlines.js
//
// Traduce in italiano i TITOLI delle notizie (arrivano in inglese dai feed). Una sola chiamata a Gemini per gruppo di titoli, non una per titolo;
// i titoli già tradotti restano in una memoria dell'istanza serverless (spesso "calda" tra una richiesta e l'altra), quindi a ogni aggiornamento si
// traducono solo quelli nuovi. Se la chiave manca o Gemini non risponde, il titolo resta quello originale: nessun errore visibile, nessun testo inventato.
//
// Usato da api/news-aggregated.js (fascia notizie in alto e scheda "Cosa ha mosso i mercati").

const { llmJSON, llmConfigured } = require('./llm');

const SYS = 'Sei un traduttore di titoli di notizie finanziarie e geopolitiche dall\'inglese all\'italiano. '
  + 'Scrivi in italiano naturale, nello stile di un titolo di giornale: chiaro, conciso, fedele all\'originale. '
  + 'Lascia invariati nomi propri, sigle e ticker (Fed, Trump, WTI, S&P 500, Nasdaq, OPEC), i numeri e i simboli di valuta. '
  + 'Non aggiungere né togliere informazioni e non commentare. Restituisci ESCLUSIVAMENTE JSON valido.';

const cache = new Map();            // titolo inglese → titolo italiano
const MAX_CACHE = 1500;
const CHUNK = 16;                   // titoli per chiamata

async function translateChunk(titles) {
  const prompt = `Traduci in italiano questi ${titles.length} titoli. Rispondi con JSON {"t":[...]}: un array di ${titles.length} stringhe, nello STESSO ORDINE, una per titolo.\n\n`
    + titles.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const out = await llmJSON({ system: SYS, prompt, maxTokens: 1400 });
  const arr = out && Array.isArray(out.t) ? out.t : null;
  if (!arr || arr.length !== titles.length) throw new Error(`traduzione titoli: attesi ${titles.length}, ricevuti ${arr ? arr.length : 0}`);
  return arr.map((x) => (typeof x === 'string' ? x.replace(/^\s*\d+[.)]\s*/, '').trim() : ''));
}

// titoli inglesi → Map(inglese → italiano) per quelli tradotti; i mancanti (errore, chiave assente) non compaiono nella mappa
async function translateTitles(titles) {
  const uniq = [...new Set((titles || []).filter((t) => typeof t === 'string' && t.trim()))];
  const todo = uniq.filter((t) => !cache.has(t));
  if (todo.length && llmConfigured()) {
    const chunks = []; for (let i = 0; i < todo.length; i += CHUNK) chunks.push(todo.slice(i, i + CHUNK));
    await Promise.all(chunks.map(async (c) => {
      try {
        const out = await translateChunk(c);
        if (cache.size + out.length > MAX_CACHE) cache.clear();
        c.forEach((t, i) => { if (out[i]) cache.set(t, out[i]); });
      } catch (e) { console.warn('translate-headlines fallita:', e.message); }
    }));
  }
  return new Map(uniq.filter((t) => cache.has(t)).map((t) => [t, cache.get(t)]));
}

module.exports = { translateTitles };
