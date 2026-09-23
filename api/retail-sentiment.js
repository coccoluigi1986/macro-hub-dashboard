// api/retail-sentiment.js
//
// Serverless Function (Vercel): posizionamento retail REALE (long/short %) per la card
// "Correlazioni e Sentiment Asset" — usa lo SWFX Sentiment Index di Dukascopy, un indice
// pubblico basato sui flussi di transazione reali del loro marketplace, calcolato dal broker
// stesso e aggiornato ogni 30 minuti. Diverso da Myfxbook/IG/OANDA (verificati e scartati in
// una richiesta precedente: bloccati da Cloudflare o richiedono un account broker) — questo è
// un endpoint pubblico e documentato che Dukascopy mette a disposizione apposta per essere
// incorporato da siti terzi (pagina "get this widget" su dukascopy.com/.../sentiment/), non
// uno scraping di una pagina non pensata per questo.
//
// La "key" nell'URL sotto è la chiave pubblica del widget embeddabile (la stessa che compare
// nell'HTML pubblico della pagina Dukascopy), non una credenziale privata. Richiede uno User-
// Agent da browser, altrimenti risponde 429 "Bot blocked" — verificato direttamente.
//
// Raggiungibile su: https://tuosito.vercel.app/api/retail-sentiment

const { toVercelHandler } = require('../lib/vercel-adapter');

const DUKA_URL = 'https://freeserv.dukascopy.com/2.0/api/'
  + '?group=quotes&method=realtimeSentimentIndex&enabled=true&key=bsq3l3p5lc8w4s0c'
  + '&liquidity=consumers&type=swfx';

// Mappa titolo Dukascopy -> chiave usata dal client (stessa convenzione di market-data.js/dxy-correlation.js).
const INSTRUMENT_MAP = {
  'EUR/USD': 'eurusd',
  'GBP/USD': 'gbpusd',
  'XAU/USD': 'gold',
  'XAG/USD': 'silver',
  'DOLLAR.IDX/USD': 'dxy',
  'USATECH.IDX/USD': 'nasdaq',
  'USA500.IDX/USD': 'sp500',
};

async function handleEvent() {
  try {
    const res = await fetch(DUKA_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; macro-hub-dashboard/1.0)' },
    });
    if (!res.ok) throw new Error(`Dukascopy sentiment error ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw)) throw new Error(raw && raw.error ? String(raw.error) : 'Risposta inattesa da Dukascopy');

    const data = {};
    let updatedAt = null;
    raw.forEach((item) => {
      const key = INSTRUMENT_MAP[item.title];
      if (!key) return;
      const long = Number(item.long);
      const short = Number(item.short);
      if (Number.isNaN(long) || Number.isNaN(short)) return;
      data[key] = { long: Number(long.toFixed(1)), short: Number(short.toFixed(1)) };
      if (item.date) updatedAt = new Date(Number(item.date)).toISOString();
    });

    return {
      statusCode: 200,
      // 15 min: la fonte stessa dichiara un aggiornamento ogni 30 minuti.
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' },
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        updatedAt,
        source: 'Dukascopy SWFX Sentiment Index — posizionamento reale dei clienti (consumers), aggiornato ogni 30 min',
        data,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

module.exports = toVercelHandler(handleEvent);
