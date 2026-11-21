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
const { fred, yoyList } = require('./indicators');   // serie FRED (anno su anno calcolato per data) per i dati che non sono eventi del calendario

// polarity decide il colore della card rispetto alle attese:
//   infl   → sopra le attese = rosso (più inflazione), sotto = verde
//   growth → sopra = verde, sotto = rosso
//   unemp  → sopra = rosso, sotto = verde
//   rate   → colore neutro (un tasso di policy non è "buono/cattivo")
const CARDS = {
  us: [
    { id: 'us_cpi_yoy',   lbl: 'CPI YoY',                country: 'US', re: /^Inflation Rate YoY$/,            pol: 'infl' },
    { id: 'us_core_yoy',  lbl: 'Core CPI YoY',           country: 'US', re: /^Core Inflation Rate YoY$/,       pol: 'infl' },
    // Super Core e Shelter NON sono eventi del calendario: gli analisti non pubblicano un "atteso". Arrivano dalle serie BLS su FRED (anno su anno, calcolato per data):
    // la card mostra ultimo valore e precedente, senza esito rispetto alle attese.
    { id: 'us_supercore', lbl: 'Super Core CPI YoY',     country: 'US', fred: 'CUSR0000SASL2RS',                  pol: 'infl' },
    { id: 'us_shelter',   lbl: 'Shelter CPI YoY',        country: 'US', fred: 'CUSR0000SAH1',                     pol: 'infl' },
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
  // Senza un atteso degli analisti non c'è nessuna "sorpresa" da valutare: nessun "sopra/sotto le attese" e colore neutro. Prima si ripiegava sul valore precedente, e righe come ZEW
  // (Europa) e Tasso di partecipazione (Lavoro) risultavano "sopra le attese" (in verde, e così le leggeva anche l'AI) pur non avendo alcuna attesa.
  const ref = forecast;
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

// VARIAZIONE rispetto al dato precedente, per la freccia e la mini-linea di ogni riga: direzione (up/down/flat), testo ("+0,3 pt") e tono per i mercati
// (l'inflazione e la disoccupazione che salgono pesano, la crescita che sale aiuta, un tasso di policy è neutro; invariato = neutro).
function deltaInfo(spec, actual, previous, unit, scale) {
  if (actual == null || previous == null || !isFinite(Number(actual)) || !isFinite(Number(previous))) return {};
  const r = Math.round((Number(actual) - Number(previous)) * 1000) / 1000, flat = Math.abs(r) < 1e-9;
  const dtone = flat || spec.pol === 'rate' ? 'mid' : spec.pol === 'growth' ? (r > 0 ? 'good' : 'bad') : (r > 0 ? 'bad' : 'good');
  const sfx = unit === '%' ? ' pt' : (scale || '');
  return { dir: flat ? 'flat' : r > 0 ? 'up' : 'down', dtone, dtxt: flat ? 'invariato' : (r > 0 ? '+' : '−') + fmtNum(Math.abs(r)) + sfx };
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
    surprise, color, ...deltaInfo(spec, e.actual, e.previous, e.unit, e.scale),
    note: [surpriseTxt, move, `uscito il ${shortDate(e.date)}`].filter(Boolean).join(' · '),
  };
}

// Card da una serie FRED (indice mensile): anno su anno dell'ultimo mese che ha il confronto e del mese prima. Nessun atteso: nessun "sopra/sotto le attese".
// Il colore è sempre neutro (giallo): senza atteso non c'è una sorpresa da valutare, e il verdetto buono/cattivo è già nella card Indicatori chiave. Se FRED non risponde la card non compare (le altre restano).
const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];   // stesso formato dei periodi del calendario ("Sep. 2026")
function buildFredCard(spec, series) {
  const l = series ? yoyList(series) : [];
  if (l.length < 2) return { id: spec.id, lbl: spec.lbl, available: false };
  const r1 = (x) => Math.round(x * 10) / 10, actual = r1(l[0].v), previous = r1(l[1].v);
  const f1 = (x) => x.toFixed(1).replace('.', ',') + '%';
  const color = COLOR.mid;   // senza atteso non c'è una "sorpresa" da colorare: giallo (neutro), come le altre righe senza esito
  const per = `${MON_EN[+l[0].d.slice(5, 7) - 1]}. ${l[0].d.slice(0, 4)}`;
  const d = actual - previous, move = d > 0.0001 ? 'in rialzo sul precedente' : d < -0.0001 ? 'in calo sul precedente' : 'invariato sul precedente';
  return {
    id: spec.id, lbl: `${spec.lbl} (${per})`, baseLbl: spec.lbl, available: true, source: 'FRED', title: spec.lbl, period: per, date: l[0].d, releasedLabel: '',
    actual, forecast: null, previous, cur: f1(actual), fore: '—', prev: f1(previous),   // sempre un decimale (3,0%, non 3%)
    surprise: null, color, ...deltaInfo(spec, actual, previous, '%', ''), note: [move, 'senza atteso degli analisti', 'dato BLS da FRED'].join(' · '),
  };
}

// Ultimi ~100 giorni di calendario USA+UE (+ le serie FRED dei dati senza atteso) → card pronte per il client
async function fetchMacroCards() {
  const to = new Date(Date.now() + 86400000);
  const from = new Date(Date.now() - 100 * 86400000);
  const ids = [...new Set(Object.values(CARDS).flat().filter((s) => s.fred).map((s) => s.fred))];
  const [events, fredSeries] = await Promise.all([
    fetchCalendarEvents({ from: from.toISOString(), to: to.toISOString(), countries: 'US,EU' }),
    Promise.all(ids.map((id) => fred(id, 3).catch((e) => { console.warn('FRED ' + id + ' non disponibile:', e.message); return null; }))),   // un errore di FRED non deve toccare le card del calendario
  ]);
  const series = Object.fromEntries(ids.map((id, i) => [id, fredSeries[i]]));
  const out = {};
  for (const [group, specs] of Object.entries(CARDS)) out[group] = specs.map((s) => (s.fred ? buildFredCard(s, series[s.fred]) : buildCard(s, events)));
  return out;
}

// Righe di testo per il grounding AI: solo dati realmente usciti, con consenso e precedente.
function macroCardLines(cards) {
  const L = [];
  const groupName = { us: 'USA', eu: 'EUROZONA', jobs: 'LAVORO USA' };
  for (const [group, list] of Object.entries(cards)) {
    list.filter((c) => c.available).forEach((c) => {
      if (c.source === 'FRED') { L.push(`- [${groupName[group]}] ${c.lbl}: ${c.cur} (precedente ${c.prev}; nessun atteso degli analisti per questo dato, serie BLS da FRED)`); return; }
      if (c.forecast == null) { L.push(`- [${groupName[group]}] ${c.lbl}: ${c.cur} (precedente ${c.prev}; nessun atteso degli analisti per questo dato) — uscito il ${c.releasedLabel}`); return; }
      L.push(`- [${groupName[group]}] ${c.lbl}: ${c.cur} (atteso ${c.fore}, precedente ${c.prev}) — uscito il ${c.releasedLabel}${c.surprise ? `, ${c.surprise === 'above' ? 'SOPRA' : c.surprise === 'below' ? 'SOTTO' : 'IN LINEA CON'} le attese` : ''}`);
    });
  }
  return L.join('\n');
}

// ---------- STORICO per le mini-linee: ultimi 12 mesi di ogni dato (ultime 26 settimane per i sussidi) ----------
// Dal calendario reale, in blocchi da 30 giorni scaricati UNO ALLA VOLTA (la fonte tronca a 2.000 eventi e limita le richieste parallele): circa 3 secondi a freddo.
// I blocchi vecchi non cambiano: restano in memoria 12 ore (finestre allineate alla mezzanotte UTC, così non si creano buchi); solo l'ultimo mese si rilegge ogni 10 minuti.
// Un valore per periodo (Flash e Final dello stesso mese: vale l'ultimo). Per Super Core e Shelter la serie è quella FRED, anno su anno per data.
const HIST_CHUNKS = 12, HIST_DAYS = 30, HIST_PTS = { us_claims: 26, us_cclaims: 26 };
const histCache = new Map();
async function histChunk(k) {
  const day0 = Math.floor(Date.now() / 86400e3) * 86400e3, key = day0 + ':' + k, ttl = k === 0 ? 10 * 60e3 : 12 * 3600e3, hit = histCache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.ev;
  const to = day0 + 2 * 86400e3 - k * HIST_DAYS * 86400e3, from = day0 + 2 * 86400e3 - (k + 1) * HIST_DAYS * 86400e3;
  const ev = await fetchCalendarEvents({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), countries: 'US,EU' });
  histCache.set(key, { t: Date.now(), ev }); if (histCache.size > 40) histCache.delete(histCache.keys().next().value);
  return ev;
}
function histSeries(spec, events) {
  const byPer = new Map();
  events.filter((e) => e.country === spec.country && e.actual != null && isFinite(Number(e.actual)) && spec.re.test(e.title)).sort((a, b) => new Date(a.date) - new Date(b.date))
    .forEach((e) => byPer.set((e.period || '') + '|' + e.date.slice(0, 4), e));
  const list = [...byPer.values()].sort((a, b) => new Date(a.date) - new Date(b.date)).slice(-(HIST_PTS[spec.id] || 12));
  return { d: list.map((e) => e.date.slice(0, 10)), v: list.map((e) => Number(e.actual)) };
}
async function fetchMacroHistory() {
  const events = [], seen = new Set();
  for (let k = 0; k < HIST_CHUNKS; k++) {
    try { for (const e of await histChunk(k)) { const key = e.id || `${e.date}|${e.title}|${e.country}`; if (!seen.has(key)) { seen.add(key); events.push(e); } } }
    catch (err) { console.warn('storico macro: blocco ' + k + ' non scaricato:', err.message); }
  }
  const specs = Object.values(CARDS).flat(), ids = [...new Set(specs.filter((s) => s.fred).map((s) => s.fred))];
  const fredSeries = await Promise.all(ids.map((id) => fred(id, 3).catch(() => null))), bySeries = Object.fromEntries(ids.map((id, i) => [id, fredSeries[i]]));
  const out = {};
  for (const s of specs) {
    let h = null;
    if (s.fred) { const l = bySeries[s.fred] ? yoyList(bySeries[s.fred]).slice(0, 13).reverse() : []; h = { d: l.map((x) => x.d), v: l.map((x) => Math.round(x.v * 100) / 100) }; }
    else if (s.re) h = histSeries(s, events);
    if (h && h.v.length >= 3) out[s.id] = h;
  }
  return out;
}

module.exports = { fetchMacroCards, macroCardLines, fetchMacroHistory, CARDS };
