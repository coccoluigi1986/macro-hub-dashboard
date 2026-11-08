// lib/fred-fetch.js
//
// Richiesta all'API ufficiale FRED con tempo massimo e nuovi tentativi. Subito dopo un deploy la cache è vuota e le tre viste (snapshot, FedWatch, Sahm Rule) partono insieme
// con decine di richieste: FRED ogni tanto risponde 429/5xx o resta appeso, e la card rimaneva "non disponibile" finché la cache non scadeva. Ora un errore passeggero
// si riprova (fino a 3 volte, con una breve pausa) e nessuna richiesta aspetta più di 10 secondi.

// FRED (o la rete davanti) a volte rifiuta con 403 le richieste senza User-Agent da browser: la vista degli indicatori lo manda ed ha sempre funzionato, `fred-data`, Sahm e FedWatch no (6-8 nov 2026: "FRED error ...: 403")
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Accept: 'application/json' };

async function fredFetch(url) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
      if (res.ok || (res.status !== 429 && res.status !== 403 && res.status < 500)) return res;   // 4xx diverso da 429/403 (chiave sbagliata, serie inesistente): inutile riprovare
      lastErr = new Error(`FRED ha risposto ${res.status}`);
    } catch (e) {
      lastErr = e;   // rete o tempo scaduto
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastErr;
}

module.exports = { fredFetch };
