// lib/shared-cache.js
//
// MEMORIA CONDIVISA DELLE ANALISI AI: una sola analisi per tutti, in qualunque parte del mondo.
//
// IL PROBLEMA. Il CDN di Vercel tiene una copia della risposta PER OGNI AREA GEOGRAFICA (Europa, USA, Asia…) e, quando la copia scade, ogni area
// richiede all'AI una analisi nuova per conto suo. Due studenti in aree diverse leggevano quindi due analisi scritte a ore diverse (e con parole,
// etichette e direzioni diverse, perché l'AI non scrive mai due volte lo stesso testo), per tutta la durata della cache (fino a 3 ore).
//
// LA SOLUZIONE. Le funzioni girano tutte nella stessa regione (iad1): qui l'analisi pronta viene salvata nella Runtime Cache di Vercel, che è
// CONDIVISA fra tutte le richieste di quella regione e resta anche dopo una nuova pubblicazione. Chi arriva trova l'analisi già scritta; solo
// quando è scaduta ne viene generata UNA, per tutti. Il CDN di ogni area riceve come scadenza lo STESSO istante (non "3 ore da quando l'ha
// ricevuta"), quindi tutte le aree passano alla nuova analisi insieme.
//
// RISPETTO A PRIMA
//  - Durata e regole di scadenza sono quelle di sempre (3 ore, accorciate attorno ai dati macro importanti: lo decide l'endpoint come prima).
//  - Una sola generazione alla volta (blocco con scadenza): le richieste che arrivano nel frattempo ricevono l'analisi precedente (se ha meno
//    di 1 ora) oppure aspettano quella nuova, invece di chiamare l'AI ognuna per conto suo (meno consumo della quota gratuita di Gemini).
//  - Se l'AI non risponde e c'è una analisi precedente (max 6 ore), tutti ricevono quella invece del messaggio "analisi non disponibile";
//    anche il ripiego, se non c'è nulla, è lo stesso per tutti e il nuovo tentativo avviene una volta sola.
//  - Dopo una pubblicazione le analisi restano (prima per 2-3 minuti comparivano i ripieghi).
//
// SICUREZZA. Ogni errore della memoria condivisa (non raggiungibile, lenta, piena) ricade sul comportamento di prima: l'endpoint genera da solo.
// La memoria si può spegnere senza ripubblicare il codice con la variabile d'ambiente SHARED_AI_CACHE=off (alla prima nuova pubblicazione).
// Intestazioni di controllo nelle risposte: X-Shared-Cache (hit, stored, stale, wait, adopt, fail, miss) e X-Shared-Store (platform | memory).
//
// Uso (negli endpoint): module.exports = toVercelHandler(withShared('nome', handleEvent, { keyOf }));
// handleEvent restituisce { statusCode, headers, body, shareOk } e shareOk dice se l'analisi è completa (solo quelle si condividono).

const crypto = require('crypto');
const { cc, ccFail } = require('./cache-control');

const VERSION = 'v1';              // da cambiare SOLO se cambia il formato di una risposta AI: le analisi già salvate si ignorano
const PREFIX = 'macrohub-ai-' + VERSION + '-';   // il progetto condivide la cache con gli altri progetti dello stesso account (piano Hobby)
const KEEP_S = 6 * 3600;           // una analisi scaduta resta consultabile 6 ore (se l'AI non risponde, si usa quella)
const STALE_WAIT_MAX_MS = 3600e3;  // mentre un'altra richiesta rigenera, si serve la precedente solo se scaduta da meno di 1 ora
const LOCK_S = 90;                 // il blocco "sto generando" scade da solo (funzione interrotta)
const WAIT_MS = 45e3, POLL_MS = 1500;
const MIN_S = 15;                  // scadenza minima comunicata al CDN
const OP_TIMEOUT_MS = 2500;

// Parti sostituibili nei test (orologio, pausa, archivio).
const D = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), store: null, pollMs: POLL_MS, waitMs: WAIT_MS };

function store() {
  if (D.store) return D.store;
  const { getCache } = require('@vercel/functions');
  D.store = getCache({ keyHashFunction: (k) => k });   // le chiavi sono già sicure per un URL: niente hash (evita collisioni)
  return D.store;
}

// Fuori da Vercel (o se la piattaforma non la offre) il pacchetto ripiega in silenzio su una memoria PER SINGOLA ISTANZA, che non è condivisa: lo si vede da qui.
function storeKind() {
  if (D.store && D.store.kind) return D.store.kind;
  try {
    const c = globalThis[Symbol.for('@vercel/request-context')];
    if (c && c.get && c.get().cache) return 'platform';
  } catch (e) { /* ignora */ }
  return process.env.RUNTIME_CACHE_ENDPOINT && process.env.RUNTIME_CACHE_HEADERS ? 'platform' : 'memory';
}

// Ogni operazione sulla memoria ha un limite di tempo e non lancia mai errori: un problema qui non deve rompere l'endpoint.
async function safe(fn) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(fn), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), OP_TIMEOUT_MS); })]);
  } catch (e) { return null; } finally { clearTimeout(timer); }
}
const getE = (st, key) => safe(() => st.get(key));
const setE = (st, key, val, ttl) => safe(() => st.set(key, val, { ttl: Math.max(1, Math.ceil(ttl)), name: key }));
const delE = (st, key) => safe(() => st.delete(key));

function sMaxAge(h) {
  if (!h) return 0;
  const v = String(h['Cache-Control'] || h['cache-control'] || '');
  const m = /s-maxage=(\d+)/.exec(v) || /max-age=(\d+)/.exec(v);
  return m ? +m[1] : 0;
}

// Risposta costruita da una analisi salvata. La scadenza per il CDN è il tempo che MANCA alla scadenza (uguale per tutti): tutte le aree cambiano insieme.
function fromEntry(e, tag, untilMs) {
  const target = untilMs || e.validUntil;
  const rem = Math.max(MIN_S, Math.ceil((target - D.now()) / 1000));
  const ok = e.ok && !untilMs;   // quando si serve una analisi scaduta (untilMs) la durata è breve e il browser ricontrolla presto
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': ok ? cc(rem, 0) : ccFail(rem), 'X-Shared-Cache': tag, 'X-Shared-Store': storeKind() },
    body: e.body,
  };
}

function mark(res, tag) {
  const out = { ...res, headers: { ...(res.headers || {}), 'X-Shared-Cache': tag, 'X-Shared-Store': storeKind() } };
  delete out.shareOk;
  return out;
}

const usable = (e, n) => Boolean(e && (n < e.validUntil || (e.retryAt && n < e.retryAt)));

async function waitFor(st, key) {
  const end = D.now() + D.waitMs;
  while (D.now() < end) {
    await D.sleep(D.pollMs);
    const e = await getE(st, key), n = D.now();
    if (usable(e, n)) return e;
    const f = await getE(st, key + '-f');
    if (f && n < f.validUntil) return f;
  }
  return null;
}

// keyOf(event) → '' (una sola analisi), 'geo' (una per parametro) o null (richiesta da non condividere: parametri mancanti, diagnostica…).
function withShared(name, handle, { keyOf } = {}) {
  return async function sharedHandler(event) {
    if (process.env.SHARED_AI_CACHE === 'off') return handle(event);
    let part;
    try { part = keyOf ? keyOf(event) : ''; } catch (e) { part = null; }
    if (part === null || part === undefined) return handle(event);
    let st;
    try { st = store(); } catch (e) { return handle(event); }
    const key = PREFIX + name + (part ? '-' + part : '');

    const now0 = D.now();
    const cur = await getE(st, key);
    if (cur && now0 < cur.validUntil) return fromEntry(cur, 'hit');                       // analisi valida: tutti la stessa
    if (cur && cur.retryAt && now0 < cur.retryAt) return fromEntry(cur, 'stale', cur.retryAt);   // ultimo tentativo fallito: si resta su quella precedente
    const fl = await getE(st, key + '-f');
    if (fl && now0 < fl.validUntil) return fromEntry(fl, 'fail');                         // ripiego condiviso: un solo nuovo tentativo per volta

    // Una sola generazione alla volta, in tutte le aree.
    const token = Math.random().toString(36).slice(2) + now0.toString(36);
    let owner = false;
    const lock = await getE(st, key + '-l');
    if (!lock || D.now() - lock.t > LOCK_S * 1000) {
      await setE(st, key + '-l', { o: token, t: D.now() }, LOCK_S);
      const chk = await getE(st, key + '-l');
      owner = !chk || chk.o === token;           // memoria non leggibile: si procede da soli come prima
    }
    if (!owner) {
      if (cur && now0 - cur.validUntil < STALE_WAIT_MAX_MS) return fromEntry(cur, 'stale', D.now() + 15e3);   // mentre l'altra rigenera: la precedente, per tutti
      const w = await waitFor(st, key);
      if (w) return fromEntry(w, w.ok ? 'wait' : 'fail', w.ok ? undefined : w.validUntil);
      // attesa scaduta: si genera comunque
    }

    const t0 = D.now();
    let res;
    try { res = await handle(event); } finally { if (owner) await delE(st, key + '-l'); }
    if (!res || res.statusCode !== 200 || typeof res.body !== 'string') return mark(res || { statusCode: 500 }, 'miss');

    const ttl = sMaxAge(res.headers), n = D.now();
    if (res.shareOk && ttl > 0) {
      const again = await getE(st, key);                                                   // qualcun altro ha finito prima di noi? si adotta la sua
      if (again && again.storedAt >= t0 && n < again.validUntil) return fromEntry(again, 'adopt');
      const e = { v: 1, body: res.body, ok: true, generatedAt: n, storedAt: n, validUntil: n + ttl * 1000 };
      await setE(st, key, e, KEEP_S);
      return fromEntry(e, 'stored');
    }
    // Generazione non riuscita (quota, errore, risposta incompleta).
    const retry = Math.max(30, ttl || 120);
    if (cur && n - cur.storedAt < KEEP_S * 1000) {                                         // c'è una analisi precedente: resta quella, uguale per tutti
      const e2 = { ...cur, retryAt: n + retry * 1000 };
      await setE(st, key, e2, KEEP_S - (n - cur.storedAt) / 1000);
      return fromEntry(e2, 'stale', e2.retryAt);
    }
    if (ttl > 0) {                                                                         // niente da mostrare: il ripiego, uguale per tutti, e un solo nuovo tentativo
      const e = { v: 1, body: res.body, ok: false, generatedAt: n, storedAt: n, validUntil: n + ttl * 1000 };
      await setE(st, key + '-f', e, ttl);
      return fromEntry(e, 'fail', e.validUntil);
    }
    return mark(res, 'miss');
  };
}

// Chiave breve e sicura per un URL a partire da testi liberi (titolo di un evento…).
function digest(...parts) { return crypto.createHash('sha1').update(parts.map((p) => String(p == null ? '' : p).trim()).join('\u0001')).digest('hex').slice(0, 16); }

module.exports = { withShared, digest, _deps: D, _internal: { PREFIX, KEEP_S, LOCK_S, MIN_S } };
