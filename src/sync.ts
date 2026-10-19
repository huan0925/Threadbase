import type { NormalizedConversation, SourceId } from "./types.ts";

export interface ConversationSummary {
  id: string;
  title: string;
  /** Update time as the site's conversation list reports it. */
  updatedAt: number | null;
}

/** Reads one site's conversations using the signed-in user's session. */
export interface ProviderClient {
  source: SourceId;
  /** Yields every conversation, most recently updated first. */
  listConversations(): AsyncIterable<ConversationSummary>;
  getConversation(id: string): Promise<NormalizedConversation>;
}

/** Where synced conversations go (the background service worker, in the extension). */
export interface SyncTarget {
  /** Conversation id → the list update time recorded when it was last saved. */
  known(): Promise<Map<string, number | null>>;
  save(conversation: NormalizedConversation, listedUpdatedAt: number | null): Promise<void>;
  progress(progress: { done: number; total: number }): void;
}

/**
 * "full" checks every conversation in the list; "quick" stops listing after a
 * run of unchanged conversations, since the list is ordered by update time.
 * Both only download conversations that are new or changed.
 */
export type SyncMode = "full" | "quick";

export interface SyncResult {
  listed: number;
  fetched: number;
  failed: number;
}

export interface SyncOptions {
  mode: SyncMode;
  /** Pause between conversation downloads, to stay well under rate limits. */
  delayMs?: number;
}

/** In quick mode, this many unchanged conversations in a row end the listing. */
const QUICK_SYNC_UNCHANGED_RUN = 20;

export async function syncProvider(
  client: ProviderClient,
  target: SyncTarget,
  options: SyncOptions,
): Promise<SyncResult> {
  const known = await target.known();
  const changed: ConversationSummary[] = [];
  let listed = 0;
  let unchangedRun = 0;

  for await (const summary of client.listConversations()) {
    listed++;
    const unchanged = known.has(summary.id) && known.get(summary.id) === summary.updatedAt;
    if (!unchanged) {
      changed.push(summary);
      unchangedRun = 0;
    } else if (options.mode === "quick" && ++unchangedRun >= QUICK_SYNC_UNCHANGED_RUN) {
      break;
    }
  }

  const result: SyncResult = { listed, fetched: 0, failed: 0 };
  target.progress({ done: 0, total: changed.length });
  for (const [index, summary] of changed.entries()) {
    if (index > 0 && options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    try {
      await target.save(await client.getConversation(summary.id), summary.updatedAt);
      result.fetched++;
    } catch (error) {
      // A signed-out session fails every request; stop instead of retrying each one.
      if (error instanceof Error && error.name === "NotLoggedInError") throw error;
      result.failed++;
    }
    target.progress({ done: index + 1, total: changed.length });
  }
  return result;
}
