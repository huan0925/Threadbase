import type { ConversationSummary, SyncMode, SyncResult } from "./sync.ts";
import type { NormalizedConversation, SourceId } from "./types.ts";

/** Messages sent to the background service worker. */
export type BackgroundRequest =
  /** A content script asks whether to sync now (and which mode). */
  | { type: "sync-begin"; source: SourceId; automatic: boolean }
  | { type: "known"; source: SourceId }
  | { type: "save"; conversation: NormalizedConversation; listedUpdatedAt: number | null }
  | { type: "progress"; source: SourceId; done: number; total: number }
  | { type: "sync-end"; source: SourceId; result?: SyncResult; error?: string }
  /** The popup asks for a sync; opens the site in a background tab if needed. */
  | { type: "start-sync"; source: SourceId }
  // Gemini, synced from the page's own calls (see gemini-backfill.ts):
  /** A Gemini tab loaded; the reply says what it should do. */
  | { type: "gemini-ready"; signedIn: boolean }
  /** The page listed chats. */
  | { type: "gemini-listed"; chats: ConversationSummary[] }
  /** The page read a chat. */
  | { type: "gemini-captured"; conversation: NormalizedConversation }
  /** The sync tab finished listing chats. */
  | { type: "gemini-list-done"; enlargeFailed: boolean; diagnosis: string | null }
  /** The sync tab finished (or gave up) reading a chat. */
  | { type: "gemini-step-done"; id: string; ok: boolean; enlargeFailed: boolean };

/** What a Gemini tab should do next. */
export type GeminiInstruction =
  | { action: "none" }
  /** Let the page list chats; with `allPages`, page through the whole list. */
  | { action: "list"; allPages: boolean }
  | { action: "capture"; id: string }
  /** Open a chat (`id`) or the chat list (null): in the page when it links to it, else by loading `url`. */
  | { action: "navigate"; url: string; id: string | null }
  | { action: "done" };

/** Sent to a site's content script: run the sync the background has queued. */
export type ContentRequest = { type: "sync" };

/** Every background response is wrapped so errors survive the message channel. */
export type BackgroundResponse<T> = { ok: true; value: T } | { ok: false; error: string };

export async function sendToBackground<T>(request: BackgroundRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as BackgroundResponse<T> | undefined;
  if (!response) throw new Error(`No response to ${request.type}`);
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

export interface SyncBeginResponse {
  mode: SyncMode | null;
}

/** Status errors that ask the user to act, rather than report a failure. */
export const NOT_LOGGED_IN = "not-logged-in";
/** Google asked to confirm the user isn't a robot (Gemini). */
export const ROBOT_CHECK = "robot-check";

/** Per-source sync status, kept in chrome.storage.local so the popup can watch it. */
export interface SyncStatus {
  running: boolean;
  /** Last time a running sync reported in; a stale one is treated as crashed. */
  heartbeatAt: number | null;
  done: number;
  total: number;
  lastSuccessAt: number | null;
  lastResult: SyncResult | null;
  /** NOT_LOGGED_IN, ROBOT_CHECK, or an error message from the last sync. */
  error: string | null;
  /** A sync the user asked for that the site's tab should run when it loads. */
  pendingMode: SyncMode | null;
}

export const EMPTY_STATUS: SyncStatus = {
  running: false,
  heartbeatAt: null,
  done: 0,
  total: 0,
  lastSuccessAt: null,
  lastResult: null,
  error: null,
  pendingMode: null,
};

export function statusKey(source: SourceId): string {
  return `status:${source}`;
}

export async function readStatus(source: SourceId): Promise<SyncStatus> {
  const key = statusKey(source);
  const stored = (await chrome.storage.local.get(key))[key] as Partial<SyncStatus> | undefined;
  return { ...EMPTY_STATUS, ...stored };
}

export async function writeStatus(source: SourceId, patch: Partial<SyncStatus>): Promise<SyncStatus> {
  const next = { ...(await readStatus(source)), ...patch };
  await chrome.storage.local.set({ [statusKey(source)]: next });
  return next;
}
