// Logique pure (sans DOM) : découpage de la saisie, quantités, recherche hybride, totaux.
// Les seuils sont regroupés dans CONFIG : ce sont des valeurs de départ, à ajuster à l'usage.

export const CONFIG = {
  weightEmb: 0.5,   // poids des embeddings dans le score final (le reste = mots communs)
  embFloor: 0.78,   // cosinus e5 en dessous duquel le score embedding vaut 0
  embSpan: 0.17,    // écart de cosinus au-dessus du plancher pour atteindre 1
  sure: 0.72,       // score >= sure : ligne acceptée sans alerte
  maybe: 0.45,      // score >= maybe : acceptée mais marquée "à vérifier"
  maxAlternatives: 5,
};

// Abréviations courantes (clés au singulier, sans accents). À compléter librement.
export const ALIASES = {
  bolo: 'bolognaise', bolognese: 'bolognaise', carbo: 'carbonara', mozza: 'mozzarella',
  yogourt: 'yaourt', yoghourt: 'yaourt', yogurt: 'yaourt', yahourt: 'yaourt',
  spag: 'spaghetti', pasta: 'pate',
};

const STOP = new Set([
  'de', 'du', 'des', 'd', 'la', 'le', 'les', 'l', 'a', 'au', 'aux', 'en', 'et', 'avec', 'sur',
  'portion', 'part', 'assiette', 'bol', 'demi', 'demie', 'moitie', 'j', 'ai', 'pris', 'mange',
]);

const NUMBER_WORDS = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10 };

export function normalize(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function singular(t) {
  return t.length > 3 && /[sx]$/.test(t) ? t.slice(0, -1) : t;
}

export function tokens(s) {
  const out = [];
  for (const raw of normalize(s).split(' ')) {
    if (!raw) continue;
    const t = singular(raw);
    const a = ALIASES[t] ?? ALIASES[raw] ?? t;
    if (!STOP.has(raw) && !STOP.has(a)) out.push(a);
  }
  return out;
}

export const normKey = (s) => tokens(s).join(' ');

// "pâtes bolo, 2 yaourts à la fraise et une compote" -> ["pâtes bolo", "2 yaourts à la fraise", "une compote"]
export function splitInput(text) {
  return String(text)
    .split(/[,;+\n]+|\s+(?:et|avec|plus)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Extrait la quantité en tête de segment ("2 yaourts", "x2", "une demi pizza", "1/2 pizza", "½ pizza").
export function parseQuantity(raw) {
  let s = String(raw).trim().replace(/½/g, '0.5 ').replace(/¼/g, '0.25 ');
  let qty = 1;
  let m;
  if ((m = s.match(/^(\d+)\s*\/\s*(\d+)\s*/))) {
    qty = Number(m[1]) / Number(m[2]);
    s = s.slice(m[0].length);
  } else if ((m = s.match(/^(\d+(?:[.,]\d+)?)\s*(?:[x×]\s*)?/i))) {
    qty = parseFloat(m[1].replace(',', '.'));
    s = s.slice(m[0].length);
  } else if ((m = s.match(/^(?:une?\s+demie?|demie?|moiti[eé])\b\s*/i))) {
    qty = 0.5;
    s = s.slice(m[0].length);
  } else if ((m = s.match(/^(un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b\s*/i))) {
    qty = NUMBER_WORDS[m[1].toLowerCase()];
    s = s.slice(m[0].length);
  } else if ((m = s.match(/\s*[x×]\s*(\d+)\s*$/i))) {
    qty = Number(m[1]);
    s = s.slice(0, m.index);
  }
  if (!(qty > 0)) qty = 1;
  return { qty, text: s.trim() };
}

export const formatQty = (q) => (q === 1 ? '' : q === 0.5 ? '½' : String(q));

// ---------- Recherche ----------

export function buildIndex(products) {
  return products.map((p, i) => ({ i, id: p.id, name: p.name, tok: tokens(p.name), nameKey: normalize(p.name) }));
}

function withinEdits(a, b, max) { // distance d'édition <= max ? (tokens courts : DP simple)
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] <= max;
}

function tokenSim(q, p) {
  if (q === p) return 1;
  if (q.length >= 4 && p.length >= 4 && (p.startsWith(q) || q.startsWith(p))) return 0.8;
  const maxEdits = Math.min(q.length, p.length) >= 8 ? 2 : Math.min(q.length, p.length) >= 5 ? 1 : 0;
  if (maxEdits && withinEdits(q, p, maxEdits)) return 0.85;
  return 0;
}

export function lexScore(qTok, pTok) {
  if (!qTok.length || !pTok.length) return 0;
  const best = (t, list) => list.reduce((m, o) => Math.max(m, tokenSim(t, o)), 0);
  const covQ = qTok.reduce((s, t) => s + best(t, pTok), 0) / qTok.length;
  const covP = pTok.reduce((s, t) => s + best(t, qTok), 0) / pTok.length;
  return 0.75 * covQ + 0.25 * covP;
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// qVec / vectors / dim optionnels : sans eux, recherche par mots uniquement.
export function rank(query, index, qVec = null, vectors = null, dim = 0, limit = CONFIG.maxAlternatives) {
  const qTok = tokens(query);
  const useEmb = !!(qVec && vectors && dim && vectors.length >= index.length * dim);
  const scored = index.map((p) => {
    const lex = lexScore(qTok, p.tok);
    let emb = null;
    if (useEmb) {
      let dot = 0;
      const off = p.i * dim;
      for (let k = 0; k < dim; k++) dot += qVec[k] * vectors[off + k];
      emb = clamp01((dot - CONFIG.embFloor) / CONFIG.embSpan);
    }
    const score = emb === null ? lex : (1 - CONFIG.weightEmb) * lex + CONFIG.weightEmb * emb;
    return { i: p.i, score, lex, emb, nameKey: p.nameKey };
  });
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const out = [];
  for (const c of scored) {
    if (seen.has(c.nameKey)) continue;
    seen.add(c.nameKey);
    out.push(c);
    if (out.length === limit) break;
  }
  return out;
}

export function confidence(cands) {
  const [top, second] = cands;
  if (!top) return 'none';
  if (top.score < CONFIG.maybe) return 'none';
  if (top.score < CONFIG.sure) return 'check';
  if (second && top.score - second.score < 0.02) return 'check';
  return 'sure';
}

// ---------- Totaux ----------

const FIELDS = ['kcal', 'kj', 'fat', 'sat', 'carb', 'sugar', 'fiber', 'prot', 'salt'];

export function totals(items) { // items : [{ product, qty }]
  const t = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  const allergens = new Set();
  for (const { product, qty } of items) {
    for (const f of FIELDS) t[f] += (product[f] ?? 0) * qty;
    for (const a of product.allergens ?? []) allergens.add(a);
  }
  for (const f of FIELDS) t[f] = Math.round(t[f] * 10) / 10;
  return { ...t, allergens: [...allergens].sort((a, b) => a.localeCompare(b, 'fr')) };
}
