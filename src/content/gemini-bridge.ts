/**
 * Messages between the Gemini content script (isolated world) and
 * gemini-page.ts (the page's own world). The content script asks the page
 * world to send its batchexecute calls, so they go out exactly like the
 * page's own: same XMLHttpRequest, same headers Chrome adds to Google pages.
 */

export const BRIDGE_SOURCE = "threadbase-gemini";

export interface BridgeRequest {
  source: typeof BRIDGE_SOURCE;
  type: "request";
  id: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

export interface BridgeResponse {
  source: typeof BRIDGE_SOURCE;
  type: "response";
  id: string;
  status: number;
  text: string;
}

export function isBridgeMessage<T extends BridgeRequest | BridgeResponse>(data: unknown, type: T["type"]): data is T {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as T).source === BRIDGE_SOURCE &&
    (data as T).type === type &&
    typeof (data as T).id === "string"
  );
}
