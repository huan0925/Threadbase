/**
 * Runs in gemini.google.com's own JavaScript world (not the isolated content
 * script world) from document start. Gemini rejects calls its own scripts
 * didn't build, so Threadbase reads chats from the responses to the page's
 * own calls instead: this script watches the page's batchexecute calls that
 * list or read chats and posts their responses to the content script.
 * Nothing leaves the page.
 *
 * In a tab Threadbase opened to sync (marked ?threadbase=…), it also rewrites
 * those calls: larger page sizes (?threadbase=enlarge), and the chat list's
 * next page when the content script left a token for this load.
 *
 * The page's transport isn't documented, so calls are recognized by URL
 * (rpcids), and both XMLHttpRequest and fetch are watched, whatever the body
 * and response types.
 */

import { LIST_TOKEN_KEY, rewriteSyncCall, RPC_LIST_CHATS, RPC_READ_CHAT, SYNC_TAB_PARAM } from "../providers/gemini.ts";
import {
  BRIDGE_SOURCE,
  isBridgeMessage,
  PAGE_STATS_ATTRIBUTE,
  type CapturedCall,
  type PageStats,
  type ReplayRequest,
} from "./gemini-bridge.ts";

/** "enlarge" or "plain" in the sync tab; null in the user's own tabs, whose calls are never changed. */
const SYNC_MODE = new URLSearchParams(location.search).get(SYNC_TAB_PARAM);
/** Calls captured so far, re-posted on request in case the content script loaded later. */
const captured: CapturedCall[] = [];
const stats: PageStats = { batchCalls: 0, chatCalls: 0, captured: 0, lastError: "" };

function noteStats(): void {
  document.documentElement?.setAttribute(PAGE_STATS_ATTRIBUTE, JSON.stringify(stats));
}

/** The chat RPCs in a batchexecute URL, or null for any other request. */
function chatRpcs(url: URL): string[] | null {
  if (url.origin !== location.origin || !url.pathname.endsWith("/batchexecute")) return null;
  stats.batchCalls++;
  const rpcids = (url.searchParams.get("rpcids") ?? "").split(",").filter(Boolean);
  if (!rpcids.some((rpcid) => rpcid === RPC_LIST_CHATS || rpcid === RPC_READ_CHAT)) {
    noteStats();
    return null;
  }
  stats.chatCalls++;
  noteStats();
  return rpcids;
}

function publish(rpcids: string[], text: string, modified: boolean): void {
  const call: CapturedCall = { source: BRIDGE_SOURCE, type: "captured", rpcids, text, modified };
  captured.push(call);
  if (captured.length > 50) captured.shift();
  stats.captured++;
  noteStats();
  window.postMessage(call, location.origin);
}

function fail(error: unknown): void {
  stats.lastError = error instanceof Error ? error.message : String(error);
  noteStats();
}

/** The rewritten body for the sync tab, or null to send the page's body unchanged. */
function rewrite(body: unknown): string | null {
  if (SYNC_MODE === null) return null;
  const text = typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : null;
  if (text === null) return null;
  const listToken = sessionStorage.getItem(LIST_TOKEN_KEY);
  const rewritten = rewriteSyncCall(text, { enlarge: SYNC_MODE === "enlarge", listToken });
  // The token is for this load's first list call only.
  if (rewritten?.usedListToken) sessionStorage.removeItem(LIST_TOKEN_KEY);
  return rewritten?.body ?? null;
}

async function xhrText(xhr: XMLHttpRequest): Promise<string> {
  switch (xhr.responseType) {
    case "":
    case "text":
      return xhr.responseText;
    case "arraybuffer":
      return new TextDecoder().decode(xhr.response as ArrayBuffer);
    case "blob":
      return (xhr.response as Blob).text();
    case "json":
      return JSON.stringify(xhr.response);
    default:
      throw new Error(`unreadable response type "${xhr.responseType}"`);
  }
}

const requestUrls = new WeakMap<XMLHttpRequest, URL>();
const { open, send } = XMLHttpRequest.prototype;

XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  requestUrls.set(this, new URL(String(url), location.href));
  return (open as (...args: unknown[]) => void).call(this, method, url, ...rest);
} as typeof XMLHttpRequest.prototype.open;

XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
  const url = requestUrls.get(this);
  const rpcids = url ? chatRpcs(url) : null;
  if (!rpcids) return send.call(this, body);
  const rewritten = rewrite(body);
  this.addEventListener("loadend", () => {
    if (this.status !== 200) return fail(`HTTP ${this.status}`);
    xhrText(this).then((text) => publish(rpcids, text, rewritten !== null), fail);
  });
  return send.call(this, rewritten ?? body);
};

const pageFetch = window.fetch;
window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  const rpcids = chatRpcs(url);
  if (!rpcids) return pageFetch.call(this, input, init);

  let rewritten: string | null = null;
  try {
    rewritten = rewrite(init?.body ?? (input instanceof Request ? await input.clone().text() : null));
  } catch (error) {
    fail(error);
  }
  let request = input;
  let options = init;
  if (rewritten !== null) {
    if (input instanceof Request) request = new Request(input, { body: rewritten });
    else options = { ...init, body: rewritten };
  }
  const response = await pageFetch.call(this, request, options);
  if (!response.ok) {
    fail(`HTTP ${response.status}`);
    return response;
  }
  response
    .clone()
    .text()
    .then((text) => publish(rpcids, text, rewritten !== null), fail);
  return response;
};

window.addEventListener("message", (event) => {
  if (event.source !== window || !isBridgeMessage<ReplayRequest>(event.data, "replay")) return;
  for (const call of captured) window.postMessage(call, location.origin);
});
