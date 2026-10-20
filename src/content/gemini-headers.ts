/**
 * Gemini only accepts batchexecute calls whose headers match the page's own,
 * and the page stamps the current time into x-goog-ext-525001261-jspb on
 * every call (recordings showed that [seconds, nanos] pair is the only part
 * that changes between calls). Reused headers get the time of sending.
 */
export function restampHeaders(headers: Record<string, string>, now: number): Record<string, string> {
  const stamp = [Math.floor(now / 1000), (now % 1000) * 1_000_000];
  const restamp = (value: unknown): unknown => {
    if (isTimestamp(value)) return stamp;
    return Array.isArray(value) ? value.map(restamp) : value;
  };
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      if (!/^x-goog-ext-\d+-jspb$/i.test(name)) return [name, value];
      try {
        return [name, JSON.stringify(restamp(JSON.parse(value)))];
      } catch {
        return [name, value];
      }
    }),
  );
}

/** Google's [seconds, nanoseconds] pair, for seconds in a plausible epoch range. */
function isTimestamp(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [seconds, nanos] = value;
  return typeof seconds === "number" && seconds > 1e9 && seconds < 1e10 && typeof nanos === "number" && nanos >= 0 && nanos < 1e9;
}
