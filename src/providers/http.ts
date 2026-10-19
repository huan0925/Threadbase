/** Thrown when the site says the user isn't signed in. */
export class NotLoggedInError extends Error {
  constructor(site: string) {
    super(`Not signed in to ${site}`);
    this.name = "NotLoggedInError";
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GetJsonOptions {
  fetch: FetchLike;
  site: string;
  headers?: Record<string, string>;
  /** Base delay before retrying a rate-limited or failed request. */
  retryDelayMs?: number;
}

const MAX_ATTEMPTS = 4;

/**
 * GETs JSON from the site the content script runs on, so the request carries
 * the user's session cookies like the site's own requests do. Retries rate
 * limiting (429) and server errors with exponential backoff.
 */
export async function getJson<T>(url: string, options: GetJsonOptions): Promise<T> {
  const retryDelayMs = options.retryDelayMs ?? 2000;
  for (let attempt = 1; ; attempt++) {
    const response = await options.fetch(url, { credentials: "include", headers: options.headers });
    if (response.ok) return (await response.json()) as T;
    if (response.status === 401 || response.status === 403) throw new NotLoggedInError(options.site);

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new Error(`${options.site} returned HTTP ${response.status} for ${new URL(url).pathname}`);
    }
    await sleep(retryDelayMs * 2 ** (attempt - 1));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Converts epoch seconds (ChatGPT) or an ISO-8601 string to epoch milliseconds. */
export function toEpochMs(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 1000) : null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
