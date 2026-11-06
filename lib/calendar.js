// lib/calendar.js
//
// Calendario economico REALE dall'endpoint pubblico non ufficiale che alimenta il calendario
// economico embeddabile di TradingView. Nessuna API key richiesta, ma richiede l'header Origin di un
// dominio tradingview.com altrimenti risponde 403 — per questo la chiamata passa dal server.
// Condiviso da api/economic-calendar.js (tabella/eventi chiave) e api/narrative.js (grounding AI).

const TV_URL = 'https://economic-calendar.tradingview.com/events';
const DEFAULT_COUNTRIES = 'US,EU,GB,JP,CN,AU,CA,CH';

// Mappatura confermata via test diretto sull'endpoint: -1 = basso impatto, 0 = medio, 1 = alto
// (es. "Unemployment Rate" USA e "FOMC Minutes" risultano importance 1, dati secondari -1).
const IMPORTANCE_MAP = { '1': 'alto', '0': 'medio', '-1': 'basso' };

// Una singola richiesta (finestra breve)
async function fetchWindow({ from, to, countries }) {
  const url = `${TV_URL}?${new URLSearchParams({ from, to, countries: countries || DEFAULT_COUNTRIES }).toString()}`;
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, {
      headers: {
        // Origin obbligatorio: senza questo header l'endpoint risponde 403.
        Origin: 'https://in.tradingview.com',
        'User-Agent': 'Mozilla/5.0 (compatible; macro-hub-dashboard/1.0)',
      },
    });
    if (res.ok || (res.status !== 429 && res.status < 500)) break;
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));   // limite di richieste o errore passeggero: si riprova con una pausa
  }
  if (!res.ok) throw new Error(`TradingView calendar error ${res.status}`);
  const data = await res.json();
  const raw = Array.isArray(data.result) ? data.result : [];

  return raw
    .filter((e) => e && e.title && e.date)
    // TradingView mischia dati economici veri con festività ("indicator":"Holidays") e voci
    // generiche da calendario diplomatico/politico ("indicator":"Calendar", es. "UN General
    // Assembly") che non hanno mai numeri né rilevanza di trading — le scarto, tranne quando
    // sono comunque segnate ad alto impatto dalla fonte (es. un summit geopolitico rilevante).
    .filter((e) => e.indicator !== 'Holidays' && (e.indicator !== 'Calendar' || Number(e.importance) >= 1))
    .map((e) => ({
      id: e.id,
      title: e.title,
      country: e.country || null,
      currency: e.currency || null,
      date: e.date,
      importance: IMPORTANCE_MAP[String(e.importance)] || 'basso',
      previous: e.previous != null ? e.previous : null,
      forecast: e.forecast != null ? e.forecast : null,
      actual: e.actual != null ? e.actual : null,
      unit: e.unit || '',
      scale: e.scale || '',
      period: e.period || '',
      source: e.source || '',
      comment: e.comment || '',
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// TradingView TAGLIA ogni risposta a 2.000 eventi, tenendo i più VECCHI: con una finestra lunga (es. i 100 giorni delle card macro, o i 45 giorni del
// calendario completo) gli eventi più recenti sparivano in silenzio — le card restavano ferme alle uscite di una settimana prima e i testi AI leggevano
// dati vecchi. Ora la finestra si spezza in blocchi da 30 giorni (al massimo ~1.100 eventi ciascuno, con tutti i paesi), uniti senza doppioni: pochi blocchi, perché troppe richieste insieme fanno scattare il limite di TradingView.
const CHUNK_DAYS = 30;
async function fetchCalendarEvents({ from, to, countries }) {
  const t0 = new Date(from).getTime(), t1 = new Date(to).getTime();
  if (!(t1 > t0) || t1 - t0 <= CHUNK_DAYS * 86400e3) return fetchWindow({ from, to, countries });
  const chunks = [];
  for (let t = t0; t < t1; t += CHUNK_DAYS * 86400e3) chunks.push({ from: new Date(t).toISOString(), to: new Date(Math.min(t + CHUNK_DAYS * 86400e3, t1)).toISOString() });
  const parts = await Promise.allSettled(chunks.map((c) => fetchWindow({ ...c, countries })));
  const ok = parts.filter((p) => p.status === 'fulfilled');
  if (!ok.length) throw parts[0].reason;
  if (ok.length < parts.length) console.warn('calendario: ' + (parts.length - ok.length) + ' blocchi su ' + parts.length + ' non scaricati');
  const seen = new Set(), out = [];
  for (const e of ok.flatMap((p) => p.value)) { const k = e.id || `${e.date}|${e.title}|${e.country}`; if (!seen.has(k)) { seen.add(k); out.push(e); } }
  return out.sort((a, b) => new Date(a.date) - new Date(b.date));
}

module.exports = { fetchCalendarEvents };
