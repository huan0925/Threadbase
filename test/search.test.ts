import assert from "node:assert/strict";
import { test } from "node:test";
import { activeBranch, buildSnippet, highlightSegments, parseQuery, search, toSearchable } from "../src/search.ts";
import type { NormalizedMessage, StoredConversation } from "../src/types.ts";

function message(sourceId: string, content: string, parentSourceId: string | null, role: NormalizedMessage["role"] = "user"): NormalizedMessage {
  return { sourceId, parentSourceId, role, content, createdAt: null, model: null };
}

function stored(partial: Partial<StoredConversation> & Pick<StoredConversation, "sourceId" | "messages">): StoredConversation {
  const source = partial.source ?? "chatgpt";
  return {
    source,
    title: "Untitled",
    createdAt: 1,
    updatedAt: 1,
    url: "https://example.test",
    activeLeafSourceId: null,
    key: `${source}:${partial.sourceId}`,
    listedUpdatedAt: null,
    syncedAt: 0,
    ...partial,
  };
}

const taxes = stored({
  sourceId: "taxes",
  title: "報稅",
  updatedAt: 200,
  activeLeafSourceId: "a2b",
  messages: [
    message("u1", "幫我整理報稅需要準備的文件", null),
    message("a1", "需要扣繳憑單和保險費收據", "u1", "assistant"),
    message("u2a", "那房貸呢", "a1"),
    message("u2b", "房貸利息可以扣除嗎？", "a1"),
    message("a2b", "可以，每年上限 30 萬元。", "u2b", "assistant"),
  ],
});
const postgres = stored({
  source: "claude",
  sourceId: "pg",
  title: "Postgres trigram index",
  updatedAt: 100,
  messages: [
    message("m1", "Which index helps LIKE '%term%' queries in Postgres?", null),
    message("m2", "Use a GIN index with pg_trgm. It also speeds up ILIKE.", "m1", "assistant"),
  ],
});
const index = [postgres, taxes].map(toSearchable);

test("finds Chinese terms of any length", () => {
  assert.deepEqual(search(index, "扣繳憑單").map((h) => h.conversation.sourceId), ["taxes"]);
  assert.deepEqual(search(index, "房貸").map((h) => h.conversation.sourceId), ["taxes"]);
});

test("matches terms anywhere in the conversation, case-insensitively", () => {
  assert.equal(search(index, "postgres ilike").length, 1, "terms in different messages");
  assert.equal(search(index, "TRIGRAM").length, 1, "title match");
  assert.equal(search(index, "postgres 房貸").length, 0);
});

test("keeps quoted phrases together", () => {
  assert.equal(search(index, '"GIN index"').length, 1);
  assert.equal(search(index, '"index GIN"').length, 0);
  assert.deepEqual(parseQuery('房貸 "GIN index"  OK'), ["房貸", "gin index", "ok"]);
});

test("orders by recency, filters by source and limits", () => {
  assert.deepEqual(search(index, "index", { source: "chatgpt" }), []);
  const many = [taxes, { ...taxes, sourceId: "t2", key: "chatgpt:t2", updatedAt: 300 }].map(toSearchable);
  assert.deepEqual(search(many, "房貸").map((h) => h.conversation.sourceId), ["t2", "taxes"]);
  assert.equal(search(many, "房貸", { limit: 1 }).length, 1);
});

test("shows the message containing the most terms", () => {
  const [hit] = search(index, "房貸 利息");
  assert.equal(hit?.messageIndex, 3);
  assert.equal(hit?.snippet, "房貸利息可以扣除嗎？");
  const [titleOnly] = search(index, "trigram");
  assert.equal(titleOnly?.messageIndex, null);
  assert.equal(titleOnly?.snippet, "");
});

test("builds single-line snippets", () => {
  const content = `${"a".repeat(100)}\n\nthe NEEDLE is here\n${"b".repeat(200)}`;
  assert.equal(buildSnippet(content, ["needle"], 10, 20), "…aaaa the NEEDLE is here bbbbb…");
  assert.equal(buildSnippet("short text", ["missing"]), "short text");
});

test("splits text into highlighted segments", () => {
  assert.deepEqual(highlightSegments("Use GIN, gin!", ["gin"]), [
    { text: "Use ", match: false },
    { text: "GIN", match: true },
    { text: ", ", match: false },
    { text: "gin", match: true },
    { text: "!", match: false },
  ]);
  assert.deepEqual(highlightSegments("abc", []), [{ text: "abc", match: false }]);
});

test("follows the active branch", () => {
  assert.deepEqual(activeBranch(taxes).map((m) => m.sourceId), ["u1", "a1", "u2b", "a2b"]);
  assert.deepEqual(activeBranch(postgres).map((m) => m.sourceId), ["m1", "m2"]);
});
