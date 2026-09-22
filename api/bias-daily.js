// api/bias-daily.js
//
// Serverless Function (Vercel): lettura del bias giornaliero geopolitico-macro (RISK-ON /
// RISK-OFF / NEUTRALE), generata da Claude a partire dalle notizie reali più recenti.
// Porting del prompt/schema JSON di backend/routers/intel.py::bias_daily() nel progetto
// di riferimento macrohub3.
//
// SEMPLIFICAZIONE rispetto al riferimento: macrohub3 include anche gli eventi in calendario
// dei prossimi 7 giorni nel prompt (via scraping TradingView, backend/tv_calendar.py). Qui
// non lo facciamo per non dover replicare quello scraping — il bias si basa solo sulle notizie
// reali, che comunque menzionano quasi sempre gli eventi macro imminenti rilevanti.
//
// Se ANTHROPIC_API_KEY manca o la chiamata fallisce, torna un fallback esplicito
// ("Lettura AI non disponibile...") invece di un errore.
//
// Raggiungibile su: https://tuosito.vercel.app/api/bias-daily

const { aggregateNews } = require('../lib/news');
const { claudeJSON } = require('../lib/claude');
const { toVercelHandler } = require('../lib/vercel-adapter');

const BIAS_SYS = 'Sei un analista macro-geopolitico senior. Rispondi SEMPRE in italiano. '
  + 'Sintetizzi il quadro giornaliero in una lettura di bias operativo. '
  + 'Restituisci ESCLUSIVAMENTE JSON valido.';

const BIAS_ASSETS = ['Gold', 'DXY', 'EUR/USD', 'Nasdaq', 'US10Y', 'Oil'];

function newsBlock(items, limit = 24) {
  return items.slice(0, limit).map((n, i) => `${i + 1}. [${n.source} ${n.published.slice(11, 16)}] ${n.title} — ${n.summary.slice(0, 180)}`).join('\n');
}

function fallback() {
  return {
    generatedAt: new Date().toISOString(),
    ai: false,
    label: 'NEUTRALE',
    score: 50,
    headline: 'Lettura AI non disponibile: quadro considerato neutrale in attesa di nuovi catalizzatori.',
    geo: { bias: 'NEUTRALE', score: 50, note: 'Nessun aggiornamento AI disponibile.' },
    macro: { bias: 'NEUTRALE', score: 50, note: 'Nessun aggiornamento AI disponibile.' },
    drivers: [],
    assets: BIAS_ASSETS.map(a => ({ asset: a, direction: 'Neutrale', probability: 50 })),
  };
}

async function handleEvent(event) {
  try {
    const items = await aggregateNews(30);

    let payload = null;
    let lastError = process.env.ANTHROPIC_API_KEY ? null : 'ANTHROPIC_API_KEY non impostata';
    if (process.env.ANTHROPIC_API_KEY && items.length) {
      try {
        const prompt = 'NOTIZIE REALI DELLE ULTIME ORE:\n'
          + `${newsBlock(items, 24)}\n\n`
          + 'Produci la LETTURA DEL BIAS GIORNALIERO GEOPOLITICO-MACRO. JSON esatto:\n'
          + '{\n'
          + '  "label": "RISK-ON|RISK-OFF|NEUTRALE",\n'
          + '  "score": 0..100,  // 0 = risk-off estremo, 100 = risk-on estremo\n'
          + '  "headline": "una frase operativa in italiano, max 150 caratteri",\n'
          + '  "geo":   {"bias":"RISK-ON|RISK-OFF|NEUTRALE","score":0..100,"note":"max 180 caratteri"},\n'
          + '  "macro": {"bias":"HAWKISH|DOVISH|NEUTRALE","score":0..100,"note":"max 180 caratteri"},\n'
          + '  "drivers": [{"label":"max 32 caratteri","detail":"max 130 caratteri","tone":"positive|negative|neutral"}],\n'
          + `  "assets": [{"asset":"${BIAS_ASSETS.join('|')}","direction":"Bullish|Bearish|Neutrale","probability":55..90}]\n`
          + '}\n'
          + `Includi 4 driver e tutti e ${BIAS_ASSETS.length} gli asset. Solo JSON.`;

        const data = await claudeJSON({ system: BIAS_SYS, prompt, maxTokens: 1400 });
        payload = {
          generatedAt: new Date().toISOString(),
          ai: true,
          label: (data.label || 'NEUTRALE').toUpperCase(),
          score: Math.round(Number(data.score) || 50),
          headline: data.headline || '—',
          geo: data.geo || {},
          macro: data.macro || {},
          drivers: (data.drivers || []).slice(0, 4),
          assets: (data.assets || []).slice(0, 6),
          newsCount: items.length,
        };
      } catch (e) {
        console.warn('daily bias AI failed:', e.message);
        lastError = e.message; // diagnostica temporanea
      }
    }

    if (!payload) payload = { ...fallback(), debugError: lastError };

    return {
      statusCode: 200,
      // 3h quando l'AI ha risposto davvero; se è il fallback, cache breve (2 min) — altrimenti un
      // singolo errore transitorio (rate limit, timeout) resterebbe "congelato" in CDN per 3 ore.
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${payload.ai ? 10800 : 120}` },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

module.exports = toVercelHandler(handleEvent);
