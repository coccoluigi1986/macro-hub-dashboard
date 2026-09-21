// netlify/functions/news-aggregated.js
//
// Feed di notizie macro/geopolitiche reali, aggregate da RSS pubblici (+ Finnhub se
// FINNHUB_KEY è configurata). Vedi lib/news.js per le fonti e la logica di dedup.
//
// Query param opzionali: ?limit=40 (default) · ?topic=geo (filtra per parole chiave geopolitiche)
// Raggiungibile su: https://tuosito.netlify.app/.netlify/functions/news-aggregated

const { aggregateNews } = require('./lib/news');

const GEO_KEYWORDS = [
  'war', 'iran', 'israel', 'houthi', 'russia', 'ukraine', 'china', 'taiwan', 'sanction',
  'tariff', 'military', 'strike', 'opec', 'geopolit', 'conflict', 'nato', 'election',
  'trump', 'middle east', 'attack', 'embargo', 'hormuz',
];

exports.handler = async function (event) {
  try {
    const params = event.queryStringParameters || {};
    const limit = parseInt(params.limit, 10) || 40;
    const topic = params.topic || 'all';

    let items = await aggregateNews(120);
    if (topic === 'geo') {
      items = items.filter(i => GEO_KEYWORDS.some(k => (i.title + ' ' + i.summary).toLowerCase().includes(k)));
    }
    items = items.slice(0, limit);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
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
};
