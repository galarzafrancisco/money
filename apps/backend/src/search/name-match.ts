/**
 * Name normalisation and matching shared by merchant and account search.
 *
 * Two different ideas, kept apart on purpose:
 * - the *identity* of a merchant (`merchantKey`) only folds formatting: case,
 *   accents, punctuation, "&" vs "and", legal suffixes and trailing store
 *   numbers. "GUZMAN Y GOMEZ 1234" and "Guzman y Gomez Pty Ltd" are one merchant.
 * - *matching* a query is looser (spelling synonyms such as BBQ / barbecue /
 *   barbeque, plurals, small typos) but never merges two merchants: it only
 *   decides whether a candidate is worth showing and how it is labelled.
 */

export type MatchType = 'exact' | 'alias' | 'prefix' | 'partial' | 'approximate';

/** Best first. Equal ranks are then ordered by the caller (activity, name) */
export const MATCH_RANK: Record<MatchType, number> = { exact: 5, alias: 4, prefix: 3, partial: 2, approximate: 1 };

const LEGAL_SUFFIXES = new Set(['pty', 'ltd', 'limited', 'inc', 'llc', 'pl', 'co']);
const SYNONYMS: Record<string, string> = {
  barbeque: 'bbq', barbecue: 'bbq', barbie: 'bbq', bbqs: 'bbq', barbeques: 'bbq', barbecues: 'bbq',
  centre: 'center',
};

/** Lowercase, accent-free words with punctuation removed ("&" becomes "and") */
export function words(input: string): string[] {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

/** Words that identify a merchant: legal suffixes and a trailing store/terminal number are dropped */
export function identityWords(input: string): string[] {
  let tokens = words(input);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens = tokens.slice(0, -1);
  while (tokens.length > 1 && /^\d{2,}$/.test(tokens[tokens.length - 1])) tokens = tokens.slice(0, -1);
  return tokens;
}

/** Stable identity of a merchant label from Up. Empty when the label has no letters or digits */
export function merchantKeyOf(label: string): string {
  const tokens = identityWords(label);
  return tokens.length === 0 ? '' : `up:${tokens.join('-')}`;
}

/** One word reduced for matching: synonym, then naive singular */
function canonical(word: string): string {
  const synonym = SYNONYMS[word];
  if (synonym) return synonym;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

function typoAllowance(word: string): number {
  return word.length >= 8 ? 2 : word.length >= 5 ? 1 : 0;
}

export type PreparedQuery = { raw: string[]; canon: string[] };

export function prepareQuery(query: string): PreparedQuery {
  const raw = words(query);
  return { raw, canon: raw.map(canonical) };
}

/**
 * How well `name` answers the query, or null when it does not. Every query
 * word has to be found in the name (as a word prefix, or within a small typo
 * distance), so "BBQ Galore" never matches "BBQs In The Hills".
 */
export function matchName(query: PreparedQuery, name: string): MatchType | null {
  if (query.raw.length === 0) return null;
  const nameRaw = words(name);
  if (nameRaw.length === 0) return null;
  const nameCanon = nameRaw.map(canonical);

  if (query.raw.join(' ') === nameRaw.join(' ') || query.raw.join(' ') === identityWords(name).join(' ')) return 'exact';
  const nameIdentity = identityWords(name).map(canonical);
  if (query.canon.join(' ') === nameCanon.join(' ') || query.canon.join(' ') === nameIdentity.join(' ')) return 'alias';

  const prefixWord = (q: string) => nameCanon.some((n) => n.startsWith(q));
  if (query.canon.every(prefixWord)) {
    const inOrderPrefix = query.canon.every((q, i) => nameCanon[i]?.startsWith(q));
    return inOrderPrefix ? 'prefix' : 'partial';
  }
  const fuzzyWord = (q: string) => nameCanon.some((n) => n.startsWith(q) || editDistance(q, n, typoAllowance(q)) <= typoAllowance(q));
  if (query.canon.every(fuzzyWord)) return 'approximate';
  return null;
}
