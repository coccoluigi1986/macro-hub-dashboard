// lib/llm.js
//
// Client minimale per Gemini (Google AI Studio), usato per generare i testi di bias/sentiment/
// dossier/traduzioni a partire da notizie reali. Nessuna dipendenza npm — chiamata diretta
// all'endpoint REST generateContent. Sostituisce il vecchio client Anthropic (credito esaurito,
// costo per token troppo alto per questo uso): il piano gratuito di AI Studio copre abbondantemente
// il volume di questa dashboard (poche decine di chiamate al giorno, grazie alla cache CDN).
//
// SETUP RICHIESTO: su Vercel, Project settings → Environment Variables → aggiungi GEMINI_API_KEY
// (chiave gratuita da https://aistudio.google.com/apikey). Opzionale: GEMINI_MODEL per cambiare
// modello senza toccare il codice (i nomi dei modelli Gemini cambiano spesso — es. 2.0 Flash-Lite
// è stato spento il 1° giugno 2026). Se la chiave manca, le funzioni che la usano tornano al loro
// fallback testuale — nessun errore visibile.

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

function llmConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

async function callGemini({ system, prompt, maxTokens, json }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY non configurata nelle Environment Variables di Vercel');

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      // I token di "thinking" contano nel limite di output: margine doppio rispetto al testo atteso
      // per non troncare il JSON se il modello ne usa qualcuno.
      maxOutputTokens: maxTokens * 2,
      temperature: 0.4,
      ...(json ? { responseMimeType: 'application/json' } : {}),
    },
    // Le notizie su guerre/sanzioni/attacchi sono materiale ordinario per un'analisi macro: soglia
    // più alta di quella di default per non vedere risposte bloccate da falsi positivi.
    safetySettings: [
      'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT',
    ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
  };

  // Un solo retry su 429 (rate limit del piano gratuito) o 5xx transitori.
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status !== 429 && res.status < 500) break;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
  const finishReason = cand
    ? cand.finishReason
    : (data.promptFeedback && data.promptFeedback.blockReason) || 'NO_CANDIDATES';
  return { text, finishReason };
}

// Invia un prompt a Gemini in "JSON mode" e ne restituisce l'oggetto parsato.
// Lancia un errore se la chiave manca, la chiamata fallisce, o la risposta non è JSON valido.
async function llmJSON({ system, prompt, maxTokens = 1500 }) {
  const { text, finishReason } = await callGemini({ system, prompt, maxTokens, json: true });
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`Risposta Gemini senza JSON valido | finishReason=${finishReason} | textLen=${text.length}`);
  const jsonSlice = text.slice(start, end + 1);
  try {
    return JSON.parse(jsonSlice);
  } catch (parseErr) {
    // Diagnostica: finishReason "MAX_TOKENS" = risposta troncata (maxTokens troppo basso), molto più
    // probabile di un JSON davvero malformato con JSON mode attivo.
    throw new Error(`${parseErr.message} | finishReason=${finishReason} | textLen=${text.length} | tail="${jsonSlice.slice(-80)}"`);
  }
}

// Invia un prompt a Gemini e ne restituisce il testo grezzo (nessun parsing JSON) — usato per
// compiti semplici come la traduzione di un singolo paragrafo.
async function llmText({ system, prompt, maxTokens = 700 }) {
  const { text, finishReason } = await callGemini({ system, prompt, maxTokens, json: false });
  if (!text.trim()) throw new Error(`Risposta Gemini vuota | finishReason=${finishReason}`);
  return text.trim();
}

module.exports = { llmJSON, llmText, llmConfigured };
