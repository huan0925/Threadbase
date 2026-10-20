import { patchStatus, serialized } from "./background-status.ts";
import { getConversation, knownUpdates, saveConversation } from "./db.ts";
import { readStatus, type GeminiInstruction } from "./messages.ts";
import { geminiSyncUrl } from "./providers/gemini.ts";
import { decideSyncMode } from "./schedule.ts";
import type { ConversationSummary, SyncMode } from "./sync.ts";
import { conversationKey, type NormalizedConversation, type StoredConversation } from "./types.ts";

/**
 * Gemini sync, run by the background worker. Gemini only answers calls its own
 * page builds, so a sync opens a background "sync tab" and steers it: first it
 * lets the page list chats, then it opens each new or changed chat in turn,
 * and the content script reports what the page loaded. The tab asks what to do
 * next after every step, so the sync survives the worker being stopped between
 * steps. Gemini tabs the user opens are only watched passively.
 */

/** Every chat seen in a Gemini list, by id: its title and list update time. */
export type GeminiIndex = Record<string, { title: string; updatedAt: number | null }>;

interface SyncTabState {
  tabId: number;
  mode: SyncMode;
  phase: "list" | "fetch";
  /** Chats to open, newest first; `index` is the one being read. */
  queue: string[];
  index: number;
  listed: number;
  fetched: number;
  failed: number;
}

const INDEX_KEY = "gemini:index";
const STATE_KEY = "gemini:syncTab";
/** Turned off once Gemini rejects enlarged page sizes, so later syncs use the page's defaults. */
const ENLARGE_KEY = "gemini:enlarge";

// ---- Pure helpers ---------------------------------------------------------------

/** Chats whose list update time differs from the one recorded at their last full read, newest first. */
export function geminiQueue(index: GeminiIndex, known: Map<string, number | null>): string[] {
  return Object.entries(index)
    .filter(([id, { updatedAt }]) => !known.has(id) || known.get(id) !== updatedAt)
    .sort(([, a], [, b]) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map(([id]) => id);
}

/**
 * Combines what the page loaded with what was stored before. A page load may
 * hold only a chat's latest turns, so messages are merged by id, never dropped.
 */
export function mergeGeminiConversation(
  existing: StoredConversation | undefined,
  incoming: NormalizedConversation,
  listedTitle: string | undefined,
): NormalizedConversation {
  const byId = new Map((existing?.messages ?? []).map((message) => [message.sourceId, message]));
  for (const message of incoming.messages) byId.set(message.sourceId, message);
  // Stable sort: a prompt and its reply share a timestamp and keep their order.
  const ordered = [...byId.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const messages = ordered.map((message, i) => ({ ...message, parentSourceId: ordered[i - 1]?.sourceId ?? null }));
  const named = (title: string | undefined) => (title && title !== "Untitled" ? title : undefined);
  const times = (pick: (c: NormalizedConversation) => number | null) =>
    [existing, incoming].map((c) => (c ? pick(c) : null)).filter((t): t is number => t !== null);
  return {
    ...incoming,
    title: named(listedTitle) ?? named(existing?.title) ?? incoming.title,
    createdAt: times((c) => c.createdAt).length ? Math.min(...times((c) => c.createdAt)) : null,
    updatedAt: times((c) => c.updatedAt).length ? Math.max(...times((c) => c.updatedAt)) : null,
    activeLeafSourceId: null,
    messages,
  };
}

// ---- Messages from Gemini tabs ---------------------------------------------------

export function onGeminiReady(tabId: number | undefined, signedIn: boolean): Promise<GeminiInstruction> {
  return serialized(async () => {
    const state = await readState();
    if (!state || state.tabId !== tabId) return { action: "none" };
    if (!signedIn) return finish(state, "not-logged-in");
    await patchStatus("gemini", { heartbeatAt: Date.now() });
    if (state.phase === "list") return { action: "list", scroll: state.mode === "full" };
    const id = state.queue[state.index];
    return id ? { action: "capture", id } : finish(state);
  });
}

/** Records listed chats; a list seen in the user's own tab may start an automatic sync. */
export function onGeminiListed(chats: ConversationSummary[]): Promise<void> {
  return serialized(async () => {
    const index = await readIndex();
    for (const chat of chats) index[chat.id] = { title: chat.title, updatedAt: chat.updatedAt };
    await chrome.storage.local.set({ [INDEX_KEY]: index });

    const state = await readState();
    if (state) return;
    const mode = decideSyncMode(await readStatus("gemini"), Date.now());
    if (mode === "full") return startSyncTab("full", null);
    if (mode === "quick") {
      const queue = geminiQueue(index, new Map(await knownUpdates("gemini")));
      if (queue.length > 0) return startSyncTab("quick", queue);
      await patchStatus("gemini", {
        error: null,
        lastSuccessAt: Date.now(),
        lastResult: { listed: Object.keys(index).length, fetched: 0, failed: 0 },
      });
    }
  });
}

export function onGeminiCaptured(conversation: NormalizedConversation, complete: boolean): Promise<void> {
  return serialized(async () => {
    const listed = (await readIndex())[conversation.sourceId];
    const existing = await getConversation(conversationKey("gemini", conversation.sourceId));
    const merged = mergeGeminiConversation(existing, conversation, listed?.title);
    // Only a read by the sync tab (whole chat) counts as up to date with the list.
    const listedUpdatedAt = complete ? (listed?.updatedAt ?? null) : (existing?.listedUpdatedAt ?? null);
    await saveConversation(merged, listedUpdatedAt);
  });
}

export function onGeminiListDone(tabId: number | undefined, enlargeFailed: boolean): Promise<GeminiInstruction> {
  return serialized(async () => {
    const state = await readState();
    if (!state || state.tabId !== tabId) return { action: "none" };
    if (enlargeFailed && (await readEnlarge())) {
      await chrome.storage.local.set({ [ENLARGE_KEY]: false });
      return { action: "navigate", url: geminiSyncUrl(null, false) };
    }
    const index = await readIndex();
    const queue = geminiQueue(index, new Map(await knownUpdates("gemini")));
    const next: SyncTabState = { ...state, phase: "fetch", queue, index: 0, listed: Object.keys(index).length };
    await writeState(next);
    await patchStatus("gemini", { done: 0, total: queue.length, heartbeatAt: Date.now() });
    return advance(next);
  });
}

export function onGeminiStepDone(
  tabId: number | undefined,
  id: string,
  ok: boolean,
  enlargeFailed: boolean,
): Promise<GeminiInstruction> {
  return serialized(async () => {
    const state = await readState();
    if (!state || state.tabId !== tabId || state.queue[state.index] !== id) return { action: "none" };
    if (!ok && enlargeFailed && (await readEnlarge())) {
      await chrome.storage.local.set({ [ENLARGE_KEY]: false });
      return { action: "navigate", url: geminiSyncUrl(id, false) };
    }
    const next: SyncTabState = {
      ...state,
      index: state.index + 1,
      fetched: state.fetched + (ok ? 1 : 0),
      failed: state.failed + (ok ? 0 : 1),
    };
    await writeState(next);
    await patchStatus("gemini", { done: next.index, total: next.queue.length, heartbeatAt: Date.now() });
    return advance(next);
  });
}

/** Starts a sync the user asked for, unless one is already running. */
export function startGeminiSync(): Promise<void> {
  return serialized(async () => {
    if (!(await readState())) await startSyncTab("full", null);
  });
}

export function onGeminiTabRemoved(tabId: number): Promise<void> {
  return serialized(async () => {
    const state = await readState();
    if (state?.tabId === tabId) await finish(state, "The Gemini sync tab was closed", false);
  });
}

// ---- Internals (call only inside serialized) -------------------------------------

/** Opens the sync tab: on the app to list chats, or straight on the first chat of `queue`. */
async function startSyncTab(mode: SyncMode, queue: string[] | null): Promise<void> {
  const enlarge = await readEnlarge();
  const tab = await chrome.tabs.create({ url: geminiSyncUrl(queue?.[0] ?? null, enlarge), active: false });
  if (tab.id === undefined) return;
  const listed = Object.keys(await readIndex()).length;
  await writeState({
    tabId: tab.id,
    mode,
    phase: queue ? "fetch" : "list",
    queue: queue ?? [],
    index: 0,
    listed,
    fetched: 0,
    failed: 0,
  });
  await patchStatus("gemini", {
    running: true,
    heartbeatAt: Date.now(),
    done: 0,
    total: queue?.length ?? 0,
    error: null,
    pendingMode: null,
  });
}

async function advance(state: SyncTabState): Promise<GeminiInstruction> {
  const id = state.queue[state.index];
  if (id === undefined) return finish(state);
  return { action: "navigate", url: geminiSyncUrl(id, await readEnlarge()) };
}

/** Ends the sync: records the result, closes the tab (or shows it to sign in). */
async function finish(state: SyncTabState, error?: string, closeTab = true): Promise<GeminiInstruction> {
  await chrome.storage.session.remove(STATE_KEY);
  await patchStatus("gemini", (status) => ({
    running: false,
    heartbeatAt: null,
    error: error ?? null,
    lastResult: { listed: state.listed, fetched: state.fetched, failed: state.failed },
    lastSuccessAt: error ? status.lastSuccessAt : Date.now(),
  }));
  if (closeTab) {
    if (error === "not-logged-in") await chrome.tabs.update(state.tabId, { active: true }).catch(() => {});
    else await chrome.tabs.remove(state.tabId).catch(() => {});
  }
  return { action: "done" };
}

async function readIndex(): Promise<GeminiIndex> {
  return ((await chrome.storage.local.get(INDEX_KEY))[INDEX_KEY] as GeminiIndex | undefined) ?? {};
}

async function readState(): Promise<SyncTabState | null> {
  return ((await chrome.storage.session.get(STATE_KEY))[STATE_KEY] as SyncTabState | undefined) ?? null;
}

async function writeState(state: SyncTabState): Promise<void> {
  await chrome.storage.session.set({ [STATE_KEY]: state });
}

async function readEnlarge(): Promise<boolean> {
  return ((await chrome.storage.local.get(ENLARGE_KEY))[ENLARGE_KEY] as boolean | undefined) ?? true;
}
