// lib/positioning.js
//
// Indicatori di sentiment/posizionamento REALI, prima scritti a mano nella dashboard:
//   - CNN Fear & Greed Index  → endpoint dati pubblico di CNN (richiede header da browser)
//   - AAII Investor Sentiment → tabella pubblica "Sentiment Survey Historical Data" di aaii.com
//
// NON inclusi, perché oggi non esiste una fonte gratuita aggiornata (verificato direttamente):
//   - NAAIM Exposure Index: dal 1° agosto 2026 la pagina pubblica mostra i dati con 3 mesi di
//     ritardo (il dato corrente è solo in abbonamento).
//   - CBOE Equity Put/Call: il CSV pubblico di CBOE si ferma al 2019 e le pagine "market
//     statistics" non sono raggiungibili da server; Yahoo non ha ^CPCE/^CPC.
// La dashboard li mostra come "non disponibili" invece di numeri vecchi.
//
// Condiviso da api/market-data.js (client) e api/narrative.js (grounding AI).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MONTHS_IT = { Jan: 'gen', Feb: 'feb', Mar: 'mar', Apr: 'apr', May: 'mag', Jun: 'giu', Jul: 'lug', Aug: 'ago', Sep: 'set', Oct: 'ott', Nov: 'nov', Dec: 'dic' };
const TIMEOUT_MS = 9000;

const FG_RATING_IT = {
  'extreme fear': 'Paura estrema', fear: 'Paura', neutral: 'Neutrale', greed: 'Avidità', 'extreme greed': 'Avidità estrema',
};

async function fetchFearGreed() {
  const res = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
    headers: { 'User-Agent': UA, Origin: 'https://www.cnn.com', Referer: 'https://www.cnn.com/' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CNN Fear&Greed HTTP ${res.status}`);
  const j = await res.json();
  const fg = j && j.fear_and_greed;
  if (!fg || typeof fg.score !== 'number') throw new Error('CNN Fear&Greed: formato inatteso');
  const r = (v) => (typeof v === 'number' ? Math.round(v) : null);
  const rating = String(fg.rating || '').toLowerCase();
  return {
    score: Math.round(fg.score),
    rating,
    ratingIt: FG_RATING_IT[rating] || rating,
    previousClose: r(fg.previous_close),
    previousWeek: r(fg.previous_1_week),
    previousMonth: r(fg.previous_1_month),
    previousYear: r(fg.previous_1_year),
    timestamp: fg.timestamp || null,
  };
}

// La pagina contiene la tabella "Reported Date | Bullish | Neutral | Bearish" con le ultime rilevazioni
// settimanali (la più recente per prima). Si estraggono le righe dal testo, senza dipendenze.
async function fetchAaii() {
  const res = await fetch('https://www.aaii.com/sentimentsurvey/sent_results', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`AAII HTTP ${res.status}`);
  const html = await res.text();
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const start = text.search(/Reported Date\s+Bullish\s+Neutral\s+Bearish/i);
  if (start < 0) throw new Error('AAII: tabella non trovata');
  const re = /([A-Z][a-z]{2}) (\d{1,2}) (\d{1,2}(?:\.\d)?)% (\d{1,2}(?:\.\d)?)% (\d{1,2}(?:\.\d)?)%/g;
  const slice = text.slice(start, start + 4000);
  const rows = [];
  let m;
  while ((m = re.exec(slice)) !== null && rows.length < 8) {
    rows.push({ label: `${m[2]} ${MONTHS_IT[m[1]] || m[1]}`, bullish: parseFloat(m[3]), neutral: parseFloat(m[4]), bearish: parseFloat(m[5]) });
  }
  if (!rows.length) throw new Error('AAII: nessuna riga valida');
  const [cur, prev] = rows;
  return {
    date: cur.label,
    bullish: cur.bullish, neutral: cur.neutral, bearish: cur.bearish,
    spread: Math.round((cur.bullish - cur.bearish) * 10) / 10,
    previous: prev ? { date: prev.label, bullish: prev.bullish, neutral: prev.neutral, bearish: prev.bearish } : null,
  };
}

// Ognuno fallisce da solo: un indicatore non raggiungibile non deve far sparire l'altro.
async function fetchPositioning() {
  const [fg, aaii] = await Promise.allSettled([fetchFearGreed(), fetchAaii()]);
  if (fg.status === 'rejected') console.warn('Fear&Greed non disponibile:', fg.reason && fg.reason.message);
  if (aaii.status === 'rejected') console.warn('AAII non disponibile:', aaii.reason && aaii.reason.message);
  return {
    fearGreed: fg.status === 'fulfilled' ? fg.value : null,
    aaii: aaii.status === 'fulfilled' ? aaii.value : null,
  };
}

module.exports = { fetchPositioning };
