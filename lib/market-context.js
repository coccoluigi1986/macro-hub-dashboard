// lib/market-context.js
//
// Contesto di mercato CONDIVISO da tutte le analisi AI della dashboard. Prima ogni funzione (bias, geopolitica,
// cruscotto asset, driver, sentiment) leggeva da sola le ultime ~30 notizie in ordine di data — in pratica le
// ultime 2 ore, piene di rumore aziendale — e dei prezzi vedeva solo la variazione di giornata. Risultato: la
// notizia della notte (es. gli attacchi americani in Iran) usciva dalla finestra prima che qualcuno la collegasse
// al movimento dell'oro in sessione asiatica, e ogni sezione raccontava una storia diversa.
//
// Qui si costruiscono, UNA volta e con dati veri:
//  1. le notizie ordinate per IMPATTO (lib/news-impact.js), non solo per data, su una finestra di 30 ore;
//  2. i MOVIMENTI REALI degli asset (candele a 15 minuti di Yahoo): variazione per sessione (Asia / Europa / USA, ora
//     italiana) e le accelerazioni anomale rispetto alla normalità dell'asset;
//  3. l'ABBINAMENTO movimento ↔ notizie uscite nelle ore del movimento (concomitanza, non causalità certa).
// Nulla è scritto a mano: se Yahoo o i feed non rispondono, i blocchi restano vuoti e l'AI lo vede.

const { aggregateNews } = require('./news');
const { impact, level, ASSET_TOPICS, SYSTEMIC } = require('./news-impact');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TZ = 'Europe/Rome';

const WATCH = [
  { key: 'oro', name: 'Oro', sym: 'GC=F', dec: 1 }, { key: 'argento', name: 'Argento', sym: 'SI=F', dec: 2 },
  { key: 'petrolio', name: 'Petrolio WTI', sym: 'CL=F', dec: 2 }, { key: 'dollaro', name: 'Dollaro (DXY)', sym: 'DX-Y.NYB', dec: 2 },
  { key: 'euro', name: 'EUR/USD', sym: 'EURUSD=X', dec: 4 }, { key: 'sterlina', name: 'GBP/USD', sym: 'GBPUSD=X', dec: 4 },
  { key: 'yen', name: 'USD/JPY', sym: 'JPY=X', dec: 2 },
  { key: 'indici', name: 'S&P 500 (future)', sym: 'ES=F', dec: 1 }, { key: 'indici', name: 'Nasdaq 100 (future)', sym: 'NQ=F', dec: 1 },
  { key: 'vix', name: 'VIX', sym: '^VIX', dec: 2 }, { key: 'rendimenti', name: 'Rendimento US 10Y', sym: '^TNX', dec: 3 },
];

// ---------- tempo (ora italiana) ----------
const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function romeParts(ms) { const o = {}; fmt.formatToParts(new Date(ms)).forEach((p) => { o[p.type] = p.value; }); return { date: `${o.year}-${o.month}-${o.day}`, h: parseInt(o.hour, 10), m: parseInt(o.minute, 10) }; }
const hhmm = (ms) => { const p = romeParts(ms); return `${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}`; };
const dowFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' });
const DOWMAP = { Sun: 'dom', Mon: 'lun', Tue: 'mar', Wed: 'mer', Thu: 'gio', Fri: 'ven', Sat: 'sab' };
const dayName = (ms) => DOWMAP[dowFmt.format(new Date(ms))];
// sessione in ora italiana: Asia dall'1:00, Europa dalle 9:00, USA dalle 15:30
function sessionOf(ms) { const { h, m } = romeParts(ms); const x = h + m / 60; return x >= 1 && x < 9 ? 'Asia' : x >= 9 && x < 15.5 ? 'Europa' : x >= 15.5 && x < 22 ? 'USA' : 'Notte'; }
const when = (ms) => `${dayName(ms)} ${hhmm(ms)}`;

// ---------- 2. movimenti degli asset ----------
async function fetchBars(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=15m`;
  let res;
  for (let i = 0; i < 2; i++) { res = await fetch(url, { headers: { 'User-Agent': UA } }); if (res.status !== 429 && res.status < 500) break; await new Promise((r) => setTimeout(r, 600)); }
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const j = await res.json(); const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) throw new Error('nessun dato');
  const q = r.indicators.quote[0]; const bars = [];
  r.timestamp.forEach((t, i) => { if (q.close[i] != null && q.high[i] != null && q.low[i] != null) bars.push({ t: t * 1000, o: q.open[i] != null ? q.open[i] : q.close[i], h: q.high[i], l: q.low[i], c: q.close[i] }); });
  return bars;
}

// Accelerazioni anomale: finestre mobili di 1, 2 e 4 ore; si confronta lo spostamento con quello tipico (mediana) dell'asset
// nelle stesse finestre dei giorni precedenti. Ritorna gli eventi migliori delle ultime 24 ore, senza sovrapposizioni.
function detectBursts(bars) {
  const out = [], cand = [];
  if (!bars.length) return out;
  const since = bars[bars.length - 1].t - 24 * 3600e3;
  for (const span of [4, 8, 16]) {                  // 1h, 2h, 4h di candele a 15 minuti
    const moves = [];
    for (let i = 0; i + span < bars.length; i++) {
      const a = bars[i], b = bars[i + span];
      if (b.t - a.t > (span + 2) * 15 * 60e3) continue;   // buco di mercato chiuso: non è un movimento
      moves.push({ from: a.o, to: b.c, t0: a.t, t1: b.t, pct: (b.c / a.o - 1) * 100 });
    }
    if (moves.length < 30) continue;
    const abs = moves.map((m) => Math.abs(m.pct)).sort((x, y) => x - y);
    const med = abs[Math.floor(abs.length * 0.5)] || 1e-6, p90 = abs[Math.floor(abs.length * 0.9)] || 1e-6;
    for (const m of moves) if (m.t1 >= since) cand.push({ ...m, ratio: Math.abs(m.pct) / med, p90ratio: Math.abs(m.pct) / p90 });
  }
  // "anomalo" = molto sopra il tipico (≥3,2× la mediana e sopra il 90° percentile)
  cand.filter((c) => c.ratio >= 3.2 && c.p90ratio >= 1.15).sort((a, b) => Math.abs(b.pct) * b.ratio - Math.abs(a.pct) * a.ratio).forEach((c) => {
    if (!out.some((o) => c.t0 < o.t1 && c.t1 > o.t0)) out.push(c);
  });
  return out.slice(0, 3);
}

// Sessioni (Asia / Europa / USA, ora italiana) degli ultimi giorni, con variazione e "quanto è insolita" rispetto alle altre sessioni dell'asset
function sessionMoves(bars, nowMs) {
  const all = []; let cur = null;
  for (const b of bars) {
    const ses = sessionOf(b.t); if (ses === 'Notte') continue;
    const key = `${romeParts(b.t).date}|${ses}`;
    if (!cur || cur.key !== key) { cur = { key, ses, o: b.o, c: b.c, t0: b.t, t1: b.t }; all.push(cur); }
    else { cur.c = b.c; cur.t1 = b.t; }
  }
  const full = all.filter((s) => s.t1 - s.t0 >= 45 * 60e3).map((s) => ({ ses: s.ses, from: s.o, to: s.c, pct: (s.c / s.o - 1) * 100, t0: s.t0, t1: s.t1, live: s.t1 >= nowMs - 20 * 60e3 }));
  const abs = full.map((s) => Math.abs(s.pct)).sort((x, y) => x - y);
  const med = abs.length ? (abs[Math.floor(abs.length / 2)] || 1e-6) : 1e-6;
  return full.filter((s) => s.t1 >= nowMs - 30 * 3600e3).slice(-4).map((s) => ({ ...s, ratio: Math.abs(s.pct) / med }));
}

// ---------- 3. abbinamento ----------
// Notizie (non di basso impatto) uscite nelle ore del movimento, più pertinenti all'asset: da `lookH` ore prima dell'inizio a 30 minuti dopo la fine.
// `reps` = notizie già raggruppate per storia (vedi clusterNews): una storia conta se UNA delle sue uscite cade nella finestra.
function matchNews(ev, assetKey, reps, lookH = 2.5, max = 3) {
  const lo = ev.t0 - lookH * 3600e3, hi = ev.t1 + 30 * 60e3, topic = ASSET_TOPICS[assetKey];
  const out = [];
  for (const r of reps) {
    // della storia si prende l'articolo uscito DENTRO la finestra (il migliore, se più di uno): l'orario mostrato è quello reale
    const inWin = r.members.filter((m) => { const t = new Date(m.published).getTime(); return t >= lo && t <= hi; });
    if (!inWin.length) continue;
    const m = inWin.sort((a, b) => b.score - a.score)[0];
    const rank = m.score + ((topic && topic.test(`${m.title} ${m.summary || ''}`) ? 2 : 0) + (SYSTEMIC.test(m.title) ? 1.5 : 0)) * 2;
    if (m.level !== 'BASSO' && rank >= 7) out.push({ n: { ...m, dups: r.dups, first: r.first }, rank });
  }
  return out.sort((a, b) => b.rank - a.rank).slice(0, max).map((x) => x.n).sort((a, b) => new Date(a.published) - new Date(b.published));
}

// Raggruppa le notizie che raccontano la stessa storia (titoli con molte parole in comune, es. dieci testate che titolano "il petrolio
// sale dopo l'attacco a Qeshm"): resta la più rilevante, con il numero di fonti e l'orario della prima uscita. Libera spazio per altri temi.
const STOP = new Set(['after', 'amid', 'over', 'into', 'says', 'said', 'will', 'than', 'more', 'with', 'from', 'that', 'this', 'what', 'were', 'have', 'been', 'could', 'would', 'their', 'about', 'ahead', 'as']);
const tokens = (t) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));
const jaccard = (a, b) => { let i = 0; a.forEach((x) => { if (b.has(x)) i++; }); return i / ((a.size + b.size - i) || 1); };
function clusterNews(sortedByScore) {
  const reps = [];
  for (const n of sortedByScore) {
    const tk = tokens(n.title), t = new Date(n.published).getTime();
    const hit = reps.find((r) => jaccard(r.tk, tk) >= 0.35);
    if (hit) { hit.dups++; hit.members.push(n); hit.first = Math.min(hit.first, t); continue; }
    reps.push({ ...n, tk, dups: 0, members: [n], first: t });
  }
  return reps;
}

const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2).replace('.', ',')}%`;
const num = (v, d) => v.toFixed(d).replace('.', ',');
async function inBatches(items, n, fn) { const out = []; for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(fn))); return out; }

// Costruzione. `nowMs` e `fetchBarsFn`/`newsFn` iniettabili per i test.
async function buildContext({ nowMs = Date.now(), newsFn = () => aggregateNews(700), barsFn = fetchBars, newsLimit = 34 } = {}) {
  const [allNews, series] = await Promise.all([
    Promise.resolve().then(newsFn).catch(() => []),
    inBatches(WATCH, WATCH.length, async (w) => { try { return { w, bars: await barsFn(w.sym) }; } catch (e) { return { w, bars: [], error: e.message }; } }),
  ]);
  const fresh = allNews.filter((n) => { const a = nowMs - new Date(n.published).getTime(); return a >= -600e3 && a <= 30 * 3600e3; });
  const ranked = fresh.map((n) => { const im = impact(n, nowMs); return { ...n, score: im.score, tags: im.tags, level: level(im.score), ageH: im.ageH }; });
  const reps = clusterNews(ranked.filter((n) => n.level !== 'BASSO').sort((a, b) => b.score - a.score));
  // Il 70% dei posti va alle storie più forti; il resto a quelle NON geopolitiche (banche centrali, dati, aziende, mercati), così un giorno
  // dominato da un solo tema non toglie all'AI tutto il resto.
  const geo = (n) => n.tags.includes('geopolitica') || n.tags.includes('scenario geopolitico');
  const head = reps.slice(0, Math.round(newsLimit * 0.7));
  const top = [...head, ...reps.slice(head.length).filter((n) => !geo(n)).slice(0, newsLimit - head.length)];

  const moves = [], events = [];
  for (const { w, bars, error } of series) {
    if (error || bars.length < 40) { moves.push({ ...w, error: error || 'dati insufficienti' }); continue; }
    const last = bars[bars.length - 1];
    const bursts = detectBursts(bars).map((b) => ({ ...b, news: matchNews(b, w.key, reps, 2.5, 3) }));
    const sessions = sessionMoves(bars, nowMs).map((s) => {
      const notable = s.ratio >= 1.7 && Math.abs(s.pct) >= (w.key === 'vix' ? 3 : 0.2);
      return { ...s, notable, news: notable ? matchNews(s, w.key, reps, 4, 4) : [] };
    });
    const day = bars.filter((b) => b.t >= last.t - 24 * 3600e3);
    const m = { ...w, price: last.c, at: last.t, from24: day.length ? day[0].o : null, change24h: day.length ? (last.c / day[0].o - 1) * 100 : null, bursts, sessions };
    moves.push(m);
    for (const s of sessions) if (s.notable) events.push({ key: w.key, name: w.name, dec: w.dec, kind: 'sessione', ses: s.ses, t0: s.t0, t1: s.t1, pct: s.pct, from: s.from, to: s.to, ratio: s.ratio, live: s.live, news: s.news });
    for (const b of bursts) events.push({ key: w.key, name: w.name, dec: w.dec, kind: 'accelerazione', ses: sessionOf((b.t0 + b.t1) / 2), t0: b.t0, t1: b.t1, pct: b.pct, from: b.from, to: b.to, ratio: b.ratio, live: false, news: b.news });
  }
  events.sort((a, b) => b.t1 - a.t1);
  // Elenco unico delle notizie citate: le migliori per impatto + quelle abbinate ai movimenti, ciascuna con un numero (N1, N2…) che i
  // movimenti richiamano: così il prompt non ripete i titoli decine di volte.
  const pool = new Map();
  top.forEach((n) => pool.set(n.title, n));
  events.forEach((e) => e.news.forEach((n) => pool.set(n.title, n)));
  const list = [...pool.values()].sort((a, b) => new Date(b.published) - new Date(a.published));
  const ids = new Map(list.map((n, i) => [n.title, `N${i + 1}`]));
  const ctx = { at: nowMs, ranked, top, moves, events, list, ids };
  ctx.text = renderText(ctx);
  return ctx;
}

let _cache = null;
async function getMarketContext(opts) {
  const nowMs = Date.now();
  if (!opts && _cache && nowMs - _cache.at < 5 * 60e3) return _cache.ctx;
  const ctx = await buildContext(opts || {});
  if (!opts) _cache = { at: nowMs, ctx };
  return ctx;
}

// ---------- testo per i prompt ----------
const tm = (n) => `${when(new Date(n.published).getTime())}`;
function renderNews(list, ids) {
  return list.map((x) => {
    const sum = x.summary && x.summary.length > 30 && !x.summary.toLowerCase().startsWith(x.title.toLowerCase().slice(0, 40)) ? ` — ${x.summary.slice(0, 130)}` : '';
    const dup = x.dups ? ` (stessa storia ripresa da altre ${x.dups} fonti, prima uscita ${when(x.first)})` : '';
    return `${ids.get(x.title)}. [${x.level}${x.tags.length ? ' · ' + x.tags.join('/') : ''}] [${x.source} ${tm(x)} Roma] ${x.title}${sum}${dup}`;
  }).join('\n');
}
// Il rendimento è già un percentuale: la sua variazione si esprime in punti base (pb), altrimenti "+0,86%" si legge come livello del rendimento.
const chg = (m, p, from, to) => { if (m.key !== 'rendimenti') return pct(p); const bp = Math.round((to - from) * 100); return `${bp > 0 ? '+' : bp < 0 ? '−' : ''}${Math.abs(bp)} pb`; };
function renderMoves(moves, ids) {
  const L = [], ref = (arr) => arr.map((n) => `${ids.get(n.title)} (${tm(n)})`).join(', ');
  for (const m of moves) {
    if (m.error) continue;
    const unit = m.key === 'rendimenti' ? '%' : '';
    const parts = m.sessions.map((s) => `${s.ses}${s.live ? ' (in corso)' : ''} ${when(s.t0)}–${hhmm(s.t1)}: ${chg(m, s.pct, s.from, s.to)} (da ${num(s.from, m.dec)}${unit} a ${num(s.to, m.dec)}${unit})${s.notable ? ' ◂ INSOLITO' : ''}`);
    L.push(`- ${m.name}: ora ${num(m.price, m.dec)}${unit}, ultime 24h ${m.change24h != null ? chg(m, m.change24h, m.from24, m.price) : 'n.d.'}${m.key === 'rendimenti' ? ' (livello del rendimento in %, variazioni in punti base)' : ''}. Per sessione (ora Roma): ${parts.join(' | ') || 'n.d.'}`);
    for (const s of m.sessions) if (s.notable) L.push(`    ▸ ${s.ses} ${when(s.t0)}–${hhmm(s.t1)} ${chg(m, s.pct, s.from, s.to)} (${s.ratio.toFixed(1).replace('.', ',')}× il tipico) — notizie concomitanti: ${s.news.length ? ref(s.news) : 'nessuna chiara nel flusso (movimento di flussi/posizionamento)'}`);
    for (const b of m.bursts) {
      const hrs = (b.t1 - b.t0) / 3600e3;
      L.push(`    ▸ ACCELERAZIONE ANOMALA ${chg(m, b.pct, b.from, b.to)} in ${hrs.toFixed(hrs % 1 ? 1 : 0).replace('.', ',')}h (${when(b.t0)}–${hhmm(b.t1)} Roma, ${b.ratio.toFixed(1).replace('.', ',')}× il tipico) — notizie concomitanti: ${b.news.length ? ref(b.news) : 'nessuna chiara nel flusso (movimento di flussi/posizionamento)'}`);
    }
  }
  return L.join('\n');
}
function renderText({ list, ids, moves }) {
  return {
    news: renderNews(list, ids),
    moves: renderMoves(moves, ids) + '\n(N1, N2… rimandano all\'elenco delle notizie: citane il contenuto e l\'orario, non il numero)',
    rules: 'REGOLE DI COERENZA (valgono per tutta l\'analisi):\n'
      + '1) Le notizie marcate ALTO (attacchi e minacce militari, dichiarazioni di Trump o di altri leader, banche centrali, dazi, dati a sorpresa) muovono TUTTI i mercati: per ciascuna indica come ha agito su petrolio, oro/argento, dollaro, rendimenti, indici, VIX e valute, SOLO sulla base dei movimenti reali forniti.\n'
      + '2) Collega ogni movimento INSOLITO o ANOMALO alla notizia uscita in quelle ore, citando orario (ora Roma) e sessione (Asia/Europa/USA). Se non c\'è una notizia concomitante dì che è un movimento di flussi/posizionamento: non inventare una causa.\n'
      + '3) La direzione di ogni asset deve essere coerente con il movimento reale e con la notizia dominante: se un asset scende nonostante una notizia di norma rialzista per lui (es. oro che cala con la tensione geopolitica perché dollaro o rendimenti salgono), SPIEGALO invece di scrivere la narrativa da manuale.\n'
      + '4) Le sezioni devono raccontare la stessa storia: stessa notizia dominante, stessi movimenti, nessuna contraddizione sulla direzione di petrolio, oro, dollaro, indici.\n'
      + '5) Per ogni notizia citata scrivi sempre quando è uscita (giorno e ora, Roma): una notizia di ieri sera non è una notizia di adesso.',
  };
}

// ---------- per la scheda "Cosa ha mosso i mercati" ----------
// Raggruppa gli eventi (sessioni insolite e accelerazioni) per fascia oraria: in ogni fascia gli asset che si sono mossi più del solito
// e le notizie più rilevanti uscite in quelle ore. Nessuna causa dichiarata: sono notizie CONCOMITANTI.
const SLOT_HOURS = { Asia: '01:00–09:00', Europa: '09:00–15:30', USA: '15:30–22:00', Notte: '22:00–01:00' };
const DAY_LONG = { dom: 'Domenica', lun: 'Lunedì', mar: 'Martedì', mer: 'Mercoledì', gio: 'Giovedì', ven: 'Venerdì', sab: 'Sabato' };
function uiSummary(ctx, maxSlots = 4) {
  const slots = new Map();
  for (const e of ctx.events) {
    const key = `${romeParts((e.t0 + e.t1) / 2).date}|${e.ses}`;
    const s = slots.get(key) || { key, ses: e.ses, day: dayName(e.t0), t0: e.t0, t1: e.t1, assets: new Map(), news: new Map(), live: false };
    s.t0 = Math.min(s.t0, e.t0); s.t1 = Math.max(s.t1, e.t1); s.live = s.live || e.live;
    const sig = Math.abs(e.pct) * e.ratio, cur = s.assets.get(e.name);
    if (!cur || sig > cur.sig) s.assets.set(e.name, { name: e.name, key: e.key, pct: e.pct, ratio: e.ratio, kind: e.kind, from: e.from, to: e.to, dec: e.dec, sig });
    for (const n of e.news) if (!s.news.has(n.title)) s.news.set(n.title, n);
    slots.set(key, s);
  }
  const out = [...slots.values()].sort((a, b) => b.t1 - a.t1).slice(0, maxSlots).map((s) => ({
    ses: s.ses, day: DAY_LONG[s.day], hours: SLOT_HOURS[s.ses], live: ctx.at - s.t1 < 25 * 60e3, t0: s.t0, t1: s.t1,
    assets: [...s.assets.values()].sort((a, b) => b.sig - a.sig).slice(0, 7).map(({ sig, ...a }) => a),
    news: [...s.news.values()].filter((n) => new Date(n.published).getTime() <= s.t1 + 30 * 60e3).sort((a, b) => b.score - a.score).slice(0, 4).sort((a, b) => new Date(b.published) - new Date(a.published)).map((n) => ({ title: n.title, source: n.source, url: n.url, published: n.published, level: n.level, tags: n.tags })),
  }));
  return {
    generatedAt: new Date(ctx.at).toISOString(), slots: out,
    prices: ctx.moves.filter((m) => !m.error).map((m) => ({ name: m.name, key: m.key, price: m.price, change24h: m.change24h })),
    topNews: ctx.top.filter((n) => n.level === 'ALTO').sort((a, b) => b.score - a.score).slice(0, 5).map((n) => ({ title: n.title, source: n.source, url: n.url, published: n.published, tags: n.tags })),
  };
}

module.exports = { getMarketContext, buildContext, uiSummary, detectBursts, sessionMoves, matchNews, fetchBars, WATCH, romeParts, hhmm, dayName, sessionOf, when, renderNews, renderMoves };
