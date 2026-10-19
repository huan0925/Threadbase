/** Converts epoch seconds (ChatGPT) or an ISO-8601 string (Claude) to epoch milliseconds. */
export function toEpochMs(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 1000) : null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
