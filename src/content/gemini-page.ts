/**
 * Runs in gemini.google.com's own JavaScript world (not the isolated content
 * script world) from document start, and sends Threadbase's batchexecute
 * calls on the content script's behalf (see gemini-bridge.ts).
 *
 * Gemini rejects calls that differ from the page's own (status 13,
 * BardErrorInfo 1096). Recordings showed the page's calls carry headers its
 * scripts build, including a session block in x-goog-ext-525001261-jspb that
 * a hand-built header lacks. So this script records the headers the page
 * sets on its own batchexecute calls and sends Threadbase's calls with the
 * same headers (timestamp renewed), the page's XMLHttpRequest and the page's
 * current session tokens. Nothing leaves the page.
 */

import { BRIDGE_SOURCE, isBridgeMessage, type BridgeRequest, type BridgeResponse } from "./gemini-bridge.ts";
import { restampHeaders } from "./gemini-headers.ts";

/** How long to wait for the page's first own call before sending without its headers. */
const PAGE_HEADERS_TIMEOUT_MS = 15_000;

/** Headers (lowercased names) the page set on its latest batchexecute call, overall and per RPC. */
let latestPageHeaders: Record<string, string> | null = null;
const pageHeadersByRpc = new Map<string, Record<string, string>>();

const ours = new WeakSet<XMLHttpRequest>();
const requestUrls = new WeakMap<XMLHttpRequest, URL>();
const requestHeaders = new WeakMap<XMLHttpRequest, Record<string, string>>();
const { open, setRequestHeader, send } = XMLHttpRequest.prototype;

const isBatch = (url: URL) => url.origin === location.origin && url.pathname.endsWith("/batchexecute");

function rememberPageHeaders(url: URL, headers: Record<string, string>): void {
  latestPageHeaders = headers;
  for (const rpcid of (url.searchParams.get("rpcids") ?? "").split(",").filter(Boolean)) {
    pageHeadersByRpc.set(rpcid, headers);
  }
}

XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  requestUrls.set(this, new URL(String(url), location.href));
  requestHeaders.set(this, {});
  return (open as (...args: unknown[]) => void).call(this, method, url, ...rest);
} as typeof XMLHttpRequest.prototype.open;

XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
  const headers = requestHeaders.get(this);
  // A page wrapper may set a header we already copied from the page's calls;
  // XHR would join the two into "v, v", so skip an identical repeat on ours.
  if (ours.has(this) && headers?.[name.toLowerCase()] === value) return;
  if (headers) headers[name.toLowerCase()] = value;
  return setRequestHeader.call(this, name, value);
};

XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
  const url = requestUrls.get(this);
  if (url && isBatch(url) && !ours.has(this)) rememberPageHeaders(url, { ...requestHeaders.get(this) });
  return send.call(this, body);
};

const pageFetch = window.fetch;
window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (isBatch(url)) {
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((value, name) => {
      headers[name] = value;
    });
    rememberPageHeaders(url, headers);
  }
  return pageFetch.call(this, input, init);
};

async function pageHeaders(rpcid: string): Promise<Record<string, string> | null> {
  for (let waited = 0; !latestPageHeaders && waited < PAGE_HEADERS_TIMEOUT_MS; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return pageHeadersByRpc.get(rpcid) ?? latestPageHeaders;
}

/** Session tokens as the page's scripts hold them now; they may differ from the initial HTML. */
interface LiveTokens {
  SNlM0e?: unknown;
  cfb2h?: unknown;
  FdrFJe?: unknown;
}

function withLiveTokens(url: URL, body: string): { url: URL; body: string } {
  const tokens = (window as unknown as { WIZ_global_data?: LiveTokens }).WIZ_global_data;
  if (!tokens) return { url, body };
  const form = new URLSearchParams(body);
  if (typeof tokens.cfb2h === "string") url.searchParams.set("bl", tokens.cfb2h);
  if (typeof tokens.FdrFJe === "string") url.searchParams.set("f.sid", tokens.FdrFJe);
  if (typeof tokens.SNlM0e === "string") form.set("at", tokens.SNlM0e);
  return { url, body: form.toString() };
}

const lowercased = (headers: Record<string, string>) =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));

// Only same-origin requests from this window are accepted, and only to Gemini.
window.addEventListener("message", async (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (!isBridgeMessage<BridgeRequest>(event.data, "request")) return;
  const { id } = event.data;
  const reply = (status: number, text: string, pageHeaderCount = 0) =>
    window.postMessage(
      { source: BRIDGE_SOURCE, type: "response", id, status, text, pageHeaderCount } satisfies BridgeResponse,
      location.origin,
    );

  const requested = new URL(event.data.url, location.href);
  if (requested.origin !== location.origin) return reply(0, "cross-origin request refused");
  const { url, body } = withLiveTokens(requested, event.data.body);
  const copied = await pageHeaders(url.searchParams.get("rpcids") ?? "");
  // The page's own headers replace Threadbase's defaults (names are compared
  // lowercased, since XHR joins repeated headers), with a fresh timestamp.
  const headers = { ...lowercased(event.data.headers), ...restampHeaders(copied ?? {}, Date.now()) };

  const xhr = new XMLHttpRequest();
  ours.add(xhr);
  xhr.open("POST", url.toString());
  xhr.withCredentials = true;
  for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
  xhr.onload = () => reply(xhr.status, xhr.responseText, Object.keys(copied ?? {}).length);
  xhr.onerror = () => reply(0, "network error");
  xhr.send(body);
});
