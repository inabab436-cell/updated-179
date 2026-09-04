/**
 * FUZZY, MEANING-TOLERANT MATCHING OF CATALOGUE STRINGS.
 *
 * Everything the agent writes is free text produced from a conversation:
 * "هودي مخطط", "الهودي المقلم", "hoodie", "هودى ابيض", "ابيض", "وايت", "لارج",
 * "L". The catalogue, on the other hand, stores one fixed spelling per row.
 *
 * The old code compared those two worlds with equality (and, for product
 * names, a plain substring test). Any wording difference — a typo, a missing
 * word, an extra adjective, a synonym, a Latin size letter — produced
 * "product_not_found" / "اللون غير متاح", which the agent then relayed to the
 * customer at the very last step of an order that was otherwise complete.
 *
 * This module replaces those hard comparisons with a graded score, so the
 * decision becomes "how close is this?" instead of "is it identical?".
 * It is pure and shared by the availability pre-check, the order
 * canonicalization (stock deduction) and anything else that has to map agent
 * wording onto catalogue rows.
 */

/** Normalization that KEEPS word boundaries (unlike the old `norm`). */
export function normalizeMatchText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u064B-\u0652\u0640]/g, "") // diacritics + tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[يى]/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("ar");
}

/** Collapsed form (no spaces at all) — used for containment tests. */
export function collapseMatchText(value: unknown): string {
  return normalizeMatchText(value).replace(/\s+/g, "");
}

const STOP_WORDS = new Set([
  "ال",
  "من",
  "في",
  "علي",
  "عن",
  "لون",
  "مقاس",
  "size",
  "color",
  "colour",
  "the",
  "a",
  "an",
  "of",
]);

export function matchTokens(value: unknown): string[] {
  return normalizeMatchText(value)
    .split(" ")
    .map((t) => (t.length > 4 ? t.replace(/^ال/, "") : t))
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

/** Levenshtein distance, capped implicitly by the input lengths. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** 0..1 similarity of two short strings (typo tolerant). */
export function stringSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const dist = editDistance(a, b);
  return Math.max(0, 1 - dist / Math.max(a.length, b.length));
}

/** 0..1 bigram (Dice) similarity — robust for longer multi-word names. */
function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) ?? 0);
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

/**
 * How strongly `query` refers to `candidate` (0..1).
 *
 * Deliberately asymmetric-friendly: a short query naming part of a longer
 * catalogue name ("هودي مخطط" vs "IKE BRAS هودي مخطط") scores very high,
 * because that is exactly how customers and the agent talk.
 */
export function nameMatchScore(candidate: unknown, query: unknown): number {
  const nc = normalizeMatchText(candidate);
  const nq = normalizeMatchText(query);
  if (!nc || !nq) return 0;
  if (nc === nq) return 1;

  const cc = nc.replace(/\s+/g, "");
  const cq = nq.replace(/\s+/g, "");
  if (cc === cq) return 0.99;
  if (cc.includes(cq) || cq.includes(cc)) {
    const ratio = Math.min(cc.length, cq.length) / Math.max(cc.length, cq.length);
    return 0.9 + 0.08 * ratio;
  }

  const ct = matchTokens(nc);
  const qt = matchTokens(nq);
  let tokenScore = 0;
  if (ct.length && qt.length) {
    let weight = 0;
    let sum = 0;
    for (const q of qt) {
      const best = ct.reduce((mx, c) => {
        const direct = c === q ? 1 : c.includes(q) || q.includes(c) ? 0.85 : 0;
        return Math.max(mx, direct, stringSimilarity(c, q));
      }, 0);
      const w = Math.max(1, q.length);
      sum += best * w;
      weight += w;
    }
    tokenScore = weight ? sum / weight : 0;
    // Reward matching a distinctive catalogue word even when the query has
    // extra words around it ("عايز الهودي المقلم بليز").
    const covered = ct.filter((c) =>
      qt.some((q) => c === q || c.includes(q) || q.includes(c) || stringSimilarity(c, q) >= 0.8),
    ).length;
    tokenScore = Math.max(tokenScore, covered / ct.length);
  }

  return Math.max(tokenScore, diceSimilarity(cc, cq));
}

export interface RankedMatch<T> {
  item: T;
  score: number;
}

export interface FuzzyPick<T> {
  /** Best candidate at or above `threshold`, else null. */
  match: T | null;
  score: number;
  /** True when a second candidate is nearly as good (caller may ask). */
  ambiguous: boolean;
  /** All candidates sorted by score, best first. */
  ranked: Array<RankedMatch<T>>;
}

export interface FuzzyPickOptions {
  /** Minimum score to accept a match. Default 0.55. */
  threshold?: number;
  /** Score gap under which two candidates are "equally good". Default 0.06. */
  ambiguityGap?: number;
}

export function fuzzyPick<T>(
  items: T[],
  labelOf: (item: T) => unknown,
  query: unknown,
  options: FuzzyPickOptions = {},
): FuzzyPick<T> {
  const threshold = options.threshold ?? 0.55;
  const gap = options.ambiguityGap ?? 0.06;
  const ranked = (items ?? [])
    .map((item) => ({ item, score: nameMatchScore(labelOf(item), query) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < threshold) {
    return { match: null, score: best?.score ?? 0, ambiguous: false, ranked };
  }
  const second = ranked[1];
  const ambiguous = !!second && best.score - second.score < gap && best.score < 0.9;
  return { match: best.item, score: best.score, ambiguous, ranked };
}

/**
 * Picks the catalogue label (colour / size wording) meant by `requested`.
 * Sizes get an extra alias pass so "لارج"/"L"/"large" all land on one row.
 */
const SIZE_ALIASES: Record<string, string[]> = {
  xs: ["xs", "اكسسمول", "اسمول جدا", "extrasmall"],
  s: ["s", "small", "سمول", "صغير"],
  m: ["m", "medium", "ميديم", "متوسط", "وسط"],
  l: ["l", "large", "لارج", "كبير"],
  xl: ["xl", "extralarge", "اكسلارج", "اكسل"],
  xxl: ["xxl", "2xl", "اكساكسلارج", "دبلاكس", "دبلاكسلارج"],
  xxxl: ["xxxl", "3xl", "تلاتاكس"],
};

function sizeKey(value: unknown): string | null {
  const c = collapseMatchText(value);
  if (!c) return null;
  for (const [key, aliases] of Object.entries(SIZE_ALIASES)) {
    if (aliases.some((a) => a === c)) return key;
  }
  return null;
}

/**
 * Colour vocabulary: the same colour written in Arabic, in transliterated
 * Arabic or in English is one colour. This is a synonym dictionary, not a
 * pattern gate — an unknown colour simply falls through to graded similarity.
 */
const COLOR_ALIASES: string[][] = [
  ["ابيض", "بيضاء", "وايت", "white", "أوف وايت", "اوفوايت", "offwhite"],
  ["اسود", "سوداء", "بلاك", "black", "كحلي غامق"],
  ["احمر", "حمراء", "ريد", "red"],
  ["ازرق", "زرقاء", "بلو", "blue"],
  ["كحلي", "نيفي", "navy", "ازرق غامق"],
  ["اخضر", "خضراء", "جرين", "green"],
  ["اصفر", "صفراء", "يلو", "yellow"],
  ["رمادي", "جراي", "جري", "grey", "gray", "سيلفر", "فضي", "silver"],
  ["بيج", "beige", "بيچ", "كريمي", "cream", "كريم"],
  ["بني", "براون", "brown", "جملي", "كافيه", "coffee"],
  ["وردي", "بينك", "pink", "روز", "rose", "بمبي"],
  ["بنفسجي", "موف", "بربل", "purple", "violet"],
  ["برتقالي", "اورانج", "orange"],
  ["ذهبي", "جولد", "gold"],
  ["تركواز", "تيل", "teal", "turquoise", "لبني", "سماوي", "بيبي بلو"],
  ["زيتي", "زيتوني", "اوليف", "olive"],
  ["نبيتي", "خمري", "بوردو", "burgundy", "maroon"],
];

function colorKey(value: unknown): string | null {
  const c = collapseMatchText(value);
  if (!c) return null;
  for (const group of COLOR_ALIASES) {
    if (group.some((a) => collapseMatchText(a) === c)) return group[0]!;
  }
  return null;
}

export function matchCatalogLabel(
  labels: Array<string | null | undefined>,
  requested: unknown,
  field: "color" | "size" = "color",
): string | null {
  const list = (labels ?? []).filter(
    (l): l is string => typeof l === "string" && l.trim().length > 0,
  );
  if (!list.length) return null;
  if (!collapseMatchText(requested)) return null;

  const exact = list.find((l) => collapseMatchText(l) === collapseMatchText(requested));
  if (exact) return exact;

  if (field === "size") {
    const wantKey = sizeKey(requested);
    if (wantKey) {
      const hit = list.find((l) => sizeKey(l) === wantKey);
      if (hit) return hit;
    }
    // Numeric sizes ("42", "٤٢").
    const num = normalizeMatchText(requested).match(/\d+/)?.[0];
    if (num) {
      const hit = list.find((l) => normalizeMatchText(l).match(/\d+/)?.[0] === num);
      if (hit) return hit;
    }
  }

  if (field === "color") {
    const wantKey = colorKey(requested);
    if (wantKey) {
      const hit = list.find((l) => colorKey(l) === wantKey);
      if (hit) return hit;
    }
  }


  const picked = fuzzyPick(list, (l) => l, requested, {
    threshold: field === "size" ? 0.7 : 0.6,
    ambiguityGap: 0.04,
  });
  return picked.match ?? null;
}
