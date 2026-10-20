/**
 * Runs in gemini.google.com's own JavaScript world (not the isolated content
 * script world). It sends Threadbase's batchexecute calls on the content
 * script's behalf (see gemini-bridge.ts) with the page's own XMLHttpRequest,
 * so they go out exactly like the page's calls, including the headers Chrome
 * adds to Google pages' own requests. Nothing leaves the page.
 */

import { BRIDGE_SOURCE, isBridgeMessage, type BridgeRequest, type BridgeResponse } from "./gemini-bridge.ts";

// Only same-origin requests from this window are accepted, and only to Gemini.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (!isBridgeMessage<BridgeRequest>(event.data, "request")) return;
  const { id, url, body, headers } = event.data;
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
