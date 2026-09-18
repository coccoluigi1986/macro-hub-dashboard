// netlify/functions/cot-data.js
//
// Funzione serverless Netlify: dati REALI del COT Report tramite l'API pubblica
// ufficiale della CFTC (Socrata Open Data, "Public Reporting Environment") —
// dato pubblico, nessuna chiave richiesta, nessun limite pratico di utilizzo.
//
// PERCHÉ QUESTA VERSIONE È MOLTO PIÙ AFFIDABILE DELLA PRECEDENTE:
// La versione precedente leggeva il testo grezzo delle pagine HTML della CFTC e lo
// interpretava con pattern (regex) — funzionava, ma era fragile e non permetteva di
// interrogare date passate. Questa versione usa invece l'API JSON strutturata che la
// CFTC pubblica apposta per questo scopo (stesso identico dato, formato molto più solido).
//
// FUNZIONALITÀ NUOVA: parametro ?date=YYYY-MM-DD nell'URL della funzione.
// Se omesso, restituisce l'ULTIMO report disponibile (sempre vero "ultimo dato", mai
// bloccato su una data fissa). Se specificato, restituisce il report più recente
// pubblicato in corrispondenza o prima di quella data (il COT esce solo il venerdì,
// quindi una data qualsiasi viene automaticamente "agganciata" al report corretto).
//
// Esempi di chiamata:
//   /.netlify/functions/cot-data                → ultimo dato disponibile
//   /.netlify/functions/cot-data?date=2026-07-15 → dato più recente fino al 15 luglio 2026
//
// Dataset Socrata usati (pubblici, nessun token richiesto):
//   Legacy Futures Only:        6dca-aqww  (oro, argento, valute, indici, cripto, Dow, VIX)
//   Disaggregated Futures Only: 72hh-3qpy  (WTI — usa Managed Money invece di Non-Commercial)

const SOCRATA_BASE = 'https://publicreporting.cftc.gov/resource';
const LEGACY_DATASET = '6dca-aqww';
const DISAGG_DATASET = '72hh-3qpy';

const LEGACY_CODES = {
  gold:    '088691',
  silver:  '084691',
  eur:     '099741',
  gbp:     '096742',
  jpy:     '097741',
  sp500:   '13874A',
  nasdaq:  '209742',
  russell: '239742',
  bitcoin: '133741',
  ether:   '146021',
  dow:     '124603',
  vix:     '1170E1',
};
const DISAGG_CODES = {
  wti: '067651',
};

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function buildUrl(dataset, code, dateParam) {
  const base = `${SOCRATA_BASE}/${dataset}.json`;
  const whereParts = [`cftc_contract_market_code='${code}'`];
  if (dateParam) {
    whereParts.push(`report_date_as_yyyy_mm_dd<='${dateParam}T00:00:00.000'`);
  }
  const params = new URLSearchParams({
    '$where': whereParts.join(' AND '),
    '$order': 'report_date_as_yyyy_mm_dd DESC',
    '$limit': '1',
  });
  return `${base}?${params.toString()}`;
}

async function fetchLegacy(code, dateParam) {
  try {
    const res = await fetch(buildUrl(LEGACY_DATASET, code, dateParam));
    if (!res.ok) return { error: `HTTP ${res.status} per codice ${code}` };
    const rows = await res.json();
    if (!rows.length) return { error: `Nessun report trovato per il codice ${code}${dateParam ? ' alla data richiesta' : ''}.` };
    const r = rows[0];
    const ncLong = num(r.noncomm_positions_long_all);
    const ncShort = num(r.noncomm_positions_short_all);
    const commLong = num(r.comm_positions_long_all);
    const commShort = num(r.comm_positions_short_all);
    return {
      reportDate: r.report_date_as_yyyy_mm_dd ? r.report_date_as_yyyy_mm_dd.slice(0, 10) : null,
      openInterest: num(r.open_interest_all),
      openInterestChange: num(r.change_in_open_interest_all),
      nonCommercialLong: ncLong,
      nonCommercialShort: ncShort,
      nonCommercialNet: (ncLong !== null && ncShort !== null) ? ncLong - ncShort : null,
      nonCommercialChangeLong: num(r.change_in_noncomm_long_all),
      nonCommercialChangeShort: num(r.change_in_noncomm_short_all),
      commercialLong: commLong,
      commercialShort: commShort,
      commercialNet: (commLong !== null && commShort !== null) ? commLong - commShort : null,
      commercialChangeLong: num(r.change_in_comm_long_all),
      commercialChangeShort: num(r.change_in_comm_short_all),
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function fetchDisaggregated(code, dateParam) {
  try {
    const res = await fetch(buildUrl(DISAGG_DATASET, code, dateParam));
    if (!res.ok) return { error: `HTTP ${res.status} per codice ${code}` };
    const rows = await res.json();
    if (!rows.length) return { error: `Nessun report trovato per il codice ${code}${dateParam ? ' alla data richiesta' : ''}.` };
    const r = rows[0];
    const mmLong = num(r.m_money_positions_long_all);
    const mmShort = num(r.m_money_positions_short_all);
    return {
      reportDate: r.report_date_as_yyyy_mm_dd ? r.report_date_as_yyyy_mm_dd.slice(0, 10) : null,
      openInterest: num(r.open_interest_all),
      openInterestChange: num(r.change_in_open_interest_all),
      managedMoneyLong: mmLong,
      managedMoneyShort: mmShort,
      managedMoneyNet: (mmLong !== null && mmShort !== null) ? mmLong - mmShort : null,
    };
  } catch (err) {
    return { error: err.message };
  }
}

exports.handler = async function (event, context) {
  try {
    const dateParam = event.queryStringParameters && event.queryStringParameters.date
      ? event.queryStringParameters.date
      : null;

    if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Parametro "date" non valido, usa il formato YYYY-MM-DD.' }) };
    }

    const legacyEntries = Object.entries(LEGACY_CODES);
    const disaggEntries = Object.entries(DISAGG_CODES);

    const [legacyResults, disaggResults] = await Promise.all([
      Promise.all(legacyEntries.map(([key, code]) => fetchLegacy(code, dateParam))),
      Promise.all(disaggEntries.map(([key, code]) => fetchDisaggregated(code, dateParam))),
    ]);

    const data = {};
    legacyEntries.forEach(([key], i) => { data[key] = legacyResults[i]; });
    disaggEntries.forEach(([key], i) => { data[key] = disaggResults[i]; });

    const errors = Object.entries(data).filter(([k, v]) => v.error).map(([k, v]) => `${k}: ${v.error}`);
    const reportDates = Object.values(data).map(d => d.reportDate).filter(Boolean);
    const latestReportDate = reportDates.length ? reportDates.sort().reverse()[0] : null;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': dateParam ? 'public, max-age=86400' : 'public, max-age=3600',
      },
      body: JSON.stringify({
        updatedAt: new Date().toISOString(),
        requestedDate: dateParam,
        latestReportDate,
        source: 'CFTC Public Reporting Environment (Socrata API) — dato pubblico ufficiale',
        parseWarning: errors.length ? `Alcuni contratti non trovati: ${errors.join(' | ')}` : null,
        data,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
