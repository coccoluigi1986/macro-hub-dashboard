// lib/news-impact.js
//
// Valutazione dell'IMPATTO di una notizia sui mercati, senza AI e senza dati scritti a mano. Si guarda COSA È SUCCESSO (un attacco,
// una dichiarazione di Trump, la decisione di una banca centrale, un dato a sorpresa, un movimento di mercato) più che di cosa si
// parla: un "Price Forecast" o un "Forex Today" commentano soltanto, un articolo su una partita di football non conta nulla.
// Usato da lib/market-context.js per ordinare le notizie per impatto invece che per sola data.

// Eventi: pesi alti. Si valuta il TITOLO (la notizia); se l'evento compare solo nel riassunto vale meno (contorno).
const EVENTS = [
  { tag: 'geopolitica', w: 6, re: /\b(strikes? (?:on|against|in)|air ?strikes?|attack(?:s|ed|ing)?|blasts?|explosions?|missiles?|drones?|bomb\w*|invad\w+|invasion|retaliat\w+|escalat\w+|war|warship\w*|ceasefire|cease-fire|blockade|hormuz|qeshm|houthi\w*|hezbollah|nuclear|sanctions?|embargo|troops|peace (?:deal|talks?|agreement)|deal (?:hopes?|looms|stalls?)|talks? stall\w*|supreme leader|netanyahu|khamenei|kremlin|putin|xi jinping)\b/i },
  { tag: 'dichiarazione', w: 5, re: /\b(trump|white house|truth social|bessent|lutnick|powell|warsh|lagarde|ueda|bailey|bullock|yellen)\b[^.]{0,40}\b(says?|said|threat\w*|warns?|announces?|signs?|orders?|vows?|slams?|demands?|pledges?|plays? down|urges?|halts?|ends?|cuts? off|stop\w*|imposes?|raises?|hints?|signals?)\b/i },
  { tag: 'banche centrali', w: 5, re: /\b((?:hikes?|cuts?|holds?|keeps?|raises?|lowers?|lifts?|pauses?) (?:\w+ ){0,3}(?:interest )?rates?|rate (?:hike|cut|decision|pause|hold)s?|fomc|minutes|intervention|reserve (?:requirement|ratio)|quantitative (?:easing|tightening)|hike bets?)\b/i },
  { tag: 'dati macro', w: 4, re: /\b(cpi|ppi|pce|nfp|non-?farm|payrolls?|jobs report|jolts|unemployment rate|jobless claims|gdp|pmi|ism|retail sales|consumer (?:sentiment|confidence)|durable goods)\b/i },
  { tag: 'dazi/politica', w: 4, re: /\b(tariffs?|trade (?:war|deal)|executive order|shutdown|debt ceiling|midterms?)\b/i },
  { tag: 'movimento mercato', w: 4, re: /\b(oil|crude|brent|wti|gold|silver|dollar|yen|yields?|stocks?|s&p 500|nasdaq|dow|vix|bitcoin)\b[^.]{0,30}\b(tumbles?|plunges?|plummets?|sinks?|slides?|slumps?|falls?|drops?|dips?|surges?|soars?|jumps?|spikes?|rallies|rebounds?|recovers?|gains?|climbs?|rises?|rise)\b/i },
  { tag: 'scenario geopolitico', w: 2.5, re: /\b(iran\w*|israel\w*|russia\w*|ukrain\w*|china|taiwan|north korea|gaza|hamas|opec\w*|middle east|west asia)\b/i },
];
// Argomento: conta poco da solo (un commento sull'oro non è una notizia che muove l'oro)
const TOPIC = /\b(oil|crude|brent|wti|gold|silver|bullion|dollar|dxy|yen|euro|sterling|yields?|treasur\w+|vix|stocks?|futures|wall street|nasdaq|s&p|iran\w*|israel\w*|fed|ecb|boj|boe)\b/gi;
const URGENT = /\b(breaking|just in|urgent|flash|developing)\b/i;
const COMMENTARY = /\b(price forecast|price analysis|forex today|what to know|what's moving|what you need|preview|week ahead|main events|outlook|analysis|forecast|explained|scenarios?|how to|picks?|stocks? to buy|history likes|could be coming|here's why|why is|why did|what are)\b/i;
const NOISE = /\b(nfl|nba|mlb|nhl|quarterback|raiders|taco bell|cupcake|recipe|horoscope|celebrity|royal|oscars?|grammy|fashion|vacation|dating|obituary|lottery|powerball|best credit cards?|mortgage rates|retirement|social security|savings rates?|i bonds?|cramer|ballot|billionaire tax|supermarket|cyclospora)\b/i;
const LOW_SRC = /(businesswire|globenewswire|prnewswire|seeking ?alpha|24\/7 wall|motley|benzinga|zacks|marketbeat|simply wall|investorplace|tipranks|insider monkey|kucoin|tmgm|indexbox|startup fortune|forbes|chase bank|tradingview|kalkine)/i;
const HI_SRC = /(forexlive|investinglive|fxstreet|federal reserve|reuters|bloomberg|wsj|financial times|ft\.com|cnbc|investing\.com)/i;

// Quali parole chiave toccano un asset (per abbinare le notizie ai movimenti)
const ASSET_TOPICS = {
  oro: /\b(gold|bullion|safe[- ]haven|xau)\b/i, argento: /\b(silver|xag)\b/i,
  petrolio: /\b(oil|crude|brent|wti|opec\w*|hormuz|energy|qeshm|refiner\w*)\b/i,
  dollaro: /\b(dollar|dxy|greenback|usd)\b/i, rendimenti: /\b(yields?|treasur\w+|bonds?|10-year|jolts|hike bets?)\b/i,
  indici: /\b(stocks?|wall street|nasdaq|s&p|dow|futures|equit\w+|selloff|rally|earnings)\b/i,
  yen: /\b(yen|jpy|boj|ueda|japan\w*)\b/i, euro: /\b(euro|eur|ecb|lagarde|eurozone)\b/i, sterlina: /\b(pound|sterling|gbp|boe|bank of england)\b/i,
  vix: /\b(vix|volatility|fear gauge|stocks?|wall street)\b/i,
};
// Notizie "di sistema": muovono tutti gli asset, quindi valgono come candidate per ogni movimento
const SYSTEMIC = /\b(iran\w*|israel\w*|hormuz|qeshm|missiles?|strikes? on|attack(?:s|ed)?|war|ceasefire|escalat\w+|retaliat\w+|trump|tariff\w*|fed|fomc|powell|warsh|rate (?:cut|hike|decision)\w*|nfp|payrolls?|cpi|breaking|sanction\w*|threat\w*)\b/i;

function impact(it, now = Date.now()) {
  const t = it.title, text = `${it.title} ${it.summary || ''}`;
  let score = 0; const tags = [];
  for (const ev of EVENTS) {
    if (ev.re.test(t)) { score += ev.w; tags.push(ev.tag); }
    else if (ev.re.test(text)) { score += ev.w * 0.45; tags.push(ev.tag); }
  }
  score += Math.min(2, (t.match(TOPIC) || []).length * 0.7);
  if (URGENT.test(t)) score += 2;
  if (COMMENTARY.test(t)) score -= 3;
  if (NOISE.test(text)) score -= 8;
  const src = it.source || '';
  if (LOW_SRC.test(src)) score -= 2; else if (HI_SRC.test(src)) score += 0.5;
  const ageH = Math.max(0, (now - new Date(it.published).getTime()) / 3600e3);
  const decay = ageH <= 10 ? 1 : ageH <= 20 ? 0.9 : 0.75;   // le notizie notturne restano in gioco per tutta la giornata
  return { score: score * decay, rawScore: score, tags: [...new Set(tags)], ageH };
}
// Soglie tarate sulle notizie reali di un giorno intenso: ALTO ≈ il 12% più forte (attacchi, dichiarazioni dei leader, decisioni, movimenti netti).
const level = (s) => (s >= 11 ? 'ALTO' : s >= 4 ? 'MEDIO' : 'BASSO');

module.exports = { impact, level, ASSET_TOPICS, SYSTEMIC };
