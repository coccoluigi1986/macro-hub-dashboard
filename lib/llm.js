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
// Piano B: il piano gratuito di Gemini ha una quota PER MODELLO e ogni tanto un modello risponde "sovraccarico" (503): se il principale non risponde si
// prova un altro, che ha il suo limite. Sostituibili da Vercel con GEMINI_FALLBACK_MODELS="modello1,modello2". Un nome sbagliato (404) viene messo da parte.
const FALLBACK_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];

function llmConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}
// I nomi dei modelli cambiano spesso e alcuni vengono spenti: invece di indovinarli, il server chiede a Google quali modelli "flash" la chiave può usare
// (una richiesta di sola lettura, che non consuma quota) e tiene l'elenco per 6 ore. Prima i "lite" (limiti più larghi), poi gli altri, dal più nuovo.
let discovered = null, discoveredAt = 0;
async function discoverModels(apiKey) {
  if (discovered && Date.now() - discoveredAt < 6 * 3600e3) return discovered;
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    const ver = (n) => parseFloat((n.match(/^gemini-([\d.]+)/) || [])[1]) || 0;
    const names = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => String(m.name).replace(/^models\//, ''))
      .filter((n) => /^gemini-[\d.]+-flash/.test(n) && !/(image|tts|live|audio|embedding|exp|thinking|robotics|computer|preview-\d)/.test(n));
    names.sort((a, b) => (Number(/lite/.test(b)) - Number(/lite/.test(a))) || (ver(b) - ver(a)));
    discovered = names;
  } catch (e) { discovered = discovered || []; }
  discoveredAt = Date.now();
  return discovered;
}
async function modelList(apiKey) {
  const primary = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const fixed = process.env.GEMINI_FALLBACK_MODELS ? process.env.GEMINI_FALLBACK_MODELS.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const others = fixed || (await discoverModels(apiKey)).filter((m) => m !== primary).slice(0, 3);
  return [primary, ...(others.length ? others : FALLBACK_MODELS)];
}

// Quando un modello risponde "quota esaurita" (429), "sovraccarico" (503) o "non esiste" (404) ogni nuova richiesta a quel modello fallisce comunque e brucia
// altro limite: per un po' l'istanza lo salta e passa subito al successivo. Limite al giorno → 10 minuti; limite al minuto → il tempo indicato da Gemini
// (minimo 30 s); sovraccarico → 30 s; modello inesistente → 1 ora.
const paused = new Map();   // modello → { until, error }

// Cosa fare quando l'AI non risponde, ricavato dall'errore: per quanto tenere in cache la risposta di ripiego e fra quanti secondi conviene riprovare.
// Un errore di quota non si risolve ripetendo ogni minuto: meglio aspettare (e non martellare l'API).
function failureInfo(e) {
  if (e && e.status === 429 && !e.overloaded) { const s = e.daily ? 900 : Math.max(60, e.retryAfter || 60); return { ttl: s, retryIn: s, quota: e.daily ? 'giorno' : 'minuto' }; }
  return { ttl: 60, retryIn: 0, quota: null };
}

async function callModel(model, apiKey, { system, prompt, maxTokens, json }) {
  const p = paused.get(model);
  if (p && Date.now() < p.until) throw p.error;
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

  // Un solo retry su 429 al minuto o 500 transitorio; non si riprova con la quota GIORNALIERA esaurita, con "sovraccarico" (503) o con un modello inesistente.
  let res, errBody = '', daily = false, retryAfter = 0, quotaId = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    if (res.ok) break;
    errBody = await res.text().catch(() => '');
    if (res.status === 429) {
      try {   // Gemini indica quale limite è stato superato e fra quanto riprovare
        const d = (JSON.parse(errBody).error || {}).details || [];
        const q = d.find((x) => /QuotaFailure/.test(x['@type'] || '')), r = d.find((x) => /RetryInfo/.test(x['@type'] || ''));
        quotaId = (q && q.violations && q.violations[0] && (q.violations[0].quotaId || q.violations[0].quotaMetric)) || '';
        retryAfter = r && r.retryDelay ? Math.ceil(parseFloat(r.retryDelay)) || 0 : 0;
      } catch (e) { /* risposta non in JSON: si usa il testo */ }
      daily = /PerDay|per day|daily/i.test(quotaId + errBody);
      if (daily) break;
    }
    if (res.status === 503 || res.status === 404 || (res.status !== 429 && res.status < 500)) break;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
  }

  if (!res.ok) {
    const err = new Error(`Gemini API error ${res.status} (${model})${res.status === 429 ? ` [limite ${daily ? 'GIORNALIERO' : 'al minuto'}${quotaId ? ' ' + quotaId : ''}${retryAfter ? ' riprova tra ' + retryAfter + 's' : ''}]` : ''}: ${errBody.slice(0, 200)}`);
    err.status = res.status; err.daily = daily; err.retryAfter = retryAfter; err.model = model;
    const pause = res.status === 429 ? (daily ? 600e3 : Math.max(30, retryAfter) * 1000) : res.status === 503 ? 30e3 : res.status === 404 ? 3600e3 : 0;
    if (pause) paused.set(model, { until: Date.now() + pause, error: err });
    throw err;
  }

  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
  const finishReason = cand
    ? cand.finishReason
    : (data.promptFeedback && data.promptFeedback.blockReason) || 'NO_CANDIDATES';
  return { text, finishReason, model };
}

async function callGemini(args) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY non configurata nelle Environment Variables di Vercel');
  const tried = [];
  for (const m of await modelList(apiKey)) {
    try { return await callModel(m, apiKey, args); }
    catch (e) {
      tried.push(e);
      // solo i problemi di capacità del modello (quota, sovraccarico, errore del server, modello inesistente) giustificano di provare un altro
      if (!(e.status === 429 || e.status === 503 || e.status === 404 || e.status >= 500)) throw e;
    }
  }
  const first = tried[0];
  if (tried.length === 1) throw first;
  // l'esito di ogni modello va PRIMA del testo dell'errore: il "motivo" mostrato nelle risposte viene accorciato
  const err = new Error(`Gemini API error ${first.status}: nessun modello ha risposto (${tried.map((e) => `${e.model} ${e.status}${e.daily ? ' limite giornaliero' : ''}`).join(', ')}) — ${first.message.slice(0, 140)}`);
  err.status = first.status; err.daily = first.daily; err.retryAfter = first.retryAfter;
  err.overloaded = tried.some((e) => e.status === 503);   // se un modello era solo sovraccarico conviene riprovare presto, non tra 15 minuti
  throw err;
}

// Invia un prompt a Gemini in "JSON mode" e ne restituisce l'oggetto parsato.
// Lancia un errore se la chiave manca, la chiamata fallisce, o la risposta non è JSON valido.
async function llmJSONOnce({ system, prompt, maxTokens }) {
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

// Con un'analisi lunga (es. Sentiment) Gemini ogni tanto restituisce un JSON troncato o senza parentesi: un secondo tentativo, subito,
// di solito riesce, e il visitatore non si ritrova una card "non disponibile". Errori di rete/limite (429) restano gestiti da callGemini.
async function llmJSON({ system, prompt, maxTokens = 1500 }) {
  try {
    return await llmJSONOnce({ system, prompt, maxTokens });
  } catch (e) {
    if (!/JSON|Unexpected|position|finishReason/i.test(e.message) || /Gemini API error/.test(e.message)) throw e;
    console.warn('llmJSON: risposta non valida, secondo tentativo:', e.message.slice(0, 120));
    return llmJSONOnce({ system, prompt, maxTokens });
  }
}

// Invia un prompt a Gemini e ne restituisce il testo grezzo (nessun parsing JSON) — usato per
// compiti semplici come la traduzione di un singolo paragrafo.
async function llmText({ system, prompt, maxTokens = 700 }) {
  const { text, finishReason } = await callGemini({ system, prompt, maxTokens, json: false });
  if (!text.trim()) throw new Error(`Risposta Gemini vuota | finishReason=${finishReason}`);
  return text.trim();
}

module.exports = { llmJSON, llmText, llmConfigured, failureInfo, modelList };
