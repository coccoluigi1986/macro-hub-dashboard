// api/news-aggregated.js
//
// Serverless Function (Vercel): feed di notizie macro/geopolitiche reali, aggregate da RSS
// pubblici (+ Finnhub se FINNHUB_KEY è configurata). Vedi lib/news.js per le fonti e la
// logica di dedup.
//
// Query param opzionali: ?limit=40 (default) · ?topic=geo (filtra per parole chiave geopolitiche) · ?lang=it (aggiunge titleIt, il titolo
// tradotto in italiano, alle prime 12 notizie) · ?view=moves (scheda "Cosa ha mosso i mercati", titoli già in italiano)
// ?debug=1 → non aggrega, testa OGNI feed RSS singolarmente e riporta status/conteggio/errore per
// ciascuno — utile per capire perché una fonte non restituisce nulla (es. blocco anti-bot su IP
// datacenter, 403/429, timeout) invece di vederla sparire in silenzio dal risultato aggregato.
// Raggiungibile su: https://tuosito.vercel.app/api/news-aggregated

const { aggregateNews, fetchRssWithDiag, RSS_FEEDS } = require('../lib/news');
const { getMarketContext, uiSummary } = require('../lib/market-context');
const { translateTitles } = require('../lib/translate-headlines');
const { toVercelHandler } = require('../lib/vercel-adapter');

const GEO_KEYWORDS = [
  'war', 'iran', 'israel', 'houthi', 'russia', 'ukraine', 'china', 'taiwan', 'sanction',
  'tariff', 'military', 'strike', 'opec', 'geopolit', 'conflict', 'nato', 'election',
  'trump', 'middle east', 'attack', 'embargo', 'hormuz',
];

async function handleEvent(event) {
  try {
    const params = event.queryStringParameters || {};

    if (params.debug) {
      const feeds = await Promise.all(RSS_FEEDS.map(fetchRssWithDiag));
      const okCount = feeds.filter(f => f.ok && f.itemCount > 0).length;
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ checkedAt: new Date().toISOString(), workingFeeds: okCount, totalFeeds: feeds.length, feeds }),
      };
    }

    // ?view=moves → "Cosa ha mosso i mercati": movimenti reali degli asset per sessione con le notizie uscite in quelle ore
    // (dati Yahoo a 15 minuti + notizie ordinate per impatto, lib/market-context.js). Nessuna AI: sempre fresco, cache breve.
    if (params.view === 'moves') {
      const summary = uiSummary(await getMarketContext());
      // titoli in italiano (titleIt); se la traduzione non c'è resta il titolo originale e la cache è breve, così si riprova presto
      const shown = summary.slots.flatMap(s => s.news);
      const tr = await translateTitles(shown.map(n => n.title));
      shown.forEach(n => { if (tr.has(n.title)) n.titleIt = tr.get(n.title); });
      const complete = shown.every(n => n.titleIt);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${complete ? 600 : 60}` },
        body: JSON.stringify(summary),
      };
    }

    const limit = parseInt(params.limit, 10) || 40;
    const topic = params.topic || 'all';

    let items = await aggregateNews(120);
    if (topic === 'geo') {
      items = items.filter(i => GEO_KEYWORDS.some(k => (i.title + ' ' + i.summary).toLowerCase().includes(k)));
    }
    items = items.slice(0, limit);

    // ?lang=it → aggiunge titleIt (titolo in italiano) alle notizie in testa all'elenco, quelle che la dashboard mostra; le altre restano in inglese
    let complete = true;
    if (params.lang === 'it') {
      const head = items.slice(0, 12).map(i => ({ ...i }));   // copie: gli oggetti originali stanno nella memoria condivisa di lib/news.js
      const tr = await translateTitles(head.map(i => i.title));
      head.forEach(i => { if (tr.has(i.title)) i.titleIt = tr.get(i.title); });
      complete = head.every(i => i.titleIt);
      items = [...head, ...items.slice(12)];
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${complete ? 600 : 120}` },
      body: JSON.stringify({
        count: items.length,
        topic,
        fetchedAt: new Date().toISOString(),
        items,
        sources: [...new Set(items.map(i => i.source))].sort(),
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

module.exports = toVercelHandler(handleEvent);
