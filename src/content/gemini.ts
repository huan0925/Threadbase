import { sendToBackground, type GeminiInstruction } from "../messages.ts";
import {
  argsByRpc,
  chatTurns,
  isSignedIn,
  listChats,
  normalizeGeminiConversation,
  parseBatchResponse,
  RPC_LIST_CHATS,
  RPC_READ_CHAT,
  SYNC_TAB_PARAM,
} from "../providers/gemini.ts";
import { BRIDGE_SOURCE, isBridgeMessage, type CapturedCall, type ReplayRequest } from "./gemini-bridge.ts";

/**
 * Gemini content script. Receives the page's own list and read calls from
 * gemini-page.ts and passes the chats to the background worker. In the sync
 * tab, it also follows the background's instructions (see gemini-backfill.ts).
 */

const LIST_TIMEOUT_MS = 20_000;
const CHAT_TIMEOUT_MS = 25_000;
/** When scrolling the chat list, stop after this many scrolls load nothing new. */
const IDLE_SCROLLS = 3;
const SCROLL_PAUSE_MS = 2000;
const SCROLL_LIMIT_MS = 3 * 60_000;

const inSyncTab = new URLSearchParams(location.search).has(SYNC_TAB_PARAM);
const readChats = new Set<string>();
let listedAt = 0;
let enlargeFailed = false;

function onCaptured(call: CapturedCall): void {
  for (const [rpcid, args] of argsByRpc(call.body)) {
    if (rpcid !== RPC_LIST_CHATS && rpcid !== RPC_READ_CHAT) continue;
    let payload: unknown;
    try {
      payload = parseBatchResponse(call.text, rpcid);
    } catch {
      // Gemini refused the page's call; if Threadbase enlarged it, that's why.
      if (call.enlarged) enlargeFailed = true;
      continue;
    }
    if (rpcid === RPC_LIST_CHATS) {
      listedAt = Date.now();
      void sendToBackground({ type: "gemini-listed", chats: listChats(payload) }).catch(() => {});
    } else if (typeof args[0] === "string") {
      const id = args[0];
      const conversation = normalizeGeminiConversation(id, "", chatTurns(payload));
      if (conversation.messages.length === 0) continue;
      void sendToBackground({ type: "gemini-captured", conversation, complete: inSyncTab })
        .then(() => readChats.add(id))
        .catch(() => {});
    }
  }
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

/** Scrolls the chat list to its end, so the page lists older chats too. */
async function scrollChatList(): Promise<void> {
  let idle = 0;
  for (const deadline = Date.now() + SCROLL_LIMIT_MS; idle < IDLE_SCROLLS && Date.now() < deadline; ) {
    const scroller = [...document.querySelectorAll<HTMLElement>('a[href*="/app/"]')]
      .map(scrollableAncestor)
      .find((element) => element !== null);
    if (!scroller) return;
    const before = listedAt;
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event("scroll"));
    await sleep(SCROLL_PAUSE_MS);
    idle = listedAt === before ? idle + 1 : 0;
  }
}

function scrollableAncestor(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

async function follow(instruction: GeminiInstruction): Promise<void> {
  switch (instruction.action) {
    case "list":
      await waitFor(() => listedAt > 0 || enlargeFailed, LIST_TIMEOUT_MS);
      if (instruction.scroll && !enlargeFailed) await scrollChatList();
      return follow(await sendToBackground<GeminiInstruction>({ type: "gemini-list-done", enlargeFailed }));
    case "capture": {
      const { id } = instruction;
      await waitFor(() => readChats.has(id) || enlargeFailed, CHAT_TIMEOUT_MS);
      return follow(
        await sendToBackground<GeminiInstruction>({ type: "gemini-step-done", id, ok: readChats.has(id), enlargeFailed }),
      );
    }
    case "navigate":
      location.assign(instruction.url);
      return;
    case "none":
    case "done":
      return;
  }
}

const signedIn = isSignedIn([...document.scripts].map((script) => script.textContent ?? "").join("\n"));
void sendToBackground<GeminiInstruction>({ type: "gemini-ready", signedIn }).then(follow, () => {});
