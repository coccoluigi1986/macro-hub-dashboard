// BOZZA api — sostituto di lib/cot.js: 2 richieste Socrata ("in (...)", una per dataset) invece di 15 (una per contratto).
// Stesso risultato (stessi campi, stesse 53 righe per contratto, stessi percentili): si verifica con cot-confronto.js.
// Se la richiesta unica fallisce (HTTP o rete), per quel dataset si ripiega sulle richieste per contratto di prima: nessun contratto manca per un errore passeggero.
const SOCRATA_BASE = 'https://publicreporting.cftc.gov/resource';
const LEGACY_DATASET = '6dca-aqww';
const DISAGG_DATASET = '72hh-3qpy';
const HISTORY_ROWS = 53;
const WINDOW_WEEKS = 62;   // finestra di date richiesta in blocco; poi si tengono le 53 righe più recenti per contratto (come prima). 62 settimane = 9 di margine per report saltati

const LEGACY_CODES = { gold: '088691', silver: '084691', eur: '099741', gbp: '096742', jpy: '097741', dxy: '098662', sp500: '13874A', nasdaq: '209742', russell: '239742', bitcoin: '133741', ether: '146021', dow: '124603', vix: '1170E1' };
const DISAGG_CODES = { wti: '067651', brent: '06765T' };

const LEGACY_SELECT = ['report_date_as_yyyy_mm_dd', 'open_interest_all', 'change_in_open_interest_all',
  'noncomm_positions_long_all', 'noncomm_positions_short_all', 'change_in_noncomm_long_all', 'change_in_noncomm_short_all',
  'comm_positions_long_all', 'comm_positions_short_all', 'change_in_comm_long_all', 'change_in_comm_short_all'].join(',');
const DISAGG_SELECT = ['report_date_as_yyyy_mm_dd', 'open_interest_all', 'change_in_open_interest_all',
  'm_money_positions_long_all', 'm_money_positions_short_all', 'change_in_m_money_long_all', 'change_in_m_money_short_all'].join(',');

function num(v) { if (v === undefined || v === null || v === '') return null; const n = parseFloat(v); return isNaN(n) ? null : n; }
function percentileRank(current, values) { const v = values.filter((x) => x !== null); if (v.length < 8) return null; return Math.round((v.filter((x) => x <= current).length / v.length) * 100); }

async function fetchWithRetry(url) {
  try { return await fetch(url); } catch (e) { await new Promise((r) => setTimeout(r, 500)); return fetch(url); }
}

// ---- percorso di prima: una richiesta per contratto (resta come ripiego) ----
function buildUrlOne(dataset, code, dateParam, select) {
  const whereParts = [`cftc_contract_market_code='${code}'`];
  if (dateParam) whereParts.push(`report_date_as_yyyy_mm_dd<='${dateParam}T00:00:00.000'`);
  const params = new URLSearchParams({ '$select': select, '$where': whereParts.join(' AND '), '$order': 'report_date_as_yyyy_mm_dd DESC', '$limit': String(HISTORY_ROWS) });
  return `${SOCRATA_BASE}/${dataset}.json?${params.toString()}`;
}
async function fetchRowsOne(dataset, code, dateParam, select) {
  const res = await fetchWithRetry(buildUrlOne(dataset, code, dateParam, select));
  if (!res.ok) throw new Error(`HTTP ${res.status} per codice ${code}`);
  return res.json();
}

// ---- percorso nuovo: tutti i contratti di un dataset in una richiesta; ritorna { codice: righe (le più recenti per prime, al massimo 53) } ----
async function fetchRowsBulk(dataset, codes, dateParam, select) {
  const end = dateParam ? new Date(dateParam + 'T00:00:00Z') : new Date();
  const since = new Date(end.getTime() - WINDOW_WEEKS * 7 * 86400e3).toISOString().slice(0, 10);
  const where = [`cftc_contract_market_code in(${codes.map((c) => `'${c}'`).join(',')})`, `report_date_as_yyyy_mm_dd>='${since}T00:00:00.000'`];
  if (dateParam) where.push(`report_date_as_yyyy_mm_dd<='${dateParam}T00:00:00.000'`);
  const params = new URLSearchParams({ '$select': 'cftc_contract_market_code,' + select, '$where': where.join(' AND '), '$order': 'report_date_as_yyyy_mm_dd DESC', '$limit': String(codes.length * (WINDOW_WEEKS + 2)) });
  const res = await fetchWithRetry(`${SOCRATA_BASE}/${dataset}.json?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const all = await res.json();
  const by = {};
  for (const r of all) { const k = r.cftc_contract_market_code; (by[k] = by[k] || []).push(r); }   // già in ordine di data decrescente
  for (const k of Object.keys(by)) by[k] = by[k].slice(0, HISTORY_ROWS);
  return by;
}

async function rowsFor(dataset, codes, dateParam, select) {
  let by = null;
  try { by = await fetchRowsBulk(dataset, codes, dateParam, select); } catch (e) { by = null; }
  // un contratto senza righe nella risposta unica (o la richiesta unica fallita) si rilegge da solo, come prima
  const out = {};
  await Promise.all(codes.map(async (code) => {
    if (by && by[code] && by[code].length) { out[code] = { rows: by[code] }; return; }
    try { const rows = await fetchRowsOne(dataset, code, dateParam, select); out[code] = rows.length ? { rows } : { error: `Nessun report trovato per il codice ${code}${dateParam ? ' alla data richiesta' : ''}.` }; }
    catch (err) { out[code] = { error: err.message }; }
  }));
  return out;
}

function legacyFrom(rows) {
  const r = rows[0];
  const ncLong = num(r.noncomm_positions_long_all), ncShort = num(r.noncomm_positions_short_all), commLong = num(r.comm_positions_long_all), commShort = num(r.comm_positions_short_all);
  const nets = rows.map((x) => { const l = num(x.noncomm_positions_long_all), s = num(x.noncomm_positions_short_all); return l !== null && s !== null ? l - s : null; });
  const net = nets[0];
  return {
    reportDate: r.report_date_as_yyyy_mm_dd ? r.report_date_as_yyyy_mm_dd.slice(0, 10) : null,
    openInterest: num(r.open_interest_all), openInterestChange: num(r.change_in_open_interest_all),
    nonCommercialLong: ncLong, nonCommercialShort: ncShort, nonCommercialNet: net,
    nonCommercialChangeLong: num(r.change_in_noncomm_long_all), nonCommercialChangeShort: num(r.change_in_noncomm_short_all),
    commercialLong: commLong, commercialShort: commShort, commercialNet: (commLong !== null && commShort !== null) ? commLong - commShort : null,
    commercialChangeLong: num(r.change_in_comm_long_all), commercialChangeShort: num(r.change_in_comm_short_all),
    netPercentile52w: net !== null ? percentileRank(net, nets) : null,
    netPercentile26w: net !== null ? percentileRank(net, nets.slice(0, 27)) : null,
    historyWeeks: nets.filter((x) => x !== null).length,
  };
}
function disaggFrom(rows) {
  const r = rows[0];
  const mmLong = num(r.m_money_positions_long_all), mmShort = num(r.m_money_positions_short_all);
  const nets = rows.map((x) => { const l = num(x.m_money_positions_long_all), s = num(x.m_money_positions_short_all); return l !== null && s !== null ? l - s : null; });
  const net = nets[0];
  return {
    reportDate: r.report_date_as_yyyy_mm_dd ? r.report_date_as_yyyy_mm_dd.slice(0, 10) : null,
    openInterest: num(r.open_interest_all), openInterestChange: num(r.change_in_open_interest_all),
    managedMoneyLong: mmLong, managedMoneyShort: mmShort, managedMoneyNet: net,
    managedMoneyChangeLong: num(r.change_in_m_money_long_all), managedMoneyChangeShort: num(r.change_in_m_money_short_all),
    netPercentile52w: net !== null ? percentileRank(net, nets) : null,
    netPercentile26w: net !== null ? percentileRank(net, nets.slice(0, 27)) : null,
    historyWeeks: nets.filter((x) => x !== null).length,
  };
}

async function fetchCotSnapshot(dateParam) {
  const legacyEntries = Object.entries(LEGACY_CODES), disaggEntries = Object.entries(DISAGG_CODES);
  const [lg, dg] = await Promise.all([
    rowsFor(LEGACY_DATASET, legacyEntries.map(([, c]) => c), dateParam, LEGACY_SELECT),
    rowsFor(DISAGG_DATASET, disaggEntries.map(([, c]) => c), dateParam, DISAGG_SELECT),
  ]);
  const data = {};
  legacyEntries.forEach(([key, code]) => { data[key] = lg[code].error ? { error: lg[code].error } : legacyFrom(lg[code].rows); });
  disaggEntries.forEach(([key, code]) => { data[key] = dg[code].error ? { error: dg[code].error } : disaggFrom(dg[code].rows); });
  const errors = Object.entries(data).filter(([, v]) => v.error).map(([k, v]) => `${k}: ${v.error}`);
  const reportDates = Object.values(data).map((d) => d.reportDate).filter(Boolean);
  const latestReportDate = reportDates.length ? reportDates.sort().reverse()[0] : null;
  return { latestReportDate, data, errors };
}

module.exports = { fetchCotSnapshot };
