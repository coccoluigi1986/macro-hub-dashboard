// BOZZA — "scala a quattro zone" per ogni dato degli indicatori chiave (poi diventa lib/indicator-bars.js).
//
// Ogni dato ha già il suo semaforo (pos/neu/warn/neg) con soglie scritte nel testo "Cosa significa". Qui le soglie diventano una POSIZIONE sulla barra:
//   0–25 % favorevole · 25–50 % neutro · 50–75 % da monitorare · 75–100 % sotto pressione.
// Più la barra è lunga, più il dato è vicino al limite. Le linee verticali sono i confini tra le zone, uguali per tutti i dati (come nella tabella di riferimento).
// La zona è sempre quella del semaforo (non si contraddicono mai); il valore decide solo dove cade DENTRO la zona.
// Nessuna soglia nuova: sono le stesse già scritte in lib/indicators.js; qui si riportano per poterle disegnare.
//   cuts = valori che separano una zona dalla successiva, dal migliore al peggiore · ends = valore a 0 % (migliore) e a 100 % (peggiore)
//   tones = quali semafori esistono per quel dato (di solito tutti e quattro) · v = dove leggere il numero (valore, variazione o testo di supporto)
// I dati senza una scala numerica (testo, orientamento) sono "qualitativi": barra tratteggiata a metà della loro zona.

const ZONE = { pos: 0, neu: 1, warn: 2, neg: 3 };
const T4 = ['pos', 'neu', 'warn', 'neg'];

// numeri scritti all'italiana ("1.234", "−0,6", "+165"): tutti quelli presenti nel testo, in ordine
const nums = (s) => (String(s == null ? '' : s).match(/[+\-−]?\d[\d.]*(?:,\d+)?/g) || []).map((x) => Number(x.replace('−', '-').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.').replace(/\.$/, '')));
const val = (i, k = 0) => nums(i.value)[k];
const dlt = (i, k = 0) => nums(i.delta && i.delta.text)[k];
const sub = (i, k = 0) => nums(i.sub)[k];
const subRe = (re) => (i) => { const m = String(i.sub || '').match(re); return m ? Number(m[1].replace(',', '.')) : null; };

const SPEC = {
  // economia e politica monetaria
  cpi: { v: (i) => val(i), cuts: [2.5, 3.5, 4.5], ends: [1.5, 5.5] },
  pce: { v: (i) => val(i), cuts: [2.3, 3, 4], ends: [1.5, 5] },
  un: { v: (i) => val(i), tones: ['pos', 'warn', 'neg'], cuts: [4.5, 5.2], ends: [3.5, 6.5] },
  nfp: { v: (i) => val(i), cuts: [150, 50, 0], ends: [300, -150] },
  gdp: { v: (i) => val(i), cuts: [2.5, 1.5, 0], ends: [4.5, -2] },
  claims: { v: (i) => val(i), cuts: [230, 260, 300], ends: [200, 360] },
  real: { v: (i) => val(i), cuts: [-0.5, 0.5, 1.5], ends: [-1.5, 2.5] },
  // geopolitica e settori
  geonews: { v: (i) => val(i), tones: ['pos', 'warn', 'neg'], cuts: [4, 10], ends: [0, 20] },
  wti: { v: (i) => dlt(i), abs: true, tones: ['neu', 'warn', 'neg'], cuts: [3, 8], ends: [0, 14] },
  gold: { v: (i) => dlt(i), tones: ['neu', 'warn'], cuts: [4], ends: [-4, 8] },
  dxy: { v: (i) => dlt(i), tones: ['neu', 'warn'], cuts: [1.5], ends: [-1.5, 3] },
  xle: { v: (i) => val(i), tones: ['neu', 'warn'], cuts: [5], ends: [-5, 10] },
  ita: { v: (i) => val(i), tones: ['neu', 'warn'], cuts: [5], ends: [-5, 10] },
  jets: { v: (i) => val(i), tones: ['neu', 'warn', 'neg'], cuts: [-2, -4], ends: [4, -8] },
  // mercato azionario
  spx: { v: subRe(/([\d,]+)% sotto il massimo/), noneIs: 0, cuts: [-5, -10, -20], ends: [0, -30], neg: true },
  ndx: { v: subRe(/([\d,]+)% sotto il massimo/), noneIs: 0, cuts: [-5, -10, -20], ends: [0, -30], neg: true },
  dji: { v: subRe(/([\d,]+)% sotto il massimo/), noneIs: 0, cuts: [-5, -10, -20], ends: [0, -30], neg: true },
  rut: { v: subRe(/([\d,]+)% sotto il massimo/), noneIs: 0, cuts: [-5, -10, -20], ends: [0, -30], neg: true },
  vix: { v: (i) => val(i), cuts: [15, 22, 30], ends: [10, 40] },
  breadth: { v: (i) => val(i), tones: ['pos', 'neu', 'warn'], cuts: [0.5, -1.5], ends: [3, -5] },
  hy: { v: (i) => val(i), cuts: [3.5, 4.5, 6], ends: [2.5, 8] },
  // settori
  breadthSec: { v: (i) => { const a = nums(i.value); return a.length >= 2 ? (a[0] / a[1]) * 100 : null; }, tones: ['pos', 'neu', 'warn'], cuts: [70, 35], ends: [100, 0] },
  laggard: { v: (i) => sub(i), tones: ['neu', 'warn'], cuts: [-8], ends: [8, -16] },
  cycdef: { v: (i) => val(i), cuts: [1, -2, -6], ends: [6, -12] },
  // curva dei tassi
  y10: { v: (i) => val(i), cuts: [3.5, 4.5, 5], ends: [2.5, 5.75] },
  y30: { v: (i) => val(i), tones: ['neu', 'warn', 'neg'], cuts: [5, 5.25], ends: [4, 5.75] },
  s2: { v: (i) => val(i), tones: ['pos', 'warn', 'neg'], cuts: [25, 0], ends: [150, -100] },
  s3: { v: (i) => val(i), tones: ['pos', 'warn', 'neg'], cuts: [25, 0], ends: [150, -100] },
  real10: { v: (i) => val(i), cuts: [1, 2, 2.5], ends: [0, 3.5] },
  // Fed
  expect: { v: (i) => val(i), cuts: [-40, 40, 100], ends: [-150, 200] },
  balance: { v: (i) => dlt(i), tones: ['pos', 'neu', 'warn'], cuts: [1, -1], ends: [4, -4] },
  // tetto al debito e deficit
  cap: { v: subRe(/\(([\d,]+)% del tetto\)/), tones: ['neu', 'warn', 'neg'], cuts: [3, 1], ends: [10, 0] },
  deficit: { v: subRe(/([\d,]+)% del PIL/), tones: ['neu', 'warn', 'neg'], cuts: [4.5, 7], ends: [0, 10] },
  debtgdp: { v: (i) => val(i), tones: ['neu', 'warn', 'neg'], cuts: [90, 130], ends: [60, 160] },
  interest: { v: subRe(/il (\d+)% di tutta/), tones: ['neu', 'warn', 'neg'], cuts: [12, 20], ends: [0, 30] },
  // liquidità
  net: { v: (i) => dlt(i, 2), cuts: [2, -2, -5], ends: [6, -10] },   // testo "+0,3% in 4 sett. · −0,6% in 13 sett.": la variazione a 13 settimane è il terzo numero
  fed: { v: (i) => dlt(i), tones: ['pos', 'neu', 'warn'], cuts: [1, -1], ends: [4, -4] },
  tga: { v: (i) => dlt(i), tones: ['neu', 'warn'], cuts: [25], ends: [-25, 50] },
  // rrp (reverse repo): soglia non numerica, resta qualitativo
  reserves: { v: (i) => dlt(i), tones: ['neu', 'warn'], cuts: [-8], ends: [8, -16] },
  m2: { v: (i) => val(i), tones: ['pos', 'neu', 'warn'], cuts: [3, 0], ends: [8, -4] },
  nfci: { v: (i) => val(i), cuts: [-0.3, 0.1, 0.5], ends: [-0.8, 1.2] },
};
// con "neg: true" i valori letti sono "% sotto il massimo" (positivi nel testo) ma la scala è negativa
const fix = (s, v) => (s.neg && v != null ? -Math.abs(v) : v);

const round = (x) => Math.round(x * 10) / 10;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const centre = (tone) => ZONE[tone] * 25 + 12.5;

// posizione (0–100) di un valore dentro la sua zona
function place(tone, v, tones, cuts, ends) {
  const k = tones.indexOf(tone);
  if (k < 0 || v == null || !isFinite(v)) return null;
  const bp = [ends[0], ...cuts, ends[1]], a = bp[k], b = bp[k + 1];
  if (a === b) return null;
  return round(ZONE[tone] * 25 + 25 * clamp((v - a) / (b - a), 0, 1));
}

// zb = { p: posizione %, q: true se qualitativo (barra tratteggiata) }
function barOf(it) {
  const s = SPEC[it.id];
  if (!s) return { p: centre(it.tone), q: true };
  let v = s.v(it);
  if (v == null && s.noneIs != null) v = s.noneIs;     // es. "sui massimi": nessuna distanza dal massimo
  v = fix(s, v);
  if (v != null && s.abs) v = Math.abs(v);
  const p = place(it.tone, v, s.tones || T4, s.cuts, s.ends);
  return p == null ? { p: centre(it.tone), q: true } : { p: clamp(p, 3, 98), q: false };
}

// punteggio 0–100 di un'area (100 = tutto favorevole) → posizione sulla stessa scala: 100–78 favorevole, 78–48 neutro, 48–22 da monitorare, sotto 22 sotto pressione
const areaPos = (score, tone) => (score == null ? null : clamp(place(tone, score, T4, [78, 48, 22], [100, 0]) ?? centre(tone), 3, 98));

function addBars(groups, overall) {
  const seen = new Set();
  const each = (g) => { (g.items || []).forEach((it) => { if (!seen.has(it)) { seen.add(it); it.zb = barOf(it); } }); (g.sub || []).forEach(each); };
  groups.forEach((g) => { each(g); if (g.score != null && g.tone !== 'off') g.zp = areaPos(g.score, g.tone); (g.sub || []).forEach((s) => { if (s.score != null && s.tone !== 'off') s.zp = areaPos(s.score, s.tone); }); });
  if (overall && overall.score != null) overall.zp = areaPos(overall.score, overall.tone);
  return { groups, overall };
}

module.exports = { addBars, barOf, SPEC, nums };
