// lib/news.js
//
// Aggregazione notizie reali: 12 feed RSS pubblici (nessuna chiave richiesta) + Finnhub
// come fonte extra opzionale se FINNHUB_KEY è configurata. Porting in Node, senza
// dipendenze npm, della logica di news_sources.py (progetto di riferimento macrohub3):
// stesso elenco di feed, stesso dedup per titolo normalizzato, stesso filtro anti-wire-release
// non latino, stesso ordinamento per data decrescente.
//
// Condiviso da news-aggregated.js, sentiment-categories.js, bias-daily.js, event-dossier.js
// e market-intelligence.js in /api.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const RSS_FEEDS = [
  ['Investing.com', 'https://www.investing.com/rss/news_285.rss'],  // Economic indicators
  ['Investing.com', 'https://www.investing.com/rss/news_14.rss'],   // Economy news
  ['Investing.com', 'https://www.investing.com/rss/news_1.rss'],    // Forex news
  ['WSJ Markets', 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml'],
  ['CNBC', 'https://www.cnbc.com/id/100003114/device/rss/rss.html'],
  ['Federal Reserve', 'https://www.federalreserve.gov/feeds/press_all.xml'],
  ['FXStreet', 'https://news.google.com/rss/search?q=site:fxstreet.com+when:2d&hl=en-US&gl=US&ceid=US:en'],
  ['ForexLive', 'https://news.google.com/rss/search?q=site:forexlive.com+OR+site:investinglive.com+when:2d&hl=en-US&gl=US&ceid=US:en'],
  ['Google News', 'https://news.google.com/rss/search?q=(federal+reserve+OR+FOMC+OR+ECB+rates)+when:2d&hl=en-US&gl=US&ceid=US:en'],
  ['Google News', 'https://news.google.com/rss/search?q=(geopolitics+OR+sanctions+OR+conflict)+markets+oil+when:2d&hl=en-US&gl=US&ceid=US:en'],
  ['Google News', 'https://news.google.com/rss/search?q=(dollar+index+OR+DXY+OR+gold+price)+when:2d&hl=en-US&gl=US&ceid=US:en'],
  // Notizie che muovono tutti i mercati, cercate apposta (il feed Yahoo Finance qui sopra rispondeva 404 ed è stato tolto):
  // minacce e attacchi militari, dichiarazioni di Trump, petrolio, sessione asiatica.
  ['Google News', 'https://news.google.com/rss/search?q=Iran+Trump+(strike+OR+attack+OR+talks+OR+threat)+when:1d&hl=en-US&gl=US&ceid=US:en'],
  ['Google News', 'https://news.google.com/rss/search?q=(Trump+OR+White+House)+(tariffs+OR+sanctions+OR+Fed+OR+dollar)+when:1d&hl=en-US&gl=US&ceid=US:en'],
  ['Google News', 'https://news.google.com/rss/search?q=(oil+prices+OR+Brent+OR+WTI+OR+OPEC)+when:1d&hl=en-US&gl=US&ceid=US:en'],
  ['Google News', 'https://news.google.com/rss/search?q=(Asian+markets+OR+Nikkei+OR+Hang+Seng+OR+yen+OR+yuan)+when:1d&hl=en-US&gl=US&ceid=US:en'],
  // Fonti dirette: Google News ogni tanto risponde 503 agli IP dei server (e in quel caso sparivano le notizie più rapide); questi feed non dipendono da lui.
  ['Bloomberg', 'https://feeds.bloomberg.com/markets/news.rss', { general: true }],
  ['Bloomberg', 'https://feeds.bloomberg.com/politics/news.rss', { general: true }],
  ['MarketWatch', 'https://feeds.content.dowjones.io/public/rss/mw_topstories', { general: true }],
  ['NYT Business', 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', { general: true }],
  ['NYT World', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', { general: true }],
  ['The Guardian', 'https://www.theguardian.com/business/rss', { general: true }],
  ['The Guardian', 'https://www.theguardian.com/world/rss', { general: true }],
  ['Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml', { general: true }],
  ['BBC Business', 'https://feeds.bbci.co.uk/news/business/rss.xml', { general: true }],
  ['OilPrice.com', 'https://oilprice.com/rss/main', { general: true }],
];

// notizie generali (guerre, politica): si tengono solo quelle che possono muovere i mercati
const MARKET_RE = /\b(markets?|stocks?|shares|equit(?:y|ies)|econom(?:y|ic|ics)|inflation|rates?|fed|federal reserve|ecb|central bank|bank of|oil|crude|brent|opec|gas|gold|silver|dollar|euro|yen|yuan|currenc(?:y|ies)|bonds?|yields?|treasur(?:y|ies)|tariffs?|trade|sanctions?|iran|israel|hormuz|gulf|ukraine|russia|china|taiwan|trump|white house|war|strikes?|attacks?|missiles?|ceasefire|nato|recession|jobs|unemployment|gdp|budget|debt|shutdown|bitcoin|crypto|energy|supply)\b/i;

function decodeEntities(str) {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function stripTags(str) {
  return decodeEntities(String(str || '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tagValue(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : '';
}

// Parser XML minimale (no dipendenze): copre RSS 2.0 e Atom, sufficiente per feed editoriali reali.
function parseFeed(xml) {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const itemTag = isAtom ? 'entry' : 'item';
  const blocks = xml.match(new RegExp(`<${itemTag}[\\s>][\\s\\S]*?</${itemTag}>`, 'gi')) || [];
  const items = [];
  for (const block of blocks) {
    const title = stripTags(tagValue(block, 'title'));
    if (!title) continue;
    let link = decodeEntities(tagValue(block, 'link')).trim();
    if (!link) {
      const m = block.match(/<link[^>]*href="([^"]+)"/i);
      if (m) link = m[1];
    }
    const desc = tagValue(block, 'description') || tagValue(block, 'summary') || tagValue(block, 'content:encoded') || tagValue(block, 'content');
    // pubDate va decodificato da eventuale CDATA (es. feed Federal Reserve: <pubDate><![CDATA[...]]></pubDate>) —
    // altrimenti new Date() riceve la stringa letterale con i marcatori CDATA, fallisce silenziosamente,
    // e l'item finisce con published="adesso" invece della sua vera data, scavalcando tutte le altre fonti.
    const pub = decodeEntities(tagValue(block, 'pubDate') || tagValue(block, 'published') || tagValue(block, 'updated')).trim();
    const d = pub ? new Date(pub) : null;
    items.push({
      title: title.slice(0, 220),
      summary: stripTags(desc).slice(0, 400),
      url: link,
      published: d && !isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString(),
    });
  }
  return items;
}

const _feedCache = new Map();   // url → { at, items }: l'ultima risposta buona di ogni feed, usata se alla prossima richiesta il feed non risponde
const STALE_MS = 3 * 3600e3;
async function fetchRss([source, url, opts]) {
  const stale = () => { const c = _feedCache.get(url); return c && Date.now() - c.at < STALE_MS ? c.items : []; };
  try {
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,application/xml,*/*' }, signal: AbortSignal.timeout(8000) });
      if (res.ok || (res.status !== 429 && res.status < 500)) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (!res.ok) return stale();
    const xml = await res.text();
    const fresh = parseFeed(xml).slice(0, 40).filter(it => !(opts && opts.general) || MARKET_RE.test(it.title)).map(it => {
      // I titoli Google News finiscono con " - NomeFonte"
      if (url.includes('news.google.com')) {
        const idx = it.title.lastIndexOf(' - ');
        if (idx > 0) {
          return { ...it, source: it.title.slice(idx + 3).trim() || source, title: it.title.slice(0, idx) };
        }
      }
      return { ...it, source };
    });
    if (fresh.length) _feedCache.set(url, { at: Date.now(), items: fresh });
    return fresh.length ? fresh : stale();
  } catch (e) {
    return stale();
  }
}

// Versione diagnostica di fetchRss: non silenzia l'errore, riporta status HTTP/eccezione per capire
// PERCHÉ un feed non restituisce nulla (es. blocco anti-bot su IP datacenter, 403/429, timeout).
// Usata solo da news-aggregated.js con ?debug=1 — il percorso normale resta fetchRss (silenzioso).
async function fetchRssWithDiag([source, url]) {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,application/xml,*/*' } });
    const ms = Date.now() - started;
    if (!res.ok) return { source, url, ok: false, status: res.status, itemCount: 0, ms };
    const xml = await res.text();
    const items = parseFeed(xml);
    return { source, url, ok: true, status: res.status, itemCount: items.length, ms, sampleTitle: items[0]?.title || null };
  } catch (e) {
    return { source, url, ok: false, status: null, itemCount: 0, ms: Date.now() - started, error: e.message };
  }
}

async function fetchFinnhub(category, apiKey) {
  try {
    const res = await fetch(`https://finnhub.io/api/v1/news?category=${encodeURIComponent(category)}&token=${apiKey}`);
    if (!res.ok) return [];
    const arr = await res.json();
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, 60).map(it => ({
      title: stripTags(it.headline).slice(0, 220),
      summary: stripTags(it.summary).slice(0, 400),
      source: it.source || 'Finnhub',
      url: it.url || '',
      published: it.datetime ? new Date(it.datetime * 1000).toISOString() : new Date().toISOString(),
    })).filter(i => i.title);
  } catch (e) {
    return [];
  }
}

let _cache = null; // { at: number, items: [] } — condivisa tra invocazioni sulla stessa istanza "calda"

async function aggregateNews(limit = 40) {
  const now = Date.now();
  if (_cache && now - _cache.at < 10 * 60 * 1000) return _cache.items.slice(0, limit);

  const finnhubKey = process.env.FINNHUB_KEY;
  const tasks = RSS_FEEDS.map(fetchRss);
  if (finnhubKey) tasks.push(...['general', 'forex', 'merger'].map(c => fetchFinnhub(c, finnhubKey)));

  const results = await Promise.all(tasks);
  const all = results.flat();

  const seen = new Set();
  const dedup = [];
  for (const it of all) {
    const asciiRatio = [...it.title].filter(ch => ch.charCodeAt(0) < 128).length / Math.max(1, it.title.length);
    if (asciiRatio < 0.7) continue; // scarta wire release non latine
    const k = it.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 70);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    dedup.push(it);
  }
  dedup.sort((a, b) => (a.published < b.published ? 1 : a.published > b.published ? -1 : 0));

  _cache = { at: now, items: dedup };
  return dedup.slice(0, limit);
}

module.exports = { aggregateNews, RSS_FEEDS, fetchRssWithDiag };
