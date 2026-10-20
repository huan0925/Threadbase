import { patchStatus, serialized, updateStatus as update } from "./background-status.ts";
import { knownUpdates, saveConversation } from "./db.ts";
import {
  WATCHDOG_ALARM,
  onGeminiCaptured,
  onGeminiListDone,
  onGeminiListed,
  onGeminiReady,
  onGeminiStepDone,
  onGeminiTabRemoved,
  onGeminiWatchdog,
  startGeminiSync,
} from "./gemini-backfill.ts";
import { readStatus, type BackgroundRequest, type BackgroundResponse, type ContentRequest, type SyncBeginResponse } from "./messages.ts";
import { CHATGPT_ORIGIN } from "./providers/chatgpt.ts";
import { CLAUDE_ORIGIN } from "./providers/claude.ts";
import { GEMINI_ORIGIN } from "./providers/gemini.ts";
import { decideSyncMode, dueForScheduledSync } from "./schedule.ts";
import { AUTO_SYNC_KEY, readAutoSyncMinutes } from "./settings.ts";
import type { SyncMode } from "./sync.ts";
import type { SourceId } from "./types.ts";

const ORIGINS: Record<SourceId, string> = { chatgpt: CHATGPT_ORIGIN, claude: CLAUDE_ORIGIN, gemini: GEMINI_ORIGIN };
const SOURCES: SourceId[] = ["chatgpt", "claude", "gemini"];
/** Tabs this extension opened just to sync, closed again when the sync succeeds. */
const OPENED_TABS_KEY = "openedTabs";
const AUTO_SYNC_ALARM = "auto-sync";

/** A tab opened to sync; `quiet` for scheduled syncs, which never bring a tab forward. */
interface OpenedTab {
  id: number;
  quiet: boolean;
}

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
          await patchStatus(request.source, {
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
      await (request.source === "gemini" ? startGeminiSync("full", false) : startSync(request.source));
      return null;
    case "gemini-ready":
      return onGeminiReady(sender.tab?.id, request.signedIn);
    case "gemini-listed":
      await onGeminiListed(request.chats);
      return null;
    case "gemini-captured":
      await onGeminiCaptured(sender.tab?.id, request.conversation);
      return null;
    case "gemini-list-done":
      return onGeminiListDone(sender.tab?.id, request.enlargeFailed, request.diagnosis);
    case "gemini-step-done":
      return onGeminiStepDone(sender.tab?.id, request.id, request.ok, request.enlargeFailed);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => void onGeminiTabRemoved(tabId));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) void onGeminiWatchdog();
  if (alarm.name === AUTO_SYNC_ALARM) void runScheduledSync();
});

// Scheduled syncs, on top of syncing when a site is opened and the Sync buttons.
void scheduleAutoSync();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && AUTO_SYNC_KEY in changes) void scheduleAutoSync();
});

/** Keeps the auto-sync alarm matching the setting, without restarting a running timer. */
async function scheduleAutoSync(): Promise<void> {
  const minutes = await readAutoSyncMinutes();
  if (minutes <= 0) {
    await chrome.alarms.clear(AUTO_SYNC_ALARM);
    return;
  }
  const existing = await chrome.alarms.get(AUTO_SYNC_ALARM);
  if (existing?.periodInMinutes === minutes) return;
  await chrome.alarms.create(AUTO_SYNC_ALARM, { delayInMinutes: minutes, periodInMinutes: minutes });
}

/** Syncs each source that hasn't synced recently, quietly and in background tabs. */
async function runScheduledSync(): Promise<void> {
  const minutes = await readAutoSyncMinutes();
  for (const source of SOURCES) {
    if (!dueForScheduledSync(await readStatus(source), Date.now(), minutes)) continue;
    await (source === "gemini" ? startGeminiSync("quick", true) : startSync(source, "quick", true));
  }
}

/**
 * Queues a sync and gets a tab of the site to run it: pokes an open tab,
 * reloads one whose content script predates the extension, or opens a
 * background tab, whose content script picks up the queued sync on load.
 * A `quiet` sync (scheduled) closes its tab even on errors rather than
 * bringing it forward.
 */
async function startSync(source: SourceId, mode: SyncMode = "full", quiet = false): Promise<void> {
  await update(source, { pendingMode: mode, error: null });
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
    await chrome.storage.session.set({ [OPENED_TABS_KEY]: [...opened, { id: created.id, quiet }] });
  }
}

/** Closes a tab we opened once its sync ends; shows it when the user must sign in (unless quiet). */
async function finishOpenedTab(tabId: number, error: string | undefined): Promise<void> {
  const opened = await openedTabs();
  const tab = opened.find((entry) => entry.id === tabId);
  if (!tab) return;
  await chrome.storage.session.set({ [OPENED_TABS_KEY]: opened.filter((entry) => entry.id !== tabId) });
  if (error === "not-logged-in" && !tab.quiet) await chrome.tabs.update(tabId, { active: true });
  else if (!error || tab.quiet) await chrome.tabs.remove(tabId);
}

async function openedTabs(): Promise<OpenedTab[]> {
  const stored = ((await chrome.storage.session.get(OPENED_TABS_KEY))[OPENED_TABS_KEY] as unknown[] | undefined) ?? [];
  // Entries were plain tab ids before scheduled syncs existed.
  return stored.map((entry) => (typeof entry === "number" ? { id: entry, quiet: false } : (entry as OpenedTab)));
}
