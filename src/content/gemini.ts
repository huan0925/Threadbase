import type { FetchLike } from "../providers/http.ts";
import { createGeminiClient, GEMINI_HEADERS_ATTRIBUTE, type CapturedGeminiHeaders } from "../providers/gemini.ts";
import { BRIDGE_SOURCE, isBridgeMessage, type BridgeRequest, type BridgeResponse } from "./gemini-bridge.ts";
import { runContentScript } from "./run.ts";

/** How long to wait for the page's own first call before syncing without its headers. */
const HEADERS_TIMEOUT_MS = 15_000;

/** Headers published by gemini-page.ts, which watches the page's own calls. */
function captured(): CapturedGeminiHeaders | null {
  try {
    return JSON.parse(document.documentElement.getAttribute(GEMINI_HEADERS_ATTRIBUTE) ?? "null");
  } catch {
    return null;
  }
}

async function headersReady(): Promise<void> {
  for (let waited = 0; !captured() && waited < HEADERS_TIMEOUT_MS; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const BRIDGE_TIMEOUT_MS = 60_000;
const pending = new Map<string, (response: BridgeResponse) => void>();

window.addEventListener("message", (event) => {
  if (event.source !== window || !isBridgeMessage<BridgeResponse>(event.data, "response")) return;
  pending.get(event.data.id)?.(event.data);
  pending.delete(event.data.id);
});

/**
 * Sends batchexecute calls through gemini-page.ts, in the page's own world,
 * so they match the page's calls in every browser-added detail. Other
 * requests (the /app fallback) are plain content-script fetches.
 */
const fetchFromPage: FetchLike = async (url, init) => {
  if (init?.method !== "POST") return fetch(url, init);
  const id = crypto.randomUUID();
  const answer = new Promise<BridgeResponse>((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error("The Gemini page didn't answer; reload it and sync again"));
    }, BRIDGE_TIMEOUT_MS);
  });
  const request: BridgeRequest = {
    source: BRIDGE_SOURCE,
    type: "request",
    id,
    url,
    body: String(init.body ?? ""),
    headers: { ...(init.headers as Record<string, string>) },
  };
  window.postMessage(request, location.origin);
  const { status, text } = await answer;
  if (status === 0) throw new Error(`Gemini request failed in the page: ${text}`);
  return new Response(text, { status });
};

runContentScript(
  createGeminiClient(fetchFromPage, {
    ready: headersReady,
    headers: (rpcid) => captured()?.byRpc[rpcid] ?? captured()?.latest ?? {},
    scripts: () => [...document.scripts].map((script) => script.textContent ?? "").join("\n"),
    path: () => location.pathname,
    language: () => document.documentElement.lang || null,
  }),
);
