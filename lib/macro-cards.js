// lib/macro-cards.js
//
// Card "Macro USA", "Europa" e "Lavoro" costruite dagli ULTIMI dati realmente pubblicati nel
// calendario economico (TradingView, lib/calendar.js): attuale, atteso dal consensus e
// precedente. Prima erano valori scritti a mano (CPI di luglio, NFP di luglio...) che
// invecchiavano; ora ogni card prende l'evento più recente già uscito per quell'indicatore.
//
// Condiviso da api/economic-calendar.js (?view=macro, per il client) e api/narrative.js
// (grounding AI: i dati usciti sono nel prompt, quindi le note non possono contraddire le card).

const { fetchCalendarEvents } = require('./calendar');

// polarity decide il colore della card rispetto alle attese:
//   infl   → sopra le attese = rosso (più inflazione), sotto = verde
//   growth → sopra = verde, sotto = rosso
//   unemp  → sopra = rosso, sotto = verde
//   rate   → colore neutro (un tasso di policy non è "buono/cattivo")
const CARDS = {
  us: [
    { id: 'us_cpi_yoy',   lbl: 'CPI YoY',                country: 'US', re: /^Inflation Rate YoY$/,            pol: 'infl' },
    { id: 'us_core_yoy',  lbl: 'Core CPI YoY',           country: 'US', re: /^Core Inflation Rate YoY$/,       pol: 'infl' },
    { id: 'us_cpi_mom',   lbl: 'CPI MoM',                country: 'US', re: /^Inflation Rate MoM$/,            pol: 'infl' },
    { id: 'us_ppi_yoy',   lbl: 'PPI YoY',                country: 'US', re: /^PPI YoY$/,                       pol: 'infl' },
    { id: 'us_ppi_mom',   lbl: 'PPI MoM',                country: 'US', re: /^PPI MoM$/,                       pol: 'infl' },
    { id: 'us_ism_mfg',   lbl: 'ISM Manufacturing PMI',  country: 'US', re: /^ISM Manufacturing PMI$/,         pol: 'growth' },
    { id: 'us_ism_svc',   lbl: 'ISM Services PMI',       country: 'US', re: /^ISM Services PMI$/,              pol: 'growth' },
    { id: 'us_gdp',       lbl: 'PIL annualizzato',     country: 'US', re: /^GDP Growth Rate QoQ( |$)/,       pol: 'growth' },
  ],
  eu: [
    { id: 'eu_cpi_yoy',   lbl: 'CPI Eurozona YoY',       country: 'EU', re: /^Inflation Rate YoY( Flash| Final)?$/,      pol: 'infl' },
    { id: 'eu_core_yoy',  lbl: 'Core CPI Eurozona YoY',  country: 'EU', re: /^Core Inflation Rate YoY( Flash| Final)?$/, pol: 'infl' },
    { id: 'eu_gdp',       lbl: 'PIL Eurozona QoQ',       country: 'EU', re: /^GDP Growth Rate QoQ/,                      pol: 'growth' },
    { id: 'eu_unemp',     lbl: 'Disoccupazione Eurozona', country: 'EU', re: /^Unemployment Rate$/,                      pol: 'unemp' },
    { id: 'eu_depo',      lbl: 'Tasso BCE deposito',   country: 'EU', re: /^Deposit Facility Rate$/,                   pol: 'rate' },
    { id: 'eu_retail',    lbl: 'Vendite al dettaglio MoM', country: 'EU', re: /^Retail Sales MoM$/,                      pol: 'growth' },
    { id: 'eu_indprod',   lbl: 'Produzione industriale MoM', country: 'EU', re: /^Industrial Production MoM$/,           pol: 'growth' },
    { id: 'eu_zew',       lbl: 'ZEW Economic Sentiment', country: 'EU', re: /^ZEW Economic Sentiment Index$/,            pol: 'growth' },
  ],
  jobs: [
    { id: 'us_nfp',       lbl: 'Non-Farm Payrolls',      country: 'US', re: /^Non Farm Payrolls$/,             pol: 'growth' },
    { id: 'us_unemp',     lbl: 'Tasso disoccupazione',   country: 'US', re: /^Unemployment Rate$/,             pol: 'unemp' },
    { id: 'us_ahe',       lbl: 'Salari orari YoY',       country: 'US', re: /^Average Hourly Earnings YoY$/,   pol: 'infl' },
    { id: 'us_jolts',     lbl: 'Offerte di lavoro JOLTs', country: 'US', re: /^JOLTs Job Openings$/,           pol: 'growth' },
    { id: 'us_u6',        lbl: 'U-6 sottoccupazione',  country: 'US', re: /^U-6 Unemployment Rate$/,         pol: 'unemp' },
    { id: 'us_part',      lbl: 'Tasso partecipazione',   country: 'US', re: /^Participation Rate$/,            pol: 'growth' },
    { id: 'us_claims',    lbl: 'Richieste sussidio iniziali', country: 'US', re: /^Initial Jobless Claims$/,   pol: 'unemp' },
    { id: 'us_cclaims',   lbl: 'Richieste continuative', country: 'US', re: /^Continuing Jobless Claims$/,     pol: 'unemp' },
  ],
};

const MONTHS_IT = { Jan: 'gen', Feb: 'feb', Mar: 'mar', Apr: 'apr', May: 'mag', Jun: 'giu', Jul: 'lug', Aug: 'ago', Sep: 'set', Oct: 'ott', Nov: 'nov', Dec: 'dic' };

// 'Sep' → 'set', 'Q2' → 'Q2', 'Oct/03' → '3 ott'
function periodIt(p) {
  if (!p) return '';
  const w = String(p).match(/^([A-Z][a-z]{2})\/(\d{1,2})$/);
  if (w) return `${parseInt(w[2], 10)} ${MONTHS_IT[w[1]] || w[1]}`;
  return MONTHS_IT[p] || p;
}

function fmtNum(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (isNaN(n)) return String(v);
  const s = Math.abs(n) >= 1000 ? n.toLocaleString('it-IT', { maximumFractionDigits: 1 }) : String(Math.round(n * 1000) / 1000).replace('.', ',');
  return s;
}

function fmtVal(v, e) {
  if (v === null || v === undefined || v === '') return '—';
  const base = fmtNum(v);
  if (base === '—') return base;
  const suffix = e.unit === '%' ? '%' : '';
  const scale = e.scale && e.unit !== '%' ? e.scale : '';
  return `${base}${suffix}${scale}`;
}

function shortDate(iso) {
  return new Date(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', timeZone: 'Europe/Rome' }).replace('.', '');
}

const COLOR = { good: 'green', bad: 'red', mid: 'gold' };

function toneFor(pol, actual, forecast, previous) {
  const ref = forecast != null ? forecast : previous;
  if (actual == null || ref == null) return { color: COLOR.mid, surprise: null };
  const diff = Number(actual) - Number(ref);
  const tol = Math.max(Math.abs(Number(ref)) * 0.001, 0.0001);
  if (Math.abs(diff) <= tol) return { color: COLOR.mid, surprise: 'inline' };
  const above = diff > 0;
  const surprise = above ? 'above' : 'below';
  if (pol === 'rate') return { color: COLOR.mid, surprise };
  if (pol === 'growth') return { color: above ? COLOR.good : COLOR.bad, surprise };
  return { color: above ? COLOR.bad : COLOR.good, surprise };   // infl, unemp
}

function buildCard(spec, events) {
  const matches = events
    .filter((e) => e.country === spec.country && e.actual != null && spec.re.test(e.title))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const e = matches[matches.length - 1];
  if (!e) return { id: spec.id, lbl: spec.lbl, available: false };
  const { color, surprise } = toneFor(spec.pol, e.actual, e.forecast, e.previous);
  const per = periodIt(e.period);
  const surpriseTxt = surprise === 'above' ? 'sopra le attese' : surprise === 'below' ? 'sotto le attese' : surprise === 'inline' ? 'in linea con le attese' : '';
  let move = '';
  if (e.previous != null) {
    const d = Number(e.actual) - Number(e.previous);
    move = d > 0 ? 'in rialzo sul precedente' : d < 0 ? 'in calo sul precedente' : 'invariato sul precedente';
  }
  return {
    id: spec.id,
    lbl: per ? `${spec.lbl} (${per})` : spec.lbl,
    baseLbl: spec.lbl,
    available: true,
    title: e.title,
    period: per,
    date: e.date,
    releasedLabel: shortDate(e.date),
    actual: e.actual, forecast: e.forecast, previous: e.previous,
    cur: fmtVal(e.actual, e), fore: fmtVal(e.forecast, e), prev: fmtVal(e.previous, e),
    surprise, color,
    note: [surpriseTxt, move, `uscito il ${shortDate(e.date)}`].filter(Boolean).join(' · '),
  };
}

// Ultimi ~100 giorni di calendario USA+UE → card pronte per il client
async function fetchMacroCards() {
  const to = new Date(Date.now() + 86400000);
  const from = new Date(Date.now() - 100 * 86400000);
  const events = await fetchCalendarEvents({ from: from.toISOString(), to: to.toISOString(), countries: 'US,EU' });
  const out = {};
  for (const [group, specs] of Object.entries(CARDS)) out[group] = specs.map((s) => buildCard(s, events));
  return out;
}

// Righe di testo per il grounding AI: solo dati realmente usciti, con consenso e precedente.
function macroCardLines(cards) {
  const L = [];
  const groupName = { us: 'USA', eu: 'EUROZONA', jobs: 'LAVORO USA' };
  for (const [group, list] of Object.entries(cards)) {
    list.filter((c) => c.available).forEach((c) => {
      L.push(`- [${groupName[group]}] ${c.lbl}: ${c.cur} (atteso ${c.fore}, precedente ${c.prev}) — uscito il ${c.releasedLabel}${c.surprise ? `, ${c.surprise === 'above' ? 'SOPRA' : c.surprise === 'below' ? 'SOTTO' : 'IN LINEA CON'} le attese` : ''}`);
    });
  }
  return L.join('\n');
}

module.exports = { fetchMacroCards, macroCardLines, CARDS };
