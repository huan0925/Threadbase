import assert from "node:assert/strict";
import { test } from "node:test";
import { geminiQueue, mergeGeminiConversation } from "../src/gemini-backfill.ts";
import type { NormalizedMessage, StoredConversation } from "../src/types.ts";

const message = (sourceId: string, createdAt: number, role: NormalizedMessage["role"] = "user"): NormalizedMessage => ({
  sourceId,
  parentSourceId: null,
  role,
  content: sourceId,
  createdAt,
  model: null,
});

test("queues new and changed chats, newest first", () => {
  const index = {
    c_old: { title: "Old", updatedAt: 100 },
    c_same: { title: "Same", updatedAt: 200 },
    c_changed: { title: "Changed", updatedAt: 400 },
    c_new: { title: "New", updatedAt: 300 },
  };
  const known = new Map<string, number | null>([
    ["c_same", 200],
    ["c_changed", 250],
    ["c_old", null],
  ]);
  assert.deepEqual(geminiQueue(index, known), ["c_changed", "c_new", "c_old"]);
});

test("merges a partial page load into what was stored, in time order", () => {
  const existing: StoredConversation = {
    source: "gemini",
    sourceId: "c_1",
    title: "Taxes",
    createdAt: 1000,
    updatedAt: 2000,
    url: "https://gemini.google.com/app/1",
    activeLeafSourceId: null,
    messages: [message("t1:prompt", 1000), message("rc1", 1000, "assistant"), message("t2:prompt", 2000)],
    key: "gemini:c_1",
    listedUpdatedAt: 2000,
    syncedAt: 0,
  };
  const incoming = {
    ...existing,
    title: "Untitled",
    createdAt: 2000,
    updatedAt: 3000,
    messages: [message("t2:prompt", 2000), message("rc2", 2000, "assistant"), message("t3:prompt", 3000)],
  };
  const merged = mergeGeminiConversation(existing, incoming, undefined);
  assert.deepEqual(
    merged.messages.map((m) => [m.sourceId, m.parentSourceId]),
    [
      ["t1:prompt", null],
      ["rc1", "t1:prompt"],
      ["t2:prompt", "rc1"],
      ["rc2", "t2:prompt"],
      ["t3:prompt", "rc2"],
    ],
  );
  assert.equal(merged.title, "Taxes", "keeps a known title over Untitled");
  assert.equal(merged.createdAt, 1000);
  assert.equal(merged.updatedAt, 3000);
  assert.equal(mergeGeminiConversation(existing, incoming, "Renamed").title, "Renamed", "the list's title wins");
  assert.equal(mergeGeminiConversation(undefined, incoming, undefined).messages.length, 3);
});
