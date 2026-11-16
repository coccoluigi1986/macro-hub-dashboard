// lib/news-feed.js
//
// Notizie VARIE per la pagina "Notizie": non solo macro e geopolitica (che nel feed principale si ripetono: stessi temi, stesse fonti), ma anche
// aziende e utili, tecnologia e AI, energia, materie prime, crypto, Asia, Europa, Italia. Ogni notizia viene da un feed RSS pubblico reale
// (nessuna chiave); i duplicati e le notizie quasi identiche (stessa storia raccontata da più testate) si tengono una volta sola.
//
// Per ogni notizia calcola anche l'impatto (lib/news-impact.js, senza AI) e COSA MUOVE: gli asset toccati (dalle parole del titolo) e una
// "lettura tipica" per tipo di evento. È una regola didattica, non una previsione: il testo dice "di solito".
//
// Usato da api/news-aggregated.js con ?view=feed.

const { fetchRss } = require('./news');
const { impact, level, ASSET_TOPICS, SYSTEMIC } = require('./news-impact');

const gn = (q, lang) => lang === 'it'
  ? `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:1d')}&hl=it&gl=IT&ceid=IT:it`
  : `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:1d')}&hl=en-US&gl=US&ceid=US:en`;

// categorie (ordine = ordine delle schede)
const CATS = [
  ['economia', 'Economia'], ['banche', 'Banche centrali'], ['aziende', 'Aziende e utili'], ['tech', 'Tecnologia e AI'], ['energia', 'Energia'],
  ['materie', 'Materie prime'], ['crypto', 'Crypto'], ['asia', 'Asia'], ['europa', 'Europa'], ['italia', 'Italia'], ['geopolitica', 'Geopolitica'],
];
// [categoria, fonte, indirizzo, opzioni]
const FEEDS = [
  ['economia', 'Google News', gn('(economy OR "jobs market" OR "consumer spending" OR "housing market" OR "retail sales" OR "consumer prices")')],
  ['economia', 'Investing.com', 'https://www.investing.com/rss/news_14.rss'],
  ['banche', 'Google News', gn('("central bank" OR "Bank of England" OR "Bank of Japan" OR "Bank of Canada" OR "Reserve Bank" OR "interest rate decision")')],
  ['banche', 'Federal Reserve', 'https://www.federalreserve.gov/feeds/press_all.xml'],
  ['aziende', 'CNBC', 'https://www.cnbc.com/id/10001147/device/rss/rss.html'],
  ['aziende', 'MarketWatch', 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines'],
  ['aziende', 'Google News', gn('(earnings OR "quarterly results" OR "raises guidance" OR "profit warning" OR merger OR acquisition OR IPO)')],
  ['tech', 'TechCrunch', 'https://techcrunch.com/feed/'],
  ['tech', 'Google News', gn('(Nvidia OR semiconductors OR "artificial intelligence" OR "AI chips" OR Microsoft OR Apple OR Tesla)')],
  ['energia', 'OilPrice.com', 'https://oilprice.com/rss/main'],
  ['energia', 'Google News', gn('("natural gas" OR LNG OR "energy prices" OR refinery OR "OPEC+" OR "power prices")')],
  ['materie', 'Investing.com', 'https://www.investing.com/rss/news_11.rss'],
  ['materie', 'Google News', gn('(copper OR wheat OR coffee OR cocoa OR lithium OR "iron ore" OR "agricultural commodities")')],
  ['crypto', 'Cointelegraph', 'https://cointelegraph.com/rss'],
  ['crypto', 'CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['asia', 'Google News', gn('("China economy" OR PBOC OR "Japan economy" OR "Bank of Japan" OR "India economy" OR "Hang Seng" OR Nikkei)')],
  ['europa', 'The Guardian', 'https://www.theguardian.com/business/eurozone/rss'],
  ['europa', 'Google News', gn('(eurozone OR ECB OR "German economy" OR DAX OR "European Union" economy)')],
  ['italia', 'ANSA', 'https://www.ansa.it/sito/notizie/economia/economia_rss.xml', { it: true }],
  ['italia', 'Il Sole 24 Ore', 'https://www.ilsole24ore.com/rss/finanza.xml', { it: true }],
  ['italia', 'Google News', gn('Borsa Milano OR BTP OR spread OR "Banca d\'Italia" OR Piazza Affari', 'it'), { it: true }],
  ['geopolitica', 'Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml'],
  ['geopolitica', 'Google News', gn('(sanctions OR election OR summit OR NATO OR "trade deal" OR treaty)')],
];

// cosa succede di solito, per tipo di evento: regole didattiche (il testo dice "di solito", non prevede nulla)
const READ = {
  'geopolitica': 'Quando sale la tensione si cercano rifugi: di solito salgono oro, dollaro e franco svizzero e scendono le azioni; il petrolio sale se è coinvolta un\'area che lo produce. Con segnali di distensione succede il contrario.',
  'scenario geopolitico': 'Le notizie sulle aree di crisi muovono soprattutto petrolio, oro e dollaro: contano gli sviluppi (nuovi attacchi o trattative), non il solo titolo.',
  'dichiarazione': 'Le parole dei leader possono muovere i prezzi in pochi minuti. Conta se aggiungono qualcosa di nuovo: guarda dollaro e rendimenti subito dopo la notizia.',
  'banche centrali': 'Una banca centrale più dura (tassi alti, meno stimoli) sostiene la propria valuta e pesa su azioni e oro; una più morbida fa il contrario.',
  'dati macro': 'Conta la sorpresa rispetto alle attese: un dato sopra le attese spinge rendimenti e dollaro e frena oro e azioni; sotto le attese, di solito, succede il contrario.',
  'dazi/politica': 'Dazi, sanzioni e blocchi alzano i costi e rallentano gli scambi: di solito pesano sulle azioni dei settori coinvolti e sostengono dollaro e beni rifugio.',
  'movimento mercato': 'Un movimento netto di un asset trascina spesso quelli collegati: guarda se dollaro, rendimenti e indici si muovono insieme o in direzioni opposte.',
};
const CAT_READ = {
  aziende: ['Titolo e settore', 'Di solito muove il titolo e il suo settore; pesa sull\'indice solo se l\'azienda è molto grande.'],
  tech: ['Settore tecnologico', 'I grandi titoli tecnologici guidano il Nasdaq: risultati o notizie su chip e AI spostano l\'intero indice.'],
  energia: ['Petrolio e gas', 'Energia cara alimenta l\'inflazione e pesa su famiglie e imprese; energia a buon mercato aiuta i consumi.'],
  materie: ['Materie prime', 'I prezzi delle materie prime si trasmettono ai costi delle aziende e all\'inflazione.'],
  crypto: ['Bitcoin', 'Le crypto seguono la propensione al rischio: salgono quando i mercati sono fiduciosi, scendono quando si cercano rifugi.'],
  asia: ['Yen, yuan e indici asiatici', 'La crescita cinese e le mosse della Banca del Giappone spostano valute asiatiche, materie prime e indici.'],
  europa: ['Euro', 'I dati europei e la BCE muovono euro, rendimenti dei Bund e indici europei.'],
  italia: ['BTP e Borsa di Milano', 'Conti pubblici, spread e banche muovono i titoli di Stato italiani e Piazza Affari.'],
};
const ASSET_LABEL = { oro: 'Oro', argento: 'Argento', petrolio: 'Petrolio', dollaro: 'Dollaro', rendimenti: 'Rendimenti USA', indici: 'Indici azionari', yen: 'Yen', euro: 'Euro', sterlina: 'Sterlina', vix: 'Volatilità (VIX)' };

// Google News restituisce anche cose che non c'entrano (guide ai regali, notizie di quartiere): si tengono solo i titoli che parlano di soldi, mercati, aziende o economia
const MONEY = /\b(stocks?|shares?|equit\w+|markets?|econom\w+|inflation|rates?|yields?|bonds?|treasur\w+|dollar|euro|eurozone|yen|yuan|oil|gas|lng|crude|gold|silver|copper|lithium|wheat|coffee|cocoa|commodit\w+|prices?|earnings|profits?|revenues?|sales|ipo|merger|acquisition|acquires?|deal|bank\w*|fed|ecb|boj|tariffs?|trade|jobs?|unemployment|gdp|supply|demand|investors?|nasdaq|dow|s&p|nvidia|chips?|semiconductors?|ai|bitcoin|crypto\w*|ether\w*|etf|borsa|borse|btp|spread|azioni|mercat\w+|tassi|petrolio|banca|banche|bce|pil|inflazione|energia|lavoro|stipend\w+|conti|debito|piazza affari|ftse|wall street)\b/i;
const JUNK = /(gift|recipe|county|holiday|festive|celebrity|horoscope|obituar|coupon|lifestyle|wedding|best (?:deals|gifts)|how to (?:cook|make)|batter(?:y|ies) collection|giveaway|sweepstakes|football|baseball|\bnfl\b|\bnba\b|caccia|sinner|calcio|students?|university|school)/i;
const DIRECT = /(investing\.com|cnbc|marketwatch|oilprice|cointelegraph|coindesk|techcrunch|federal reserve)/i;   // feed già dedicati alla finanza: non serve filtrarli per argomento
// testate riconosciute: le notizie trovate tramite Google News si tengono solo se vengono da fonti giornalistiche o finanziarie note (niente blog, riviste di settore locali, comunicati)
const ALLOW = /(reuters|bloomberg|wsj|wall street journal|financial times|\bft\b|ft\.com|cnbc|marketwatch|barron|investing\.com|yahoo|morningstar|fortune|business insider|economist|bbc|guardian|al jazeera|nikkei|south china morning|scmp|fxstreet|tradingview|kitco|mining\.com|rigzone|s&p global|sharecast|seeking ?alpha|benzinga|forbes|new york times|nyt|washington post|axios|politico|the hill|cnn|npr|associated press|\bap\b|fox business|techcrunch|the verge|wired|ars technica|coindesk|cointelegraph|decrypt|the block|oilprice|argus|platts|natural gas intelligence|world oil|il sole 24 ore|ansa|milano finanza|\bopen\b|repubblica|corriere|la stampa|borsa italiana|soldionline|teleborsa|\bagi\b|adnkronos|sky tg24|deutsche welle|\bdw\b|france 24|euronews|japan times|kyodo|xinhua|caixin|economic times|livemint|business standard|straits times|anadolu|zawya|biggo|investopedia|nasdaq\.com)/i;
const GENERIC_NAMES =new Set('trump china iran israel russia ukraine europe america united states bitcoin federal reserve wall street google news japan japanese germany german india indian eurozone bloomberg reuters yahoo finance markets'.split(' '));
const names = (t) => new Set((String(t).match(/\b[A-Z][a-zA-Z]{4,}\b/g) || []).map((w) => w.toLowerCase()).filter((w) => !GENERIC_NAMES.has(w)));
const STOP = new Set('the a an of to in on for and or as at by with from is are was were be been will would after over amid says say said new this that its it his her their has have had not but up down out into than more most under about could may might per via vs'.split(' '));
const tokens = (t) => new Set(String(t).toLowerCase().replace(/[^a-z0-9àèéìòù\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)));
const overlap = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n; };
const similar = (a, b) => { if (!a.size || !b.size) return false; const n = overlap(a, b); return n / Math.min(a.size, b.size) >= 0.6 && n >= 3; };

// ---- PRECISIONE (14-16 nov 2026) ----
// 1) Pubblicità, newsletter e notizie locali che passavano i filtri ("Morning Bid", caffetterie e birrifici di Kansas City).
const JUNK2 = /(morning (?:bid|brew|brief)|newsletter|sponsored|podcast|webinar|\bquiz\b|\bbeers?\b|\bbirre\b|brewer(?:y|ies)|coffee shops?|caffetteri\w*|restaurants?|ristorant\w*|food truck|best places)/i;
// 2) Ogni notizia prendeva la categoria dalla RICERCA che l'aveva trovata: "coffee" portava le caffetterie in Materie prime, "summit" un'azienda farmaceutica in Geopolitica,
//    il caso della cacciata del CEO di Nvidia in Geopolitica. Ora il titolo deve parlare davvero della categoria; se parla d'altro passa alla categoria giusta, se non
//    c'entra con nessuna si scarta. (Economia, Aziende, Tecnologia e Italia non hanno controllo: sono argomenti ampi.)
const CHECK = {
  energia: /\b(oil|crude|brent|wti|gas|lng|opec\+?|refiner\w*|pipelines?|power (?:prices?|grid|plant\w*|demand)|electricity|energy|fuels?|gasoline|diesel|coal|uranium|solar|wind farms?|tankers?|hormuz|petrol\w*|renewables?|energia|greggio|carburant\w*|bollett\w*)\b/i,
  materie: /\b(gold|silver|copper|platinum|palladium|nickel|zinc|alumin\w+|iron ore|steel|lithium|cobalt|rare earths?|wheat|corn|soy\w*|sugar|coffee|cocoa|cotton|cattle|commodit\w+|metals?|bullion|mining|miners?|crops?|fertili[sz]ers?|oro|argento|rame|grano|caff[eè]|cacao|materie prime|metalli)\b/i,
  crypto: /\b(bitcoin|btc|ether(?:eum)?|eth|crypto\w*|stablecoins?|blockchain|tokens?|tokeni[sz]\w*|coinbase|binance|solana|xrp|digital assets?|defi|dogecoin)\b/i,
  banche: /\b(central bank\w*|fed|federal reserve|fomc|ecb|boj|boe|snb|rba|rbi|pboc|bank of (?:england|japan|canada|korea|thailand|israel|taiwan)|reserve bank|rate (?:cut|cuts|hike|hikes|decision|path)|interest rates?|monetary|governor|policymakers?|rate-setters?|bce|banca centrale|banche centrali|tassi)\b/i,
  asia: /\b(china|chinese|japan\w*|india\w*|hong kong|hang seng|nikkei|taiwan\w*|korea\w*|singapore|asia\w*|yuan|yen|pboc|boj|thai\w*|vietnam\w*|indonesia\w*|philippine\w*|malaysia\w*|pakistan\w*|australia\w*|beijing|tokyo|shanghai|shenzhen|mumbai|sensex|nifty|kospi|cina|giappone|asia)\b/i,
  europa: /\b(euro(?:zone| area)?|european|europe|ecb|bce|germany|german|france|french|italy|italian|spain|spanish|netherlands|dutch|britain|british|u\.k\.|uk|bund|gilt|dax|cac|stoxx|ftse|brussels|eu|europa|europeo|eurozona|germania|francia)\b/i,
  geopolitica: /\b(wars?|conflicts?|sanctions?|nato|russia\w*|ukrain\w*|iran\w*|israel\w*|gaza|hamas|hezbollah|houthi\w*|hormuz|missiles?|drones?|ceasefire|truce|troops|military|invasion|nuclear (?:deal|talks|plant|incident|threat|weapon\w*)|elections?|summit|g7|g20|apec|treaty|treaties|diplomat\w*|geopolit\w*|tariffs?|trade (?:war|deal|talks|dispute)|blockade|sabotage|embargo|lebanon|syria|yemen|iraq|libya|sudan|venezuela|north korea|kremlin|pentagon|espionage|coup|protests?|guerra|sanzion\w*|tregua)\b/i,
};
const GEO_CORP = /\b(shares|stocks?|fda|ipo|earnings|therapeutics|pharma\w*|azioni)\b/i;   // "Summit shares tumble after FDA…" non è geopolitica
const RECLASS = ['geopolitica', 'banche', 'energia', 'materie', 'crypto', 'asia', 'europa'];   // dove cercare se il titolo non c'entra con la categoria della ricerca
const fits = (cat, t) => { const re = CHECK[cat]; if (!re) return true; if (!re.test(t)) return false; return cat === 'geopolitica' ? !GEO_CORP.test(t) : true; };
function reclass(it) {
  if (it.it || fits(it.cat, it.title)) return it.cat;                    // i feed italiani (categoria "italia") non si toccano
  for (const c of RECLASS) if (c !== it.cat && fits(c, it.title)) return c;
  return CHECK[it.cat] ? null : it.cat;                                  // non c'entra con nessuna categoria: via
}
// 3) La stessa notizia raccontata con altre parole (PIL giapponese −0,1%: due titoli diversi): stessa cifra + almeno due parole in comune
const nums = (t) => new Set((String(t).match(/\d[\d.,]*%?/g) || []).filter((x) => !/^(?:19|20)\d\d$/.test(x) && (x.includes('%') || x.length >= 3 || /[.,]/.test(x))));
const sameNum = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };
// 4) Un solo nome non deve invadere il feed (Nvidia compariva 8 volte): al massimo 3 notizie con lo stesso nome proprio
const MAX_PER_NAME = 3;
// 5) Asset toccati: prima tutto finiva in "Indici azionari" e "Volatilità (VIX)" (qualunque notizia con la parola "stocks"), le crypto in "Indici azionari"
const ASSETS = [
  ['Oro', /\b(gold|bullion|xau|safe[- ]haven|oro)\b/i], ['Argento', /\b(silver|xag|argento)\b/i],
  ['Petrolio', /\b(oil|crude|brent|wti|opec\w*|hormuz|refiner\w*|petrolio|greggio)\b/i], ['Gas naturale', /\b(natural gas|lng|gnl|gas prices?|ttf|henry hub)\b/i],
  ['Dollaro', /\b(dollar|dxy|greenback|dollaro)\b/i], ['Rendimenti USA', /\b(treasur\w+|10-year|2-year|jolts|hike bets?|bond yields?|yields? on)\b/i],
  ['S&P 500', /\b(s&p ?500|wall street)\b/i], ['Nasdaq', /\b(nasdaq|tech stocks?|chip ?stocks?|semiconductor stocks?)\b/i], ['Dow Jones', /\bdow(?: jones)?\b/i],
  ['Bitcoin', /\b(bitcoin|btc)\b/i], ['Ethereum', /\bether(?:eum)?\b/i], ['Volatilità (VIX)', /\b(vix|fear gauge|implied volatility)\b/i],
  ['Yen', /\b(yen|jpy|boj|ueda|giappone)\b/i], ['Cina (yuan e indici)', /\b(yuan|pboc|renminbi|china|chinese|beijing)\b/i], ['Indici asiatici', /\b(nikkei|hang seng|kospi|sensex|nifty|csi 300|shanghai composite)\b/i],
  ['Euro', /\b(ecb|bce|lagarde|eurozone|eurozona|eur\/usd|euro (?:area|zone)|single currency|valuta unica)\b/i], ['Sterlina', /\b(pound|sterling|gbp|boe|bank of england)\b/i],
];
// (le banche d'affari come Morgan Stanley o Goldman non ci sono: quando "prevedono" o "alzano un rating" sono la fonte, non l'asset toccato)
const COMPANIES = ['Nvidia', 'Apple', 'Microsoft', 'Alphabet', 'Google', 'Amazon', 'Meta', 'Tesla', 'Broadcom', 'AMD', 'Intel', 'Oracle', 'Netflix', 'Uber', 'UniCredit', 'Commerzbank', 'Intesa', 'Enel', 'Eni', 'Exxon', 'Chevron', 'Shell', 'BP', 'Salesforce', 'Palantir'];
const COMPANY_RE = new RegExp('\\b(' + COMPANIES.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b');
// 6) TIPO di notizia, dal titolo (inglese o italiano): più precisa di "notizia di economia". Si mostra solo se il titolo lo dice chiaramente.
const KINDS = [   // l'ordine conta: la prima regola che corrisponde vince (un rating non è una fusione, anche se parla di un'acquisizione)
  ['Rating o target price', /\b(upgrades?|downgrades?|price targets?|overweight|underweight|rating|migliora il rating|alza il target|tagli? (?:dei )?prezzi target|prezzi target)\b/i],
  ['Utili e risultati', /\b(earnings|quarterly results|results|revenues?|profits?|guidance|eps\b|utili|trimestrale|ricavi|bilancio)\b/i],
  ['Quotazione (IPO)', /\b(ipo|go public|goes public|listing|debut|quotazione)\b/i],
  ['Fusione o acquisizione', /\b(mergers?|acquisitions?|acquires?|acquiring|takeover|buyout|stake in|fusione|acquisizione|opa|opas)\b/i],
  ['Decisione sui tassi', /\b(rate (?:cut|cuts|hike|hikes|decision)|raises rates|cuts rates|holds rates|hikes? (?:in|at) december|policy meeting|rialz\w+ (?:dei )?tassi|taglio dei tassi)\b/i],
  ['Parole di una banca centrale', /\b(governor|vice[- ]president of the (?:ecb|fed)|ecb['’]?s \w+|boj chief|ueda|lagarde|powell|vujcic|policymaker|rate[- ]setter|capo della banca centrale|banca centrale)\b/i],
  ['Dato macro', /\b(gdp|pil|inflation|inflazione|cpi|ppi|payrolls|unemployment|disoccupazione|retail sales|industrial production|produzione industriale|pmi|trade balance|housing|consumer (?:confidence|spending|prices)|productivity|economy (?:contracts?|shrinks?|grows?|expands?|stalls?)|economia\b.*\b(?:contrae|cresce|stallo)|reddito|debito pubblico|debito sale)\b/i],
  ['Evento geopolitico', /\b(attack\w*|strikes?|missiles?|drones?|ceasefire|talks|sanctions?|sabotage|border (?:closure|clos\w+|crossing)|nato|summit|vertice|tregua|sanzion\w*|attacc\w*|petroliere|miniere|nuclear|nucleare|ukrain\w*|ucrain\w*|russia\w*)\b/i],
  ['Previsione o analisi', /\b(forecasts?|predicts?|could (?:hit|reach|touch|trigger)|outlook|expects?|sees\b|analysts?|strategists?|three questions|things to watch|week ahead|what to know|prevede|potrebbe|previsioni|cinque cose|attesa per)\b/i],
  ['Regolamentazione o legale', /\b(regulat\w+|lawsuit|sues?|antitrust|probe|investigation|approval|approves?|approved|rejects?|bans?|banned|court|fda|sec\b|autorizz\w+|approvazione)\b/i],
  ['Prodotto o tecnologia', /\b(launch\w*|unveil\w*|rolls? out|new (?:chip|model|product|feature)|partnership|robotaxi\w*|briefing)\b/i],
  ['Movimento dei prezzi', /\b(falls?|drops?|slides?|plunges?|surges?|jumps?|rall(?:y|ies)|tumbles?|slumps?|hits? (?:a )?(?:record|low|high)|lowest|highest|selloff|sell-off|crash\w*|crolla\w*|scivola\w*|minimo|massimo|crollano)\b/i],
];
const kindOf = (title, cat) => { for (const [k, re] of KINDS) if (re.test(title)) return k; return cat === 'geopolitica' ? 'Evento geopolitico' : null; };
// la società citata è il soggetto della notizia (e non un concorrente o una fonte) solo in questi tipi di notizia, oppure se compare all'inizio del titolo
const KIND_SU_TITOLO = new Set(['Utili e risultati', 'Rating o target price', 'Fusione o acquisizione', 'Quotazione (IPO)', 'Prodotto o tecnologia', 'Movimento dei prezzi', 'Previsione o analisi']);

// ---- traduzione dei titoli: Gemini se c'è la chiave, altrimenti il traduttore pubblico di Google (nessuna chiave) ----
const trCache = new Map();
async function gtx(text) {
  const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=it&dt=t&q=' + encodeURIComponent(text), { signal: AbortSignal.timeout(4500) });
  if (!r.ok) throw new Error('traduzione ' + r.status);
  const j = await r.json();
  return (j[0] || []).map((s) => s[0]).join('').trim();
}
async function translateAll(titles, budgetMs) {
  const todo = [...new Set(titles)].filter((t) => !trCache.has(t));
  if (todo.length && process.env.GEMINI_API_KEY) {
    try { const { translateTitles } = require('./translate-headlines'); const gem = await Promise.race([translateTitles(todo), new Promise((r) => setTimeout(() => r(new Map()), Math.min(3500, budgetMs)))]); gem.forEach((v, k) => trCache.set(k, v)); } catch (e) { /* si usa il traduttore pubblico */ }
  }
  const left = todo.filter((t) => !trCache.has(t));
  const t0 = Date.now(); let i = 0;
  const worker = async () => { while (i < left.length && Date.now() - t0 < budgetMs) { const t = left[i++]; try { const it = await gtx(t); if (it) trCache.set(t, it); } catch (e) { /* resta l'originale */ } } };
  await Promise.all(Array.from({ length: 8 }, worker));
  if (trCache.size > 2500) trCache.clear();
  return trCache;
}

let _cache = null;
async function buildFeed({ perCat = 6, total = 66 } = {}) {
  if (_cache && Date.now() - _cache.at < 8 * 60 * 1000) return _cache.out;
  const t0 = Date.now(), now = Date.now();
  const results = await Promise.all(FEEDS.map(async ([cat, source, url, opts]) => (await fetchRss([source, url, { general: false }])).map((it) => ({ ...it, cat, it: !!(opts && opts.it), source: it.source || source }))));
  let all = results.flat().filter((it) => it.title && it.url && !/[؀-ۿ]/.test(it.source || ''));
  // solo le ultime 30 ore; via il rumore (sport, gossip, notizie che non parlano di economia)
  all = all.filter((it) => { const ms = new Date(it.published).getTime(); return now - ms < 30 * 3600e3 && ms < now + 3600e3; });
  all = all.filter((it) => !JUNK.test(it.title) && !JUNK2.test(it.title) && (DIRECT.test(it.source || '') || (ALLOW.test(it.source || '') && MONEY.test(it.title))));
  all = all.map((it) => ({ ...it, cat: reclass(it) })).filter((it) => it.cat);   // il titolo deve parlare della categoria; se parla d'altro cambia categoria, se non c'entra con nessuna si scarta
  const scored = all.map((it) => ({ it, imp: impact(it, now) })).filter((x) => x.imp.rawScore > -5);
  // la stessa storia da più testate si tiene una volta (la più recente): titoli molto simili, oppure lo stesso nome proprio (azienda, persona) nella stessa categoria con altre parole in comune
  scored.sort((a, b) => (a.it.published < b.it.published ? 1 : -1));
  const kept = [], perName = new Map();
  for (const x of scored) {
    const tk = tokens(x.it.title), nm = names(x.it.title), nu = nums(x.it.title), key = x.it.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 70);
    const dup = kept.some((k) => k.key === key || similar(k.tk, tk) || (k.it.cat === x.it.cat && [...nm].some((n) => k.nm.has(n)) && overlap(k.tk, tk) >= 2) || (sameNum(k.nu, nu) && overlap(k.tk, tk) >= 2));
    if (dup) continue;
    if ([...nm].some((n) => (perName.get(n) || 0) >= MAX_PER_NAME)) continue;   // lo stesso nome (es. Nvidia) al massimo 3 volte
    nm.forEach((n) => perName.set(n, (perName.get(n) || 0) + 1));
    kept.push({ ...x, tk, nm, nu, key });
  }
  // per categoria al massimo perCat notizie (le più recenti), poi tutte in ordine di data: ogni tema compare, nessuno invade
  const byCat = {}; for (const k of kept) (byCat[k.it.cat] = byCat[k.it.cat] || []).push(k);
  const picked = []; CATS.forEach(([c]) => { (byCat[c] || []).slice(0, perCat).forEach((k) => picked.push(k)); });
  picked.sort((a, b) => (a.it.published < b.it.published ? 1 : -1));
  const head = picked.slice(0, total);
  const trs = await translateAll(head.filter((k) => !k.it.it).map((k) => k.it.title), Math.max(1500, 8200 - (Date.now() - t0)));
  const items = head.map(({ it, imp }) => {
    const lvl = level(imp.score), text = `${it.title} ${it.summary || ''}`;
    // asset toccati, in ordine di precisione: il titolo dell'azienda citata, poi gli asset di cui parla davvero il testo (titolo + inizio del riassunto)
    const kind = kindOf(it.title, it.cat), co = COMPANY_RE.exec(it.title), shortText = `${it.title} ${String(it.summary || '').slice(0, 200)}`, assets = [];
    if (co && (KIND_SU_TITOLO.has(kind) || co.index < 25)) assets.push(co[1] + ' (titolo)');
    for (const [label, re] of ASSETS) if (re.test(shortText) && !assets.includes(label)) assets.push(label);
    if (it.cat === 'crypto') { if (!assets.some((a) => /Bitcoin|Ethereum/.test(a))) assets.unshift('Crypto'); assets.sort((a, b) => (/Bitcoin|Ethereum|Crypto/.test(b) ? 1 : 0) - (/Bitcoin|Ethereum|Crypto/.test(a) ? 1 : 0)); }   // nelle crypto vengono prima gli asset crypto
    assets.splice(4);
    const out = { cat: it.cat, kind, title: it.title, titleIt: it.it ? it.title : (trs.get(it.title) || null), source: it.source, url: it.url, published: it.published, level: lvl };
    const reads = imp.tags.filter((t) => READ[t]).slice(0, 2), cr = CAT_READ[it.cat];
    out.moves = {
      assets: assets.length ? assets : (cr ? [cr[0]] : []),
      all: SYSTEMIC.test(it.title) && lvl !== 'BASSO',
      read: reads.length ? reads.map((t) => READ[t]) : (cr ? [cr[1]] : []),
      tags: imp.tags,
    };
    return out;
  });
  const complete = items.every((i) => i.titleIt);
  const out = { generatedAt: new Date().toISOString(), cats: CATS.map(([id, label]) => ({ id, label, n: items.filter((i) => i.cat === id).length })), complete, items };
  _cache = { at: complete ? Date.now() : Date.now() - 6.5 * 60 * 1000, out };   // titoli non tradotti: si riprova dopo 1,5 minuti
  return out;
}

module.exports = { buildFeed, CATS, translateAll };
