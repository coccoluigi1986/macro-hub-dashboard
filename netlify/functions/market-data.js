// netlify/functions/market-data.js
//
// Funzione serverless Netlify: prezzi di mercato REALI (indici, metalli, petrolio, VIX)
// da Twelve Data — piano gratuito: 800 richieste/giorno, 8/minuto.
//
// SETUP RICHIESTO:
// 1. Registrati gratis su https://twelvedata.com/pricing (piano Free)
// 2. Su Netlify: Site settings → Environment variables → aggiungi TWELVEDATA_API_KEY
// 3. Raggiungibile su: https://tuosito.netlify.app/.netlify/functions/market-data
//
// STORIA DI QUESTO FILE — perché i ticker sono cambiati:
// La prima versione usava ETF come proxy per gli indici (SPY per S&P 500, QQQ per Nasdaq,
// DIA per Dow). Era un ERRORE: il prezzo di un ETF non è il valore dell'indice — SPY quota
// circa 1/10 del valore reale dell'S&P 500. Un utente ha giustamente segnalato numeri
// completamente sbagliati in ordine di grandezza. Questa versione usa i ticker diretti degli
// indici (SPX, NDX, DJI), che secondo la documentazione Twelve Data sono coperti anche dal
// piano gratuito. Se durante l'uso reale uno di questi ticker risultasse comunque non
// disponibile sul tuo piano, il campo "error" per quell'asset specifico te lo dirà chiaramente
// invece di restituire in silenzio un numero sbagliato.

const SYMBOLS = {
  sp500:   'SPX',       // S&P 500 — ticker indice diretto (non più l'ETF SPY)
  nasdaq:  'NDX',       // Nasdaq 100 — ticker indice diretto (non più l'ETF QQQ)
  dow:     'DJI',       // Dow Jones Industrial Average — ticker indice diretto (non più l'ETF DIA)
  gold:    'XAU/USD',   // Oro spot
  silver:  'XAG/USD',   // Argento spot (mancava completamente nella versione precedente)
  wti:     'WTI/USD',   // Petrolio WTI — se il tuo piano non lo copre, valuta 'USO' (ETF) come proxy dichiarato
  vix:     'VIX',       // Indice di volatilità CBOE — ticker diretto (non più l'ETF VIXY)
  eurusd:  'EUR/USD',
};

exports.handler = async function (event, context) {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'TWELVEDATA_API_KEY non configurata nelle Environment Variables di Netlify' }),
    };
  }

  try {
    const symbolList = Object.values(SYMBOLS).join(',');
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbolList)}&apikey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Twelve Data error: ${res.status}`);
    const raw = await res.json();

    const byKey = (sym) => raw[sym] || (raw.symbol === sym ? raw : null);

    function extract(sym) {
      const q = byKey(sym);
      if (!q) return { error: `Nessuna risposta per il simbolo ${sym}.` };
      if (q.code || q.status === 'error') {
        return { error: q.message || `Simbolo ${sym} non disponibile su questo piano Twelve Data.` };
      }
      const price = q.close !== undefined ? parseFloat(q.close) : null;
      const changePercent = q.percent_change !== undefined ? parseFloat(q.percent_change) : null;
      if (price === null) return { error: `Prezzo mancante nella risposta per ${sym}.` };
      return { price, changePercent, previousClose: q.previous_close ? parseFloat(q.previous_close) : null };
    }

    const data = {};
    Object.entries(SYMBOLS).forEach(([key, sym]) => { data[key] = extract(sym); });

    const errors = Object.entries(data).filter(([k, v]) => v.error).map(([k, v]) => `${k} (${SYMBOLS[k]}): ${v.error}`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=120',
      },
      body: JSON.stringify({
        updatedAt: new Date().toISOString(),
        source: 'Twelve Data — ticker diretti per gli indici, non più ETF proxy',
        parseWarning: errors.length ? `Simboli non disponibili: ${errors.join(' | ')}` : null,
        data,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
