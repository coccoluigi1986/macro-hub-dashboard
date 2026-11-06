// api/bias-daily.js
//
// Serverless Function (Vercel): lettura del bias giornaliero geopolitico-macro (RISK-ON /
// RISK-OFF / NEUTRALE), generata da Gemini a partire dalle notizie reali più recenti.
// Porting del prompt/schema JSON di backend/routers/intel.py::bias_daily() nel progetto
// di riferimento macrohub3.
//
// SEMPLIFICAZIONE rispetto al riferimento: macrohub3 include anche gli eventi in calendario
// dei prossimi 7 giorni nel prompt (via scraping TradingView, backend/tv_calendar.py). Qui
// non lo facciamo per non dover replicare quello scraping — il bias si basa solo sulle notizie
// reali, che comunque menzionano quasi sempre gli eventi macro imminenti rilevanti.
//
// Se GEMINI_API_KEY manca o la chiamata fallisce, torna un fallback esplicito
// ("Lettura AI non disponibile...") invece di un errore.
//
// Raggiungibile su: https://tuosito.vercel.app/api/bias-daily

const { aggregateNews } = require('../lib/news');
const { getMarketContext } = require('../lib/market-context');
const { llmJSON, llmConfigured, failureInfo } = require('../lib/llm');
const { releaseAwareTtl } = require('../lib/release-watch');
const { toVercelHandler } = require('../lib/vercel-adapter');

const BIAS_SYS = 'Sei un analista macro-geopolitico senior. Rispondi SEMPRE in italiano. '
  + 'Sintetizzi il quadro giornaliero in una lettura di bias operativo. '
  + 'Restituisci ESCLUSIVAMENTE JSON valido.';

// Gli asset più osservati dal desk: Indici = S&P 500 e Nasdaq 100 insieme; per il VIX la direzione è quella della volatilità.
const BIAS_ASSETS = ['Gold', 'Silver', 'DXY', 'EUR/USD', 'GBP/USD', 'Oil', 'Indici', 'VIX'];

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
    // Contesto condiviso con le altre analisi: notizie ordinate per impatto sulle ultime 30 ore + movimenti reali degli asset con le
    // notizie concomitanti (lib/market-context.js). Se non è disponibile si ricade sul vecchio elenco per data.
    const ctx = await getMarketContext().catch((e) => { console.warn('market context non disponibile:', e.message); return null; });

    let payload = null, failReason = null, fail = { ttl: 120, retryIn: 0 };
    if (llmConfigured() && (items.length || ctx)) {
      try {
        const prompt = (ctx
          ? `NOTIZIE REALI DELLE ULTIME 30 ORE, ORDINATE PER IMPATTO (fonte, giorno e ora di Roma; ALTO = muove tutti i mercati):\n${ctx.text.news}\n\n`
            + `MOVIMENTI REALI DEGLI ASSET (sessioni in ora di Roma) E NOTIZIE USCITE IN QUELLE ORE:\n${ctx.text.moves}\n\n${ctx.text.rules}\n\n`
          : `NOTIZIE REALI DELLE ULTIME ORE:\n${newsBlock(items, 24)}\n\n`)
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
          + 'Per "Indici" intendi S&P 500 e Nasdaq 100 insieme; per "VIX" la direzione indica la volatilità (Bullish = volatilità in aumento, Bearish = in calo). '
          + 'Basa la direzione di ogni asset sulle notizie e sui movimenti reali sopra: la direzione è la tua lettura per le prossime ore e deve restare coerente con quanto l\'asset ha fatto davvero (se vai contro il movimento recente, spiegalo nel driver). '
          + 'La headline e almeno un driver devono citare la notizia dominante delle ultime ore, con il suo orario.\n'
          + `Includi 4 driver e tutti e ${BIAS_ASSETS.length} gli asset. Solo JSON.`;

        const data = await llmJSON({ system: BIAS_SYS, prompt, maxTokens: 2500 });
        payload = {
          generatedAt: new Date().toISOString(),
          ai: true,
          label: (data.label || 'NEUTRALE').toUpperCase(),
          score: Math.round(Number(data.score) || 50),
          headline: data.headline || '—',
          geo: data.geo || {},
          macro: data.macro || {},
          drivers: (data.drivers || []).slice(0, 4),
          assets: (data.assets || []).slice(0, BIAS_ASSETS.length),
          newsCount: items.length,
        };
      } catch (e) {
        console.warn('daily bias AI failed:', e.message);
        failReason = String(e.message).slice(0, 260);   // il motivo del ripiego, visibile nella risposta (nessun dato riservato)
        fail = failureInfo(e);                           // quota esaurita: cache più lunga e nuovo tentativo più tardi
      }
    }

    if (!payload) { payload = fallback(); if (failReason) { payload.reason = failReason; payload.retryIn = fail.retryIn; } }

    return {
      statusCode: 200,
      // 3h quando l'AI ha risposto davvero; se è il fallback, cache breve (2 min) — altrimenti un
      // singolo errore transitorio (rate limit, timeout) resterebbe "congelato" in CDN per 3 ore.
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${payload.ai ? await releaseAwareTtl(10800) : fail.ttl}` },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

module.exports = toVercelHandler(handleEvent);
