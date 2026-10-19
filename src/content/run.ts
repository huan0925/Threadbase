import { sendToBackground, type ContentRequest, type SyncBeginResponse } from "../messages.ts";
import { syncProvider, type ProviderClient, type SyncTarget } from "../sync.ts";

/** Give the site a moment to finish loading before syncing in the background. */
const AUTO_SYNC_DELAY_MS = 2000;
/** Pause between conversation downloads, to stay well under the site's rate limits. */
const DOWNLOAD_DELAY_MS = 300;

/**
 * Runs in the site's own tab, so requests carry the user's session exactly
 * like the site's own requests. Syncs automatically when the page opens (the
 * background decides how often) and whenever the popup asks.
 */
export function runContentScript(client: ProviderClient): void {
  const { source } = client;
  let syncing = false;

  const target: SyncTarget = {
    known: async () => new Map(await sendToBackground<[string, number | null][]>({ type: "known", source })),
    save: async (conversation, listedUpdatedAt) => {
      await sendToBackground({ type: "save", conversation, listedUpdatedAt });
    },
    progress: ({ done, total }) => {
      void sendToBackground({ type: "progress", source, done, total }).catch(() => {});
    },
  };

  async function sync(automatic: boolean): Promise<void> {
    if (syncing) return;
    syncing = true;
    try {
      const { mode } = await sendToBackground<SyncBeginResponse>({ type: "sync-begin", source, automatic });
      if (!mode) return;
      try {
        const result = await syncProvider(client, target, { mode, delayMs: DOWNLOAD_DELAY_MS });
        await sendToBackground({ type: "sync-end", source, result });
      } catch (error) {
        const message =
          error instanceof Error && error.name === "NotLoggedInError"
            ? "not-logged-in"
            : error instanceof Error
              ? error.message
              : String(error);
        await sendToBackground({ type: "sync-end", source, error: message });
      }
    } finally {
      syncing = false;
    }
  }

  chrome.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse) => {
    if (request.type !== "sync") return;
    void sync(false);
    sendResponse(true);
  });
  setTimeout(() => void sync(true), AUTO_SYNC_DELAY_MS);
}
