// Fuzzy matching for the command palette (lib/palette.js). Pure: no DOM, tested in node (test/ui-fuzzy.test.ts).
// Case-insensitive; a Hangul initial consonant in the query matches any syllable that starts with it (ㅍㅌ → 포트).
// Every space-separated word of the query must match. A word scores higher at the start of the text, at a word start,
// as one unbroken run, and in the title rather than only in the item's other text. Numbers only match as a run.

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const SYL0 = 0xac00, SYL1 = 0xd7a3;

/** The initial consonant of a Hangul syllable, else null */
export function initialOf(c) {
  const n = c.codePointAt(0);
  return n >= SYL0 && n <= SYL1 ? CHO[Math.floor((n - SYL0) / 588)] : null;
}

const isCho = (c) => CHO.includes(c);
const eq = (q, t) => q === t || (isCho(q) && initialOf(t) === q);
const boundary = (s, i) => i === 0 || /[\s\-_./:@·|()[\]]/.test(s[i - 1]) || (/\d/.test(s[i]) !== /\d/.test(s[i - 1]));

/** Lower case, NFC (so a decomposed 한 from a Mac file name matches a typed one) */
export const fold = (s) => String(s ?? '').normalize('NFC').toLowerCase();

/** The query's words, folded; empty for a blank query */
export const words = (query) => fold(query).split(/\s+/).filter(Boolean);

/**
 * One word against one text (both folded) → { score, hits } or null. hits: the matched character indices.
 * A run (substring) beats a scattered match (subsequence); both prefer the start and word starts.
 */
export function matchWord(word, text) {
  const n = word.length;
  if (!n) return { score: 0, hits: [] };
  let best = null;
  // runs: every place the word appears whole
  for (let i = 0; i + n <= text.length; i++) {
    let k = 0;
    while (k < n && eq(word[k], text[i + k])) k++;
    if (k < n) continue;
    const score = 100 + (i === 0 ? 40 : boundary(text, i) ? 25 : 0) + (n === text.length ? 30 : 0) - Math.min(i, 30) / 2;
    if (!best || score > best.score) best = { score, hits: Array.from({ length: n }, (_, j) => i + j) };
    if (i === 0) break;
  }
  // a number is a port, a PID or an IP part: 8790 must not find 8794 by its scattered digits
  if (best || /^\d+$/.test(word)) return best;
  // scattered: the word's characters in order, preferring word starts for each next character
  const hits = [];
  let from = 0;
  for (const c of word) {
    let at = -1;
    for (let j = from; j < text.length; j++) {
      if (!eq(c, text[j])) continue;
      if (at < 0) at = j;
      if (boundary(text, j)) { at = j; break; }
    }
    if (at < 0) return null;
    hits.push(at);
    from = at + 1;
  }
  let score = 40;
  for (let k = 0; k < hits.length; k++) {
    if (boundary(text, hits[k])) score += 8;
    if (k && hits[k] === hits[k - 1] + 1) score += 4;
    else if (k) score -= Math.min(hits[k] - hits[k - 1], 10);
  }
  return { score: Math.max(1, score - hits[0] / 4), hits };
}

/**
 * The whole query against an item's title and its other text → { score, hits } (hits index the title) or null when
 * any word matches neither. A blank query matches everything with score 0.
 */
export function score(query, title, text = '') {
  const ws = Array.isArray(query) ? query : words(query);
  const t = fold(title);
  const rest = fold(text);
  let total = 0;
  const hits = new Set();
  for (const w of ws) {
    const inTitle = matchWord(w, t);
    const inRest = rest ? matchWord(w, rest) : null;
    if (inTitle && (!inRest || inTitle.score * 1.5 >= inRest.score)) {
      total += inTitle.score * 1.5;
      for (const h of inTitle.hits) hits.add(h);
    } else if (inRest) total += inRest.score;
    else return null;
  }
  return { score: total, hits: [...hits].sort((a, b) => a - b) };
}

/**
 * Items { title, text?, boost? } that match the query, best first; ties keep the input order. A blank query keeps
 * every item in order. boost is added to a match's score (recent items). limit caps the answer.
 */
export function rank(query, items, { limit = Infinity } = {}) {
  const ws = words(query);
  const out = [];
  items.forEach((item, i) => {
    const m = ws.length ? score(ws, item.title, item.text) : { score: 0, hits: [] };
    if (m) out.push({ item, score: m.score + (ws.length ? item.boost ?? 0 : 0), hits: m.hits, i });
  });
  if (ws.length) out.sort((a, b) => b.score - a.score || a.i - b.i);
  return out.slice(0, limit).map(({ item, score: s, hits }) => ({ item, score: s, hits }));
}

/** Split text into [{ text, hit }] runs for highlighting the matched characters */
export function segments(text, hits) {
  const s = String(text ?? '');
  const set = new Set(hits);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const hit = set.has(i);
    if (out.length && out[out.length - 1].hit === hit) out[out.length - 1].text += s[i];
    else out.push({ text: s[i], hit });
  }
  return out;
}
