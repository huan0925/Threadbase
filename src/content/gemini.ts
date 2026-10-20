import { sendToBackground, type GeminiInstruction } from "../messages.ts";
import {
  chatTurns,
  isSignedIn,
  LIST_TOKEN_KEY,
  listChats,
  nextListToken,
  normalizeGeminiConversation,
  parseBatchResponse,
  RPC_LIST_CHATS,
  RPC_READ_CHAT,
  SYNC_TAB_PARAM,
} from "../providers/gemini.ts";
import {
  BRIDGE_SOURCE,
  isBridgeMessage,
  PAGE_STATS_ATTRIBUTE,
  type CapturedCall,
  type PageStats,
  type ReplayRequest,
} from "./gemini-bridge.ts";

/**
 * Gemini content script. Receives the page's own list and read calls from
 * gemini-page.ts and passes the chats to the background worker. In the sync
 * tab, it also follows the background's instructions (see gemini-backfill.ts).
 */

const LIST_TIMEOUT_MS = 20_000;
const CHAT_TIMEOUT_MS = 25_000;
/** sessionStorage key for the list pages the sync tab already asked for, so paging can't loop. */
const LIST_PAGES_KEY = "threadbase:gemini-list-pages";
const MAX_LIST_PAGES = 100;
/**
 * Pauses before opening the next chat, so a sync reads at a person's pace:
 * longer before a full page load, which costs dozens of requests.
 */
const CLICK_PAUSE_MS = 3000;
const LOAD_PAUSE_MS = 6000;

/** The sync tab's mode ("enlarge" or "plain") this page was loaded with, if it's the sync tab. */
const loadedMode = new URLSearchParams(location.search).get(SYNC_TAB_PARAM);
const readChats = new Set<string>();
let listedAt = 0;
/** The latest chat list's next-page token. */
let listToken: string | null = null;
/** Gemini refused a call Threadbase rewrote (larger pages or a list page). */
let rewriteRefused = false;

/** Problems parsing captured responses, for the diagnosis shown when a sync finds no chats. */
let parseError = "";

function onCaptured(call: CapturedCall): void {
  for (const rpcid of call.rpcids) {
    if (rpcid !== RPC_LIST_CHATS && rpcid !== RPC_READ_CHAT) continue;
    let payload: unknown;
    try {
      payload = parseBatchResponse(call.text, rpcid);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
      // Gemini refused the page's call; if Threadbase rewrote it, that's why.
      if (call.modified) rewriteRefused = true;
      continue;
    }
    if (rpcid === RPC_LIST_CHATS) {
      listedAt = Date.now();
      listToken = nextListToken(payload);
      void sendToBackground({ type: "gemini-listed", chats: listChats(payload) }).catch(() => {});
      continue;
    }
    // Each turn starts with [chatId, responseId], so the chat id needs no request body.
    const turns = chatTurns(payload);
    const id = turns.map((turn) => (Array.isArray(turn[0]) ? turn[0][0] : null)).find((v) => typeof v === "string");
    if (typeof id !== "string") continue;
    const conversation = normalizeGeminiConversation(id, "", turns);
    if (conversation.messages.length === 0) continue;
    void sendToBackground({ type: "gemini-captured", conversation })
      .then(() => readChats.add(id))
      .catch(() => {});
  }
}

/** Why no chats were listed, in terms of what the page did. */
function diagnosis(): string {
  let stats: PageStats | null = null;
  try {
    stats = JSON.parse(document.documentElement.getAttribute(PAGE_STATS_ATTRIBUTE) ?? "null");
  } catch {
    // Unreadable stats; report what is known.
  }
  if (!stats) return "the page watcher isn't running; reload the Gemini tab";
  const problem = stats.lastError || parseError;
  return (
    `page made ${stats.batchCalls} calls, ${stats.chatCalls} for chats, ${stats.captured} read` +
    (problem ? `; ${problem}` : "")
  );
}

window.addEventListener("message", (event) => {
  if (event.source === window && isBridgeMessage<CapturedCall>(event.data, "captured")) onCaptured(event.data);
});
// Calls the page made before this script loaded.
window.postMessage({ source: BRIDGE_SOURCE, type: "replay" } satisfies ReplayRequest, location.origin);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !condition() && Date.now() < deadline; ) await sleep(250);
}

/** The page's own link to a chat, if its chat list shows it. */
function chatLink(id: string): HTMLAnchorElement | null {
  const path = `/app/${id.replace(/^c_/, "")}`;
  return [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/app/"]')].find(
    (link) => new URL(link.href, location.href).pathname === path,
  ) ?? null;
}

async function capture(id: string): Promise<void> {
  await waitFor(() => readChats.has(id) || rewriteRefused, CHAT_TIMEOUT_MS);
  return follow(
    await sendToBackground<GeminiInstruction>({
      type: "gemini-step-done",
      id,
      ok: readChats.has(id),
      enlargeFailed: rewriteRefused,
    }),
  );
}

/**
 * In a full sync, asks for the chat list's next page by reloading: the page's
 * own first list call then carries the token (see gemini-page.ts). Returns
 * false once the list is complete.
 */
async function loadNextListPage(): Promise<boolean> {
  const requested = JSON.parse(sessionStorage.getItem(LIST_PAGES_KEY) ?? "[]") as string[];
  if (!listToken || rewriteRefused || requested.includes(listToken) || requested.length >= MAX_LIST_PAGES) {
    sessionStorage.removeItem(LIST_PAGES_KEY);
    sessionStorage.removeItem(LIST_TOKEN_KEY);
    return false;
  }
  sessionStorage.setItem(LIST_PAGES_KEY, JSON.stringify([...requested, listToken]));
  sessionStorage.setItem(LIST_TOKEN_KEY, listToken);
  await sleep(LOAD_PAUSE_MS);
  location.reload();
  return true;
}

async function follow(instruction: GeminiInstruction): Promise<void> {
  switch (instruction.action) {
    case "list":
      await waitFor(() => listedAt > 0 || rewriteRefused, LIST_TIMEOUT_MS);
      if (instruction.allPages && (await loadNextListPage())) return;
      sessionStorage.removeItem(LIST_PAGES_KEY);
      sessionStorage.removeItem(LIST_TOKEN_KEY);
      return follow(
        await sendToBackground<GeminiInstruction>({
          type: "gemini-list-done",
          enlargeFailed: rewriteRefused,
          diagnosis: listedAt > 0 ? null : diagnosis(),
        }),
      );
    case "capture":
      return capture(instruction.id);
    case "navigate": {
      // Opening the chat from the page's own chat list loads just that chat,
      // like a person clicking it; a full page load costs dozens of requests.
      // A different mode (enlarging turned off) only takes effect on a fresh load.
      const sameMode = new URL(instruction.url).searchParams.get(SYNC_TAB_PARAM) === loadedMode;
      const link = instruction.id && sameMode ? chatLink(instruction.id) : null;
      if (link && instruction.id) {
        await sleep(CLICK_PAUSE_MS);
        link.click();
        return capture(instruction.id);
      }
      await sleep(LOAD_PAUSE_MS);
      location.assign(instruction.url);
      return;
    }
    case "none":
    case "done":
      return;
  }
}

const signedIn = isSignedIn([...document.scripts].map((script) => script.textContent ?? "").join("\n"));
void sendToBackground<GeminiInstruction>({ type: "gemini-ready", signedIn }).then(follow, () => {});
