import { createGeminiClient, GEMINI_HEADERS_ATTRIBUTE, type CapturedGeminiHeaders } from "../providers/gemini.ts";
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

runContentScript(
  createGeminiClient((url, init) => fetch(url, init), {
    ready: headersReady,
    headers: (rpcid) => captured()?.byRpc[rpcid] ?? captured()?.latest ?? {},
    scripts: () => [...document.scripts].map((script) => script.textContent ?? "").join("\n"),
    path: () => location.pathname,
    language: () => document.documentElement.lang || null,
  }),
);
