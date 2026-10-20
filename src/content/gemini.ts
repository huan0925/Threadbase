import type { FetchLike } from "../providers/http.ts";
import { createGeminiClient } from "../providers/gemini.ts";
import { BRIDGE_SOURCE, isBridgeMessage, type BridgeRequest, type BridgeResponse } from "./gemini-bridge.ts";
import { runContentScript } from "./run.ts";

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
    scripts: () => [...document.scripts].map((script) => script.textContent ?? "").join("\n"),
    language: () => document.documentElement.lang || null,
  }),
);
