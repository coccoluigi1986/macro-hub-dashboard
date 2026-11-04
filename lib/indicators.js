// lib/indicators.js
//
// Indicatori chiave del mercato, tutti calcolati da dati REALI e raggruppati in sei aree (la scheda "Indicatori chiave"):
//   1. Contesto economico e politica monetaria   — FRED: inflazione (CPI e PCE core), lavoro, PIL, sussidi, tasso reale
//   2. Tensioni geopolitiche e settori economici — notizie ad alto impatto (lib/market-context.js) + petrolio, oro, dollaro, energia/difesa/compagnie aeree
//   3. Reazione generale del mercato azionario   — indici, VIX, tendenza (media a 200 giorni), ampiezza, rischio di credito
//   4. Impatto sui settori azionari              — gli 11 settori dell'S&P 500 (ETF SPDR) a 1 giorno / 1 settimana / 1 mese
//   5. Tassi e Treasuries                        — curva dei tassi, politica della Fed, tetto al debito e deficit (Tesoro USA)
//   6. Liquidità a mercato                       — bilancio della Fed, conto del Tesoro (TGA), reverse repo, riserve, M2, condizioni finanziarie
// Fonti senza chiave: FRED (file CSV pubblici), FiscalData del Tesoro USA, Yahoo Finance. Se una fonte non risponde l'indicatore semplicemente
// manca (e l'errore è elencato): non si inventa nulla. Ogni indicatore ha un "semaforo" dal punto di vista di chi investe in azioni:
// pos = favorevole · neu = neutro · warn = da monitorare · neg = sotto pressione. Le soglie sono scritte nel testo "Cosa significa" di ciascuno:
// sono una lettura educativa, non un consiglio d'investimento.
// Usato da api/market-data.js (?view=indicators).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DAY = 86400e3;

// ---------- formati italiani ----------
const nf = (n, d = 1) => Number(n).toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: 'always' });
const sg = (n, d = 1) => { const r = Number(Math.abs(n).toFixed(d)); return (r === 0 ? '' : n > 0 ? '+' : '−') + nf(Math.abs(n), d); };   // −0,04 si scrive 0,0, non −0,0
const usdM = (m, d = 2) => { const a = Math.abs(m); return (m < 0 ? '−' : '') + '$' + (a >= 0.95e6 ? nf(a / 1e6, d) + ' trilioni' : a >= 1e3 ? nf(a / 1e3, a >= 1e5 ? 0 : 1) + ' miliardi' : nf(a, 0) + ' milioni'); };
const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const monthIt = (d) => `${MESI[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
const dayIt = (d) => `${+d.slice(8, 10)} ${MESI[+d.slice(5, 7) - 1]}`;
const dir = (v, eps = 0.005) => (v > eps ? 'up' : v < -eps ? 'down' : 'flat');

// ---------- scarico ----------
async function getText(url) {
  let res;
  for (let i = 0; i < 2; i++) {
    res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} da ${new URL(url).host}`);
  return res.text();
}
const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key); if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await fn(); cache.set(key, { t: Date.now(), v }); return v;
}
// FRED: file CSV pubblico (nessuna chiave) → [{d:'AAAA-MM-GG', v}] in ordine di data
const fred = (id, years = 3) => cached('fred:' + id, 30 * 60e3, async () => {
  const cosd = new Date(Date.now() - years * 366 * DAY).toISOString().slice(0, 10);
  const lines = (await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`)).trim().split('\n').slice(1);
  const out = []; for (const l of lines) { const [d, v] = l.split(','); const x = Number(v); if (d && v && v !== '.' && isFinite(x)) out.push({ d, v: x }); }
  if (!out.length) throw new Error('serie vuota ' + id); return out;
});
// Yahoo: chiusure giornaliere → [{d, c}]
const yahoo = (sym, range = '6mo') => cached('y:' + sym + range, 5 * 60e3, async () => {
  const j = JSON.parse(await getText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`));
  const r = j.chart && j.chart.result && j.chart.result[0]; if (!r || !r.timestamp) throw new Error('nessun dato ' + sym);
  const c = r.indicators.quote[0].close; const out = [];
  r.timestamp.forEach((t, i) => { if (c[i] != null) out.push({ d: new Date(t * 1000).toISOString().slice(0, 10), c: c[i] }); });
  if (out.length < 5) throw new Error('dati insufficienti ' + sym); return out;
});
// Tesoro USA (FiscalData)
const fiscal = (p) => cached('fd:' + p, 30 * 60e3, async () => JSON.parse(await getText('https://api.fiscaldata.treasury.gov/services/api/fiscal_service/' + p)).data);

// ---------- piccoli calcoli ----------
const last = (s, k = 0) => s[s.length - 1 - k];
const pctBack = (s, n, key = 'c') => (s.length > n ? (last(s)[key] / last(s, n)[key] - 1) * 100 : null);
const onOrBefore = (s, date) => { let r = null; for (const p of s) { if (p.d <= date) r = p; else break; } return r; };
const daysAgo = (date, n) => new Date(new Date(date + 'T12:00:00Z').getTime() - n * DAY).toISOString().slice(0, 10);
const yoyAt = (s, k = 0) => (s.length > 12 + k ? (last(s, k).v / last(s, 12 + k).v - 1) * 100 : null);
const spark = (arr, n = 40) => { const a = arr.slice(-n); return a.map((x) => Number(Number(x).toFixed(3))); };

const item = (id, label, value, sub, delta, tone, hint, extra = {}) => ({ id, label, value, sub, delta: delta || null, tone, hint, ...extra });
const TONE_LABEL = { pos: 'Favorevole', neu: 'Neutro', warn: 'Da monitorare', neg: 'Sotto pressione' };
function summarize(items) {
  const c = { pos: 0, neu: 0, warn: 0, neg: 0 }; items.forEach((i) => { c[i.tone]++; });
  const n = items.length || 1; let tone = 'neu';
  if (c.neg >= Math.max(2, Math.ceil(n * 0.25)) || (c.neg >= 1 && c.warn >= Math.ceil(n * 0.5))) tone = 'neg';
  else if (c.warn + c.neg >= Math.ceil(n / 3)) tone = 'warn';
  else if (c.pos >= Math.ceil(n / 2)) tone = 'pos';
  return { tone, toneLabel: TONE_LABEL[tone], counts: c };
}
const settle = async (jobs, errors) => { const out = {}; await Promise.all(Object.entries(jobs).map(async ([k, fn]) => { try { out[k] = await fn(); } catch (e) { out[k] = null; errors.push(`${k}: ${e.message}`); } })); return out; };

// =====================================================================================================================
// 1. CONTESTO ECONOMICO E POLITICA MONETARIA
// =====================================================================================================================
// ---------- lancetta: un punteggio 0-100 per ogni indicatore ----------
// Ogni dato ha il suo semaforo (pos/neu/warn/neg); il punteggio dell'indicatore è la media dei semafori dei dati che lo compongono
// (favorevole 100, neutro 62, da monitorare 35, sotto pressione 8) e decide la zona della lancetta. È una sintesi, non una misura scientifica:
// i dati che la compongono restano consultabili uno per uno.
const TONE_SCORE = { pos: 100, neu: 62, warn: 35, neg: 8 };
const toneOfScore = (s) => (s >= 78 ? 'pos' : s >= 48 ? 'neu' : s >= 22 ? 'warn' : 'neg');
const WORDS = {
  default: { pos: 'Favorevole', neu: 'Neutro', warn: 'Da monitorare', neg: 'Sotto pressione' },
  geo: { pos: 'Tensione bassa', neu: 'Tensione moderata', warn: 'Tensione alta', neg: 'Tensione molto alta' },
  equity: { pos: 'Forte', neu: 'Neutro', warn: 'Cauto', neg: 'Debole' },
  sectors: { pos: 'Risk-on', neu: 'Equilibrato', warn: 'Difensivo', neg: 'Risk-off' },
  liquidity: { pos: 'Abbondante', neu: 'Stabile', warn: 'In calo', neg: 'Scarsa' },
  curve: { pos: 'Normale', neu: 'Neutra', warn: 'Piatta', neg: 'Invertita' },
  fed: { pos: 'Accomodante', neu: 'Neutrale', warn: 'Restrittiva', neg: 'Molto restrittiva' },
  debt: { pos: 'Sostenibile', neu: 'Gestibile', warn: 'Teso', neg: 'Critico' },
};
const SHORT = { cpi: 'inflazione', pce: 'inflazione PCE', un: 'disoccupazione', nfp: 'nuovi posti di lavoro', gdp: 'crescita', claims: 'sussidi', real: 'tasso reale', geonews: 'notizie di guerra', wti: 'petrolio', gold: 'oro', dxy: 'dollaro',
  xle: 'energia', ita: 'difesa', jets: 'compagnie aeree', spx: 'S&P 500', ndx: 'Nasdaq', dji: 'Dow Jones', rut: 'piccole imprese', vix: 'volatilità (VIX)', trend: 'tendenza', breadth: 'ampiezza', hy: 'rischio di credito',
  breadthSec: 'settori in rialzo', leader: 'settore più forte', laggard: 'settore più debole', cycdef: 'ciclici contro difensivi', y10: 'rendimento a 10 anni', y2: 'rendimento a 2 anni', y30: 'rendimento a 30 anni', s2: 'curva 10−2 anni',
  s3: 'curva 10−3 mesi', real10: 'rendimento reale', range: 'tasso Fed', balance: 'bilancio Fed', expect: 'attese sui tassi', debt: 'debito', cap: 'tetto al debito', deficit: 'deficit', debtgdp: 'debito/PIL', interest: 'interessi sul debito',
  net: 'liquidità netta', fed: 'bilancio Fed', tga: 'conto del Tesoro', rrp: 'reverse repo', reserves: 'riserve bancarie', m2: 'massa monetaria', nfci: 'condizioni finanziarie' };
// come si chiama un dato quando "pesa" (primo) e quando "aiuta" (secondo): dice il perché, non solo il nome
const WHY = { cpi: ['inflazione alta', 'inflazione contenuta'], pce: ['inflazione PCE alta', 'inflazione PCE contenuta'], un: ['disoccupazione in salita', 'disoccupazione bassa'], nfp: ['pochi nuovi posti di lavoro', 'molti nuovi posti di lavoro'],
  gdp: ['crescita debole', 'crescita solida'], claims: ['sussidi in aumento', 'pochi sussidi'], real: ['tasso reale alto', 'tasso reale basso'], geonews: ['molte notizie di guerra', 'poche notizie di guerra'], wti: ['petrolio in forte movimento', 'petrolio stabile'],
  gold: ['oro in forte rialzo', 'oro stabile'], dxy: ['dollaro molto forte', 'dollaro stabile'], xle: ['energia in forte rialzo', 'energia'], ita: ['difesa in forte rialzo', 'difesa'], jets: ['compagnie aeree in calo', 'compagnie aeree'],
  spx: ['S&P 500 in calo', 'S&P 500 vicino ai massimi'], ndx: ['Nasdaq in calo', 'Nasdaq forte'], dji: ['Dow Jones in calo', 'Dow Jones forte'], rut: ['piccole imprese in calo', 'piccole imprese forti'], vix: ['volatilità alta', 'volatilità bassa'],
  trend: ['tendenza ribassista', 'tendenza rialzista'], breadth: ['rialzo concentrato su pochi titoli', 'rialzo ampio'], hy: ['rischio di credito alto', 'rischio di credito basso'], breadthSec: ['pochi settori in rialzo', 'molti settori in rialzo'],
  cycdef: ['difensivi in vantaggio sui ciclici', 'ciclici in vantaggio'], leader: ['settore più forte', 'settore più forte'], laggard: ['un settore in forte calo', 'settore più debole'], y10: ['rendimento a 10 anni alto', 'rendimento a 10 anni basso'],
  y2: ['rendimento a 2 anni alto', 'rendimento a 2 anni'], y30: ['rendimento a 30 anni alto', 'rendimento a 30 anni'], s2: ['curva piatta o invertita', 'curva normale'], s3: ['curva piatta o invertita', 'curva normale'], real10: ['rendimento reale alto', 'rendimento reale basso'],
  range: ['tasso Fed', 'tasso Fed'], balance: ['bilancio Fed in calo', 'bilancio Fed in crescita'], expect: ['attese di rialzi dei tassi', 'attese di tagli dei tassi'], debt: ['debito in crescita', 'debito'], cap: ['tetto al debito vicino', 'tetto al debito lontano'],
  deficit: ['deficit alto', 'deficit contenuto'], debtgdp: ['debito/PIL alto', 'debito/PIL contenuto'], interest: ['interessi sul debito alti', 'interessi sul debito contenuti'], net: ['liquidità netta in calo', 'liquidità netta in crescita'],
  fed: ['bilancio Fed in calo', 'bilancio Fed in crescita'], tga: ['conto del Tesoro in forte crescita', 'conto del Tesoro'], rrp: ['reverse repo', 'reverse repo'], reserves: ['riserve bancarie in calo', 'riserve bancarie'], m2: ['massa monetaria in calo', 'massa monetaria in crescita'],
  nfci: ['condizioni finanziarie dure', 'condizioni finanziarie facili'] };
function gaugeOf(items, words, onlyIds) {
  const g = onlyIds ? items.filter((i) => onlyIds.includes(i.id)) : items;
  const score = g.length ? Math.round(g.reduce((s, i) => s + TONE_SCORE[i.tone], 0) / g.length) : null;
  const tone = score == null ? 'neu' : toneOfScore(score), nm = (i, bad) => (WHY[i.id] ? WHY[i.id][bad ? 0 : 1] : SHORT[i.id] || i.label);
  return { score, tone, label: (WORDS[words] || WORDS.default)[tone], weigh: [...g.filter((i) => i.tone === 'neg'), ...g.filter((i) => i.tone === 'warn')].map((i) => nm(i, true)).filter((x, k, a) => a.indexOf(x) === k).slice(0, 2), help: g.filter((i) => i.tone === 'pos').map((i) => nm(i, false)).filter((x, k, a) => a.indexOf(x) === k).slice(0, 2) };
}
// frase di sintesi della riga (frammenti con i numeri chiave, separati da "·"), costruita dai dati veri del gruppo
const AREA = { macro: 'economia e Fed', geo: 'geopolitica', equity: 'mercato azionario', sectors: 'settori azionari', rates: 'tassi e Treasuries', liquidity: 'liquidità' };
function briefOf(g) {
  const it = (id) => g.items.find((i) => i.id === id), v = (id) => (it(id) ? it(id).value : null), dl = (id) => (it(id) && it(id).delta ? it(id).delta.text : null);
  const j = (a) => a.filter(Boolean).join(' · ');
  const sub = (id) => (g.sub || []).find((s) => s.id === id), sv = (s, id) => { const i = s && s.items.find((x) => x.id === id); return i ? i.value : null; };
  switch (g.id) {
    case 'macro': return j([v('cpi') && `Inflazione core ${v('cpi')}`, v('un') && `Disoccupazione ${v('un')}`, v('gdp') && `PIL ${v('gdp')}`, g.stance && `Fed ${g.stance}`]);
    case 'geo': return j([v('geonews') && `${v('geonews')} storie ad alto impatto in 24 ore`, v('wti') && `Petrolio ${v('wti')} (${dl('wti').replace(' in 5 giorni', ' in 5 gg')})`, v('ita') && `Difesa ${v('ita')} sul mercato`]);
    case 'equity': return j([v('spx') && `S&P 500 ${v('spx')} (${dl('spx')})`, v('vix') && `VIX ${v('vix')}`, v('hy') && `Spread di credito ${v('hy')}`, v('trend') && `Tendenza ${v('trend').toLowerCase()}`]);
    case 'sectors': return j([v('breadthSec') && `${v('breadthSec')} settori in rialzo oggi`, v('leader') && `Più forte ${v('leader')}`, v('laggard') && `Più debole ${v('laggard')}`, v('cycdef') && `Ciclici contro difensivi ${v('cycdef')}`]);
    case 'rates': { const d = sub('debt'); return j([v('y10') && `Treasury 10 anni ${v('y10')}`, v('s2') && `Curva 10−2 anni ${v('s2')}`, v('range') && `Tasso Fed ${v('range')}`, d && d.bar && `Margine sul tetto al debito ${usdM(d.bar.room, 2)}`]); }
    case 'liquidity': return j([v('net') && `Liquidità netta ${v('net')} (${dl('net')})`, v('reserves') && `Riserve bancarie ${v('reserves')}`, v('nfci') && `Condizioni finanziarie ${v('nfci')}`]);
    case 'curve': return j([sv(g, 's2') && `10−2 anni ${sv(g, 's2')}`, sv(g, 's3') && `10−3 mesi ${sv(g, 's3')}`, sv(g, 'y10') && `10 anni ${sv(g, 'y10')}`]);
    case 'fed': return j([sv(g, 'range') && `Target ${sv(g, 'range')}`, sv(g, 'real') && `Tasso reale ${sv(g, 'real')}`, sv(g, 'expect') && `Attese ${sv(g, 'expect')}`]);
    case 'debt': return j([sv(g, 'debt') && `Debito ${sv(g, 'debt')}`, sv(g, 'cap') && `Tetto ${sv(g, 'cap')}`, sv(g, 'deficit') && `Deficit ${sv(g, 'deficit')}`]);
    default: return '';
  }
}
function decorate(g) {
  Object.assign(g, gaugeOf(g.items, g.id === 'rates' ? 'default' : g.id, g.gauge));
  if (g.id === 'geo') { const gn = g.items.find((i) => i.id === 'geonews'); if (gn && gn.tone === 'neg' && g.score > 44) { g.score = 44; g.tone = toneOfScore(44); g.label = WORDS.geo[g.tone]; } }   // tensione alta: la lancetta non può stare su "moderata"
  if (g.sub) g.sub.forEach((s) => { Object.assign(s, gaugeOf(s.items, s.id, s.gauge)); s.brief = briefOf(s); });
  g.brief = briefOf(g);
  return g;
}
// verdetto generale: media delle sei aree, con ciò che pesa e ciò che regge
function overallOf(groups) {
  if (!groups.length) return null;
  const score = Math.round(groups.reduce((s, g) => s + g.score, 0) / groups.length), tone = toneOfScore(score);
  const name = (g) => `${AREA[g.id]} (${g.label.toLowerCase()})`, byScore = [...groups].sort((a, b) => a.score - b.score);
  return { score, tone, label: { pos: 'Favorevole', neu: 'Neutro', warn: 'Cautela', neg: 'Sotto pressione' }[tone],
    weigh: byScore.filter((g) => g.tone === 'warn' || g.tone === 'neg').slice(0, 3).map(name), hold: [...byScore].reverse().filter((g) => g.tone === 'pos' || g.tone === 'neu').slice(0, 3).map(name) };
}

async function groupMacro(errors) {
  const S = await settle({ cpi: () => fred('CPILFESL', 3), pce: () => fred('PCEPILFE', 3), un: () => fred('UNRATE', 3), nfp: () => fred('PAYEMS', 3), gdp: () => fred('A191RL1Q225SBEA', 4), claims: () => fred('ICSA', 2), effr: () => fred('EFFR', 1) }, errors);
  const items = [];
  const cpiY = S.cpi && yoyAt(S.cpi), cpiP = S.cpi && yoyAt(S.cpi, 1);
  if (cpiY != null) items.push(item('cpi', 'Inflazione core (CPI)', nf(cpiY) + '%', 'prezzi al consumo senza cibo ed energia, anno su anno', { text: sg(cpiY - cpiP) + ' pt sul mese prima', dir: dir(cpiY - cpiP, 0.04) },
    cpiY < 2.5 ? 'pos' : cpiY < 3.5 ? 'neu' : cpiY < 4.5 ? 'warn' : 'neg',
    'Misura quanto salgono i prezzi che paghiamo, senza i beni più volatili (cibo ed energia). La Fed punta al 2%: più l\'inflazione resta sopra, più a lungo tiene i tassi alti, e tassi alti pesano sulle azioni. Lettura: sotto il 2,5% favorevole, 2,5–3,5% neutra, 3,5–4,5% da monitorare, sopra il 4,5% sotto pressione.',
    { asof: monthIt(last(S.cpi).d), spark: spark(S.cpi.map((_, i) => (i >= 12 ? (S.cpi[i].v / S.cpi[i - 12].v - 1) * 100 : null)).filter((x) => x != null), 24) }));
  const pceY = S.pce && yoyAt(S.pce), pceP = S.pce && yoyAt(S.pce, 1);
  if (pceY != null) items.push(item('pce', 'Inflazione core (PCE)', nf(pceY) + '%', 'la misura preferita dalla Fed', { text: sg(pceY - pceP) + ' pt sul mese prima', dir: dir(pceY - pceP, 0.04) },
    pceY < 2.3 ? 'pos' : pceY < 3 ? 'neu' : pceY < 4 ? 'warn' : 'neg',
    'È l\'indice dei prezzi che la Fed guarda per decidere sui tassi (il suo obiettivo è il 2%). Lettura: sotto il 2,3% favorevole, 2,3–3% neutra, 3–4% da monitorare, sopra il 4% sotto pressione.',
    { asof: monthIt(last(S.pce).d) }));
  if (S.un) { const u = last(S.un).v, u3 = last(S.un, 3).v, uP = last(S.un, 1).v; items.push(item('un', 'Disoccupazione', nf(u) + '%', 'quota di persone senza lavoro che lo cercano', { text: sg(u - uP) + ' pt sul mese prima', dir: dir(u - uP, 0.04) },
    u - u3 >= 0.4 || u > 5.2 ? 'neg' : u > 4.5 || u - u3 >= 0.3 ? 'warn' : 'pos',
    'Un\'economia con poca disoccupazione spende e produce; ma un aumento rapido (0,4 punti in tre mesi) è un classico segnale di rallentamento. Lettura: sotto il 4,5% e stabile favorevole, 4,5–5,2% o in salita da monitorare, sopra il 5,2% o in forte salita sotto pressione.',
    { asof: monthIt(last(S.un).d), spark: spark(S.un.map((x) => x.v), 24) })); }
  if (S.nfp) { const d1 = last(S.nfp).v - last(S.nfp, 1).v, d3 = (last(S.nfp).v - last(S.nfp, 3).v) / 3; items.push(item('nfp', 'Nuovi posti di lavoro', sg(d1, 0) + ' mila', 'variazione degli occupati nel mese (NFP)', { text: 'media 3 mesi ' + sg(d3, 0) + ' mila', dir: dir(d1, 5) },
    d1 > 150 ? 'pos' : d1 > 50 ? 'neu' : d1 >= 0 ? 'warn' : 'neg',
    'Quanti posti di lavoro si aggiungono ogni mese negli USA. Servono circa 100 mila nuovi posti al mese per assorbire chi entra nel mercato del lavoro. Lettura: oltre 150 mila favorevole, 50–150 mila neutro, 0–50 mila da monitorare, negativo sotto pressione.',
    { asof: monthIt(last(S.nfp).d) })); }
  if (S.gdp) { const g = last(S.gdp).v, gp = last(S.gdp, 1).v; items.push(item('gdp', 'Crescita (PIL)', nf(g) + '%', 'ultimo trimestre, ritmo annualizzato', { text: sg(g - gp) + ' pt sul trimestre prima', dir: dir(g - gp, 0.05) },
    g > 2.5 ? 'pos' : g > 1.5 ? 'neu' : g >= 0 ? 'warn' : 'neg',
    'La velocità a cui cresce l\'economia statunitense. Lettura: oltre il 2,5% favorevole, 1,5–2,5% neutra, 0–1,5% da monitorare, negativa sotto pressione (due trimestri negativi di fila sono la definizione classica di recessione).',
    { asof: 'trimestre ' + monthIt(last(S.gdp).d) })); }
  if (S.claims) { const c = last(S.claims).v / 1000, c4 = S.claims.slice(-4).reduce((a, b) => a + b.v, 0) / 4000; items.push(item('claims', 'Sussidi di disoccupazione', nf(c, 0) + ' mila', 'nuove richieste nella settimana', { text: 'media 4 sett. ' + nf(c4, 0) + ' mila', dir: dir(c - c4, 2) },
    c < 230 ? 'pos' : c < 260 ? 'neu' : c < 300 ? 'warn' : 'neg',
    'Quante persone, ogni settimana, chiedono per la prima volta il sussidio: è il dato sul lavoro più rapido, esce ogni giovedì. Lettura: sotto 230 mila favorevole, 230–260 mila neutro, 260–300 mila da monitorare, oltre 300 mila sotto pressione.',
    { asof: 'sett. al ' + dayIt(last(S.claims).d), spark: spark(S.claims.map((x) => x.v / 1000), 30) })); }
  // orientamento della politica monetaria: tasso reale = tasso Fed effettivo - inflazione core
  let stance = null;
  if (S.effr && cpiY != null) {
    const e = last(S.effr).v, real = e - cpiY;
    stance = real > 1.5 ? 'restrittiva' : real > 0.5 ? 'moderatamente restrittiva' : real > -0.5 ? 'neutrale' : 'accomodante';
    items.push(item('real', 'Tasso reale della Fed', sg(real) + '%', `tasso Fed ${nf(e, 2)}% meno inflazione core ${nf(cpiY)}%`, null,
      real > 1.5 ? 'neg' : real > 0.5 ? 'warn' : real > -0.5 ? 'neu' : 'pos',
      'È il tasso della Fed "ripulito" dall\'inflazione: dice quanto la politica monetaria frena (o spinge) davvero l\'economia. Lettura: oltre +1,5% restrittiva (sotto pressione), +0,5/+1,5% moderatamente restrittiva (da monitorare), vicino a zero neutrale, sotto −0,5% accomodante (favorevole).',
      { asof: 'tasso al ' + dayIt(last(S.effr).d) }));
  }
  const sum = summarize(items);
  const bits = [];
  if (cpiY != null) bits.push(`l'inflazione core è al ${nf(cpiY)}%`);
  if (S.un) bits.push(`la disoccupazione al ${nf(last(S.un).v)}%`);
  if (S.gdp) bits.push(`il PIL cresce del ${nf(last(S.gdp).v)}% annualizzato`);
  return { id: 'macro', title: 'Contesto economico e politica monetaria', icon: 'bank', stance, ...sum, items,
    reading: bits.length ? `Negli USA ${bits.join(', ')}${stance ? `: la politica monetaria è ${stance}` : ''}.` : 'Dati macro non disponibili in questo momento.' };
}

// =====================================================================================================================
// 2. TENSIONI GEOPOLITICHE E SETTORI ECONOMICI (notizie + mercato)
// =====================================================================================================================
const STOP = new Set(['after', 'amid', 'over', 'into', 'says', 'said', 'will', 'than', 'more', 'with', 'from', 'that', 'this', 'what', 'were', 'have', 'been', 'could', 'would', 'their', 'about', 'ahead', 'as']);
const toks = (t) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));
const jac = (a, b) => { let i = 0; a.forEach((x) => { if (b.has(x)) i++; }); return i / ((a.size + b.size - i) || 1); };
// storie geopolitiche ad alto impatto delle ultime 24 ore, con le testate che raccontano la stessa vicenda raggruppate
function geoStories(ctx, nowMs) {
  const cand = ctx.ranked.filter((n) => n.level === 'ALTO' && (n.tags.includes('geopolitica') || n.tags.includes('scenario geopolitico')) && nowMs - new Date(n.published).getTime() <= 24 * 3600e3).sort((a, b) => b.score - a.score);
  const reps = [];
  for (const n of cand) { const tk = toks(n.title); const hit = reps.find((r) => jac(r.tk, tk) >= 0.35); if (hit) hit.fonti++; else reps.push({ ...n, tk, fonti: 1 }); }
  return reps;
}
async function groupGeo(errors, ctxFn, translate) {
  const S = await settle({ wti: () => yahoo('CL=F', '1mo'), gold: () => yahoo('GC=F', '1mo'), dxy: () => yahoo('DX-Y.NYB', '1mo'), spy: () => yahoo('SPY', '1mo'), xle: () => yahoo('XLE', '1mo'), ita: () => yahoo('ITA', '1mo'), jets: () => yahoo('JETS', '1mo'), ctx: ctxFn }, errors);
  const items = [], stories = [];
  if (S.ctx) {
    const st = geoStories(S.ctx, Date.now()), n = st.length;
    items.push(item('geonews', 'Notizie geopolitiche ad alto impatto', String(n), 'storie distinte nelle ultime 24 ore (non titoli ripetuti)', null,
      n >= 10 ? 'neg' : n >= 4 ? 'warn' : 'pos',
      'Contiamo le vicende diverse (guerre, attacchi, minacce, sanzioni, trattative) che le fonti segnalano come molto rilevanti per i mercati nelle ultime 24 ore; più testate che titolano la stessa cosa contano una sola volta. Lettura: meno di 4 favorevole (tensione bassa), 4–9 da monitorare, 10 o più sotto pressione (tensione alta).',
      { asof: 'ultime 24 ore' }));
    const top = st.slice(0, 3); const tr = translate ? await translate(top.map((x) => x.title)) : new Map();
    top.forEach((x) => stories.push({ title: x.title, titleIt: tr.get(x.title) || null, source: x.source, url: x.url, published: x.published, fonti: x.fonti }));
  }
  const px = (s, n, d = 2) => (s ? { p: last(s).c, ch: pctBack(s, n) } : null);
  const wti = px(S.wti, 5), gold = px(S.gold, 5), dxy = px(S.dxy, 5), spy5 = S.spy ? pctBack(S.spy, 5) : null;
  if (wti) items.push(item('wti', 'Petrolio WTI', '$' + nf(wti.p, 2), 'prezzo al barile · variazione a 5 giorni', { text: sg(wti.ch) + '% in 5 giorni', dir: dir(wti.ch, 0.2) },
    wti.ch > 8 ? 'neg' : wti.ch > 3 ? 'warn' : wti.ch < -8 ? 'warn' : 'neu',
    'Il petrolio è il termometro più rapido delle tensioni in Medio Oriente e dell\'offerta di energia: un balzo alza i costi di imprese e famiglie e rilancia l\'inflazione. Lettura: oltre +8% in 5 giorni sotto pressione, +3/+8% da monitorare, tra −3% e +3% neutro; anche un crollo oltre −8% segnala instabilità (da monitorare).',
    { asof: 'chiusura del ' + dayIt(last(S.wti).d), spark: spark(S.wti.map((x) => x.c), 22) }));
  if (gold) items.push(item('gold', 'Oro', '$' + nf(gold.p, 0), 'rifugio per eccellenza · variazione a 5 giorni', { text: sg(gold.ch) + '% in 5 giorni', dir: dir(gold.ch, 0.2) },
    gold.ch > 4 ? 'warn' : 'neu',
    'Nei momenti di paura molti investitori comprano oro come protezione: un forte rialzo in pochi giorni indica ricerca di sicurezza. Il prezzo però dipende anche da dollaro e rendimenti, quindi non sale sempre con le tensioni. Lettura: oltre +4% in 5 giorni da monitorare, altrimenti neutro.',
    { asof: 'chiusura del ' + dayIt(last(S.gold).d), spark: spark(S.gold.map((x) => x.c), 22) }));
  if (dxy) items.push(item('dxy', 'Dollaro (DXY)', nf(dxy.p, 2), 'forza del dollaro contro le altre valute · 5 giorni', { text: sg(dxy.ch) + '% in 5 giorni', dir: dir(dxy.ch, 0.1) },
    dxy.ch > 1.5 ? 'warn' : 'neu',
    'Quando il mondo è nervoso il dollaro tende a rafforzarsi (è la moneta rifugio): un dollaro molto forte però pesa su oro, materie prime e mercati emergenti. Lettura: oltre +1,5% in 5 giorni da monitorare, altrimenti neutro.',
    { asof: 'chiusura del ' + dayIt(last(S.dxy).d) }));
  const rel = (name, s, label, sub, hint, badWhenLow) => { if (!s || spy5 == null) return; const ch = pctBack(s, 5), r = ch - spy5; items.push(item(name, label, sg(r) + ' pt', sub, { text: label.split(' ')[0] + ' ' + sg(ch) + '% · S&P 500 ' + sg(spy5) + '%', dir: dir(r, 0.1) }, badWhenLow ? (r < -4 ? 'neg' : r < -2 ? 'warn' : 'neu') : (r > 5 ? 'warn' : 'neu'), hint, { asof: 'a 5 giorni' })); };
  rel('xle', S.xle, 'Energia (XLE)', 'rendimento a 5 giorni rispetto all\'S&P 500', 'I petroliferi guadagnano quando il petrolio sale per tensioni sull\'offerta. Un forte vantaggio sul mercato (oltre +5 punti in 5 giorni) segnala che gli investitori si stanno proteggendo con l\'energia: da monitorare.', false);
  rel('ita', S.ita, 'Difesa (ITA)', 'rendimento a 5 giorni rispetto all\'S&P 500', 'Le aziende di difesa e aerospazio salgono quando cresce il rischio di conflitti. Oltre +5 punti sul mercato in 5 giorni: da monitorare.', false);
  rel('jets', S.jets, 'Compagnie aeree (JETS)', 'rendimento a 5 giorni rispetto all\'S&P 500', 'Le compagnie aeree sono tra le più colpite da petrolio caro e tensioni (costi del carburante, rotte chiuse). Sotto −2 punti sul mercato in 5 giorni: da monitorare; sotto −4: sotto pressione.', true);
  const sum = summarize(items);
  const gn = items.find((i) => i.id === 'geonews');
  if (gn && gn.tone === 'neg' && (sum.tone === 'neu' || sum.tone === 'pos')) { sum.tone = 'warn'; sum.toneLabel = TONE_LABEL.warn; }   // tensione alta: il gruppo non può risultare "neutro"
  const n = S.ctx ? geoStories(S.ctx, Date.now()).length : null;
  const level = n == null ? null : n >= 10 ? 'alta' : n >= 4 ? 'moderata' : 'bassa';
  const reading = level
    ? `La tensione geopolitica è ${level} (${n} storie ad alto impatto in 24 ore)${wti ? `; il petrolio è a $${nf(wti.p, 0)} (${sg(wti.ch)}% in 5 giorni)` : ''}${S.xle && S.ita && spy5 != null ? `; in 5 giorni energia ${sg(pctBack(S.xle, 5) - spy5)} pt e difesa ${sg(pctBack(S.ita, 5) - spy5)} pt rispetto all'S&P 500` : ''}.`
    : 'Notizie non disponibili in questo momento.';
  return { id: 'geo', title: 'Tensioni geopolitiche e settori economici', icon: 'globe', ...sum, items, stories, reading };
}

// =====================================================================================================================
// 3. REAZIONE GENERALE DEL MERCATO AZIONARIO  +  4. IMPATTO SUI SETTORI
// =====================================================================================================================
const sma = (arr, n) => (arr.length >= n ? arr.slice(-n).reduce((a, b) => a + b, 0) / n : null);
async function groupEquity(errors) {
  const S = await settle({ spx: () => yahoo('^GSPC', '1y'), ndx: () => yahoo('^NDX', '1y'), dji: () => yahoo('^DJI', '1y'), rut: () => yahoo('^RUT', '1y'), vix: () => yahoo('^VIX', '6mo'), spy: () => yahoo('SPY', '6mo'), rsp: () => yahoo('RSP', '6mo'), hy: () => fred('BAMLH0A0HYM2', 2) }, errors);
  const items = [];
  const idx = (id, label, s) => {
    if (!s) return; const c = s.map((x) => x.c), p = last(s).c, d1 = pctBack(s, 1), w1 = pctBack(s, 5), m1 = pctBack(s, 21), hi = Math.max(...c.slice(-252)), dd = (p / hi - 1) * 100, m200 = sma(c, 200);
    const above = m200 != null ? p > m200 : null;
    items.push(item(id, label, nf(p, 0), `1 sett. ${sg(w1)}% · 1 mese ${sg(m1)}% · ${nf(Math.abs(dd))}% sotto il massimo a 52 sett.`.replace(' 0,0% sotto il massimo', ' sui massimi').replace('· 0,0% sotto', '· sui massimi'), { text: sg(d1, 2) + '% oggi', dir: dir(d1, 0.02) },
      dd < -20 ? 'neg' : (dd < -10 || above === false) ? 'warn' : dd < -5 ? 'neu' : 'pos',
      `Il livello dell'indice e quanto dista dal suo massimo degli ultimi 12 mesi. ${above != null ? `Oggi è ${above ? 'SOPRA' : 'SOTTO'} la media mobile a 200 giorni (${nf(m200, 0)}), la linea che molti usano per distinguere un trend rialzista da uno ribassista. ` : ''}Lettura: a meno del 5% dal massimo e sopra la media a 200 giorni favorevole, 5–10% di calo neutro, oltre il 10% o sotto la media a 200 giorni da monitorare, oltre il 20% (mercato "orso") sotto pressione.`,
      { asof: 'chiusura del ' + dayIt(last(s).d), spark: spark(c, 40) }));
  };
  idx('spx', 'S&P 500', S.spx); idx('ndx', 'Nasdaq 100', S.ndx); idx('dji', 'Dow Jones', S.dji); idx('rut', 'Russell 2000 (piccole imprese)', S.rut);
  if (S.vix) { const v = last(S.vix).c, w = pctBack(S.vix, 5); items.push(item('vix', 'VIX — l\'indice della paura', nf(v, 1), 'volatilità attesa dai mercati sull\'S&P 500', { text: sg(w) + '% in 5 giorni', dir: dir(w, 1) },
    v < 15 ? 'pos' : v < 22 ? 'neu' : v < 30 ? 'warn' : 'neg',
    'Misura quanta agitazione gli investitori si aspettano nelle prossime settimane: sale quando i mercati scendono in fretta. Lettura: sotto 15 calma (favorevole), 15–22 normale (neutro), 22–30 nervosismo (da monitorare), oltre 30 panico (sotto pressione).',
    { asof: 'chiusura del ' + dayIt(last(S.vix).d), spark: spark(S.vix.map((x) => x.c), 40) })); }
  if (S.spx) { const c = S.spx.map((x) => x.c), m200 = sma(c, 200), m50 = sma(c, 50), p = last(S.spx).c; if (m200) items.push(item('trend', 'Tendenza dell\'S&P 500', p > m200 ? 'Rialzista' : 'Ribassista', `prezzo ${sg((p / m200 - 1) * 100)}% rispetto alla media a 200 giorni${m50 ? ` · ${sg((p / m50 - 1) * 100)}% rispetto a quella a 50` : ''}`, null,
    p > m200 && (!m50 || p > m50) ? 'pos' : p > m200 ? 'neu' : 'warn',
    'La media mobile a 200 giorni è il prezzo medio dell\'ultimo anno circa: sopra, il trend di fondo è rialzista; sotto, ribassista. Lettura: sopra entrambe le medie (50 e 200 giorni) favorevole, sopra la sola 200 neutro, sotto la 200 da monitorare.', { asof: 'chiusura del ' + dayIt(last(S.spx).d) })); }
  if (S.spy && S.rsp) { const a = pctBack(S.rsp, 21) - pctBack(S.spy, 21); items.push(item('breadth', 'Ampiezza del rialzo', sg(a) + ' pt', 'S&P 500 "pari peso" (RSP) contro quello normale (SPY), 1 mese', null,
    a > 0.5 ? 'pos' : a > -1.5 ? 'neu' : 'warn',
    'L\'S&P 500 normale pesa di più le grandi società (poche giganti tech); la versione "pari peso" dà lo stesso peso a tutte le 500. Se la versione pari peso va meglio, il rialzo è esteso a molte aziende (sano); se va molto peggio, il mercato si regge su poche azioni (fragile). Lettura: oltre +0,5 punti favorevole, tra −1,5 e +0,5 neutro, sotto −1,5 da monitorare.', { asof: 'ultimo mese' })); }
  if (S.hy) { const h = last(S.hy).v, h1 = last(S.hy, 21).v; items.push(item('hy', 'Rischio di credito (spread high yield)', nf(h, 2) + '%', 'extra-rendimento che chiedono le aziende più rischiose', { text: sg(h - h1, 2) + ' pt in un mese', dir: dir(h - h1, 0.02) },
    h < 3.5 ? 'pos' : h < 4.5 ? 'neu' : h < 6 ? 'warn' : 'neg',
    'È quanto in più (rispetto ai titoli di Stato) devono pagare le aziende più indebitate per farsi prestare denaro: sale quando gli investitori temono fallimenti e recessione, ed è spesso il primo a "sentire" lo stress. Lettura: sotto 3,5% calmo (favorevole), 3,5–4,5% normale, 4,5–6% teso (da monitorare), oltre 6% stress (sotto pressione).',
    { asof: 'dato del ' + dayIt(last(S.hy).d), spark: spark(S.hy.map((x) => x.v), 40) })); }
  const sum = summarize(items);
  const spx = S.spx ? { p: last(S.spx).c, d1: pctBack(S.spx, 1), dd: (last(S.spx).c / Math.max(...S.spx.map((x) => x.c).slice(-252)) - 1) * 100 } : null;
  return { id: 'equity', title: 'Reazione generale del mercato azionario', icon: 'bars', ...sum, items,
    reading: spx ? `L'S&P 500 oggi ${spx.d1 >= 0 ? 'sale' : 'scende'} dello ${nf(Math.abs(spx.d1), 2)}% e ${spx.dd > -0.1 ? 'è sui massimi' : `dista il ${nf(Math.abs(spx.dd))}% dal massimo dell'ultimo anno`}${S.vix ? `; la paura (VIX) è a ${nf(last(S.vix).c, 1)}` : ''}${S.hy ? ` e il rischio di credito è ${last(S.hy).v < 3.5 ? 'basso' : last(S.hy).v < 4.5 ? 'nella norma' : 'in aumento'}` : ''}.` : 'Dati azionari non disponibili in questo momento.' };
}

const SECTORS = [['XLK', 'Tecnologia', 'cic'], ['XLF', 'Finanziari', 'cic'], ['XLE', 'Energia', 'cic'], ['XLV', 'Salute', 'dif'], ['XLY', 'Beni di consumo ciclici', 'cic'], ['XLP', 'Beni di consumo di base', 'dif'],
  ['XLI', 'Industriali', 'cic'], ['XLU', 'Servizi di pubblica utilità', 'dif'], ['XLB', 'Materiali', 'cic'], ['XLRE', 'Immobiliare', 'dif'], ['XLC', 'Comunicazioni', 'cic']];
async function groupSectors(errors) {
  const list = await Promise.all(SECTORS.map(async ([sym, name, kind]) => { try { const s = await yahoo(sym, '6mo'); return { sym, name, kind, price: last(s).c, d1: pctBack(s, 1), w1: pctBack(s, 5), m1: pctBack(s, 21), m3: pctBack(s, 63), asof: last(s).d }; } catch (e) { errors.push(`${sym}: ${e.message}`); return null; } }));
  const table = list.filter(Boolean);
  let spy = null; try { spy = await yahoo('SPY', '6mo'); } catch (e) { errors.push('SPY: ' + e.message); }
  if (table.length < 6) return { id: 'sectors', title: 'Impatto sui settori azionari', icon: 'layers', tone: 'neu', toneLabel: TONE_LABEL.neu, items: [], table: [], reading: 'Dati sui settori non disponibili in questo momento.' };
  if (spy) { const s1 = pctBack(spy, 1), s5 = pctBack(spy, 5), s21 = pctBack(spy, 21); table.forEach((t) => { t.rel1 = t.d1 - s1; t.rel5 = t.w1 - s5; t.rel21 = t.m1 - s21; }); }
  const items = [];
  const byM = [...table].sort((a, b) => b.m1 - a.m1), top = byM[0], bot = byM[byM.length - 1];
  const up = table.filter((t) => t.d1 > 0).length;
  items.push(item('breadthSec', 'Settori in rialzo oggi', `${up} su ${table.length}`, 'quanti dei settori dell\'S&P 500 chiudono in positivo', null, up >= table.length * 0.7 ? 'pos' : up >= table.length * 0.35 ? 'neu' : 'warn',
    'Quando quasi tutti i settori salgono il movimento è generalizzato; quando solo pochi salgono, il mercato è diviso. Lettura: almeno il 70% dei settori in rialzo favorevole, tra il 35% e il 70% neutro, meno del 35% da monitorare.', { asof: 'oggi' }));
  items.push(item('leader', 'Settore più forte (1 mese)', top.name, `${top.sym} · ${sg(top.m1)}% in un mese`, { text: sg(top.d1, 2) + '% oggi', dir: dir(top.d1, 0.02) }, 'neu', 'Il settore con il miglior rendimento nell\'ultimo mese: indica dove sta andando il denaro.', { asof: 'ultimo mese' }));
  items.push(item('laggard', 'Settore più debole (1 mese)', bot.name, `${bot.sym} · ${sg(bot.m1)}% in un mese`, { text: sg(bot.d1, 2) + '% oggi', dir: dir(bot.d1, 0.02) }, bot.m1 < -8 ? 'warn' : 'neu', 'Il settore con il peggior rendimento nell\'ultimo mese: indica da dove sta uscendo il denaro. Lettura: calo oltre l\'8% in un mese da monitorare.', { asof: 'ultimo mese' }));
  const cyc = table.filter((t) => t.kind === 'cic'), dif = table.filter((t) => t.kind === 'dif');
  const avg = (a, k) => a.reduce((s, x) => s + x[k], 0) / a.length;
  if (cyc.length && dif.length) { const sp = avg(cyc, 'm1') - avg(dif, 'm1'); items.push(item('cycdef', 'Ciclici contro difensivi (1 mese)', sg(sp) + ' pt', 'settori che seguono l\'economia (tecnologia, finanziari, industriali…) contro quelli stabili (salute, beni di base, utility)', null,
    sp > 1 ? 'pos' : sp > -2 ? 'neu' : sp > -6 ? 'warn' : 'neg',
    'In fase di fiducia vanno meglio i settori ciclici (legati alla crescita); quando cresce la paura gli investitori si rifugiano nei difensivi (salute, beni di base, servizi pubblici). Lettura: ciclici avanti di oltre 1 punto favorevole, tra −2 e +1 neutro, difensivi avanti di 2–6 punti da monitorare, di oltre 6 punti sotto pressione (fuga verso i settori difensivi).', { asof: 'ultimo mese' })); }
  const sum = summarize(items);
  return { id: 'sectors', title: 'Impatto sui settori azionari', icon: 'layers', ...sum, items, table, gauge: ['breadthSec', 'cycdef'],
    reading: `Oggi ${up} settori su ${table.length} salgono; nell'ultimo mese il più forte è ${top.name} (${sg(top.m1)}%), il più debole ${bot.name} (${sg(bot.m1)}%)${cyc.length && dif.length ? `; ${avg(cyc, 'm1') > avg(dif, 'm1') ? 'i settori ciclici battono quelli difensivi' : 'i difensivi battono i ciclici'}` : ''}.` };
}

// =====================================================================================================================
// 5. TASSI E TREASURIES: curva, Fed, tetto al debito e deficit
// =====================================================================================================================
const CURVE = [['3M', 'DGS3MO'], ['2A', 'DGS2'], ['5A', 'DGS5'], ['10A', 'DGS10'], ['30A', 'DGS30']];
async function groupRates(errors) {
  const jobs = { cpi: () => fred('CPILFESL', 3), t10y2y: () => fred('T10Y2Y', 4), t10y3m: () => fred('T10Y3M', 4), real: () => fred('DFII10', 2), be: () => fred('T10YIE', 2), up: () => fred('DFEDTARU', 4), lo: () => fred('DFEDTARL', 4), effr: () => fred('EFFR', 1), walcl: () => fred('WALCL', 2),
    dtp: () => fiscal('v2/accounting/od/debt_to_penny?sort=-record_date&page[size]=420&fields=record_date,tot_pub_debt_out_amt'), dts: () => fiscal('v1/accounting/dts/debt_subject_to_limit?sort=-record_date&page[size]=14'),
    deficit: () => fred('FYFSD', 6), gdpn: () => fred('GDP', 2), debtgdp: () => fred('GFDEGDQ188S', 4), interest: () => fred('A091RC1Q027SBEA', 3), outlays: () => fred('FYONET', 6) };
  CURVE.forEach(([k, id]) => { jobs[k] = () => fred(id, 3); });
  const S = await settle(jobs, errors);

  // ---- curva dei tassi ----
  const cItems = [], pts = [];
  CURVE.forEach(([k]) => { const s = S[k]; if (s) pts.push({ k, now: last(s).v, ago1m: (onOrBefore(s, daysAgo(last(s).d, 30)) || {}).v ?? null, ago1y: (onOrBefore(s, daysAgo(last(s).d, 365)) || {}).v ?? null, d: last(s).d }); });
  const p10 = pts.find((p) => p.k === '10A'), p2 = pts.find((p) => p.k === '2A'), p30 = pts.find((p) => p.k === '30A');
  if (p10) cItems.push(item('y10', 'Rendimento Treasury a 10 anni', nf(p10.now, 2) + '%', 'il tasso di riferimento per mutui e valutazioni delle azioni', { text: sg((p10.now - p10.ago1m) * 100, 0) + ' pb in un mese', dir: dir(p10.now - p10.ago1m, 0.01) },
    p10.now > 5 ? 'neg' : p10.now > 4.5 ? 'warn' : p10.now > 3.5 ? 'neu' : 'pos',
    'È il rendimento che lo Stato USA paga per prestiti a 10 anni: guida i tassi dei mutui e il "prezzo" di tutti gli investimenti. Se sale, le azioni (soprattutto quelle di crescita) valgono meno. Lettura: sotto 3,5% favorevole, 3,5–4,5% neutro, 4,5–5% da monitorare, oltre 5% sotto pressione. (pb = punti base, 100 pb = 1%.)',
    { asof: 'dato del ' + dayIt(p10.d) }));
  if (p2) cItems.push(item('y2', 'Rendimento Treasury a 2 anni', nf(p2.now, 2) + '%', 'riflette dove il mercato vede i tassi della Fed', { text: sg((p2.now - p2.ago1m) * 100, 0) + ' pb in un mese', dir: dir(p2.now - p2.ago1m, 0.01) }, 'neu',
    'Il rendimento a 2 anni segue le attese sulla politica della Fed: se sale, il mercato scommette su tassi più alti.', { asof: 'dato del ' + dayIt(p2.d) }));
  if (p30) cItems.push(item('y30', 'Rendimento Treasury a 30 anni', nf(p30.now, 2) + '%', 'costo del debito di lungo periodo', { text: sg((p30.now - p30.ago1m) * 100, 0) + ' pb in un mese', dir: dir(p30.now - p30.ago1m, 0.01) },
    p30.now > 5.25 ? 'neg' : p30.now > 5 ? 'warn' : 'neu', 'Oltre il 5% è un livello che negli ultimi anni ha messo sotto pressione azioni e mutui. Lettura: sotto 5% neutro, 5–5,25% da monitorare, oltre 5,25% sotto pressione.', { asof: 'dato del ' + dayIt(p30.d) }));
  const s2 = S.t10y2y && last(S.t10y2y).v, s3 = S.t10y3m && last(S.t10y3m).v;
  let invertedUntil = null; if (S.t10y2y) { for (let i = S.t10y2y.length - 1; i >= 0; i--) if (S.t10y2y[i].v < 0) { invertedUntil = S.t10y2y[i].d; break; } }
  if (s2 != null) cItems.push(item('s2', 'Curva 10 anni − 2 anni', sg(s2 * 100, 0) + ' pb', s2 < 0 ? 'curva INVERTITA' : s2 < 0.25 ? 'curva piatta' : 'curva normale', { text: invertedUntil ? 'ultima inversione: ' + monthIt(invertedUntil) : 'nessuna inversione negli ultimi 4 anni', dir: dir(s2, 0.01) },
    s2 < 0 ? 'neg' : s2 < 0.25 ? 'warn' : 'pos',
    'Di norma i prestiti lunghi rendono più dei corti. Quando i tassi a 2 anni superano quelli a 10 la curva è "invertita": storicamente un segnale che il mercato teme un rallentamento (ha preceduto quasi tutte le recessioni USA, spesso con molti mesi di anticipo). Lettura: sotto zero sotto pressione, 0–25 pb da monitorare, oltre 25 pb normale (favorevole).',
    { asof: 'dato del ' + dayIt(last(S.t10y2y).d), spark: spark(S.t10y2y.map((x) => x.v * 100), 40) }));
  if (s3 != null) cItems.push(item('s3', 'Curva 10 anni − 3 mesi', sg(s3 * 100, 0) + ' pb', s3 < 0 ? 'curva INVERTITA' : s3 < 0.25 ? 'curva piatta' : 'curva normale', null, s3 < 0 ? 'neg' : s3 < 0.25 ? 'warn' : 'pos',
    'È la versione della curva che la Fed di New York usa per stimare il rischio di recessione. Lettura: sotto zero sotto pressione, 0–25 pb da monitorare, oltre 25 pb favorevole.', { asof: 'dato del ' + dayIt(last(S.t10y3m).d) }));
  if (S.real && S.be) cItems.push(item('real10', 'Rendimento reale a 10 anni', nf(last(S.real).v, 2) + '%', `inflazione attesa dal mercato ${nf(last(S.be).v, 2)}%`, null, last(S.real).v > 2.5 ? 'neg' : last(S.real).v > 2 ? 'warn' : last(S.real).v > 1 ? 'neu' : 'pos',
    'È il rendimento del Treasury a 10 anni al netto dell\'inflazione attesa: è il vero "costo del denaro". Un rendimento reale alto toglie valore all\'oro e alle azioni di crescita. Lettura: sotto 1% favorevole, 1–2% neutro, 2–2,5% da monitorare, oltre 2,5% sotto pressione.', { asof: 'dato del ' + dayIt(last(S.real).d) }));
  const curveSum = summarize(cItems);

  // ---- Fed ----
  const fItems = [];
  if (S.up && S.lo) {
    const u = last(S.up).v, l = last(S.lo).v; let lastChange = null; for (let i = S.up.length - 1; i > 0; i--) if (S.up[i].v !== S.up[i - 1].v) { lastChange = { d: S.up[i].d, bp: (S.up[i].v - S.up[i - 1].v) * 100 }; break; }
    fItems.push(item('range', 'Tasso della Fed (target)', `${nf(l, 2)}–${nf(u, 2)}%`, S.effr ? `tasso effettivo ${nf(last(S.effr).v, 2)}%` : '', lastChange ? { text: `ultima mossa: ${sg(lastChange.bp, 0)} pb a ${monthIt(lastChange.d)}`, dir: dir(lastChange.bp, 1) } : { text: 'invariato da oltre 4 anni', dir: 'flat' }, 'neu',
      'È la fascia in cui la Fed fa muovere il costo del denaro a brevissimo termine: guida i tassi di mutui, prestiti e rendimenti dei titoli di Stato. Ogni passo vale di solito 25 punti base (0,25%).', { asof: 'al ' + dayIt(last(S.up).d) }));
  }
  // orientamento: tasso reale (tasso Fed meno inflazione core) e attese del mercato (rendimento a 2 anni meno tasso Fed: sopra zero = si scommette su rialzi)
  const cpiYoy = S.cpi && yoyAt(S.cpi);
  if (S.effr && cpiYoy != null) { const e = last(S.effr).v, real = e - cpiYoy; fItems.push(item('real', 'Tasso reale della Fed', sg(real) + '%', `tasso Fed ${nf(e, 2)}% meno inflazione core ${nf(cpiYoy)}%`, null,
    real > 1.5 ? 'neg' : real > 0.5 ? 'warn' : real > -0.5 ? 'neu' : 'pos',
    'È il tasso della Fed "ripulito" dall\'inflazione: dice quanto la politica monetaria frena (o spinge) davvero l\'economia. Lettura: oltre +1,5% molto restrittiva (sotto pressione), +0,5/+1,5% restrittiva (da monitorare), vicino a zero neutrale, sotto −0,5% accomodante (favorevole).', { asof: 'tasso al ' + dayIt(last(S.effr).d) })); }
  if (S.effr && p2) { const spr = p2.now - last(S.effr).v; fItems.push(item('expect', 'Cosa si aspetta il mercato dalla Fed', sg(spr * 100, 0) + ' pb', spr > 0.15 ? 'il rendimento a 2 anni è sopra il tasso Fed: il mercato scommette su RIALZI' : spr < -0.15 ? 'il rendimento a 2 anni è sotto il tasso Fed: il mercato scommette su TAGLI' : 'il mercato non si aspetta cambi di tasso', null,
    spr > 1 ? 'neg' : spr > 0.4 ? 'warn' : spr < -0.4 ? 'pos' : 'neu',
    'Il rendimento a 2 anni anticipa dove il mercato vede i tassi della Fed: se è molto sopra il tasso attuale, gli investitori si aspettano rialzi (negativo per le azioni); se è sotto, si aspettano tagli (positivo). Lettura: oltre +100 pb sotto pressione, +40/+100 pb da monitorare, tra −40 e +40 neutro, sotto −40 pb favorevole.', { asof: 'dato del ' + dayIt(p2.d) })); }
  if (S.walcl) { const w = last(S.walcl).v, w13 = last(S.walcl, 13).v, ch = (w / w13 - 1) * 100; fItems.push(item('balance', 'Bilancio della Fed', usdM(w), 'titoli e prestiti in mano alla banca centrale', { text: sg(ch) + '% in 13 settimane', dir: dir(ch, 0.1) },
    ch > 1 ? 'pos' : ch > -1 ? 'neu' : 'warn',
    'Quando la Fed compra titoli (bilancio che cresce) immette liquidità nel sistema e aiuta le azioni; quando li lascia scadere senza sostituirli (bilancio che cala, "quantitative tightening") la toglie. Lettura: in crescita di oltre l\'1% in 13 settimane favorevole, tra −1% e +1% neutro, in calo di oltre l\'1% da monitorare.', { asof: 'sett. al ' + dayIt(last(S.walcl).d), spark: spark(S.walcl.map((x) => x.v / 1e6), 52) })); }
  const fedSum = summarize(fItems);

  // ---- tetto al debito e deficit ----
  const dItems = []; let bar = null;
  if (S.dtp && S.dtp.length) {
    const rows = S.dtp.map((r) => ({ d: r.record_date, v: Number(r.tot_pub_debt_out_amt) / 1e6 })).sort((a, b) => (a.d < b.d ? -1 : 1)), now = last(rows), y1 = onOrBefore(rows, daysAgo(now.d, 365)), d90 = onOrBefore(rows, daysAgo(now.d, 90));
    dItems.push(item('debt', 'Debito pubblico USA', usdM(now.v, 1), 'debito federale totale', y1 ? { text: sg((now.v / y1.v - 1) * 100) + '% in un anno', dir: 'up' } : null, 'warn',
      'È tutto ciò che lo Stato federale americano deve ai suoi creditori. Cresce ogni giorno perché la spesa supera le entrate (deficit). Un debito alto non è un problema immediato, ma rende lo Stato più sensibile ai tassi di interesse e alle crisi di fiducia.', { asof: 'dato del ' + dayIt(now.d) }));
    const dts = (S.dts || []); const d0 = dts.length ? dts[0].record_date : null, today = dts.filter((r) => r.record_date === d0);
    if (today.length) {
      const bal = (catg) => today.filter((r) => r.debt_catg === catg).reduce((s, r) => s + Number(r.close_today_bal), 0);
      const limit = bal('Statutory Debt Limit'), subject = bal('Debt Held by the Public') + bal('Intragovernmental Holdings') - bal('Debt Not Subject to Limit') + bal('Other Debt Subject to Limit'), room = limit - subject;
      if (limit > 0 && subject > 0) {
        const pace = d90 ? (now.v - d90.v) / ((new Date(now.d) - new Date(d90.d)) / DAY) : null, days = pace && pace > 0 ? Math.round(room / pace) : null;
        const pctRoom = (room / limit) * 100;
        bar = { limit, subject, room, pctUsed: (subject / limit) * 100, date: d0 };
        dItems.push(item('cap', 'Tetto al debito', usdM(limit, 1), `margine rimasto ${usdM(room, 2)} (${nf(pctRoom)}% del tetto)`, days ? { text: `a questo ritmo circa ${days} giorni`, dir: 'flat' } : null,
          pctRoom < 1 ? 'neg' : pctRoom < 3 ? 'warn' : 'neu',
          `Il Congresso fissa per legge un limite massimo al debito che il Tesoro può emettere. Quando ci si avvicina, il Tesoro ricorre a "misure straordinarie" e, se il tetto non viene alzato, rischia di non poter pagare tutto: è già successo (2011, 2023) e ogni volta ha agitato i mercati. La stima dei giorni divide il margine per l'aumento medio giornaliero del debito negli ultimi 90 giorni: è un calcolo semplice, non una previsione (il Tesoro può guadagnare tempo con le misure straordinarie). Lettura: margine oltre il 3% neutro, 1–3% da monitorare, sotto l'1% sotto pressione.`,
          { asof: 'dato del ' + dayIt(d0) }));
      }
    }
  }
  const fy = S.deficit && last(S.deficit), gdpN = S.gdpn && last(S.gdpn);
  if (fy) { const def = -fy.v, dg = gdpN ? (def / (gdpN.v * 1000)) * 100 : null; dItems.push(item('deficit', 'Deficit federale annuo', usdM(def, 2), `anno fiscale ${fy.d.slice(0, 4)}${dg != null ? ` · ${nf(dg)}% del PIL` : ''}`, S.deficit.length > 1 ? { text: 'anno prima ' + usdM(-last(S.deficit, 1).v, 2), dir: dir(def + last(S.deficit, 1).v, 1) } : null,
    dg == null ? 'warn' : dg > 7 ? 'neg' : dg > 4.5 ? 'warn' : 'neu',
    'È la differenza tra quello che lo Stato spende e quello che incassa in un anno: va finanziata emettendo nuovi titoli di Stato (Treasuries), che pesano sui rendimenti. Lettura: sotto il 4,5% del PIL neutro, 4,5–7% da monitorare, oltre il 7% sotto pressione.', { asof: 'anno fiscale al ' + dayIt(fy.d) })); }
  if (S.debtgdp) dItems.push(item('debtgdp', 'Debito / PIL', nf(last(S.debtgdp).v, 0) + '%', 'debito federale rispetto a ciò che produce l\'economia in un anno', S.debtgdp.length > 4 ? { text: sg(last(S.debtgdp).v - last(S.debtgdp, 4).v) + ' pt in un anno', dir: dir(last(S.debtgdp).v - last(S.debtgdp, 4).v, 0.2) } : null,
    last(S.debtgdp).v > 130 ? 'neg' : last(S.debtgdp).v > 90 ? 'warn' : 'neu', 'Il rapporto tra debito e PIL dice quanto è pesante il debito rispetto alla capacità di ripagarlo. Lettura: sotto il 90% neutro, 90–130% da monitorare, oltre il 130% sotto pressione.', { asof: 'trimestre ' + monthIt(last(S.debtgdp).d) }));
  if (S.interest && S.outlays) { const i = last(S.interest).v * 1000, o = Math.abs(last(S.outlays).v), sh = (i / o) * 100; dItems.push(item('interest', 'Interessi sul debito', usdM(i, 2), `ogni anno, circa il ${nf(sh, 0)}% di tutta la spesa federale`, null, sh > 20 ? 'neg' : sh > 12 ? 'warn' : 'neu',
    'Quanto lo Stato paga ogni anno solo di interessi: più è alta questa voce, meno soldi restano per il resto, e più il debito diventa un problema di tassi. Lettura: sotto il 12% della spesa neutro, 12–20% da monitorare, oltre il 20% sotto pressione.', { asof: 'trimestre ' + monthIt(last(S.interest).d) })); }
  const debtSum = summarize(dItems);

  const all = [...cItems, ...fItems, ...dItems], sum = summarize(all);
  const parts = [];
  if (p10) parts.push(`il Treasury a 10 anni rende il ${nf(p10.now, 2)}%`);
  if (s2 != null) parts.push(`la curva 10−2 anni è ${s2 < 0 ? 'invertita' : s2 < 0.25 ? 'piatta' : 'normale'} (${sg(s2 * 100, 0)} pb)`);
  if (bar) parts.push(`il margine sotto il tetto al debito è ${usdM(bar.room, 2)}`);
  return { id: 'rates', title: 'Tassi di interesse e mercato obbligazionario (Treasuries)', icon: 'trend', ...sum, items: all,
    reading: parts.length ? `Oggi ${parts.join(', ')}.` : 'Dati sui tassi non disponibili in questo momento.',
    sub: [{ id: 'curve', title: 'Curva dei tassi', ...curveSum, items: cItems, curve: pts, gauge: ['s2', 's3'] }, { id: 'fed', title: 'Politica monetaria della Fed', ...fedSum, items: fItems, gauge: ['real', 'expect'] }, { id: 'debt', title: 'Tetto al debito e deficit', ...debtSum, items: dItems, bar }] };
}

// =====================================================================================================================
// 6. LIQUIDITÀ A MERCATO
// =====================================================================================================================
async function groupLiquidity(errors) {
  const S = await settle({ walcl: () => fred('WALCL', 3), tga: () => fred('WTREGEN', 3), rrp: () => fred('RRPONTSYD', 3), res: () => fred('WRESBAL', 3), m2: () => fred('M2SL', 3), nfci: () => fred('NFCI', 3) }, errors);
  const items = []; let net = [];
  if (S.walcl && S.tga && S.rrp) {
    net = S.walcl.map((w) => { const t = onOrBefore(S.tga, w.d), r = onOrBefore(S.rrp, w.d); return t && r ? { d: w.d, v: w.v - t.v - r.v * 1000 } : null; }).filter(Boolean);
    if (net.length > 14) {
      const now = last(net), c4 = (now.v / last(net, 4).v - 1) * 100, c13 = (now.v / last(net, 13).v - 1) * 100;
      items.push(item('net', 'Liquidità netta del sistema', usdM(now.v, 2), 'bilancio Fed − conto del Tesoro − reverse repo', { text: `${sg(c4)}% in 4 sett. · ${sg(c13)}% in 13 sett.`, dir: dir(c13, 0.1) },
        c13 > 2 ? 'pos' : c13 > -2 ? 'neu' : c13 > -5 ? 'warn' : 'neg',
        'È una misura molto seguita della "benzina" disponibile per i mercati: parte dai soldi che la Fed ha creato (bilancio) e toglie quelli "parcheggiati" nel conto del Tesoro (TGA) e nel reverse repo. Se cresce, c\'è più denaro che può andare in azioni e obbligazioni; se cala, i mercati hanno meno sostegno. Lettura (variazione in 13 settimane): oltre +2% favorevole, tra −2% e +2% neutra, −2/−5% da monitorare, oltre −5% sotto pressione.',
        { asof: 'sett. al ' + dayIt(now.d), spark: spark(net.map((x) => x.v / 1e6), 52) }));
    }
  }
  if (S.walcl) { const w = last(S.walcl).v, ch = (w / last(S.walcl, 13).v - 1) * 100; items.push(item('fed', 'Bilancio della Fed', usdM(w), 'quanto denaro ha creato la banca centrale', { text: sg(ch) + '% in 13 settimane', dir: dir(ch, 0.1) }, ch > 1 ? 'pos' : ch > -1 ? 'neu' : 'warn', 'Vedi "Politica monetaria della Fed": la crescita del bilancio immette liquidità, la riduzione la toglie.', { asof: 'sett. al ' + dayIt(last(S.walcl).d) })); }
  if (S.tga) { const t = last(S.tga).v, ch = (t / last(S.tga, 13).v - 1) * 100; items.push(item('tga', 'Conto del Tesoro presso la Fed (TGA)', usdM(t, 2), 'il "conto corrente" dello Stato USA', { text: sg(ch) + '% in 13 settimane', dir: dir(ch, 0.1) }, ch > 25 ? 'warn' : 'neu',
    'Quando il Tesoro incassa tasse o emette titoli, i soldi finiscono qui e escono dal sistema bancario: un TGA che sale in fretta drena liquidità dai mercati; quando il Tesoro spende, la restituisce. Lettura: crescita oltre il 25% in 13 settimane da monitorare (drenaggio), altrimenti neutro.', { asof: 'sett. al ' + dayIt(last(S.tga).d) })); }
  if (S.rrp) { const r = last(S.rrp).v, r13 = (onOrBefore(S.rrp, daysAgo(last(S.rrp).d, 91)) || {}).v; items.push(item('rrp', 'Reverse repo overnight (RRP)', '$' + nf(r, r < 10 ? 1 : 0) + ' miliardi', 'denaro che i fondi parcheggiano alla Fed per una notte', r13 != null ? { text: '13 settimane fa $' + nf(r13, 0) + ' miliardi', dir: dir(r - r13, 1) } : null, r < 50 ? 'neu' : 'pos',
    'Era un enorme serbatoio di liquidità inutilizzata (oltre 2.000 miliardi nel 2022): quando si svuota, la liquidità è tornata nel sistema e i mercati non hanno più questo "cuscinetto" da cui attingere. Un valore vicino a zero significa serbatoio esaurito.', { asof: 'dato del ' + dayIt(last(S.rrp).d), spark: spark(S.rrp.map((x) => x.v), 60) })); }
  if (S.res) { const v = last(S.res).v, ch = (v / last(S.res, 13).v - 1) * 100; items.push(item('reserves', 'Riserve delle banche presso la Fed', usdM(v, 2), 'denaro "al sicuro" che le banche tengono in cassa', { text: sg(ch) + '% in 13 settimane', dir: dir(ch, 0.1) }, ch < -8 ? 'warn' : 'neu',
    'Se le riserve scendono troppo le banche diventano più caute nel prestare e il mercato monetario può avere tensioni (come a settembre 2019). Lettura: calo oltre l\'8% in 13 settimane da monitorare, altrimenti neutro.', { asof: 'sett. al ' + dayIt(last(S.res).d) })); }
  if (S.m2) { const y = yoyAt(S.m2); if (y != null) items.push(item('m2', 'Massa monetaria M2', nf(y) + '%', 'crescita su base annua del denaro in circolazione', { text: usdM(last(S.m2).v * 1000, 1), dir: dir(y, 0.1) }, y > 3 ? 'pos' : y > 0 ? 'neu' : 'warn',
    'M2 è il totale di contanti, conti correnti e depositi: se cresce, c\'è più denaro nell\'economia (spinta a consumi e investimenti); se si riduce, come nel 2022-23, è un freno. Lettura: oltre +3% annuo favorevole, 0–3% neutro, in calo da monitorare.', { asof: monthIt(last(S.m2).d) })); }
  if (S.nfci) { const v = last(S.nfci).v; items.push(item('nfci', 'Condizioni finanziarie (NFCI)', sg(v, 2), v < 0 ? 'più facili della media storica' : 'più dure della media storica', { text: 'sett. al ' + dayIt(last(S.nfci).d), dir: dir(v, 0.01) }, v < -0.3 ? 'pos' : v < 0.1 ? 'neu' : v < 0.5 ? 'warn' : 'neg',
    'Indice della Fed di Chicago che riassume 105 misure di tassi, spread di credito, azioni e leva: sotto zero significa che è facile e poco costoso finanziarsi. Lettura: sotto −0,3 favorevole, tra −0,3 e +0,1 neutro, +0,1/+0,5 da monitorare, oltre +0,5 sotto pressione.', { asof: 'sett. al ' + dayIt(last(S.nfci).d), spark: spark(S.nfci.map((x) => x.v), 52) })); }
  const sum = summarize(items);
  const n = items.find((i) => i.id === 'net');
  return { id: 'liquidity', title: 'Liquidità a mercato', icon: 'scale', ...sum, items,
    reading: n ? `La liquidità netta del sistema è ${n.value} (${n.delta.text.replace(/sett./g, 'settimane')}); ${S.nfci ? `le condizioni finanziarie sono ${last(S.nfci).v < 0 ? 'più facili' : 'più dure'} della media` : ''}${S.rrp ? `, il serbatoio dei reverse repo è ${last(S.rrp).v < 50 ? 'quasi vuoto' : 'ancora capiente'}` : ''}.` : 'Dati sulla liquidità non disponibili in questo momento.' };
}

// =====================================================================================================================
async function getIndicators({ ctxFn = null, translate = null } = {}) {
  const errors = [];
  const [macro, geo, equity, sectors, rates, liquidity] = await Promise.all([
    groupMacro(errors), groupGeo(errors, ctxFn, translate), groupEquity(errors), groupSectors(errors), groupRates(errors), groupLiquidity(errors),
  ].map((p) => p.catch((e) => { errors.push(e.message); return null; })));
  const groups = [macro, geo, equity, sectors, rates, liquidity].filter(Boolean).map(decorate);
  return { generatedAt: new Date().toISOString(), overall: overallOf(groups), groups, errors };
}

module.exports = { getIndicators, summarize, TONE_LABEL };
