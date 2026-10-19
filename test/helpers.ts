import { readFileSync } from "node:fs";
import type { FetchLike } from "../src/providers/http.ts";

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

export interface FakeSite {
  fetch: FetchLike;
  /** Requested paths (with query), in order. */
  requests: { path: string; headers: Record<string, string> }[];
}

/**
 * A stand-in for a site's API. Routes map "pathname?query" (or just the
 * pathname) to a JSON body, a status code, or a function of the attempt count.
 */
export function fakeSite(routes: Record<string, unknown>): FakeSite {
  const requests: FakeSite["requests"] = [];
  const attempts = new Map<string, number>();
  const fetch: FetchLike = async (url, init) => {
    const { pathname, search } = new URL(url);
    requests.push({ path: pathname + search, headers: { ...(init?.headers as Record<string, string>) } });
    const key = pathname + search in routes ? pathname + search : pathname;
    if (!(key in routes)) return new Response("not found", { status: 404 });
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    let route = routes[key];
    if (typeof route === "function") route = route(attempt);
    if (typeof route === "number") return new Response("", { status: route });
    return Response.json(route);
  };
  return { fetch, requests };
}
