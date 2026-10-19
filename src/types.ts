/**
 * The normalized shape every provider produces. Providers map a site's own
 * conversation format into these types; storage, search and the UI only
 * ever see this shape.
 */

/** Identifier of the AI service a conversation came from. */
export type SourceId = "chatgpt" | "claude";

export const SOURCE_NAMES: Record<SourceId, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
};

export type Role = "user" | "assistant" | "system" | "tool";

export interface NormalizedMessage {
  /** Stable id from the provider. */
  sourceId: string;
  /**
   * Provider id of the parent message, or null for the first message.
   * Conversations are trees: regenerating or editing a prompt creates a branch.
   */
  parentSourceId: string | null;
  role: Role;
  /** Plain-text content used for display and search. */
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
  /** Link back to the conversation on the provider's site. */
  url: string;
  /** Leaf of the branch the user last saw; null when unknown or linear. */
  activeLeafSourceId: string | null;
  messages: NormalizedMessage[];
}

export interface StoredConversation extends NormalizedConversation {
  /** `${source}:${sourceId}`, the IndexedDB key. */
  key: string;
  /**
   * The conversation's update time as the site's conversation list reported
   * it; a different value on the next sync means it must be fetched again.
   */
  listedUpdatedAt: number | null;
  syncedAt: number;
}

export function conversationKey(source: SourceId, sourceId: string): string {
  return `${source}:${sourceId}`;
}
