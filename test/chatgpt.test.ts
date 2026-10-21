import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatGPTClient, normalizeChatGPTConversation, type ChatGPTConversation } from "../src/providers/chatgpt.ts";
import { fakeSite, fixture } from "./helpers.ts";

const [taxesRaw, sourdoughRaw] = fixture<ChatGPTConversation[]>("chatgpt-conversations.json");
const taxes = normalizeChatGPTConversation(taxesRaw!);
const sourdough = normalizeChatGPTConversation(sourdoughRaw!);

test("maps conversation metadata", () => {
  assert.equal(taxes.source, "chatgpt");
  assert.equal(taxes.sourceId, "c0ffee00-0000-4000-8000-000000000001");
  assert.equal(taxes.title, "報稅文件整理");
  assert.equal(taxes.createdAt, 1710201600123);
  assert.equal(taxes.url, "https://chatgpt.com/c/c0ffee00-0000-4000-8000-000000000001");
});

test("skips hidden system prompts and custom instructions", () => {
  const ids = taxes.messages.map((m) => m.sourceId);
  assert.ok(!ids.includes("sys"));
  assert.ok(!ids.includes("ctx"));
  assert.equal(taxes.messages[0]?.parentSourceId, null, "first kept message reattaches to the root");
});

test("keeps every branch and records the active leaf", () => {
  assert.deepEqual(
    taxes.messages.map((m) => m.sourceId),
    ["u1", "a1", "u2a", "a2a", "u2b", "a2b"],
  );
  assert.equal(taxes.messages.find((m) => m.sourceId === "u2b")?.parentSourceId, "a1");
  assert.equal(taxes.activeLeafSourceId, "a2b");
  assert.equal(taxes.messages.find((m) => m.sourceId === "a1")?.model, "gpt-4o");
});

test("flattens multimodal parts and drops reasoning", () => {
  assert.deepEqual(
    sourdough.messages.map((m) => [m.role, m.content]),
    [
      ["user", "[image]\nIs my sourdough starter ready to bake with?"],
      ["assistant", "It has doubled and is bubbly, so it is ready. Try the float test to be sure."],
    ],
  );
  assert.equal(sourdough.messages[1]?.parentSourceId, "b1", "skipped thoughts node is bypassed");
});

test("client pages through the list with the session's bearer token", async () => {
  const site = fakeSite({
    "/api/auth/session": { accessToken: "tok" },
    "/backend-api/conversations?offset=0&limit=100&order=updated": {
      items: [{ id: "a", title: "A", update_time: "2026-10-01T00:00:00.500000+00:00" }],
      total: 2,
    },
    "/backend-api/conversations?offset=1&limit=100&order=updated": {
      items: [{ id: "b", title: "B", update_time: 1700000000.25 }],
      total: 2,
    },
    "/backend-api/conversation/a": { ...taxesRaw, conversation_id: undefined, id: undefined },
  });
  const client = createChatGPTClient(site.fetch);

  const listed = [];
  for await (const summary of client.listConversations()) listed.push(summary);
  assert.deepEqual(listed, [
    { id: "a", title: "A", updatedAt: Date.parse("2026-10-01T00:00:00.500Z") },
    { id: "b", title: "B", updatedAt: 1700000000250 },
  ]);

  const conversation = await client.getConversation("a");
  assert.equal(conversation.sourceId, "a", "falls back to the requested id");
  assert.equal(conversation.messages.length, 6);
  assert.equal(site.requests.filter((r) => r.path === "/api/auth/session").length, 1, "token is reused");
  assert.ok(site.requests.slice(1).every((r) => r.headers.Authorization === "Bearer tok"));
});

test("client reports a signed-out session", async () => {
  const site = fakeSite({ "/api/auth/session": {} });
  const client = createChatGPTClient(site.fetch);
  await assert.rejects(client.listConversations()[Symbol.asyncIterator]().next(), { name: "NotLoggedInError" });
});
