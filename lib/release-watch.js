// lib/release-watch.js
//
// Durata della cache che tiene conto dei dati in uscita. Prima i testi AI restavano in cache 3 ore comunque: se il Non-Farm Payrolls usciva alle 14:30
// e il testo era stato generato alle 14:00, gli studenti leggevano l'analisi "prima del dato" fino alle 17:00.
//
// Ora la durata viene accorciata in due casi (altrimenti resta quella di base):
//  1) sta per uscire un dato importante (alto impatto, USD/EUR/GBP/JPY, con previsione, oppure una decisione sui tassi): la cache scade
//     poco DOPO l'uscita, così la prima richiesta successiva genera il testo con il numero vero;
//  2) un dato importante è uscito da poco ma il calendario non ha ancora il valore "actual" (succede per qualche minuto): cache breve, si riprova presto.
// Le richieste al calendario sono una sola finestra di ~40 ore, tenuta in memoria 5 minuti: costo trascurabile. Se il calendario non risponde si usa la durata di base.

const { fetchCalendarEvents } = require('./calendar');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY'];
const AFTER_RELEASE_S = 180;      // la cache scade 3 minuti dopo l'ora del dato, quando il valore "actual" è di solito già nel calendario
const LAG_WINDOW_MS = 45 * 60e3;  // oltre 45 minuti senza valore, il dato non viene più aspettato (es. rinviato)
const MEMO_MS = 5 * 60e3;

let memo = { t: 0, events: null };

function isRelease(e) {
  return e.importance === 'alto' && CURRENCIES.includes(e.currency) && (e.forecast != null || /interest rate decision|fomc (statement|press)|press conference/i.test(e.title));
}

async function watched() {
  if (memo.events && Date.now() - memo.t < MEMO_MS) return memo.events;
  const now = Date.now();
  const events = await fetchCalendarEvents({ from: new Date(now - 3 * 3600e3).toISOString(), to: new Date(now + 36 * 3600e3).toISOString(), countries: 'US,EU,GB,JP' });
  memo = { t: Date.now(), events: events.filter(isRelease) };
  return memo.events;
}

// base e floor in secondi: la durata torna un numero tra floor e base
async function releaseAwareTtl(base, floor = 300) {
  try {
    const events = await watched();
    const now = Date.now();
    let ttl = base;
    const next = events.map((e) => new Date(e.date).getTime()).filter((t) => t > now).sort((a, b) => a - b)[0];
    if (next != null) ttl = Math.min(ttl, Math.round((next - now) / 1000) + AFTER_RELEASE_S);
    const waiting = events.some((e) => { const t = new Date(e.date).getTime(); return t <= now && now - t < LAG_WINDOW_MS && e.actual == null; });
    if (waiting) ttl = Math.min(ttl, floor);
    return Math.max(floor, Math.min(base, ttl));
  } catch (e) {
    return base;
  }
}

module.exports = { releaseAwareTtl };
