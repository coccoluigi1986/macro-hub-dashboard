// lib/fred-fetch.js
//
// Richiesta all'API ufficiale FRED con tempo massimo e nuovi tentativi. Subito dopo un deploy la cache è vuota e le tre viste (snapshot, FedWatch, Sahm Rule) partono insieme
// con decine di richieste: FRED ogni tanto risponde 429/5xx o resta appeso, e la card rimaneva "non disponibile" finché la cache non scadeva. Ora un errore passeggero
// si riprova (fino a 3 volte, con una breve pausa) e nessuna richiesta aspetta più di 10 secondi.
//
// 14 nov 2026, subito dopo un deploy: 18 serie su 18 degli indicatori chiave risposero 429 (troppe richieste insieme da più funzioni). Ora (1) in ogni istanza al massimo
// MAX_PARALLEL richieste contemporanee verso FRED, per TUTTI i chiamanti (fred-data, FedWatch, Sahm, indicatori), e (2) sul 429 la pausa è più lunga (si rispetta
// Retry-After, al massimo 2,5 secondi) perché riprovare subito a raffica peggiora la situazione.

// FRED (o la rete davanti) a volte rifiuta con 403 le richieste senza User-Agent da browser: la vista degli indicatori lo manda ed ha sempre funzionato, `fred-data`, Sahm e FedWatch no (6-8 nov 2026: "FRED error ...: 40
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Accept: 'application/json' };

const MAX_PARALLEL = 5;
let _active = 0; const _queue = [];
async function slot(fn) {
  if (_active >= MAX_PARALLEL) await new Promise((r) => _queue.push(r));
  _active++;
  try { return await fn(); } finally { _active--; const next = _queue.shift(); if (next) next(); }
}

// pausa prima del prossimo tentativo: sul 429 più lunga e con Retry-After se c'è (tetto 2,5 s: la funzione ha un tempo massimo)
function pausa(res, attempt) {
  if (res && res.status === 429) { const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after')); return Math.min(2500, (ra > 0 ? ra * 1000 : 900 * (attempt + 1))); }
  return 500 * (attempt + 1);
}

async function fredFetch(url) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res = null;
    try {
      res = await slot(() => fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) }));
      if (res.ok || (res.status !== 429 && res.status !== 403 && res.status < 500)) return res;   // 4xx diverso da 429/403 (chiave sbagliata, serie inesistente): inutile riprovare
      lastErr = new Error(`FRED ha risposto ${res.status}`);
    } catch (e) {
      lastErr = e;   // rete o tempo scaduto
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, pausa(res, attempt)));
  }
  throw lastErr;
}

module.exports = { fredFetch };
