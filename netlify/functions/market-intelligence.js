// netlify/functions/market-intelligence.js
//
// Driver aggiornato via AI per ogni asset della sezione "Mercati — Asset Monitor": prima i
// campi "driver" (il paragrafo "da cosa si muove e il perché") e "bars" (i due fattori chiave)
// di marketData in index.html erano scritti a mano una volta sola e restavano statici per
// sempre, anche quando il prezzo veniva aggiornato live. Questa funzione li rigenera con
// Claude a partire da notizie reali (lib/news.js) e dai prezzi/variazioni ATTUALI passati
// dal client (stesso snapshot già mostrato nelle card, per evitare disallineamenti).
//
// Se ANTHROPIC_API_KEY manca o la chiamata fallisce, il client tiene semplicemente il driver
// statico di fallback già presente in marketData — stesso pattern del resto della dashboard.
//
// Query param: ?snapshot=<JSON URL-encoded> — { "<nome asset>": {"val":"...", "chg": n}, ... }
// Raggiungibile su: https://tuosito.netlify.app/.netlify/functions/market-intelligence

const { aggregateNews } = require('./lib/news');
const { claudeJSON } = require('./lib/claude');

const ASSETS = [
  'DXY', 'EUR/USD', 'GBP/USD', 'WTI Crude Oil', 'Gold Futures', 'Silver Futures',
  'Nasdaq 100', 'S&P 500', 'Dow Jones', 'US 10Y Yield', 'VIX',
];

const SYS = 'Sei un analista macro di un desk di trading istituzionale. Rispondi SEMPRE in italiano, '
  + 'tecnico e concreto, basandoti sulle notizie reali e sui prezzi forniti. '
  + 'Restituisci ESCLUSIVAMENTE JSON valido, senza testo prima o dopo.';

function newsBlock(items, limit = 30) {
  return items.slice(0, limit).map((n, i) => `${i + 1}. [${n.source} ${n.published.slice(11, 16)}] ${n.title} — ${n.summary.slice(0, 180)}`).join('\n');
}

exports.handler = async function (event) {
  try {
    const params = event.queryStringParameters || {};
    let snapshot = {};
    if (params.snapshot) {
      try { snapshot = JSON.parse(params.snapshot); } catch (e) { snapshot = {}; }
    }

    const items = await aggregateNews(30);

    let payload = null;
    if (process.env.ANTHROPIC_API_KEY && items.length) {
      try {
        const priceLines = ASSETS.map(a => {
          const s = snapshot[a];
          return s ? `- ${a}: ${s.val}${s.chg != null ? ` (${s.chg >= 0 ? '+' : ''}${s.chg}%)` : ''}` : `- ${a}: prezzo non disponibile`;
        }).join('\n');

        const prompt = `PREZZI ATTUALI (dalla dashboard, appena aggiornati):\n${priceLines}\n\n`
          + `NOTIZIE REALI DELLE ULTIME ORE:\n${newsBlock(items, 30)}\n\n`
          + `Per OGNI asset qui sotto produci il driver di mercato aggiornato ad ADESSO:\n${ASSETS.map(a => `- "${a}"`).join('\n')}\n\n`
          + 'Restituisci JSON con questa struttura esatta:\n'
          + '{\n'
          + '  "assets": [\n'
          + '    {"name":"DXY",'
          + '"driver":"2-3 frasi in italiano, tecniche, su cosa muove concretamente l\'asset in questo momento — collega esplicitamente le notizie sopra al prezzo. Max 320 caratteri.",'
          + '"bars":[{"lbl":"nome fattore, max 40 caratteri","pct":0..100,"tone":"red|gold|green","note":"max 110 caratteri"},{"lbl":"secondo fattore","pct":0..100,"tone":"red|gold|green","note":"max 110 caratteri"}]}\n'
          + '  ]\n'
          + '}\n'
          + 'Regole: usa ESATTAMENTE i nomi degli asset elencati sopra, uno per ciascuno (11 in totale). '
          + '"tone" indica se il fattore è un vento contrario (red), misto/incerto (gold) o favorevole (green) per l\'asset. '
          + 'Niente prefazioni, solo JSON.';

        const data = await claudeJSON({ system: SYS, prompt, maxTokens: 4000 });
        const byName = {};
        (data.assets || []).forEach(a => { if (a && a.name) byName[a.name] = a; });

        const assets = {};
        ASSETS.forEach(name => {
          const a = byName[name];
          if (!a) return;
          assets[name] = {
            driver: a.driver || null,
            bars: (a.bars || []).slice(0, 2).map(b => ({
              lbl: b.lbl || '', pct: Math.max(0, Math.min(100, Number(b.pct) || 0)),
              tone: ['red', 'gold', 'green'].includes(b.tone) ? b.tone : 'gold',
              note: b.note || '',
            })),
          };
        });

        payload = { generatedAt: new Date().toISOString(), ai: true, newsCount: items.length, assets };
      } catch (e) {
        console.warn('market intelligence AI failed:', e.message);
      }
    }

    if (!payload) payload = { generatedAt: new Date().toISOString(), ai: false, newsCount: items.length, assets: {} };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10800' }, // 3h
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
