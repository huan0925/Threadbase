import type { ConversationSummary, ProviderClient } from "../sync.ts";
import type { NormalizedConversation, NormalizedMessage } from "../types.ts";
import { fetchWithRetry, NotLoggedInError, type FetchLike } from "./http.ts";

/**
 * Gemini, read through the same Google "batchexecute" RPCs gemini.google.com's
 * own UI uses. Responses are positional JSON arrays rather than objects; the
 * positions below were mapped from recordings of the live site (made with
 * tools/har-shape.mjs) and are the first thing to check if syncing breaks.
 */

export const GEMINI_ORIGIN = "https://gemini.google.com";

/** RPC ids, as named in the batchexecute URL's `rpcids` parameter. */
const RPC_LIST_CHATS = "MaZiqc";
const RPC_READ_CHAT = "hNvQHb";

const LIST_PAGE_SIZE = 35;
const TURNS_PAGE_SIZE = 100;
/** Guards against a pagination token that never runs out. */
const MAX_PAGES = 500;

/** Page-embedded values every batchexecute call needs. */
interface SessionTokens {
  /** XSRF token, sent as the `at` form field ("SNlM0e" in WIZ_global_data). */
  at: string;
  /** Server build label, the `bl` query parameter ("cfb2h"). */
  bl: string | null;
  /** Session id, the `f.sid` query parameter ("FdrFJe"). */
  sid: string | null;
}

type Json = unknown;
/** One conversation turn from hNvQHb: a prompt, its reply candidates, a timestamp. */
type Turn = Json[];

export function createGeminiClient(fetch: FetchLike, origin = GEMINI_ORIGIN): ProviderClient {
  let tokens: Promise<SessionTokens> | undefined;
  let requestId = Math.floor(Math.random() * 90_000) + 10_000;
  /** Conversation id → title, filled while listing (the chat itself doesn't carry one). */
  const titles = new Map<string, string>();

  const call = async (rpcid: string, args: Json[]): Promise<Json> => {
    tokens ??= fetchSessionTokens(fetch, origin);
    const { at, bl, sid } = await tokens;
    const query = new URLSearchParams({ rpcids: rpcid, "source-path": "/app", rt: "c" });
    if (bl) query.set("bl", bl);
    if (sid) query.set("f.sid", sid);
    query.set("_reqid", String((requestId += 100_000)));
    const body = new URLSearchParams({
      "f.req": JSON.stringify([[[rpcid, JSON.stringify(args), null, "generic"]]]),
      at,
    });
    const response = await fetchWithRetry(
      `${origin}/_/BardChatUi/data/batchexecute?${query}`,
      { method: "POST", body },
      {
        fetch,
        site: "Gemini",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "X-Same-Domain": "1" },
      },
    );
    return parseBatchResponse(await response.text(), rpcid);
  };

  return {
    source: "gemini",

    async *listConversations(): AsyncIterable<ConversationSummary> {
      const seen = new Set<string>();
      let token: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const payload = await call(RPC_LIST_CHATS, [
          LIST_PAGE_SIZE,
          token,
          [null, null, 1, null, null, null, null, null, null, 1],
        ]);
        const chats = arrayAt(payload, 2);
        for (const chat of chats) {
          const summary = toSummary(chat);
          if (!summary || seen.has(summary.id)) continue;
          seen.add(summary.id);
          titles.set(summary.id, summary.title);
          yield summary;
        }
        const next = at(payload, 1);
        if (typeof next !== "string" || next === token || chats.length === 0) return;
        token = next;
      }
    },

    async getConversation(id) {
      const turns = new Map<string, Turn>();
      let token: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const payload = await call(RPC_READ_CHAT, [id, TURNS_PAGE_SIZE, token, 1, [0], [4], null, 1]);
        // Keyed by response id, so a page served twice can't duplicate turns.
        for (const turn of arrayAt(payload, 0) as Turn[]) turns.set(String(at(turn, 0, 1) ?? turns.size), turn);
        const next = at(payload, 1);
        if (typeof next !== "string" || next === token) break;
        token = next;
      }
      return normalizeGeminiConversation(id, titles.get(id) ?? "", [...turns.values()]);
    },
  };
}

/** Reads the batchexecute tokens from the app page, as the page's own scripts do. */
async function fetchSessionTokens(fetch: FetchLike, origin: string): Promise<SessionTokens> {
  const html = await (await fetchWithRetry(`${origin}/app`, {}, { fetch, site: "Gemini" })).text();
  const value = (key: string) => html.match(new RegExp(`"${key}":"([^"]*)"`))?.[1] ?? null;
  const at = value("SNlM0e");
  // Signed-out visitors get the landing page, which has no XSRF token.
  if (!at) throw new NotLoggedInError("Gemini");
  return { at, bl: value("cfb2h"), sid: value("FdrFJe") };
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
        if (typeof item[2] !== "string") throw new Error(`Gemini returned no data for ${rpcid}`);
        return JSON.parse(item[2]);
      }
    }
  }
  throw new Error(`Gemini's response had no result for ${rpcid}`);
}

function toSummary(chat: Json): ConversationSummary | null {
  const id = at(chat, 0);
  if (typeof id !== "string") return null;
  const title = at(chat, 1);
  return {
    id,
    title: typeof title === "string" ? title : "",
    // The list's timestamp position isn't pinned down, so take its first [seconds, nanos] pair.
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
