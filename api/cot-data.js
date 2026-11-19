// api/cot-data.js
//
// Serverless Function (Vercel): dati REALI del COT Report tramite l'API pubblica
// ufficiale della CFTC (Socrata Open Data, "Public Reporting Environment") —
// dato pubblico, nessuna chiave richiesta, nessun limite pratico di utilizzo.
// Il fetch e il calcolo dei percentili stanno in lib/cot.js (condiviso con api/narrative.js).
//
// FUNZIONALITÀ: parametro ?date=YYYY-MM-DD nell'URL della funzione.
// Se omesso, restituisce l'ULTIMO report disponibile (sempre vero "ultimo dato", mai
// bloccato su una data fissa). Se specificato, restituisce il report più recente
// pubblicato in corrispondenza o prima di quella data (il COT esce solo il venerdì,
// quindi una data qualsiasi viene automaticamente "agganciata" al report corretto).
//
// Esempi di chiamata:
//   /api/cot-data                → ultimo dato disponibile
//   /api/cot-data?date=2026-07-15 → dato più recente fino al 15 luglio 2026

const { toVercelHandler } = require('../lib/vercel-adapter');
const { cc } = require('../lib/cache-control');
const { fetchCotSnapshot } = require('../lib/cot');

// Per quanti secondi la copia scaduta può ancora essere servita subito (mentre si prepara la nuova): fino a un'ora prima del prossimo venerdì 19:30 UTC
// (il CFTC pubblica il venerdì alle 15:30 ora di New York = 19:30-20:30 UTC), al massimo 6 giorni. Così dopo una pausa di ore o giorni (notte, weekend, subito dopo
// una pubblicazione del sito) nessuno aspetta il ricalcolo, e la copia vecchia non sopravvive mai all'uscita del nuovo rapporto.
function cotSwr(now = Date.now()) {
  const d = new Date(now);
  if (d.getUTCDay() === 5 && d.getUTCHours() * 60 + d.getUTCMinutes() >= 19 * 60 + 30 && d.getUTCHours() < 22) return 0;   // finestra di uscita del rapporto (venerdì 19:30-22:00 UTC): niente copie "stale", si vuole il dato nuovo appena c'è
  let release = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7), 19, 30);
  if (release <= now) release += 7 * 86400e3;
  return Math.max(0, Math.min(6 * 86400, Math.floor((release - now) / 1000) - 3600));
}

async function handleEvent(event) {
  try {
    const dateParam = event.queryStringParameters && event.queryStringParameters.date
      ? event.queryStringParameters.date
      : null;

    if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Parametro "date" non valido, usa il formato YYYY-MM-DD.' }) };
    }

    const { latestReportDate, data, errors } = await fetchCotSnapshot(dateParam);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // il rapporto COT è settimanale: la copia vecchia si serve subito mentre si rinnova (senza attese per chi apre il sito), ma mai oltre l'uscita del rapporto successivo (venerdì).
        // Una risposta INCOMPLETA (qualche contratto non letto) resta in cache pochissimo e senza "stale": un errore passeggero non deve restare per ore.
        'Cache-Control': dateParam ? 'public, max-age=86400' : (errors.length ? 'public, max-age=120' : cc(3600, cotSwr())),
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
}

module.exports = toVercelHandler(handleEvent);
