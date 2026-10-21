import type { SourceId, StoredConversation } from "./types.ts";

/**
 * Substring search, which works the same for languages written without
 * spaces (Chinese, Japanese). Each conversation has a compact search record
 * (lowercased text, no message structure) kept next to it, so searching
 * reads far less than the conversations themselves, and newest-first
 * scanning can stop as soon as a page of results is found.
 */

export interface SearchRecord {
  /** Same key as the conversation. */
  key: string;
  source: SourceId;
  sourceId: string;
  title: string;
  url: string;
  createdAt: number | null;
  updatedAt: number | null;
  /** Ascending order is most recently updated first. */
  order: number;
  lowerTitle: string;
  /** Lowercased message contents, parallel to the conversation's messages. */
  contents: string[];
}

export interface SearchMatch {
  record: SearchRecord;
  /** Message that contains the most terms (its excerpt is shown), or null when only the title matched. */
  messageIndex: number | null;
  terms: string[];
}

export interface SearchOptions {
  source?: SourceId;
  limit?: number;
}

export function toSearchRecord(conversation: StoredConversation): SearchRecord {
  return {
    key: conversation.key,
    source: conversation.source,
    sourceId: conversation.sourceId,
    title: conversation.title,
    url: conversation.url,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    order: -(conversation.updatedAt ?? conversation.createdAt ?? 0),
    lowerTitle: conversation.title.toLowerCase(),
    contents: conversation.messages.map((m) => m.content.toLowerCase()),
  };
}

/**
 * Splits a query into terms that must all appear somewhere in a conversation
 * (title or any message). Whitespace separates terms; double quotes keep a
 * phrase together.
 */
export function parseQuery(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = (match[1] ?? match[2] ?? "").trim().toLowerCase();
    if (term) terms.push(term);
  }
  return terms;
}

/** The match if every term appears in the record, else null. Terms must be lowercase (see parseQuery). */
export function matchRecord(record: SearchRecord, terms: string[]): SearchMatch | null {
  if (terms.length === 0) return null;
  const everyTermFound = terms.every(
    (term) => record.lowerTitle.includes(term) || record.contents.some((content) => content.includes(term)),
  );
  if (!everyTermFound) return null;

  let best: number | null = null;
  let bestCount = 0;
  record.contents.forEach((content, index) => {
    const count = terms.filter((term) => content.includes(term)).length;
    if (count > bestCount) {
      best = index;
      bestCount = count;
    }
  });
  return { record, messageIndex: best, terms };
}

/** Matching records, most recently updated first. */
export function search(records: SearchRecord[], query: string, options: SearchOptions = {}): SearchMatch[] {
  const terms = parseQuery(query);
  const matches: SearchMatch[] = [];
  for (const record of [...records].sort((a, b) => a.order - b.order)) {
    if (options.source && record.source !== options.source) continue;
    const match = matchRecord(record, terms);
    if (match) matches.push(match);
    if (options.limit && matches.length >= options.limit) break;
  }
  return matches;
}

/** The excerpt to show for a match, from the stored conversation's original text. */
export function matchSnippet(conversation: StoredConversation, match: SearchMatch): string {
  const message = match.messageIndex === null ? undefined : conversation.messages[match.messageIndex];
  return message ? buildSnippet(message.content, match.terms) : "";
}

/** Returns a single-line excerpt of `content` around the first matching term. */
export function buildSnippet(content: string, terms: string[], before = 40, after = 120): string {
  const lower = content.toLowerCase();
  let index = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1 && (index === -1 || found < index)) index = found;
  }
  if (index === -1) index = 0;

  const start = Math.max(0, index - before);
  const end = Math.min(content.length, index + after);
  const excerpt = content.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${excerpt}${end < content.length ? "…" : ""}`;
}

/** Splits text into plain and highlighted segments for rendering without HTML injection. */
export function highlightSegments(text: string, terms: string[]): { text: string; match: boolean }[] {
  const lower = text.toLowerCase();
  const segments: { text: string; match: boolean }[] = [];
  let position = 0;
  while (position < text.length) {
    let next = -1;
    let length = 0;
    for (const term of terms) {
      const found = lower.indexOf(term, position);
      if (found !== -1 && (next === -1 || found < next || (found === next && term.length > length))) {
        next = found;
        length = term.length;
      }
    }
    if (next === -1) {
      segments.push({ text: text.slice(position), match: false });
      break;
    }
    if (next > position) segments.push({ text: text.slice(position, next), match: false });
    segments.push({ text: text.slice(next, next + length), match: true });
    position = next + length;
  }
  return segments;
}

/** Messages on the branch the user last saw, oldest first; all messages if unknown. */
export function activeBranch(conversation: StoredConversation): StoredConversation["messages"] {
  const { messages, activeLeafSourceId } = conversation;
  if (!activeLeafSourceId) return messages;
  const bySourceId = new Map(messages.map((m) => [m.sourceId, m]));
  const branch: StoredConversation["messages"] = [];
  let current = bySourceId.get(activeLeafSourceId);
  while (current && branch.length <= messages.length) {
    branch.push(current);
    current = current.parentSourceId ? bySourceId.get(current.parentSourceId) : undefined;
  }
  return branch.length > 0 ? branch.reverse() : messages;
}
