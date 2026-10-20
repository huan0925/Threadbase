/**
 * Messages between gemini-page.ts (the page's own world) and the Gemini
 * content script (isolated world), over window.postMessage.
 */

export const BRIDGE_SOURCE = "threadbase-gemini";

/** <html> attribute where gemini-page.ts publishes what it has seen, for diagnosing syncs. */
export const PAGE_STATS_ATTRIBUTE = "data-threadbase-gemini";

/** What gemini-page.ts has seen of the page's calls. */
export interface PageStats {
  /** batchexecute calls the page made. */
  batchCalls: number;
  /** Of those, calls that list or read chats. */
  chatCalls: number;
  /** Chat calls whose response was read and posted. */
  captured: number;
  /** The last problem reading a response, if any. */
  lastError: string;
}

/** The page's own batchexecute call for chats (list or read) and its response. */
export interface CapturedCall {
  source: typeof BRIDGE_SOURCE;
  type: "captured";
  /** RPC ids in the call, from the URL's `rpcids` parameter. */
  rpcids: string[];
  /** The raw batchexecute response. */
  text: string;
  /** Whether Threadbase enlarged the page's page sizes in this call. */
  enlarged: boolean;
}

/** Asks gemini-page.ts to post again the calls it captured before the content script was listening. */
export interface ReplayRequest {
  source: typeof BRIDGE_SOURCE;
  type: "replay";
}

export function isBridgeMessage<T extends CapturedCall | ReplayRequest>(data: unknown, type: T["type"]): data is T {
  return (
    typeof data === "object" && data !== null && (data as T).source === BRIDGE_SOURCE && (data as T).type === type
  );
}
