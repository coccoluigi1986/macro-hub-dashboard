// lib/fedwatch.js
//
// Probabilità di taglio / invariato / rialzo dei tassi Fed "stile CME FedWatch", ricavate dai future sui Fed Funds.
// Il dato ufficiale CME FedWatch è a pagamento: qui si usano gli stessi future (ZQ), letti gratis da Yahoo Finance, con il
// metodo semplificato descritto da CME. Il risultato è una STIMA: può differire di qualche punto dal dato ufficiale.
//
// Metodo:
//  - Il future Fed Funds di un mese quota 100 − (tasso effettivo medio atteso nel mese).
//  - Per una riunione FOMC nel mese M (decisione al giorno D, nuovo tasso dal giorno D+1) il tasso medio del mese è la
//    media pesata del tasso prima (D giorni) e dopo (N−D giorni): da qui si ricava il tasso atteso DOPO la riunione.
//  - Se la riunione cade negli ultimi giorni del mese (meno di 7 giorni dopo la decisione) il peso è troppo piccolo:
//    si usa il future del mese successivo, che incorpora già il nuovo tasso per tutto il mese.
//  - La variazione attesa (in multipli di 25 pb) si ripartisce tra i due livelli adiacenti: +2,5 pb = 10% rialzo, 90% invariato.
//  - Dalla seconda riunione in poi le probabilità sono CUMULATE rispetto a oggi (non solo per quel passo).
// Usato da api/fred-data.js (?view=fedwatch).

const { fetchYahooQuote } = require('./yahoo');
const { fetchCalendarEvents } = require('./calendar');
const { fetchFredSnapshot } = require('./fred');

const MONTH_CODE = 'FGHJKMNQUVXZ';
// Giorni di decisione (ultimo giorno di ogni riunione) del calendario FOMC 2026 pubblicato dalla Fed. Le riunioni successive
// al 2026 vengono prese dal calendario economico live quando compaiono (sempre la prossima).
const FOMC_DECISIONS_2026 = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'];
const DECISION_CUTOFF_UTC_HOUR = 20;   // il comunicato esce alle 14:00 di New York (18-19 UTC): dopo le 20 UTC la riunione del giorno è "passata"

const contractSymbol = (y, m0) => `ZQ${MONTH_CODE[m0]}${String(y).slice(2)}.CBT`;      // m0 = 0..11
const ym = (y, m0) => `${y}-${String(m0 + 1).padStart(2, '0')}`;
const daysIn = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

// Prossime riunioni (date ISO del giorno di decisione), dalla prima ancora da svolgere.
function upcomingMeetings(now, nextFromCalendar, count = 2) {
  const today = now.toISOString().slice(0, 10), decided = now.getUTCHours() >= DECISION_CUTOFF_UTC_HOUR;
  const set = new Set(FOMC_DECISIONS_2026);
  if (nextFromCalendar) set.add(nextFromCalendar);
  return [...set].filter((d) => d > today || (d === today && !decided)).sort().slice(0, count);
}

// Mesi di cui servono i future: quello di ogni riunione e il successivo.
function monthsNeeded(meetings) {
  const need = new Map();
  meetings.forEach((d) => {
    const [y, m] = d.split('-').map(Number);
    for (const k of [0, 1]) { const mm = (m - 1 + k) % 12, yy = y + Math.floor((m - 1 + k) / 12); need.set(ym(yy, mm), { y: yy, m0: mm }); }
  });
  return [...need.entries()].map(([key, v]) => ({ key, ...v, symbol: contractSymbol(v.y, v.m0) }));
}

// futures: { 'YYYY-MM': tasso implicito in % (100 − prezzo) }
function computeFedWatch({ effr, targetLower, targetUpper, meetings, futures }) {
  let rPre = effr; const out = [];
  for (const iso of meetings) {
    const [y, m, d] = iso.split('-').map(Number), m0 = m - 1, N = daysIn(y, m0), after = N - d;
    const nextKey = ym(y + Math.floor((m0 + 1) / 12), (m0 + 1) % 12);
    let rPost = null, via = null;
    if (after >= 7 && futures[ym(y, m0)] != null) { rPost = (futures[ym(y, m0)] * N - rPre * d) / after; via = ym(y, m0); }
    else if (futures[nextKey] != null) { rPost = futures[nextKey]; via = nextKey; }
    if (rPost == null || !isFinite(rPost)) break;
    const cumBp = (rPost - effr) * 100, steps = Math.max(-6, Math.min(6, cumBp / 25));
    const lo = Math.floor(steps + 1e-9), hi = Math.ceil(steps - 1e-9);
    const dist = {};
    if (lo === hi) dist[lo] = 1; else { dist[lo] = hi - steps; dist[hi] = steps - lo; }
    const levels = Object.entries(dist).map(([s, p]) => ({ steps: Number(s), p, lower: targetLower + Number(s) * 0.25, upper: targetUpper + Number(s) * 0.25 })).sort((a, b) => a.steps - b.steps);
    out.push({
      date: iso, rPost, cumBp, via, levels,
      pHike: levels.filter((l) => l.steps > 0).reduce((s, l) => s + l.p, 0),
      pHold: (levels.find((l) => l.steps === 0) || { p: 0 }).p,
      pCut: levels.filter((l) => l.steps < 0).reduce((s, l) => s + l.p, 0),
    });
    rPre = rPost;
  }
  return out;
}

// Raccoglie gli input (tasso Fed da FRED, calendario, future da Yahoo) e calcola. Lancia un errore se manca qualcosa di essenziale:
// il chiamante mostra "non disponibile", senza inventare numeri.
async function getFedWatch(fredApiKey) {
  const fred = await fetchFredSnapshot(fredApiKey);
  const effr = parseFloat(fred.fedFundsRate), lower = Number(fred.fedTargetLower), upper = Number(fred.fedTargetUpper);
  if (![effr, lower, upper].every(isFinite)) throw new Error('tasso Fed non disponibile da FRED');
  const now = new Date();
  let nextCal = null;
  try {
    const events = await fetchCalendarEvents({ from: now.toISOString(), to: new Date(now.getTime() + 60 * 86400000).toISOString(), countries: 'US' });
    const dec = events.filter((e) => /^Fed Interest Rate Decision$/i.test(e.title) && new Date(e.date) > now).sort((a, b) => a.date.localeCompare(b.date))[0];
    if (dec) nextCal = dec.date.slice(0, 10);
  } catch (e) { /* senza calendario live si usa quello Fed 2026 */ }
  const meetings = upcomingMeetings(now, nextCal, 2);
  if (!meetings.length) throw new Error('nessuna riunione FOMC in programma');
  const months = monthsNeeded(meetings);
  const quotes = await Promise.allSettled(months.map((mo) => fetchYahooQuote(mo.symbol)));
  const futures = {}, prices = {};
  quotes.forEach((q, i) => { if (q.status === 'fulfilled' && q.value.price != null) { prices[months[i].symbol] = q.value.price; futures[months[i].key] = 100 - q.value.price; } });
  const fw = computeFedWatch({ effr, targetLower: lower, targetUpper: upper, meetings, futures });
  if (!fw.length) throw new Error('future Fed Funds non disponibili');
  return {
    asOf: now.toISOString(), effr, lower, upper, meetings: fw, prices,
    source: 'Stima dai future Fed Funds CME (Yahoo Finance) con metodo semplificato; tasso Fed da FRED',
  };
}

module.exports = { getFedWatch, computeFedWatch, upcomingMeetings, monthsNeeded, contractSymbol, FOMC_DECISIONS_2026 };
