// netlify/functions/lib/news.js
//
// Aggregazione notizie reali: 12 feed RSS pubblici (nessuna chiave richiesta) + Finnhub
// come fonte extra opzionale se FINNHUB_KEY è configurata. Porting in Node, senza
// dipendenze npm, della logica di news_sources.py (progetto di riferimento macrohub3):
// stesso elenco di feed, stesso dedup per titolo normalizzato, stesso filtro anti-wire-release
// non latino, stesso ordinamento per data decrescente.
//
// Condiviso da news-aggregated.js, sentiment-categories.js, bias-daily.js ed event-dossier.js.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const RSS_FEEDS = [
  ['Investing.com', 'https://www.investing.com/rss/news_285.rss'],  // Economic indicators
  ['Investing.com', 'https://www.investing.com/rss/news_14.rss'],   // Economy news
  ['Investing.com', 'https://www.investing.com/rss/news_1.rss'],    // Forex news
  ['Yahoo Finance', 'https://finance.yahoo.com/news/rssindex'],
  ['WSJ Markets', 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml'],
  ['CNBC', 'https://www.cnbc.com/id/100003114/device/rss/rss.html'],
  ['Federal Reserve', 'https://www.federalreserve.gov/feeds/press_all.xml'],
  ['FXStreet', 'https://news.google.com/rss/search?q=site:fxstreet.com+when:2d&hl=en-US&gl=US&ceid=US:en'],
  ['ForexLive', 'https://news.google.com/rss/search?q=site:forexlive.com+OR+site:investinglive.com+when:2d&hl=en-US&gl=US&ceid=US:en'],
  ['Google News', 'https://news.google.com/rss/search?q=(federal+reserve+OR+FOMC+OR+ECB+rates)+when:2d&hl=en-US&gl=US&ceid=US:en'],
  ['Google News', 'https://news.google.com/rss/search?q=(geopolitics+OR+sanctions+OR+conflict)+markets+oil+when:2d&hl=en-US&gl=US&ceid=US:en'],
  ['Google News', 'https://news.google.com/rss/search?q=(dollar+index+OR+DXY+OR+gold+price)+when:2d&hl=en-US&gl=US&ceid=US:en'],
];

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
    let link = tagValue(block, 'link').trim();
    if (!link) {
      const m = block.match(/<link[^>]*href="([^"]+)"/i);
      if (m) link = m[1];
    }
    const desc = tagValue(block, 'description') || tagValue(block, 'summary') || tagValue(block, 'content:encoded') || tagValue(block, 'content');
    const pub = tagValue(block, 'pubDate') || tagValue(block, 'published') || tagValue(block, 'updated');
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

async function fetchRss([source, url]) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,application/xml,*/*' } });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseFeed(xml).slice(0, 25).map(it => {
      // I titoli Google News finiscono con " - NomeFonte"
      if (url.includes('news.google.com')) {
        const idx = it.title.lastIndexOf(' - ');
        if (idx > 0) {
          return { ...it, source: it.title.slice(idx + 3).trim() || source, title: it.title.slice(0, idx) };
        }
      }
      return { ...it, source };
    });
  } catch (e) {
    return [];
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

let _cache = null; // { at: number, items: [] } — condivisa tra invocazioni sulla stessa istanza Lambda "calda"

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

module.exports = { aggregateNews, RSS_FEEDS };
