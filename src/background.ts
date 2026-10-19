import { knownUpdates, saveConversation } from "./db.ts";
import {
  readStatus,
  writeStatus,
  type BackgroundRequest,
  type BackgroundResponse,
  type ContentRequest,
  type SyncBeginResponse,
  type SyncStatus,
} from "./messages.ts";
import { CHATGPT_ORIGIN } from "./providers/chatgpt.ts";
import { CLAUDE_ORIGIN } from "./providers/claude.ts";
import { decideSyncMode } from "./schedule.ts";
import type { SourceId } from "./types.ts";

const ORIGINS: Record<SourceId, string> = { chatgpt: CHATGPT_ORIGIN, claude: CLAUDE_ORIGIN };
/** Tabs this extension opened just to sync, closed again when the sync succeeds. */
const OPENED_TABS_KEY = "openedTabs";

chrome.runtime.onMessage.addListener((request: BackgroundRequest, sender, sendResponse) => {
  handle(request, sender).then(
    (value): void => sendResponse({ ok: true, value } satisfies BackgroundResponse<unknown>),
    (error: unknown): void =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true; // respond asynchronously
});

async function handle(request: BackgroundRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (request.type) {
    case "sync-begin":
      return serialized(async (): Promise<SyncBeginResponse> => {
        const mode = decideSyncMode(await readStatus(request.source), Date.now());
        if (mode) {
          await writeStatus(request.source, {
            running: true,
            heartbeatAt: Date.now(),
            done: 0,
            total: 0,
            error: null,
            pendingMode: null,
          });
        }
        return { mode };
      });
    case "known":
      return knownUpdates(request.source);
    case "save":
      await saveConversation(request.conversation, request.listedUpdatedAt);
      return null;
    case "progress":
      return update(request.source, { done: request.done, total: request.total, heartbeatAt: Date.now() });
    case "sync-end":
      await update(request.source, (status) => ({
        running: false,
        heartbeatAt: null,
        error: request.error ?? null,
        lastResult: request.result ?? status.lastResult,
        lastSuccessAt: request.error ? status.lastSuccessAt : Date.now(),
      }));
      if (sender.tab?.id !== undefined) await finishOpenedTab(sender.tab.id, request.error);
      return null;
    case "start-sync":
      await startSync(request.source);
      return null;
  }
}

/**
 * Queues a full sync and gets a tab of the site to run it: pokes an open tab,
 * reloads one whose content script predates the extension, or opens a
 * background tab, whose content script picks up the queued sync on load.
 */
async function startSync(source: SourceId): Promise<void> {
  await update(source, { pendingMode: "full", error: null });
  const origin = ORIGINS[source];
  const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
  if (tab?.id !== undefined) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "sync" } satisfies ContentRequest);
    } catch {
      await chrome.tabs.reload(tab.id);
    }
    return;
  }
  const created = await chrome.tabs.create({ url: `${origin}/`, active: false });
  if (created.id !== undefined) {
    const opened = await openedTabs();
    await chrome.storage.session.set({ [OPENED_TABS_KEY]: [...opened, created.id] });
  }
}

/** Closes a tab we opened once its sync succeeds; shows it when the user must sign in. */
async function finishOpenedTab(tabId: number, error: string | undefined): Promise<void> {
  const opened = await openedTabs();
  if (!opened.includes(tabId)) return;
  await chrome.storage.session.set({ [OPENED_TABS_KEY]: opened.filter((id) => id !== tabId) });
  if (error === "not-logged-in") await chrome.tabs.update(tabId, { active: true });
  else if (!error) await chrome.tabs.remove(tabId);
}

async function openedTabs(): Promise<number[]> {
  return ((await chrome.storage.session.get(OPENED_TABS_KEY))[OPENED_TABS_KEY] as number[] | undefined) ?? [];
}

// Status updates are read-modify-write; run them one at a time so concurrent
// messages (progress, sync-end, sync-begin) can't overwrite each other.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function update(
  source: SourceId,
  patch: Partial<SyncStatus> | ((status: SyncStatus) => Partial<SyncStatus>),
): Promise<SyncStatus> {
  return serialized(async () =>
    writeStatus(source, typeof patch === "function" ? patch(await readStatus(source)) : patch),
  );
}
