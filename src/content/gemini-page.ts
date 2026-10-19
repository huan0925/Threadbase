/**
 * Runs in gemini.google.com's own JavaScript world (not the isolated content
 * script world) from document start. Gemini's batchexecute calls carry
 * x-goog-ext-*-jspb headers its scripts build (session ids, a timestamp)
 * that Threadbase can't reproduce, and calls without them are rejected. This
 * watches the page's own calls and publishes their latest headers on the
 * <html> element, where the Threadbase content script reads them. Only these
 * header values are recorded; nothing leaves the page.
 */

import { GEMINI_HEADERS_ATTRIBUTE, type CapturedGeminiHeaders } from "../providers/gemini.ts";

const EXT_HEADER = /^x-goog-ext-\d+-jspb$/i;
const captured: CapturedGeminiHeaders = { latest: {}, byRpc: {} };

function record(url: string | URL, name: string, value: string): void {
  if (!EXT_HEADER.test(name)) return;
  const parsed = new URL(String(url), location.href);
  if (!parsed.pathname.endsWith("/batchexecute")) return;
  const key = name.toLowerCase();
  captured.latest[key] = value;
  for (const rpcid of (parsed.searchParams.get("rpcids") ?? "").split(",").filter(Boolean)) {
    (captured.byRpc[rpcid] ??= {})[key] = value;
  }
  document.documentElement.setAttribute(GEMINI_HEADERS_ATTRIBUTE, JSON.stringify(captured));
}

const requestUrls = new WeakMap<XMLHttpRequest, string | URL>();
const { open, setRequestHeader } = XMLHttpRequest.prototype;

XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  requestUrls.set(this, url);
  return (open as (...args: unknown[]) => void).call(this, method, url, ...rest);
} as typeof XMLHttpRequest.prototype.open;

XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
  const url = requestUrls.get(this);
  if (url !== undefined) record(url, name, value);
  return setRequestHeader.call(this, name, value);
};

const pageFetch = window.fetch;
window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
  const url = input instanceof Request ? input.url : input;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.forEach((value, name) => record(url, name, value));
  return pageFetch.call(this, input, init);
};
