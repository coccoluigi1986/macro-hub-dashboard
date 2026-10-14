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

async function fetchCalendarEvents({ from, to, countries }) {
  const url = `${TV_URL}?${new URLSearchParams({ from, to, countries: countries || DEFAULT_COUNTRIES }).toString()}`;
  const res = await fetch(url, {
    headers: {
      // Origin obbligatorio: senza questo header l'endpoint risponde 403.
      Origin: 'https://in.tradingview.com',
      'User-Agent': 'Mozilla/5.0 (compatible; macro-hub-dashboard/1.0)',
    },
  });
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

module.exports = { fetchCalendarEvents };
