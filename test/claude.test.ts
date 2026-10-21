import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeClient, normalizeClaudeConversation, type ClaudeConversation } from "../src/providers/claude.ts";
import { fakeSite, fixture } from "./helpers.ts";

const [postgresRaw, travelRaw] = fixture<ClaudeConversation[]>("claude-conversations.json");
const postgres = normalizeClaudeConversation(postgresRaw!);
const travel = normalizeClaudeConversation(travelRaw!);

test("maps conversation metadata", () => {
  assert.equal(postgres.source, "claude");
  assert.equal(postgres.title, "Postgres index for search");
  assert.equal(postgres.createdAt, Date.parse("2025-01-10T09:00:00Z"));
  assert.equal(postgres.url, "https://claude.ai/chat/5eed0000-0000-4000-8000-000000000001");
});

test("extracts text, artifacts and attachment names but not thinking", () => {
  const [question, answer] = postgres.messages;
  assert.equal(question?.role, "user");
  assert.equal(
    question?.content,
    "Which index should I use for LIKE '%term%' queries in Postgres?\n[attachment: schema.sql]",
  );
  assert.equal(answer?.role, "assistant");
  assert.match(answer?.content ?? "", /^Use a GIN index with the pg_trgm extension\.\n\[artifact: Trigram index migration\]\nCREATE EXTENSION pg_trgm;/);
  assert.doesNotMatch(answer?.content ?? "", /They need a trigram index/);
});

test("drops empty messages and relinks their children", () => {
  assert.deepEqual(
    postgres.messages.map((m) => [m.sourceId, m.parentSourceId]),
    [
      ["m1", null],
      ["m2", "m1"],
      ["m4", "m2"],
      ["m5", "m4"],
    ],
  );
  assert.equal(postgres.activeLeafSourceId, "m5", "latest message when no leaf is given");
});

test("uses the current leaf the site reports, resolving dropped messages", () => {
  assert.equal(normalizeClaudeConversation({ ...postgresRaw!, current_leaf_message_uuid: "m2" }).activeLeafSourceId, "m2");
  assert.equal(normalizeClaudeConversation({ ...postgresRaw!, current_leaf_message_uuid: "m3" }).activeLeafSourceId, "m2");
});

test("chains conversations without parent links", () => {
  assert.equal(travel.title, "Untitled");
  assert.equal(travel.activeLeafSourceId, null);
  assert.deepEqual(
    travel.messages.map((m) => [m.sourceId, m.parentSourceId, m.role]),
    [
      ["o1", null, "user"],
      ["o2", "o1", "assistant"],
    ],
  );
});

test("client lists chat organizations newest first and fetches from the right one", async () => {
  const site = fakeSite({
    "/api/organizations": [
      { uuid: "personal", capabilities: ["chat"] },
      { uuid: "api-only", capabilities: ["api"] },
      { uuid: "team", capabilities: ["chat", "claude_pro"] },
    ],
    "/api/organizations/personal/chat_conversations": [
      { uuid: "old", name: "Old", updated_at: "2025-01-01T00:00:00Z" },
    ],
    "/api/organizations/team/chat_conversations": [
      { uuid: postgresRaw!.uuid, name: "New", updated_at: "2026-01-01T00:00:00Z" },
    ],
    [`/api/organizations/team/chat_conversations/${postgresRaw!.uuid}`]: postgresRaw,
  });
  const client = createClaudeClient(site.fetch);

  const listed = [];
  for await (const summary of client.listConversations()) listed.push(summary.id);
  assert.deepEqual(listed, [postgresRaw!.uuid, "old"]);
  assert.ok(!site.requests.some((r) => r.path.includes("api-only")));

  const conversation = await client.getConversation(postgresRaw!.uuid);
  assert.equal(conversation.title, "Postgres index for search");
  assert.match(site.requests.at(-1)!.path, /\?tree=True&rendering_mode=messages&render_all_tools=true$/);
});

test("client reports a signed-out session", async () => {
  const site = fakeSite({ "/api/organizations": 403 });
  const client = createClaudeClient(site.fetch);
  await assert.rejects(client.listConversations()[Symbol.asyncIterator]().next(), { name: "NotLoggedInError" });
});
