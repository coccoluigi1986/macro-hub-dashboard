// api/market-intelligence.js
//
// Serverless Function (Vercel): driver aggiornato via AI per ogni asset della sezione
// "Mercati — Asset Monitor": prima i campi "driver" (il paragrafo "da cosa si muove e il
// perché") e "bars" (i due fattori chiave) di marketData in index.html erano scritti a
// mano una volta sola e restavano statici per sempre, anche quando il prezzo veniva
// aggiornato live. Questa funzione li rigenera con Claude a partire da notizie reali
// (lib/news.js) e dai prezzi/variazioni ATTUALI passati dal client (stesso snapshot già
// mostrato nelle card, per evitare disallineamenti).
//
// Gli 11 asset sono divisi in piccoli batch e generati in PARALLELO (Promise.allSettled):
// una singola chiamata Claude per tutti gli 11 asset andava in timeout (>30s) — batch più
// piccoli in parallelo restano ben sotto il limite, e se un batch fallisce gli altri
// restano comunque validi (degradazione parziale, non un 500 totale).
//
// Se ANTHROPIC_API_KEY manca o tutti i batch falliscono, il client tiene semplicemente il
// driver statico di fallback già presente in marketData — stesso pattern del resto della dashboard.
//
// Query param: ?snapshot=<JSON URL-encoded> — { "<nome asset>": {"val":"...", "chg": n}, ... }
// Raggiungibile su: https://tuosito.vercel.app/api/market-intelligence

const { aggregateNews } = require('../lib/news');
const { claudeJSON } = require('../lib/claude');
const { toVercelHandler } = require('../lib/vercel-adapter');

const BATCHES = [
  ['DXY', 'EUR/USD', 'GBP/USD'],
  ['Gold Futures', 'Silver Futures', 'WTI Crude Oil'],
  ['Nasdaq 100', 'S&P 500', 'Dow Jones'],
  ['US 10Y Yield', 'VIX'],
];
const ASSETS = BATCHES.flat();

const SYS = 'Sei un analista macro di un desk di trading istituzionale. Rispondi SEMPRE in italiano, '
  + 'tecnico e concreto, basandoti sulle notizie reali e sui prezzi forniti. '
  + 'Restituisci ESCLUSIVAMENTE JSON valido, senza testo prima o dopo.';

function newsBlock(items, limit = 24) {
  return items.slice(0, limit).map((n, i) => `${i + 1}. [${n.source} ${n.published.slice(11, 16)}] ${n.title} — ${n.summary.slice(0, 160)}`).join('\n');
}

async function fetchBatch(batchAssets, priceLines, newsText) {
  const prompt = `PREZZI ATTUALI (dalla dashboard, appena aggiornati):\n${priceLines}\n\n`
    + `NOTIZIE REALI DELLE ULTIME ORE:\n${newsText}\n\n`
    + `Per OGNI asset qui sotto produci il driver di mercato aggiornato ad ADESSO:\n${batchAssets.map(a => `- "${a}"`).join('\n')}\n\n`
    + 'Restituisci JSON con questa struttura esatta:\n'
    + '{\n'
    + '  "assets": [\n'
    + '    {"name":"<nome asset esatto>",'
    + '"driver":"2 frasi in italiano, tecniche, su cosa muove concretamente l\'asset in questo momento — collega esplicitamente le notizie sopra al prezzo. Max 260 caratteri.",'
    + '"bars":[{"lbl":"nome fattore, max 40 caratteri","pct":0..100,"tone":"red|gold|green","note":"max 100 caratteri"},{"lbl":"secondo fattore","pct":0..100,"tone":"red|gold|green","note":"max 100 caratteri"}]}\n'
    + '  ]\n'
    + '}\n'
    + `Regole: usa ESATTAMENTE i nomi degli asset elencati sopra, uno per ciascuno (${batchAssets.length} in totale). `
    + '"tone" indica se il fattore è un vento contrario (red), misto/incerto (gold) o favorevole (green) per l\'asset. '
    + 'Niente prefazioni, solo JSON.';
  return claudeJSON({ system: SYS, prompt, maxTokens: 1200 });
}

async function handleEvent(event) {
  try {
    const params = event.queryStringParameters || {};
    let snapshot = {};
    if (params.snapshot) {
      try { snapshot = JSON.parse(params.snapshot); } catch (e) { snapshot = {}; }
    }

    const items = await aggregateNews(30);
    const assets = {};
    let anyAi = false;

    if (process.env.ANTHROPIC_API_KEY && items.length) {
      const priceLines = ASSETS.map(a => {
        const s = snapshot[a];
        return s ? `- ${a}: ${s.val}${s.chg != null ? ` (${s.chg >= 0 ? '+' : ''}${s.chg}%)` : ''}` : `- ${a}: prezzo non disponibile`;
      }).join('\n');
      const newsText = newsBlock(items, 24);

      const results = await Promise.allSettled(BATCHES.map(b => fetchBatch(b, priceLines, newsText)));
      results.forEach((r, i) => {
        if (r.status !== 'fulfilled') {
          console.warn(`market intelligence batch ${BATCHES[i].join(',')} failed:`, r.reason && r.reason.message);
          return;
        }
        (r.value.assets || []).forEach(a => {
          if (!a || !a.name || !BATCHES[i].includes(a.name)) return;
          assets[a.name] = {
            driver: a.driver || null,
            bars: (a.bars || []).slice(0, 2).map(b => ({
              lbl: b.lbl || '', pct: Math.max(0, Math.min(100, Number(b.pct) || 0)),
              tone: ['red', 'gold', 'green'].includes(b.tone) ? b.tone : 'gold',
              note: b.note || '',
            })),
          };
          anyAi = true;
        });
      });
    }

    const payload = { generatedAt: new Date().toISOString(), ai: anyAi, newsCount: items.length, assets };
    const complete = Object.keys(assets).length === ASSETS.length;

    return {
      statusCode: 200,
      // 3h solo se TUTTI i batch sono andati a buon fine; se anche solo un batch è mancante
      // (rate limit, timeout), cache breve (2 min) così il prossimo giro può completare i mancanti
      // invece di restare "congelato" incompleto in CDN per ore.
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${complete ? 10800 : 120}` },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

module.exports = toVercelHandler(handleEvent);
