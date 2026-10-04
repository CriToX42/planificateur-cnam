// Recherche approximative dans le catalogue : sans accents, ordre des mots libre,
// début de mot suffisant, fautes de frappe tolérées (une faute jusqu'à 6 lettres, deux au-delà).

const STOPWORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'en', 'et', 'a', 'au', 'aux', 'pour', 'un', 'une', 'par', 'sur']);

export const normalize = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function words(text) {
  return normalize(text).split(/[^a-z0-9+]+/).filter((w) => w && !STOPWORDS.has(w));
}

// Distance de Damerau-Levenshtein restreinte, abandonnée dès qu'elle dépasse max.
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

const allowedTypos = (term) => (term.length <= 3 ? 0 : term.length <= 6 ? 1 : 2);

/** Meilleure correspondance d'un mot cherché parmi les mots d'un diplôme : { score, word } ou null. */
function matchTerm(term, candidates) {
  let best = null;
  const typos = allowedTypos(term);
  for (const w of candidates) {
    let score = 0;
    if (w === term) score = 1;
    else if (w.startsWith(term)) score = 0.9;
    else if (term.length >= 3 && w.includes(term)) score = 0.6;
    else if (typos) {
      // faute de frappe sur le mot entier, ou sur son début (« informatiq » tapé « infromatiq »)
      const d = Math.min(distance(term, w, typos), distance(term, w.slice(0, term.length), typos));
      if (d <= typos) score = 0.75 - 0.15 * d;
    }
    if (score && (!best || score > best.score)) best = { score, word: w };
  }
  return best;
}

const cache = new WeakMap();
function indexOf(d) {
  if (!cache.has(d)) {
    cache.set(d, {
      title: words(d.title),
      type: words(d.type || ''),
      extra: words([d.code, d.type, d.level_out].filter(Boolean).join(' ')),
    });
  }
  return cache.get(d);
}

/**
 * Diplômes correspondant à la requête, du plus pertinent au moins pertinent.
 * Chaque mot cherché doit correspondre à un mot du diplôme (titre, code, type ou niveau).
 * Retourne [{ diploma, score, hits }] où hits est l'ensemble des mots du titre trouvés.
 */
export function search(diplomas, query) {
  const terms = words(query);
  if (!terms.length) return diplomas.map((diploma) => ({ diploma, score: 0, hits: new Set() }));
  const results = [];
  for (const diploma of diplomas) {
    const idx = indexOf(diploma);
    let score = 0;
    const hits = new Set();
    let ok = true;
    for (const term of terms) {
      const inTitle = matchTerm(term, idx.title);
      const inExtra = matchTerm(term, idx.extra);
      const best = inTitle && (!inExtra || inTitle.score >= inExtra.score) ? inTitle : inExtra;
      if (!best) { ok = false; break; }
      score += best.score * (best === inTitle ? 1 : 0.8);
      if (best === inTitle) hits.add(best.word);
      // « ingenieur », « master », « certificat » : on cherche d'abord ce type de formation
      if (idx.type.some((w) => w.startsWith(term))) score += 0.25;
    }
    if (!ok) continue;
    // Bonus : premier mot du titre trouvé (« master … » cherche d'abord les masters), titres courts.
    if (hits.has(idx.title[0])) score += 0.3;
    score -= idx.title.length * 0.01;
    results.push({ diploma, score, hits });
  }
  return results.sort((a, b) => b.score - a.score);
}
