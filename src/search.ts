import type { SourceId, StoredConversation } from "./types.ts";

/**
 * In-memory search over every stored conversation. Substring matching works
 * the same for languages written without spaces (Chinese, Japanese) and
 * stays fast for personal-sized histories.
 */

export interface SearchableConversation {
  conversation: StoredConversation;
  title: string;
  /** Lowercased message contents, parallel to conversation.messages. */
  contents: string[];
}

export interface SearchHit {
  conversation: StoredConversation;
  /** Message whose excerpt is shown, or null when only the title matched. */
  messageIndex: number | null;
  snippet: string;
  terms: string[];
}

export interface SearchOptions {
  source?: SourceId;
  limit?: number;
}

export function toSearchable(conversation: StoredConversation): SearchableConversation {
  return {
    conversation,
    title: conversation.title.toLowerCase(),
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

/** Matching conversations, most recently updated first. */
export function search(index: SearchableConversation[], query: string, options: SearchOptions = {}): SearchHit[] {
  const terms = parseQuery(query);
  if (terms.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const entry of index) {
    if (options.source && entry.conversation.source !== options.source) continue;
    const everyTermFound = terms.every(
      (term) => entry.title.includes(term) || entry.contents.some((content) => content.includes(term)),
    );
    if (everyTermFound) hits.push(toHit(entry, terms));
  }

  hits.sort((a, b) => recency(b.conversation) - recency(a.conversation));
  return options.limit ? hits.slice(0, options.limit) : hits;
}

function recency(conversation: StoredConversation): number {
  return conversation.updatedAt ?? conversation.createdAt ?? 0;
}

/** Shows the message that contains the most query terms. */
function toHit(entry: SearchableConversation, terms: string[]): SearchHit {
  let best: number | null = null;
  let bestCount = 0;
  entry.contents.forEach((content, index) => {
    const count = terms.filter((term) => content.includes(term)).length;
    if (count > bestCount) {
      best = index;
      bestCount = count;
    }
  });
  const snippet =
    best === null ? "" : buildSnippet(entry.conversation.messages[best]!.content, terms);
  return { conversation: entry.conversation, messageIndex: best, snippet, terms };
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
