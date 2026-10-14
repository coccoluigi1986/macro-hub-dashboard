// lib/cot.js
//
// COT Report REALE dall'API pubblica ufficiale della CFTC (Socrata, "Public Reporting
// Environment") — nessuna chiave. Condiviso da api/cot-data.js (cards della sezione COT) e
// api/narrative.js (grounding AI: validazione incrociata e note).
//
// Per ogni contratto non scarica solo l'ultimo report ma le ultime ~53 settimane, così calcola
// ANCHE il percentile reale del posizionamento netto (prima era un numero scritto a mano che
// restava fermo ad agosto) e la variazione settimanale netta.
//
// Datasets Socrata:
//   Legacy Futures Only:        6dca-aqww  (Non-Commercial vs Commercial)
//   Disaggregated Futures Only: 72hh-3qpy  (Managed Money — usato per WTI e Brent)

const SOCRATA_BASE = 'https://publicreporting.cftc.gov/resource';
const LEGACY_DATASET = '6dca-aqww';
const DISAGG_DATASET = '72hh-3qpy';
const HISTORY_ROWS = 53;

const LEGACY_CODES = {
  gold:    '088691',
  silver:  '084691',
  eur:     '099741',
  gbp:     '096742',
  jpy:     '097741',
  dxy:     '098662',   // U.S. Dollar Index (ICE Futures U.S.)
  sp500:   '13874A',
  nasdaq:  '209742',
  russell: '239742',
  bitcoin: '133741',
  ether:   '146021',
  dow:     '124603',
  vix:     '1170E1',
};
const DISAGG_CODES = {
  wti:   '067651',
  brent: '06765T',     // Brent Last Day (NYMEX)
};

const LEGACY_SELECT = [
  'report_date_as_yyyy_mm_dd', 'open_interest_all', 'change_in_open_interest_all',
  'noncomm_positions_long_all', 'noncomm_positions_short_all', 'change_in_noncomm_long_all', 'change_in_noncomm_short_all',
  'comm_positions_long_all', 'comm_positions_short_all', 'change_in_comm_long_all', 'change_in_comm_short_all',
].join(',');
const DISAGG_SELECT = [
  'report_date_as_yyyy_mm_dd', 'open_interest_all', 'change_in_open_interest_all',
  'm_money_positions_long_all', 'm_money_positions_short_all', 'change_in_m_money_long_all', 'change_in_m_money_short_all',
].join(',');

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function buildUrl(dataset, code, dateParam, select) {
  const whereParts = [`cftc_contract_market_code='${code}'`];
  if (dateParam) whereParts.push(`report_date_as_yyyy_mm_dd<='${dateParam}T00:00:00.000'`);
  const params = new URLSearchParams({
    '$select': select,
    '$where': whereParts.join(' AND '),
    '$order': 'report_date_as_yyyy_mm_dd DESC',
    '$limit': String(HISTORY_ROWS),
  });
  return `${SOCRATA_BASE}/${dataset}.json?${params.toString()}`;
}

// Percentile "rank": quota delle osservazioni della finestra con valore <= a quello attuale (0-100).
function percentileRank(current, values) {
  const v = values.filter((x) => x !== null);
  if (v.length < 8) return null;   // storia insufficiente: meglio nessun numero che uno inventato
  return Math.round((v.filter((x) => x <= current).length / v.length) * 100);
}

// Una richiesta di rete fallita ("fetch failed") capita ogni tanto con ~15 chiamate parallele
// verso Socrata: un singolo retry evita contratti mancanti per un errore transitorio.
async function fetchWithRetry(url) {
  try {
    return await fetch(url);
  } catch (e) {
    await new Promise((r) => setTimeout(r, 500));
    return fetch(url);
  }
}

async function fetchRows(dataset, code, dateParam, select) {
  const res = await fetchWithRetry(buildUrl(dataset, code, dateParam, select));
  if (!res.ok) throw new Error(`HTTP ${res.status} per codice ${code}`);
  const rows = await res.json();
  if (!rows.length) throw new Error(`Nessun report trovato per il codice ${code}${dateParam ? ' alla data richiesta' : ''}.`);
  return rows;
}

async function fetchLegacy(code, dateParam) {
  try {
    const rows = await fetchRows(LEGACY_DATASET, code, dateParam, LEGACY_SELECT);
    const r = rows[0];
    const ncLong = num(r.noncomm_positions_long_all);
    const ncShort = num(r.noncomm_positions_short_all);
    const commLong = num(r.comm_positions_long_all);
    const commShort = num(r.comm_positions_short_all);
    const nets = rows.map((x) => {
      const l = num(x.noncomm_positions_long_all), s = num(x.noncomm_positions_short_all);
      return l !== null && s !== null ? l - s : null;
    });
    const net = nets[0];
    return {
      reportDate: r.report_date_as_yyyy_mm_dd ? r.report_date_as_yyyy_mm_dd.slice(0, 10) : null,
      openInterest: num(r.open_interest_all),
      openInterestChange: num(r.change_in_open_interest_all),
      nonCommercialLong: ncLong,
      nonCommercialShort: ncShort,
      nonCommercialNet: net,
      nonCommercialChangeLong: num(r.change_in_noncomm_long_all),
      nonCommercialChangeShort: num(r.change_in_noncomm_short_all),
      commercialLong: commLong,
      commercialShort: commShort,
      commercialNet: (commLong !== null && commShort !== null) ? commLong - commShort : null,
      commercialChangeLong: num(r.change_in_comm_long_all),
      commercialChangeShort: num(r.change_in_comm_short_all),
      netPercentile52w: net !== null ? percentileRank(net, nets) : null,
      netPercentile26w: net !== null ? percentileRank(net, nets.slice(0, 27)) : null,
      historyWeeks: nets.filter((x) => x !== null).length,
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function fetchDisaggregated(code, dateParam) {
  try {
    const rows = await fetchRows(DISAGG_DATASET, code, dateParam, DISAGG_SELECT);
    const r = rows[0];
    const mmLong = num(r.m_money_positions_long_all);
    const mmShort = num(r.m_money_positions_short_all);
    const nets = rows.map((x) => {
      const l = num(x.m_money_positions_long_all), s = num(x.m_money_positions_short_all);
      return l !== null && s !== null ? l - s : null;
    });
    const net = nets[0];
    return {
      reportDate: r.report_date_as_yyyy_mm_dd ? r.report_date_as_yyyy_mm_dd.slice(0, 10) : null,
      openInterest: num(r.open_interest_all),
      openInterestChange: num(r.change_in_open_interest_all),
      managedMoneyLong: mmLong,
      managedMoneyShort: mmShort,
      managedMoneyNet: net,
      managedMoneyChangeLong: num(r.change_in_m_money_long_all),
      managedMoneyChangeShort: num(r.change_in_m_money_short_all),
      netPercentile52w: net !== null ? percentileRank(net, nets) : null,
      netPercentile26w: net !== null ? percentileRank(net, nets.slice(0, 27)) : null,
      historyWeeks: nets.filter((x) => x !== null).length,
    };
  } catch (err) {
    return { error: err.message };
  }
}

// dateParam opzionale (YYYY-MM-DD): report più recente pubblicato in quella data o prima.
async function fetchCotSnapshot(dateParam) {
  const legacyEntries = Object.entries(LEGACY_CODES);
  const disaggEntries = Object.entries(DISAGG_CODES);
  const [legacyResults, disaggResults] = await Promise.all([
    Promise.all(legacyEntries.map(([, code]) => fetchLegacy(code, dateParam))),
    Promise.all(disaggEntries.map(([, code]) => fetchDisaggregated(code, dateParam))),
  ]);
  const data = {};
  legacyEntries.forEach(([key], i) => { data[key] = legacyResults[i]; });
  disaggEntries.forEach(([key], i) => { data[key] = disaggResults[i]; });
  const errors = Object.entries(data).filter(([, v]) => v.error).map(([k, v]) => `${k}: ${v.error}`);
  const reportDates = Object.values(data).map((d) => d.reportDate).filter(Boolean);
  const latestReportDate = reportDates.length ? reportDates.sort().reverse()[0] : null;
  return { latestReportDate, data, errors };
}

module.exports = { fetchCotSnapshot };
