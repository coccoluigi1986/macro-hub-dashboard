// netlify/functions/sentiment-categories.js
//
// Sentiment operativo per 6 categorie (Fed/Tassi, Geopolitica, Macro, DXY/Dollaro,
// Gold/Commodities, Indici/Equity), generato da Claude a partire da notizie reali
// aggregate (lib/news.js). Porting diretto del prompt/schema JSON di
// backend/routers/intel.py::sentiment_categories() nel progetto di riferimento macrohub3.
//
// Se ANTHROPIC_API_KEY manca o la chiamata fallisce, torna un fallback testuale
// esplicito ("Analisi AI non disponibile...") invece di un errore — stesso pattern
// del resto delle funzioni live di questa dashboard.
//
// Raggiungibile su: https://tuosito.netlify.app/.netlify/functions/sentiment-categories

const { aggregateNews } = require('./lib/news');
const { claudeJSON } = require('./lib/claude');

const CATEGORIES = [
  { key: 'fed_rates', label: 'FED / TASSI' },
  { key: 'geopolitics', label: 'GEOPOLITICA' },
  { key: 'macro', label: 'MACRO' },
  { key: 'dxy', label: 'DXY / DOLLARO' },
  { key: 'commodities', label: 'GOLD / COMMODITIES' },
  { key: 'equity', label: 'INDICI / EQUITY' },
];

const SENT_SYS = 'Sei il capo analista macro di un desk di trading istituzionale. Rispondi SEMPRE in italiano. '
  + 'Analizzi flussi di notizie reali e ne estrai il posizionamento operativo. '
  + 'Restituisci ESCLUSIVAMENTE JSON valido, senza testo prima o dopo.';

function newsBlock(items, limit = 30) {
  return items.slice(0, limit).map((n, i) => `${i + 1}. [${n.source} ${n.published.slice(11, 16)}] ${n.title} — ${n.summary.slice(0, 180)}`).join('\n');
}

function fallback(items) {
  return {
    generatedAt: new Date().toISOString(),
    newsCount: items.length,
    ai: false,
    categories: CATEGORIES.map(c => ({
      key: c.key,
      label: c.label,
      bias: 'NEUTRAL',
      narrative: 'Analisi AI non disponibile: flusso notizie acquisito ma non elaborato.',
      sources: [...new Set(items.slice(0, 6).map(i => i.source))].slice(0, 3),
    })),
    keyRisks: ['Analisi AI non disponibile in questo ciclo — riprova tra qualche minuto.'],
  };
}

exports.handler = async function (event) {
  try {
    const items = await aggregateNews(40);
    if (!items.length) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
        body: JSON.stringify(fallback([])),
      };
    }

    let payload = null;
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const catSpec = CATEGORIES.map(c => `- "${c.key}" (${c.label})`).join('\n');
        const prompt = 'Ecco le ultime notizie reali dai mercati (fonte e ora UTC tra parentesi):\n\n'
          + `${newsBlock(items, 30)}\n\n`
          + `Per OGNI categoria qui sotto produci il sentiment operativo:\n${catSpec}\n\n`
          + 'Restituisci JSON con questa struttura esatta:\n'
          + '{\n'
          + '  "categories": [\n'
          + '    {"key":"fed_rates","bias":"BULLISH|BEARISH|NEUTRAL",'
          + '"narrative":"3-4 frasi in italiano, tecniche e concrete, che spiegano cosa dicono le notizie e '
          + 'l\'impatto su prezzi/rendimenti/asset. Max 380 caratteri.",'
          + '"sources":["nome fonte 1","nome fonte 2","nome fonte 3"]}\n'
          + '  ],\n'
          + '  "key_risks": ["4-5 rischi chiave concreti, una riga ciascuno, in italiano, max 130 caratteri"]\n'
          + '}\n'
          + 'Regole: bias riferito all\'ASSET DOMINANTE della categoria (per FED/TASSI = propensione al rischio; '
          + 'per DXY = dollaro; per GOLD = oro; per INDICI = equity). Usa SOLO nomi di fonti presenti nella lista. '
          + 'Niente prefazioni, solo JSON.';

        const data = await claudeJSON({ system: SENT_SYS, prompt, maxTokens: 1700 });
        const byKey = {};
        (data.categories || []).forEach(c => { if (c && c.key) byKey[c.key] = c; });

        payload = {
          generatedAt: new Date().toISOString(),
          newsCount: items.length,
          ai: true,
          categories: CATEGORIES.map(c => ({
            key: c.key,
            label: c.label,
            bias: (byKey[c.key]?.bias || 'NEUTRAL').toUpperCase(),
            narrative: byKey[c.key]?.narrative || '—',
            sources: (byKey[c.key]?.sources || []).slice(0, 3),
          })),
          keyRisks: (data.key_risks || []).slice(0, 6),
        };
      } catch (e) {
        console.warn('sentiment categories AI failed:', e.message);
      }
    }

    if (!payload) payload = fallback(items);

    return {
      statusCode: 200,
      // 6h quando l'AI ha risposto davvero; se è il fallback, cache breve (2 min) — altrimenti un
      // singolo errore transitorio (rate limit, timeout) resterebbe "congelato" in CDN per ore.
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${payload.ai ? 21600 : 120}` },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
