// lib/claude.js
//
// Client minimale per l'API Claude (Anthropic), usato per generare i testi di
// bias/sentiment/dossier a partire da notizie reali. Nessuna dipendenza npm —
// chiamata diretta all'endpoint Messages.
//
// SETUP RICHIESTO: su Vercel, Project settings → Environment Variables → aggiungi
// ANTHROPIC_API_KEY (console.anthropic.com). Se manca, le funzioni che la usano
// tornano semplicemente al loro fallback testuale — nessun errore visibile.

const MODEL = 'claude-sonnet-5';

// Invia un prompt a Claude e ne estrae il primo blocco JSON valido dalla risposta.
// Lancia un errore se la chiave manca, la chiamata fallisce, o la risposta non contiene JSON.
async function claudeJSON({ system, prompt, maxTokens = 1500 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY non configurata nelle Environment Variables di Vercel');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = (data.content || []).map(b => b.text || '').join('');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Risposta Claude senza JSON valido');
  const jsonSlice = text.slice(start, end + 1);
  try {
    return JSON.parse(jsonSlice);
  } catch (parseErr) {
    // Diagnostica: se stop_reason è "max_tokens" la risposta è stata troncata (maxTokens troppo
    // basso per questo prompt) — motivo molto più probabile di un vero JSON malformato da Claude.
    throw new Error(`${parseErr.message} | stop_reason=${data.stop_reason} | textLen=${text.length} | tail="${jsonSlice.slice(-80)}"`);
  }
}

module.exports = { claudeJSON, MODEL };
