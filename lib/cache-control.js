// Cache-Control con "stale-while-revalidate" per le risposte LENTE da ricalcolare.
//
// Prima: quando la copia in cache scadeva (ogni 5 min – 3 ore a seconda del dato), il primo visitatore dopo la scadenza aspettava il ricalcolo
// (cot-data ~9 s, indicatori e heatmap ~2 s, analisi AI 4-14 s) e con lui la Panoramica e il ticker: era il "a volte il sito si apre lento".
// Ora: allo scadere, il CDN di Vercel e il browser servono SUBITO la copia vecchia e ne preparano una nuova in background; il visitatore dopo la riceve fresca.
// La copia vecchia non vive oltre `swr` secondi: dopo quel limite si ricalcola come prima.
//
// Si usa solo sulle risposte COMPLETE. Le risposte di ripiego (errore, AI mancante, fonte incompleta) restano con cache breve e senza "stale":
// altrimenti un problema transitorio verrebbe servito più a lungo.
function cc(ttl, swr) {
  return swr > 0
    ? `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=${swr}`
    : `public, max-age=${ttl}`;
}

// Per i dati che dipendono dalle uscite del calendario (releaseAwareTtl accorcia la cache vicino a un dato importante):
// il "stale" si usa solo quando la durata è quella normale, cioè quando non c'è un dato in uscita o appena uscito. Così dopo un dato importante
// nessuno riceve per primo il numero vecchio.
function ccRelease(ttl, base, swr) {
  return ttl === base ? cc(ttl, swr) : `public, max-age=${ttl}`;
}

// Analisi AI (3 ore): "stale" per 1 ora, ma solo se l'AI ha risposto davvero e non c'è un dato importante in uscita; il ripiego resta a cache breve.
async function aiCc(ok, failTtl) {
  if (!ok) return `public, max-age=${failTtl}`;
  const { releaseAwareTtl } = require('./release-watch');
  return ccRelease(await releaseAwareTtl(10800), 10800, 3600);
}

module.exports = { cc, ccRelease, aiCc };
