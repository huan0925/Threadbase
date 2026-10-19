/** Trigram FTS can only match terms of at least this many characters. */
const MIN_FTS_LENGTH = 3;

export interface ParsedQuery {
  /** All terms, as the user typed them. */
  terms: string[];
  /** FTS5 phrase expressions for terms long enough for the trigram index. */
  ftsTerms: string[];
  /** Short terms (e.g. two-character Chinese words) matched with LIKE instead. */
  likeTerms: string[];
}

/**
 * Splits a query into terms that must all appear. Whitespace separates terms;
 * double quotes keep a phrase together. FTS5 syntax is never passed through,
 * so user input can't produce a query syntax error.
 */
export function parseQuery(query: string): ParsedQuery {
  const terms: string[] = [];
  for (const match of query.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = (match[1] ?? match[2] ?? "").trim();
    if (term) terms.push(term);
  }
  const ftsTerms: string[] = [];
  const likeTerms: string[] = [];
  for (const term of terms) {
    if ([...term].length >= MIN_FTS_LENGTH) ftsTerms.push(`"${term.replaceAll('"', '""')}"`);
    else likeTerms.push(term);
  }
  return { terms, ftsTerms, likeTerms };
}

/** Returns a single-line excerpt of `content` around the first matching term. */
export function buildSnippet(content: string, terms: string[], before = 40, after = 100): string {
  const lower = content.toLowerCase();
  let index = -1;
  for (const term of terms) {
    const found = lower.indexOf(term.toLowerCase());
    if (found !== -1 && (index === -1 || found < index)) index = found;
  }
  if (index === -1) index = 0;

  const start = Math.max(0, index - before);
  const end = Math.min(content.length, index + after);
  const excerpt = content.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${excerpt}${end < content.length ? "…" : ""}`;
}
