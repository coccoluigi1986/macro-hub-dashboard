// api/event-dossier.js
//
// Serverless Function (Vercel): dossier AI per il "Prossimo evento chiave" — aggiunge un
// blocco di contesto generato da Gemini (perché conta oggi, note sui tempi, asset da
// monitorare, cosa aspettarsi) SOPRA i dati dell'evento — che restano quelli del calendario
// curato a mano già presente in dashboard.html (keyEvents). Non sostituisce gli scenari
// "sopra/sotto le attese" già scritti a mano: quelli restano come sono, il dossier AI è un
// livello aggiuntivo con la lettura più aggiornata basata sulle notizie di oggi.
//
// Porting mirato del prompt di backend/routers/intel.py::next_key_event() nel progetto di
// riferimento macrohub3 — senza lo scraping calendario (tv_calendar.py), perché qui la fonte
// dell'evento è già il calendario esistente della dashboard, passato dal client via query string.
//
// Query param richiesti: title, date (ISO), impact (alto|medio|basso). Opzionali: forecast, previous.
// Raggiungibile su: https://tuosito.vercel.app/api/event-dossier?title=...&date=...&impact=alto

const { aggregateNews } = require('../lib/news');
const { llmJSON, llmConfigured } = require('../lib/llm');
const { toVercelHandler } = require('../lib/vercel-adapter');

const EVENT_SYS = 'Sei un analista macro senior che prepara il dossier pre-evento per un desk di trading. '
  + 'Rispondi SEMPRE in italiano, tecnico e operativo. Restituisci ESCLUSIVAMENTE JSON valido.';

function fallback() {
  return {
    ai: false,
    context: 'Dossier AI non disponibile in questo ciclo.',
    timingNote: '',
    assetsToWatch: ['DXY', 'Gold', 'EUR/USD', 'US10Y'],
    whatToExpect: 'Attesa volatilità nei 20 minuti attorno al rilascio.',
    ifAbove: '',
    ifBelow: '',
  };
}

async function handleEvent(event) {
  try {
    const p = event.queryStringParameters || {};
    const title = (p.title || '').trim();
    const dateIso = p.date || '';
    if (!title || !dateIso) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Parametri richiesti mancanti: title, date' }) };
    }
    const impact = p.impact || 'medio';
    const forecast = p.forecast || 'n/d';
    const previous = p.previous || 'n/d';

    let dossier = null;
    if (llmConfigured()) {
      try {
        const local = new Date(dateIso).toLocaleString('it-IT', {
          weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome',
        });
        const news = await aggregateNews(20);
        const newsLines = news.slice(0, 16).map((n, i) => `${i + 1}. [${n.source} ${n.published.slice(11, 16)}] ${n.title} — ${n.summary.slice(0, 180)}`).join('\n');

        const prompt = 'EVENTO DA ANALIZZARE:\n'
          + `- Titolo: ${title}\n`
          + `- Data/ora Italia: ${local}\n`
          + `- Previsto: ${forecast}\n`
          + `- Precedente: ${previous}\n`
          + `- Impatto: ${impact}\n\n`
          + 'CONTESTO DALLE NOTIZIE REALI DI OGGI:\n'
          + `${newsLines || '- nessuna notizia rilevante trovata'}\n\n`
          + 'Restituisci JSON esatto:\n'
          + '{\n'
          + '  "context": "il perche macro/geopolitico di questo evento OGGI, alla luce delle notizie sopra, max 260 caratteri",\n'
          + '  "timing_note": "nota su orari e sovrapposizioni con altri eventi o catalizzatori vicini, max 200 caratteri (stringa vuota se non rilevante)",\n'
          + '  "assets_to_watch": ["4 asset separati"],\n'
          + '  "what_to_expect": "cosa guardare esattamente all\'uscita, max 220 caratteri",\n'
          + '  "if_above": "reazione tipica dei mercati se il dato esce SOPRA le attese (dollaro, oro, rendimenti, equity), max 200 caratteri",\n'
          + '  "if_below": "reazione tipica dei mercati se il dato esce SOTTO le attese, max 200 caratteri"\n'
          + '}\nIn if_above/if_below ragiona sulla natura dell\'indicatore (un dato sopra le attese non è sempre "positivo" per la valuta: dipende da cosa misura e dal contesto di politica monetaria). Solo JSON.';

        const data = await llmJSON({ system: EVENT_SYS, prompt, maxTokens: 1500 });
        dossier = {
          ai: true,
          context: data.context || '',
          timingNote: data.timing_note || '',
          assetsToWatch: (data.assets_to_watch || []).slice(0, 4),
          whatToExpect: data.what_to_expect || '',
          ifAbove: data.if_above || '',
          ifBelow: data.if_below || '',
        };
      } catch (e) {
        console.warn('event dossier AI failed:', e.message);
      }
    }

    if (!dossier) dossier = fallback();

    return {
      statusCode: 200,
      // 6h quando l'AI ha risposto davvero; se è il fallback, cache breve (2 min) — altrimenti un
      // singolo errore transitorio (rate limit, timeout) resterebbe "congelato" in CDN per ore.
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${dossier.ai ? 21600 : 120}` },
      body: JSON.stringify({ generatedAt: new Date().toISOString(), event: { title, date: dateIso, impact }, dossier }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

module.exports = toVercelHandler(handleEvent);
