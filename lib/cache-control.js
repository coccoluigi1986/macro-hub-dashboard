// Cache-Control: UNA SOLA versione dei dati per tutti, e "stale-while-revalidate" per le risposte LENTE da ricalcolare.
//
// COERENZA FRA UTENTI. Prima il browser teneva la risposta per tutta la durata della cache del server (analisi AI 3 ore, indicatori 20 minuti, cicli 10 minuti…): chi apriva
// il sito aveva una copia "sua", anche di 3 ore prima di quella già pronta sul CDN. Due studenti con lo stesso link vedevano analisi di ore diverse (RISK-OFF per uno, RISK-ON
// per l'altro), e dopo il ricaricamento o dopo il ricontrollo automatico lo stesso utente le vedeva cambiare. Ora il browser tiene la copia al massimo 60 secondi (BROWSER_MAX) e
// poi la ricontrolla con il CDN (richiesta condizionale: se non è cambiata non scarica nulla, 304) mentre il CDN di Vercel continua a tenere la copia per tutto il suo tempo (s-maxage):
// tutti vedono la stessa versione entro un minuto, e il carico sul server non cambia.
//
// STALE-WHILE-REVALIDATE. Quando la copia in cache scade (ogni 5 min – 3 ore a seconda del dato), il CDN serve SUBITO la copia vecchia e ne prepara una nuova in background; il
// visitatore dopo la riceve fresca. La copia vecchia non vive oltre `swr` secondi: dopo quel limite si ricalcola come prima.
// Si usa solo sulle risposte COMPLETE. Le risposte di ripiego (errore, AI mancante, fonte incompleta) restano con cache breve e senza "stale": altrimenti un problema transitorio
// verrebbe servito più a lungo.
const BROWSER_MAX = 60;

function cc(ttl, swr) {
  const b = Math.min(ttl, BROWSER_MAX);
  if (swr > 0) return `public, max-age=${b}, s-maxage=${ttl}, stale-while-revalidate=${swr}`;
  return ttl > BROWSER_MAX ? `public, max-age=${b}, s-maxage=${ttl}` : `public, max-age=${ttl}`;
}

// Per i dati che dipendono dalle uscite del calendario (releaseAwareTtl accorcia la cache vicino a un dato importante):
// il "stale" si usa solo quando la durata è quella normale, cioè quando non c'è un dato in uscita o appena uscito. Così dopo un dato importante
// nessuno riceve per primo il numero vecchio.
function ccRelease(ttl, base, swr) {
  return ttl === base ? cc(ttl, swr) : cc(ttl, 0);
}

// Risposta di RIPIEGO (l'AI non ha risposto, fonte incompleta): il CDN la tiene `ttl` secondi, uguale per tutti (così i nuovi tentativi dei visitatori NON generano una analisi a testa:
// scaduta la copia, la prima richiesta ne prepara una e tutti ricevono quella); il browser la ricontrolla ogni 15 secondi al massimo.
function ccFail(ttl) {
  return `public, max-age=${Math.min(ttl, 15)}, s-maxage=${ttl}`;
}

// Analisi AI (3 ore): "stale" per 1 ora, ma solo se l'AI ha risposto davvero e non c'è un dato importante in uscita; il ripiego resta a cache breve.
async function aiCc(ok, failTtl) {
  if (!ok) return ccFail(failTtl);
  const { releaseAwareTtl } = require('./release-watch');
  return ccRelease(await releaseAwareTtl(10800), 10800, 3600);
}

module.exports = { cc, ccRelease, ccFail, aiCc, BROWSER_MAX };
