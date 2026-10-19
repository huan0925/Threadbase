/**
 * The normalized shape every importer produces. Importers map a provider's
 * export format into these types; everything downstream (storage, search,
 * UI) only ever sees this shape.
 */

/** Identifier of the AI service a conversation came from, e.g. "chatgpt". */
export type SourceId = string;

export type Role = "user" | "assistant" | "system" | "tool";

export interface NormalizedMessage {
  /** Stable id from the provider; used to dedupe on re-import. */
  sourceId: string;
  /**
   * Provider id of the parent message, or null for the first message.
   * Conversations are trees: regenerating or editing a prompt creates a branch.
   */
  parentSourceId: string | null;
  role: Role;
  /** Plain-text content used for display and full-text search. */
  content: string;
  /** Unix epoch milliseconds, if the provider records it. */
  createdAt: number | null;
  model: string | null;
}

export interface NormalizedConversation {
  source: SourceId;
  /** Stable conversation id from the provider. */
  sourceId: string;
  title: string;
  createdAt: number | null;
  updatedAt: number | null;
  /** Link back to the conversation in the provider's UI, when one exists. */
  url: string | null;
  /** Leaf of the branch the user last saw; null when the conversation is linear. */
  activeLeafSourceId: string | null;
  messages: NormalizedMessage[];
  /**
   * The provider's original record, kept so improved parsers can re-derive
   * data later without asking the user to export again.
   */
  raw: unknown;
}

export interface Importer {
  source: SourceId;
  /** Human-readable name, e.g. "ChatGPT". */
  name: string;
  /** Whether this importer understands the given parsed JSON document. */
  detect(data: unknown): boolean;
  parse(data: unknown): Iterable<NormalizedConversation>;
}
