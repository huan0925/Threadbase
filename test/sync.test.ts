import assert from "node:assert/strict";
import { test } from "node:test";
import { getJson, NotLoggedInError } from "../src/providers/http.ts";
import { syncProvider, type ConversationSummary, type ProviderClient, type SyncTarget } from "../src/sync.ts";
import type { NormalizedConversation } from "../src/types.ts";
import { fakeSite } from "./helpers.ts";

function conversation(id: string): NormalizedConversation {
  return {
    source: "chatgpt",
    sourceId: id,
    title: id,
    createdAt: null,
    updatedAt: null,
    url: `https://chatgpt.com/c/${id}`,
    activeLeafSourceId: null,
    messages: [],
  };
}

function fakeClient(summaries: ConversationSummary[], failing: string[] = []) {
  const fetched: string[] = [];
  let listedCount = 0;
  const client: ProviderClient = {
    source: "chatgpt",
    async *listConversations() {
      for (const summary of summaries) {
        listedCount++;
        yield summary;
      }
    },
    async getConversation(id) {
      fetched.push(id);
      if (failing.includes(id)) throw new Error("boom");
      return conversation(id);
    },
  };
  return { client, fetched, listedCount: () => listedCount };
}

function memoryTarget(initial: [string, number | null][] = []) {
  const stored = new Map(initial);
  const progress: { done: number; total: number }[] = [];
  const target: SyncTarget = {
    known: async () => new Map(stored),
    save: async (c, listedUpdatedAt) => void stored.set(c.sourceId, listedUpdatedAt),
    progress: (p) => void progress.push(p),
  };
  return { target, stored, progress };
}

const summaries = (n: number, updatedAt = (i: number) => i): ConversationSummary[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, title: `c${i}`, updatedAt: updatedAt(i) }));

test("first sync downloads everything", async () => {
  const { client, fetched } = fakeClient(summaries(3));
  const { target, stored, progress } = memoryTarget();
  assert.deepEqual(await syncProvider(client, target, { mode: "full" }), { listed: 3, fetched: 3, failed: 0 });
  assert.deepEqual(fetched, ["c0", "c1", "c2"]);
  assert.deepEqual([...stored], [["c0", 0], ["c1", 1], ["c2", 2]]);
  assert.deepEqual(progress.at(-1), { done: 3, total: 3 });
});

test("later syncs only download new and changed conversations", async () => {
  const { client, fetched } = fakeClient(summaries(4, (i) => (i === 1 ? 100 : i)));
  const { target } = memoryTarget([["c0", 0], ["c1", 1], ["c2", 2]]);
  const result = await syncProvider(client, target, { mode: "full" });
  assert.deepEqual(result, { listed: 4, fetched: 2, failed: 0 });
  assert.deepEqual(fetched, ["c1", "c3"]);
});

test("quick sync stops listing after a run of unchanged conversations", async () => {
  const all = summaries(100);
  const known = all.slice(2).map((s): [string, number | null] => [s.id, s.updatedAt]);
  const { client, fetched, listedCount } = fakeClient(all);
  const { target } = memoryTarget(known);
  const result = await syncProvider(client, target, { mode: "quick" });
  assert.deepEqual(fetched, ["c0", "c1"]);
  assert.equal(result.listed, 22);
  assert.equal(listedCount(), 22);
});

test("a failed conversation is skipped and retried next time", async () => {
  const { client } = fakeClient(summaries(3), ["c1"]);
  const { target, stored } = memoryTarget();
  assert.deepEqual(await syncProvider(client, target, { mode: "full" }), { listed: 3, fetched: 2, failed: 1 });
  assert.ok(!stored.has("c1"));
});

test("a signed-out session stops the sync", async () => {
  const { client } = fakeClient(summaries(3));
  client.getConversation = async () => {
    throw new NotLoggedInError("ChatGPT");
  };
  const { target } = memoryTarget();
  await assert.rejects(syncProvider(client, target, { mode: "full" }), { name: "NotLoggedInError" });
});

test("getJson retries rate limits and server errors, then gives up", async () => {
  const site = fakeSite({ "/flaky": (attempt: number) => (attempt < 3 ? 429 : { ok: 1 }), "/down": 503, "/gone": 404 });
  const options = { fetch: site.fetch, site: "Test", retryDelayMs: 1 };
  assert.deepEqual(await getJson("https://x.test/flaky", options), { ok: 1 });
  await assert.rejects(getJson("https://x.test/down", options), /Test returned HTTP 503 for \/down/);
  assert.equal(site.requests.filter((r) => r.path === "/down").length, 4);
  await assert.rejects(getJson("https://x.test/gone", options), /HTTP 404/);
  assert.equal(site.requests.filter((r) => r.path === "/gone").length, 1, "client errors aren't retried");
});
