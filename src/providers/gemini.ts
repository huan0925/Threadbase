import type { ConversationSummary } from "../sync.ts";
import type { NormalizedConversation, NormalizedMessage } from "../types.ts";

/**
 * Gemini, read from the responses to the page's own "batchexecute" calls.
 *
 * Unlike ChatGPT and Claude, Threadbase doesn't call Gemini's API itself:
 * Gemini rejects calls that its own page scripts didn't build (status 13,
 * BardErrorInfo 1096), even sent from the page with the page's headers. So
 * src/content/gemini-page.ts watches the page's own calls and hands their
 * responses to the content script, and syncing works by having a Gemini tab
 * open each conversation (see src/gemini-backfill.ts).
 *
 * Responses are positional JSON arrays rather than objects; the positions
 * below were mapped from recordings of the live site (made with
 * tools/har-shape.mjs) and match those used by the maintained open-source
 * client github.com/HanaokaYuzu/Gemini-API. Check them first if syncing breaks.
 */

export const GEMINI_ORIGIN = "https://gemini.google.com";

/** RPC ids, as named in the batchexecute URL's `rpcids` parameter. */
export const RPC_LIST_CHATS = "MaZiqc";
export const RPC_READ_CHAT = "hNvQHb";

/**
 * In the sync tab, the page's own list and read calls ask for this many chats
 * or turns instead of the page's defaults (35 and 10), so one page load gets
 * more. If Gemini rejects the enlarged calls, syncing falls back to the defaults.
 */
const ENLARGED_PAGE_SIZE = 100;

/** Query parameter marking a tab Threadbase opened to sync; its value says whether to enlarge. */
export const SYNC_TAB_PARAM = "threadbase";

type Json = unknown;
/** One conversation turn from hNvQHb: a prompt, its reply candidates, a timestamp. */
type Turn = Json[];

/** The page URL of a conversation, or of the app when no id is given, marked for the sync tab. */
export function geminiSyncUrl(id: string | null, enlarge: boolean): string {
  const path = id ? `/app/${id.replace(/^c_/, "")}` : "/app";
  return `${GEMINI_ORIGIN}${path}?${SYNC_TAB_PARAM}=${enlarge ? "enlarge" : "plain"}`;
}

/** The arguments of each RPC in a batchexecute request body (form-encoded f.req). */
export function argsByRpc(body: string): Map<string, Json[]> {
  const calls = new Map<string, Json[]>();
  try {
    const freq = JSON.parse(new URLSearchParams(body).get("f.req") ?? "null") as Json;
    for (const call of arrayAt(freq, 0)) {
      const [rpcid, args] = call as [unknown, unknown];
      if (typeof rpcid === "string" && typeof args === "string") calls.set(rpcid, JSON.parse(args));
    }
  } catch {
    // Not a batchexecute body Threadbase understands; leave it alone.
  }
  return calls;
}

/**
 * Raises the page sizes in the page's own list (MaZiqc: [count, token, filter])
 * and read (hNvQHb: [id, turns, token, …]) calls. Returns null when the body
 * has neither, so callers send it unchanged.
 */
export function enlargePageSizes(body: string): string | null {
  const form = new URLSearchParams(body);
  let freq: Json;
  try {
    freq = JSON.parse(form.get("f.req") ?? "null");
  } catch {
    return null;
  }
  let changed = false;
  for (const call of arrayAt(freq, 0)) {
    if (!Array.isArray(call) || typeof call[1] !== "string") continue;
    const sizeIndex = call[0] === RPC_LIST_CHATS ? 0 : call[0] === RPC_READ_CHAT ? 1 : -1;
    if (sizeIndex === -1) continue;
    const args = JSON.parse(call[1]) as Json[];
    if (typeof args[sizeIndex] !== "number" || (args[sizeIndex] as number) >= ENLARGED_PAGE_SIZE) continue;
    args[sizeIndex] = ENLARGED_PAGE_SIZE;
    call[1] = JSON.stringify(args);
    changed = true;
  }
  if (!changed) return null;
  form.set("f.req", JSON.stringify(freq));
  return form.toString();
}

/** Chats in a MaZiqc payload: [_, nextPageToken, [chat, …]]. */
export function listChats(payload: Json): ConversationSummary[] {
  return arrayAt(payload, 2)
    .map(toSummary)
    .filter((summary): summary is ConversationSummary => summary !== null);
}

/** Turns in an hNvQHb payload: [[turn, …], nextPageToken, …]. */
export function chatTurns(payload: Json): Turn[] {
  return arrayAt(payload, 0) as Turn[];
}

/** Whether the page is signed in: its WIZ_global_data has an XSRF token ("SNlM0e"). */
export function isSignedIn(html: string): boolean {
  return /"SNlM0e":\s*"[^"]+"/.test(html);
}

/**
 * A batchexecute response is ")]}'" followed by length-prefixed JSON chunks.
 * Each result is ["wrb.fr", rpcid, payloadAsJsonString, …].
 */
export function parseBatchResponse(text: string, rpcid: string): Json {
  for (const line of text.split("\n")) {
    if (!line.startsWith("[")) continue;
    let chunk: Json;
    try {
      chunk = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(chunk)) continue;
    for (const item of chunk) {
      if (Array.isArray(item) && item[0] === "wrb.fr" && item[1] === rpcid) {
        if (typeof item[2] !== "string") {
          // Failed calls carry a status code where the payload would be, e.g. [3] for a bad request.
          const code = item.slice(3).find((field: Json) => Array.isArray(field) && typeof field[0] === "number");
          throw new Error(`Gemini rejected ${rpcid}${code ? ` (status ${JSON.stringify(code)})` : ""}`);
        }
        return JSON.parse(item[2]);
      }
    }
  }
  throw new Error(`Gemini's response had no result for ${rpcid}`);
}

export function toSummary(chat: Json): ConversationSummary | null {
  const id = at(chat, 0);
  // A chat record has many fields; anything shorter isn't one.
  if (!Array.isArray(chat) || chat.length < 2 || typeof id !== "string") return null;
  const title = at(chat, 1);
  return {
    id,
    title: typeof title === "string" ? title : "",
    // At index 5 (index 2 is "pinned"); found by shape in case it moves.
    updatedAt: Array.isArray(chat) ? (chat.map(toTimestamp).find((t) => t !== null) ?? null) : null,
  };
}

/**
 * Turns arrive newest first. Each turn is
 *   [[chatId, responseId], previousTurnRef, [[prompt, …], …], [[candidate, …], …], [seconds, nanos]]
 * where a candidate is [candidateId, [replyText, …], …] and previousTurnRef is
 * [chatId, responseId, candidateId] of the turn before it, naming the reply
 * candidate the user kept. Only that candidate is stored, as one linear thread.
 */
export function normalizeGeminiConversation(id: string, title: string, turns: Turn[]): NormalizedConversation {
  const ordered = [...turns].sort((a, b) => (toTimestamp(at(a, 4)) ?? 0) - (toTimestamp(at(b, 4)) ?? 0));
  const messages: NormalizedMessage[] = [];
  let parentId: string | null = null;

  ordered.forEach((turn, index) => {
    const responseId = at(turn, 0, 1);
    const turnId = typeof responseId === "string" ? responseId : `${id}#${index}`;
    const createdAt = toTimestamp(at(turn, 4));

    const prompt = at(turn, 2, 0, 0);
    if (typeof prompt === "string" && prompt.trim()) {
      messages.push({
        sourceId: `${turnId}:prompt`,
        parentSourceId: parentId,
        role: "user",
        content: prompt.trim(),
        createdAt,
        model: null,
      });
      parentId = `${turnId}:prompt`;
    }

    const candidates = arrayAt(turn, 3, 0);
    const keptId = at(ordered[index + 1], 1, 2);
    const kept = candidates.find((c) => at(c, 0) === keptId) ?? candidates[0];
    const reply = at(kept, 1, 0);
    if (typeof reply === "string" && reply.trim()) {
      const candidateId = at(kept, 0);
      const sourceId = typeof candidateId === "string" ? candidateId : `${turnId}:reply`;
      messages.push({ sourceId, parentSourceId: parentId, role: "assistant", content: reply.trim(), createdAt, model: null });
      parentId = sourceId;
    }
  });

  const firstAt = toTimestamp(at(ordered[0], 4));
  const lastAt = toTimestamp(at(ordered.at(-1), 4));
  return {
    source: "gemini",
    sourceId: id,
    title: title.trim() || "Untitled",
    createdAt: firstAt,
    updatedAt: lastAt,
    url: `${GEMINI_ORIGIN}/app/${id.replace(/^c_/, "")}`,
    activeLeafSourceId: null,
    messages,
  };
}

/** Google's [seconds, nanoseconds] timestamp as epoch milliseconds. */
function toTimestamp(value: Json): number | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return null;
  const [seconds, nanos = 0] = value;
  if (typeof seconds !== "number" || seconds < 1e9 || seconds > 1e10 || typeof nanos !== "number") return null;
  return seconds * 1000 + Math.floor(nanos / 1e6);
}

/** Safe positional access into nested arrays. */
function at(value: Json, ...path: number[]): Json {
  let current = value;
  for (const index of path) {
    if (!Array.isArray(current)) return undefined;
    current = current[index];
  }
  return current;
}

function arrayAt(value: Json, ...path: number[]): Json[] {
  const found = at(value, ...path);
  return Array.isArray(found) ? found : [];
}
