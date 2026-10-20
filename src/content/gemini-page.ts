/**
 * Runs in gemini.google.com's own JavaScript world (not the isolated content
 * script world). It sends Threadbase's batchexecute calls on the content
 * script's behalf (see gemini-bridge.ts) with the page's own XMLHttpRequest,
 * so they go out exactly like the page's calls, including the headers Chrome
 * adds to Google pages' own requests, and with the session tokens the page
 * is using right now. Nothing leaves the page.
 */

import { BRIDGE_SOURCE, isBridgeMessage, type BridgeRequest, type BridgeResponse } from "./gemini-bridge.ts";

/** Session tokens as the page's scripts hold them now; they may differ from the initial HTML. */
interface LiveTokens {
  SNlM0e?: unknown;
  cfb2h?: unknown;
  FdrFJe?: unknown;
}

function withLiveTokens(url: string, body: string): { url: string; body: string } {
  const tokens = (window as unknown as { WIZ_global_data?: LiveTokens }).WIZ_global_data;
  if (!tokens) return { url, body };
  const target = new URL(url, location.href);
  const form = new URLSearchParams(body);
  if (typeof tokens.cfb2h === "string") target.searchParams.set("bl", tokens.cfb2h);
  if (typeof tokens.FdrFJe === "string") target.searchParams.set("f.sid", tokens.FdrFJe);
  if (typeof tokens.SNlM0e === "string") form.set("at", tokens.SNlM0e);
  return { url: target.toString(), body: form.toString() };
}

// Only same-origin requests from this window are accepted, and only to Gemini.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (!isBridgeMessage<BridgeRequest>(event.data, "request")) return;
  const { id, headers } = event.data;
  const { url, body } = withLiveTokens(event.data.url, event.data.body);
  const reply = (status: number, text: string) =>
    window.postMessage({ source: BRIDGE_SOURCE, type: "response", id, status, text } satisfies BridgeResponse, location.origin);

  if (new URL(url, location.href).origin !== location.origin) return reply(0, "cross-origin request refused");
  const xhr = new XMLHttpRequest();
  xhr.open("POST", url);
  xhr.withCredentials = true;
  for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
  xhr.onload = () => reply(xhr.status, xhr.responseText);
  xhr.onerror = () => reply(0, "network error");
  xhr.send(body);
});
