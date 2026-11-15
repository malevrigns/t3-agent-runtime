import type { MemoryRecord } from './ports.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'have', 'what',
  'when', 'where', 'which', 'please', 'check', 'about', 'into', 'just',
]);

/** Stable dedup key. Same kind and normalized wording collapse to one active row. */
export function memoryContentKey(kind: string, content: string): string {
  const norm = content
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。!！?？,，;；:：]+$/g, '')
    .trim()
    .slice(0, 500);
  return `${kind}:${norm}`;
}

/** Bigrams stay inside each CJK run, so a space or digit cannot glue two words together. */
function cjkBigrams(text: string): string[] {
  const grams: string[] = [];
  for (const run of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    const chars = [...run];
    for (let i = 0; i < chars.length - 1; i++) grams.push(chars[i]! + chars[i + 1]!);
  }
  return grams;
}

function searchTerm(term: string): string {
  return term.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * Lexical overlap for English tokens and CJK bigrams.
 * A score of 0 means the text should not be recalled for this query.
 */
export function scoreText(haystack: string, query: string | undefined): number {
  if (!query?.trim()) return 0;
  const hay = haystack.toLowerCase();
  const q = query.trim().toLowerCase();
  let score = hay.includes(q) ? 8 : 0;
  const terms = q
    .split(/\s+/)
    .map(searchTerm)
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
  let hits = 0;
  for (const term of terms) {
    if (hay.includes(term)) hits++;
  }
  score += hits * 2;

  const queryGrams = cjkBigrams(q);
  if (queryGrams.length > 0) {
    const hayGrams = new Set(cjkBigrams(hay));
    let gramHits = 0;
    for (const gram of queryGrams) {
      if (hayGrams.has(gram)) gramHits++;
    }
    if (gramHits >= 1) score += gramHits;
  }

  return score;
}

export function scoreMemory(record: MemoryRecord, query: string | undefined, now: number): number {
  const pin = record.pinned ? 1000 : 0;
  const lexical = query?.trim()
    ? scoreText(`${record.kind} ${record.content} ${(record.tags ?? []).join(' ')}`, query)
    : 1;
  if (query?.trim() && lexical === 0 && !record.pinned) return 0;
  const salience = record.salience ?? 0.5;
  const confidence = record.confidence > 0 ? record.confidence : 1;
  const stamp = record.lastAccessedAt ?? record.updatedAt;
  const ageDays = Math.max(0, now - stamp) / 86_400_000;
  const recency = 1 / (1 + ageDays / 14);
  const use = Math.log2(2 + (record.accessCount ?? 0));
  return pin + lexical * confidence * (0.5 + salience) * (0.75 + 0.25 * recency) * use;
}

/** At most three pinned facts lead the window. Extra pins fill only leftover slots. */
export function selectRankedMemories(records: MemoryRecord[], query: string | undefined, limit: number, now = Date.now()): MemoryRecord[] {
  if (limit <= 0) return [];
  const ranked = records
    .map((record) => ({ record, score: scoreMemory(record, query, now) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.record.confidence !== a.record.confidence) return b.record.confidence - a.record.confidence;
      return b.record.updatedAt - a.record.updatedAt;
    })
    .map((entry) => entry.record);

  const pinCap = Math.min(3, limit);
  const pinned = ranked.filter((record) => record.pinned);
  const unpinned = ranked.filter((record) => !record.pinned);
  const lead = pinned.slice(0, pinCap);
  const room = limit - lead.length;
  const unpinnedTake = unpinned.slice(0, room);
  const extraPins = pinned.slice(pinCap, pinCap + (room - unpinnedTake.length));
  return [...lead, ...unpinnedTake, ...extraPins];
}
