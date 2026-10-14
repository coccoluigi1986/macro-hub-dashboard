// api/narrative.js
//
// Serverless Function (Vercel): analisi narrative AI per le sezioni che prima erano testo scritto a
// mano e invecchiavano in silenzio (Geopolitica, Fed, Barometro Hawkish/Dovish, Cruscotto Asset,
// Indici Azionari). Ogni sezione è una chiamata a Gemini con lo stesso "grounding" reale:
//   - notizie vere aggregate da RSS (lib/news.js)
//   - prezzi e variazioni di oggi da Yahoo Finance (lib/yahoo.js)
//   - dati macro ufficiali FRED, incluso il target range Fed (lib/fred.js)
//   - prossimi eventi ad alto impatto dal calendario economico (lib/calendar.js)
// e la regola esplicita di non citare nulla che non sia nei dati forniti.
//
// Alcune sezioni aggiungono al grounding blocchi extra (campo "needs"):
//   released    → ultimi dati macro USA/UE/lavoro già usciti, con atteso e precedente (lib/macro-cards.js)
//   cot         → posizionamento CFTC con percentili a 52 settimane (lib/cot.js)
//   positioning → CNN Fear & Greed e AAII (lib/positioning.js)
//
// Query: ?section=geo|fed|hawkdove|assets|indices|macro|sentiment|newscmp
// Risposta: { generatedAt, section, ai, data } — se Gemini non risponde, ai:false e data:null
// (il client mostra "analisi non disponibile" invece di testo vecchio).
// Cache CDN 3h quando l'AI ha risposto, 2 min altrimenti (un errore transitorio non resta congelato).
// Raggiungibile su: https://tuosito.vercel.app/api/narrative?section=geo

const { aggregateNews } = require('../lib/news');
const { llmJSON, llmConfigured } = require('../lib/llm');
const { fetchYahooQuote } = require('../lib/yahoo');
const { fetchFredSnapshot } = require('../lib/fred');
const { fetchCalendarEvents } = require('../lib/calendar');
const { fetchMacroCards, macroCardLines } = require('../lib/macro-cards');
const { fetchCotSnapshot } = require('../lib/cot');
const { fetchPositioning } = require('../lib/positioning');
const { toVercelHandler } = require('../lib/vercel-adapter');

const QUOTES = {
  'S&P 500': '^GSPC', 'Nasdaq 100': '^NDX', 'Dow Jones': '^DJI', 'Russell 2000': '^RUT', 'VIX': '^VIX',
  'DXY (Dollar Index)': 'DX-Y.NYB', 'Rendimento US 10Y (%)': '^TNX',
  'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'JPY=X',
  'Oro (futures)': 'GC=F', 'Argento (futures)': 'SI=F', 'WTI': 'CL=F', 'Brent': 'BZ=F',
};

const SYS = 'Sei un analista macro-geopolitico senior di un desk di trading istituzionale. Rispondi SEMPRE in '
  + 'italiano, in modo tecnico, concreto e operativo. Restituisci ESCLUSIVAMENTE JSON valido. '
  + 'REGOLA FONDAMENTALE: usa SOLO fatti e numeri presenti nelle notizie e nei dati forniti. Non inventare '
  + 'cifre, date, dichiarazioni, decisioni o eventi: se un\'informazione non è nei dati forniti, non citarla, '
  + 'anche se credi di ricordarla. Quando citi un numero, deve comparire nei dati.';

async function marketLines() {
  const entries = await Promise.allSettled(Object.entries(QUOTES).map(async ([label, sym]) => {
    const q = await fetchYahooQuote(sym);
    if (q.price == null) return null;
    const chg = q.changePercent != null ? ` (${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}% oggi)` : '';
    return `- ${label}: ${Number(q.price.toFixed(4))}${chg}`;
  }));
  return entries.map(e => e.status === 'fulfilled' ? e.value : null).filter(Boolean).join('\n');
}

async function fredLines() {
  const key = process.env.FRED_API_KEY;
  if (!key) return '';
  const d = await fetchFredSnapshot(key);
  const L = [];
  if (d.fedTargetLower != null && d.fedTargetUpper != null) L.push(`- Target range Fed attuale (FRED): ${d.fedTargetLower.toFixed(2)}%-${d.fedTargetUpper.toFixed(2)}%`);
  if (d.fedFundsRate) L.push(`- Fed funds effettivo: ${d.fedFundsRate}%`);
  if (d.cpiYoY) L.push(`- CPI USA YoY: ${d.cpiYoY}% (riferimento ${d.cpiDate}), core ${d.coreCpiYoY}%`);
  if (d.ppiYoY) L.push(`- PPI USA YoY: ${d.ppiYoY}%`);
  if (d.unemploymentRate) L.push(`- Disoccupazione USA: ${d.unemploymentRate}% (${d.unemploymentDate})`);
  if (d.nfpChangeThousands != null) L.push(`- NFP ultima variazione mensile: ${d.nfpChangeThousands >= 0 ? '+' : ''}${d.nfpChangeThousands}K (${d.nfpDate})`);
  if (d.gdpAnnualizedQoQ) L.push(`- PIL reale USA annualizzato ultimo trimestre: ${d.gdpAnnualizedQoQ}% (${d.gdpDate})`);
  if (d.nominal10y != null) L.push(`- Treasury 10Y: ${d.nominal10y}%, rendimento reale ${d.real10y}%, breakeven 10Y ${d.breakeven10y}%, curva 10Y-2Y ${d.curve10y2yBps} pb`);
  if (d.fedPathBps3m != null) L.push(`- Sentiero Fed implicito: T-bill 3M ${d.fedPathBps3m >= 0 ? '+' : ''}${d.fedPathBps3m} pb vs Fed funds, Treasury 1Y ${d.fedPathBps12m >= 0 ? '+' : ''}${d.fedPathBps12m} pb`);
  return L.join('\n');
}

async function calendarLines() {
  const from = new Date(); from.setUTCHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 45 * 86400000);
  const events = (await fetchCalendarEvents({ from: from.toISOString(), to: to.toISOString() })).filter(e => e.importance === 'alto');
  const near = events.filter(e => new Date(e.date).getTime() <= from.getTime() + 10 * 86400000 && ['USD', 'EUR', 'GBP', 'JPY'].includes(e.currency));
  const decisions = events.filter(e => /interest rate decision|fomc/i.test(e.title));
  const fmt = (e) => {
    const when = new Date(e.date).toLocaleString('it-IT', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
    return `- ${when} (Roma) ${e.currency} ${e.title}${e.forecast != null ? ` — previsto ${e.forecast}${e.unit}` : ''}${e.previous != null ? `, precedente ${e.previous}${e.unit}` : ''}`;
  };
  const seen = new Set();
  return [...near.slice(0, 18), ...decisions].filter(e => !seen.has(e.id) && seen.add(e.id)).map(fmt).join('\n');
}

// Ultimi dati macro già usciti (stesse card mostrate nelle sezioni Macro / Europa / Lavoro)
async function releasedLines() {
  return macroCardLines(await fetchMacroCards());
}

const COT_LABELS = {
  gold: 'Oro', silver: 'Argento', eur: 'EUR (Euro FX)', gbp: 'GBP', jpy: 'JPY', dxy: 'US Dollar Index (futures)',
  sp500: 'S&P 500 E-mini', nasdaq: 'Nasdaq 100', dow: 'Dow Jones', russell: 'Russell 2000', vix: 'VIX futures',
  wti: 'WTI', brent: 'Brent', bitcoin: 'Bitcoin (CME)', ether: 'Ether (CME)',
};
// ICU it-IT non raggruppa i numeri a 4 cifre ("8297" accanto a "36.076"): separatore delle migliaia esplicito
const itInt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const sgn = (n) => `${n >= 0 ? '+' : ''}${itInt(n)}`;

async function cotLines() {
  const snap = await fetchCotSnapshot(null);
  const L = [];
  for (const [key, label] of Object.entries(COT_LABELS)) {
    const d = snap.data[key];
    if (!d || d.error) continue;
    const mm = d.managedMoneyNet != null;
    const net = mm ? d.managedMoneyNet : d.nonCommercialNet;
    if (net == null) continue;
    const who = mm ? 'Managed Money' : 'Non-Commercial';
    const cl = mm ? d.managedMoneyChangeLong : d.nonCommercialChangeLong;
    const cs = mm ? d.managedMoneyChangeShort : d.nonCommercialChangeShort;
    const chg = cl != null && cs != null ? `, variazione settimanale ${sgn(cl - cs)} (long ${sgn(cl)} / short ${sgn(cs)})` : '';
    const oi = d.openInterest != null ? `; open interest ${itInt(d.openInterest)}${d.openInterestChange != null ? ` (${sgn(d.openInterestChange)} sett.)` : ''}` : '';
    const pct = d.netPercentile52w != null ? `; posizionamento netto al ${d.netPercentile52w}° percentile delle ultime 52 settimane (${d.netPercentile26w}° su 26)` : '';
    const comm = !mm && d.commercialNet != null ? `; Commercial net ${sgn(d.commercialNet)}` : '';
    L.push(`- ${label}: ${who} net ${sgn(net)}${chg}${oi}${pct}${comm} [report del ${d.reportDate}]`);
  }
  return L.join('\n');
}

async function positioningLines() {
  const p = await fetchPositioning();
  const L = [];
  if (p.fearGreed) {
    const f = p.fearGreed;
    L.push(`- CNN Fear & Greed: ${f.score}/100 (${f.ratingIt}); chiusura precedente ${f.previousClose}, 1 settimana fa ${f.previousWeek}, 1 mese fa ${f.previousMonth}, 1 anno fa ${f.previousYear}`);
  }
  if (p.aaii) {
    const a = p.aaii;
    L.push(`- AAII Sentiment Survey (rilevazione ${a.date}): bullish ${a.bullish}%, neutral ${a.neutral}%, bearish ${a.bearish}% (spread bull-bear ${a.spread >= 0 ? '+' : ''}${a.spread} pt)`
      + (a.previous ? `; rilevazione precedente (${a.previous.date}): bullish ${a.previous.bullish}%, bearish ${a.previous.bearish}%` : ''));
  }
  L.push('- NAAIM Exposure Index e CBOE Put/Call Ratio: NON DISPONIBILI (nessuna fonte gratuita aggiornata) — non citarne valori');
  return L.join('\n');
}

const EXTRA_BLOCKS = {
  released: { title: 'ULTIMI DATI MACRO PUBBLICATI (calendario economico: valore attuale, atteso dal consensus, precedente)', fn: releasedLines },
  cot: { title: 'POSIZIONAMENTO COT (CFTC, ultimo report settimanale; i percentili sono calcolati sulle ultime 52 settimane)', fn: cotLines },
  positioning: { title: 'INDICATORI DI SENTIMENT (fonti reali)', fn: positioningLines },
};

async function buildContext(needs = []) {
  const safe = (p) => p.catch((e) => { console.warn('narrative grounding fallito:', e.message); return ''; });
  const extraKeys = needs.filter((k) => EXTRA_BLOCKS[k]);
  const [news, market, macro, calendar, ...extras] = await Promise.all([
    aggregateNews(40).then(items => items.slice(0, 30).map((n, i) => `${i + 1}. [${n.source} ${n.published.slice(5, 16).replace('T', ' ')} UTC] ${n.title} — ${n.summary.slice(0, 170)}`).join('\n')).catch((e) => { console.warn('news fallite:', e.message); return ''; }),
    safe(marketLines()), safe(fredLines()), safe(calendarLines()),
    ...extraKeys.map((k) => safe(EXTRA_BLOCKS[k].fn())),
  ]);
  const today = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Rome' });
  const extraText = extraKeys.map((k, i) => `${EXTRA_BLOCKS[k].title}:\n${extras[i] || '- non disponibili'}\n\n`).join('');
  return {
    hasData: Boolean(news || market),
    text: `DATA DI OGGI: ${today}\n\nNOTIZIE REALI RECENTI (fonte, ora UTC):\n${news || '- nessuna notizia disponibile'}\n\n`
      + `PREZZI DI OGGI (Yahoo Finance):\n${market || '- non disponibili'}\n\n`
      + `DATI MACRO UFFICIALI (FRED):\n${macro || '- non disponibili'}\n\n`
      + extraText
      + `PROSSIMI EVENTI AD ALTO IMPATTO (calendario economico):\n${calendar || '- non disponibili'}\n`,
  };
}

const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
// array di oggetti: scarta null/valori non-oggetto che l'AI può restituire ogni tanto
const objs = (v, n) => arr(v, n).filter(x => x && typeof x === 'object');
const str = (v) => (typeof v === 'string' ? v : '');

const SECTIONS = {
  geo: {
    maxTokens: 2200,
    task: 'Produci l\'analisi della sezione GEOPOLITICA: i driver geopolitici attivi in questo momento e il loro impatto sui mercati.',
    schema: '{\n'
      + '  "cards": [\n'
      + '    {"label":"titolo breve del principale conflitto/tensione geopolitica attiva","text":"3-4 frasi, max 450 caratteri"},\n'
      + '    {"label":"Impatto su energia e supply chain (o altro canale di trasmissione dominante)","text":"3-4 frasi, max 450 caratteri"}\n'
      + '  ],\n'
      + '  "monitor": "cosa monitorare: l\'evento geopolitico a più alto impatto potenziale e gli scenari escalation vs de-escalation, max 450 caratteri",\n'
      + '  "news": [ 4 oggetti {"cat":"max 28 caratteri","trend":"up|down|flat","desc":"2-3 frasi, max 280 caratteri","sources":["nome fonte presente nelle notizie"]} ],\n'
      + '  "bias": "bias di conflitto e lettura operativa, max 520 caratteri, con <b>..</b> attorno a 2 concetti chiave"\n'
      + '}\n"trend" indica come evolve il RISCHIO: up = in aumento, down = in calo, flat = stabile.',
    normalize: (d) => ({
      cards: objs(d.cards, 2).map(c => ({ label: str(c.label), text: str(c.text) })),
      monitor: str(d.monitor),
      news: objs(d.news, 4).map(n => ({ cat: str(n.cat), trend: ['up', 'down', 'flat'].includes(n.trend) ? n.trend : 'flat', desc: str(n.desc), sources: arr(n.sources, 3).map(str) })),
      bias: str(d.bias),
    }),
  },
  fed: {
    maxTokens: 2200,
    task: 'Produci l\'analisi della sezione BANCHE CENTRALI — FED: stato attuale della politica monetaria e prospettive. '
      + 'Descrivi l\'ultima decisione SOLO se risulta dalle notizie; altrimenti basati sul target range FRED e sui dati di inflazione/lavoro forniti.',
    schema: '{\n'
      + '  "decision": {"headline":"stato attuale della politica monetaria / ultima decisione, max 90 caratteri","text":"3-4 frasi, max 520 caratteri"},\n'
      + '  "why_up": [ 5 punti brevi su perché la Fed potrebbe restare restrittiva o alzare ancora, max 170 caratteri ciascuno ],\n'
      + '  "why_pause": [ 5 punti brevi su perché il ciclo restrittivo potrebbe fermarsi o invertire, max 170 caratteri ciascuno ],\n'
      + '  "synthesis": "sintesi operativa — come adeguarsi, numerata 1) 2) 3) 4) su dollaro, oro, rendimenti reali/equity, sentiment/rischi, max 900 caratteri"\n'
      + '}',
    normalize: (d) => ({
      decision: { headline: str(d.decision && d.decision.headline), text: str(d.decision && d.decision.text) },
      whyUp: arr(d.why_up, 5).map(str), whyPause: arr(d.why_pause, 5).map(str), synthesis: str(d.synthesis),
    }),
  },
  hawkdove: {
    maxTokens: 2500,
    task: 'Produci il BAROMETRO HAWKISH / DOVISH: bilancio dei fattori che spingono la Fed verso una linea più restrittiva (hawkish) o più accomodante (dovish), alla luce dei dati e delle notizie.',
    schema: '{\n'
      + '  "regime_title": "etichetta breve del regime attuale, max 60 caratteri",\n'
      + '  "regime_quote": "2-3 frasi che riassumono il regime, max 380 caratteri, con <b>..</b> sulla conclusione",\n'
      + '  "hawk": [ 4-6 spinte hawkish brevi, max 110 caratteri ciascuna ],\n'
      + '  "dove": [ 4-6 spinte dovish brevi, max 110 caratteri ciascuna ],\n'
      + '  "note": "nota di lettura e prossimi dati/eventi da monitorare (dal calendario), max 380 caratteri",\n'
      + '  "conflicts": [ 2 segnali contrastanti nei dati, max 200 caratteri ciascuno ],\n'
      + '  "fomc": {"headline":"stato del prossimo FOMC (data dal calendario) e cosa prezza il mercato, max 260 caratteri, con <b>..</b>","rows":[ 3 oggetti {"label":"max 70 caratteri","value":"max 90 caratteri","tone":"hawk|dove|neutral"} ],"note":"max 300 caratteri; se le probabilità puntuali non sono nei dati, dillo esplicitamente senza stimarle"},\n'
      + '  "synthesis": "sintesi finale, max 700 caratteri"\n'
      + '}',
    normalize: (d) => ({
      regimeTitle: str(d.regime_title), regimeQuote: str(d.regime_quote),
      hawk: arr(d.hawk, 6).map(str), dove: arr(d.dove, 6).map(str), note: str(d.note),
      conflicts: arr(d.conflicts, 3).map(str),
      fomc: {
        headline: str(d.fomc && d.fomc.headline),
        rows: objs(d.fomc && d.fomc.rows, 3).map(r => ({ label: str(r.label), value: str(r.value), tone: ['hawk', 'dove', 'neutral'].includes(r.tone) ? r.tone : 'neutral' })),
        note: str(d.fomc && d.fomc.note),
      },
      synthesis: str(d.synthesis),
    }),
  },
  assets: {
    maxTokens: 3000,
    task: 'Produci il CRUSCOTTO ASSET: per ciascuno dei 5 asset indicati, bias direzionale e lettura. Usa i prezzi e le variazioni di oggi forniti.',
    schema: '{\n'
      + '  "assets": [ 5 oggetti, uno per ciascuna chiave esattamente in quest\'ordine: eurusd, usdjpy, gold, oil, equity (equity = S&P 500 / Nasdaq),\n'
      + '    {"key":"eurusd","bias":"bull|bear|neutral","bias_label":"etichetta maiuscola breve, max 36 caratteri","sentiment":"max 90 caratteri","outlook":"scenari qualitativi con percentuali che sommano 100, es. 50% rialzo / 35% laterale / 15% ribasso, max 90 caratteri","text":"3-4 frasi, max 520 caratteri, con driver concreti tratti da notizie e dati"} ]\n'
      + '}\nLe percentuali di "outlook" sono scenari indicativi e qualitativi, non probabilità statistiche.',
    normalize: (d) => ({
      assets: objs(d.assets, 5).map(a => ({
        key: str(a.key), bias: ['bull', 'bear', 'neutral'].includes(a.bias) ? a.bias : 'neutral',
        biasLabel: str(a.bias_label), sentiment: str(a.sentiment), outlook: str(a.outlook), text: str(a.text),
      })),
    }),
  },
  indices: {
    maxTokens: 1400,
    task: 'Produci le note operative sugli INDICI AZIONARI USA: come si muove ciascun indice oggi e perché, con attenzione ai driver (tassi, rendimenti, tech, energia, small cap).',
    schema: '{\n'
      + '  "indices": [ 4 oggetti, uno per ciascuna chiave esattamente in quest\'ordine: sp500, nasdaq, dow, russell,\n'
      + '    {"key":"sp500","text":"2-3 frasi, max 380 caratteri, anche con una nota operativa"} ]\n'
      + '}',
    normalize: (d) => ({ indices: objs(d.indices, 4).map(i => ({ key: str(i.key), text: str(i.text) })) }),
  },
  // Note di commento sotto le card Macro USA / Europa / Lavoro / Rendimenti + "Cosa prezza il mercato".
  // Le card stesse (valori) arrivano dal calendario reale; qui l'AI le interpreta senza poterle contraddire.
  macro: {
    needs: ['released'],
    maxTokens: 5000,
    task: 'Produci le NOTE DI LETTURA delle sezioni Macro USA, Europa (Eurozona/BCE), Lavoro e Rendimenti/VIX/DXY, più le liste "cosa prezza il mercato" e "rischi non prezzati". '
      + 'Per i dati macro usa ESCLUSIVAMENTE il blocco "ULTIMI DATI MACRO PUBBLICATI" e i dati FRED: cita sempre il mese/periodo di riferimento e non parlare di dati più vecchi come se fossero recenti. '
      + 'Per la BCE usa solo ciò che compare nei dati (es. tasso sui depositi) e nelle notizie.',
    schema: '{\n'
      + '  "us_note": "Lettura d\'insieme del quadro macro USA (inflazione, attività PMI/ISM, crescita): cosa dicono i dati usciti rispetto alle attese e cosa implicano per la Fed, max 760 caratteri, con <b>..</b> su 2-3 concetti",\n'
      + '  "eu_note": "Lettura d\'insieme dell\'Eurozona (inflazione, crescita, BCE) e confronto con gli USA, max 760 caratteri, con <b>..</b>",\n'
      + '  "jobs_note": "Perché conta il mercato del lavoro oggi: payrolls, disoccupazione, salari, sussidi, JOLTs — cosa segnalano, max 760 caratteri, con <b>..</b>",\n'
      + '  "rates_note": "Lettura di rendimento 10Y, curva, DXY e VIX con i valori di oggi dai dati, max 620 caratteri, con <b>..</b>",\n'
      + '  "priced": [ 4 oggetti {"label":"cosa è già prezzato, max 60 caratteri","detail":"max 190 caratteri"} ],\n'
      + '  "risks": [ 3 oggetti {"label":"rischio non prezzato, max 60 caratteri","detail":"max 190 caratteri"} ]\n'
      + '}',
    normalize: (d) => ({
      usNote: str(d.us_note), euNote: str(d.eu_note), jobsNote: str(d.jobs_note), ratesNote: str(d.rates_note),
      priced: objs(d.priced, 4).map(p => ({ label: str(p.label), detail: str(p.detail) })),
      risks: objs(d.risks, 3).map(p => ({ label: str(p.label), detail: str(p.detail) })),
    }),
  },
  // Sentiment (indicatori di posizionamento), Risk-On/Off, validazione incrociata news vs COT/OI/macro e nota COT.
  sentiment: {
    needs: ['released', 'cot', 'positioning'],
    maxTokens: 6500,
    task: 'Produci: la lettura degli INDICATORI DI SENTIMENT (Fear & Greed, AAII; NAAIM e Put/Call non sono disponibili: dillo senza inventare valori), '
      + 'il quadro RISK-ON / RISK-OFF (VIX, azionario, oro, regime), la VALIDAZIONE INCROCIATA sull\'ORO (la narrativa delle notizie contro COT, open interest e macro) e una nota generale sul COT. '
      + 'Per il COT usa solo le righe del blocco POSIZIONAMENTO COT (i percentili sono su 52 settimane, non su 6 mesi). '
      + 'La validazione incrociata confronta cosa dicono le NOTIZIE con cosa mostrano i dati: "aligned" = notizie e dati puntano nella stessa direzione, "conflict" = si contraddicono.',
    schema: '{\n'
      + '  "sent_note": "Lettura d\'insieme di Fear & Greed e AAII: livello, variazione rispetto a settimana/mese precedenti, cosa implica; chiudi dicendo che NAAIM e Put/Call non sono disponibili, max 820 caratteri, con <b>..</b>",\n'
      + '  "risk": {\n'
      + '    "vix_sub": "lettura del livello del VIX di oggi, max 150 caratteri",\n'
      + '    "equity_sub": "lettura dell\'S&P 500 di oggi, max 150 caratteri",\n'
      + '    "gold_sub": "lettura dell\'oro di oggi, max 150 caratteri",\n'
      + '    "regime": {"label":"max 22 caratteri maiuscolo, es. RISK-OFF / RISK-ON / MISTO","tone":"risk_on|risk_off|mixed","sub":"max 170 caratteri"},\n'
      + '    "note": "lettura d\'insieme del regime di rischio, max 620 caratteri, con <b>..</b>"\n'
      + '  },\n'
      + '  "xval": [ 3 oggetti in quest\'ordine: "News vs COT", "News vs Open Interest", "News vs Macro" (focus ORO),\n'
      + '    {"title":"...","status":"aligned|conflict","text":"max 520 caratteri, con numeri presenti nei dati e <b>..</b>"} ],\n'
      + '  "xv_bias": "bias risultante sull\'oro dai 3 controlli incrociati e indicazione operativa, max 760 caratteri, con <b>..</b>",\n'
      + '  "cot_note": "nota generale sul posizionamento COT di oggi: gli asset con posizionamento più estremo per percentile e cosa significa, max 760 caratteri, con <b>..</b>"\n'
      + '}',
    normalize: (d) => {
      const r = d.risk || {};
      const rg = r.regime || {};
      return {
        sentNote: str(d.sent_note),
        risk: {
          vixSub: str(r.vix_sub), equitySub: str(r.equity_sub), goldSub: str(r.gold_sub), note: str(r.note),
          regime: { label: str(rg.label), tone: ['risk_on', 'risk_off', 'mixed'].includes(rg.tone) ? rg.tone : 'mixed', sub: str(rg.sub) },
        },
        xval: objs(d.xval, 3).map(x => ({ title: str(x.title), status: x.status === 'aligned' ? 'aligned' : 'conflict', text: str(x.text) })),
        xvBias: str(d.xv_bias),
        cotNote: str(d.cot_note),
      };
    },
  },
  // "Notizie macro a confronto": come fonti diverse raccontano gli stessi temi, dalle notizie reali.
  newscmp: {
    maxTokens: 2000,
    task: 'Produci la sezione NOTIZIE MACRO A CONFRONTO: 4 sintesi di come fonti DIVERSE tra quelle presenti nelle notizie raccontano i temi macro dominanti di oggi (inflazione, Fed/tassi, energia/geopolitica, mercati). '
      + 'Sono sintesi comparate, non citazioni testuali; ogni voce deve basarsi su una notizia realmente presente nell\'elenco e usare come "src" il nome della fonte come compare nell\'elenco.',
    schema: '{\n'
      + '  "items": [ 4 oggetti {"src":"nome fonte presente nelle notizie","txt":"2-3 frasi che sintetizzano come quella fonte racconta il tema, max 330 caratteri"} ]\n'
      + '}',
    normalize: (d) => ({ items: objs(d.items, 4).map(i => ({ src: str(i.src), txt: str(i.txt) })) }),
  },
};

// Per fed e hawkdove i dati macro già usciti (ISM, PCE, lavoro...) migliorano il grounding.
SECTIONS.fed.needs = ['released'];
SECTIONS.hawkdove.needs = ['released'];

async function handleEvent(event) {
  try {
    const section = ((event.queryStringParameters || {}).section || '').trim();
    const spec = SECTIONS[section];
    if (!spec) {
      return { statusCode: 400, body: JSON.stringify({ error: `Parametro section non valido. Valori ammessi: ${Object.keys(SECTIONS).join(', ')}` }) };
    }

    let data = null;
    if (llmConfigured()) {
      try {
        const ctx = await buildContext(spec.needs || []);
        if (ctx.hasData) {
          const prompt = `${ctx.text}\n${spec.task}\nRestituisci JSON con questa struttura esatta:\n${spec.schema}\nSolo JSON.`;
          const raw = await llmJSON({ system: SYS, prompt, maxTokens: spec.maxTokens });
          data = spec.normalize(raw);
        }
      } catch (e) {
        console.warn(`narrative ${section} AI failed:`, e.message);
      }
    }

    const ai = Boolean(data);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ai ? 10800 : 120}` },
      body: JSON.stringify({ generatedAt: new Date().toISOString(), section, ai, data }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

module.exports = toVercelHandler(handleEvent);
