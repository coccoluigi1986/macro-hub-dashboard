// lib/fred-fetch.js
//
// Richiesta all'API ufficiale FRED con tempo massimo e nuovi tentativi. Subito dopo un deploy la cache è vuota e le tre viste (snapshot, FedWatch, Sahm Rule) partono insieme
// con decine di richieste: FRED ogni tanto risponde 429/5xx o resta appeso, e la card rimaneva "non disponibile" finché la cache non scadeva. Ora un errore passeggero
// si riprova (fino a 3 volte, con una breve pausa) e nessuna richiesta aspetta più di 10 secondi.

async function fredFetch(url) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.ok || (res.status !== 429 && res.status < 500)) return res;   // 4xx diverso da 429 (chiave sbagliata, serie inesistente): inutile riprovare
      lastErr = new Error(`FRED ha risposto ${res.status}`);
    } catch (e) {
      lastErr = e;   // rete o tempo scaduto
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastErr;
}

module.exports = { fredFetch };
