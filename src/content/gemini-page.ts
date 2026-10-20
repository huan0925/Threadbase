/**
 * Runs in gemini.google.com's own JavaScript world (not the isolated content
 * script world) from document start. Gemini rejects calls its own scripts
 * didn't build, so Threadbase reads chats from the responses to the page's
 * own calls instead: this script watches the page's batchexecute calls that
 * list or read chats and posts their responses to the content script.
 * Nothing leaves the page.
 *
 * In a tab Threadbase opened to sync (marked ?threadbase=enlarge), it also
 * raises those calls' page sizes so each page load returns more.
 */

import { argsByRpc, enlargePageSizes, RPC_LIST_CHATS, RPC_READ_CHAT, SYNC_TAB_PARAM } from "../providers/gemini.ts";
import { BRIDGE_SOURCE, isBridgeMessage, type CapturedCall, type ReplayRequest } from "./gemini-bridge.ts";

const ENLARGE = new URLSearchParams(location.search).get(SYNC_TAB_PARAM) === "enlarge";
/** Calls captured so far, re-posted on request in case the content script loaded later. */
const captured: CapturedCall[] = [];

const isChatCall = (url: URL, body: string) =>
  url.origin === location.origin &&
  url.pathname.endsWith("/batchexecute") &&
  [...argsByRpc(body).keys()].some((rpcid) => rpcid === RPC_LIST_CHATS || rpcid === RPC_READ_CHAT);

function publish(body: string, text: string, enlarged: boolean): void {
  const call: CapturedCall = { source: BRIDGE_SOURCE, type: "captured", body, text, enlarged };
  captured.push(call);
  if (captured.length > 50) captured.shift();
  window.postMessage(call, location.origin);
}

/** The body to send: enlarged in a sync tab, otherwise as the page built it. */
function prepare(body: string): { body: string; enlarged: boolean } {
  const enlarged = ENLARGE ? enlargePageSizes(body) : null;
  return enlarged ? { body: enlarged, enlarged: true } : { body, enlarged: false };
}

const bodyText = (body: unknown) =>
  typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : null;

const requestUrls = new WeakMap<XMLHttpRequest, URL>();
const { open, send } = XMLHttpRequest.prototype;

XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  requestUrls.set(this, new URL(String(url), location.href));
  return (open as (...args: unknown[]) => void).call(this, method, url, ...rest);
} as typeof XMLHttpRequest.prototype.open;

XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
  const url = requestUrls.get(this);
  const text = bodyText(body);
  if (!url || text === null || !isChatCall(url, text)) return send.call(this, body);
  const prepared = prepare(text);
  this.addEventListener("load", () => publish(prepared.body, this.responseText, prepared.enlarged));
  return send.call(this, prepared.body);
};

const pageFetch = window.fetch;
window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  const text = bodyText(init?.body);
  if (input instanceof Request || text === null || !isChatCall(url, text)) return pageFetch.call(this, input, init);
  const prepared = prepare(text);
  const response = await pageFetch.call(this, input, { ...init, body: prepared.body });
  response
    .clone()
    .text()
    .then((responseText) => publish(prepared.body, responseText, prepared.enlarged), () => {});
  return response;
};

window.addEventListener("message", (event) => {
  if (event.source !== window || !isBridgeMessage<ReplayRequest>(event.data, "replay")) return;
  for (const call of captured) window.postMessage(call, location.origin);
});
