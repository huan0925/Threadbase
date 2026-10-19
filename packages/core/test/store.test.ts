import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type NormalizedConversation, type NormalizedMessage } from "../src/index.ts";

function message(sourceId: string, content: string, parentSourceId: string | null, role: NormalizedMessage["role"] = "user"): NormalizedMessage {
  return { sourceId, parentSourceId, role, content, createdAt: 1_700_000_000_000, model: null };
}

function conversation(overrides: Partial<NormalizedConversation> & Pick<NormalizedConversation, "sourceId" | "messages">): NormalizedConversation {
  return {
    source: "chatgpt",
    title: "Untitled",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    url: null,
    activeLeafSourceId: null,
    raw: {},
    ...overrides,
  };
}

const taxes = conversation({
  sourceId: "taxes",
  title: "報稅",
  activeLeafSourceId: "a2b",
  messages: [
    message("u1", "幫我整理報稅需要準備的文件", null),
    message("a1", "需要扣繳憑單和保險費收據", "u1", "assistant"),
    message("u2a", "那房貸呢", "a1"),
    message("u2b", "房貸利息可以扣除嗎？", "a1"),
    message("a2b", "可以，每年上限 30 萬元。", "u2b", "assistant"),
  ],
});
const postgres = conversation({
  source: "claude",
  sourceId: "pg",
  title: "Postgres trigram index",
  messages: [
    message("m1", "Which index helps LIKE '%term%' queries in Postgres?", null),
    message("m2", "Use a GIN index with pg_trgm. It also speeds up ILIKE.", "m1", "assistant"),
  ],
});

function seededStore(): Store {
  const store = new Store(":memory:");
  store.importAll([taxes, postgres]);
  return store;
}

test("re-importing the same export is a no-op", () => {
  const store = new Store(":memory:");
  assert.deepEqual(store.importAll([taxes, postgres]), {
    conversationsAdded: 2,
    conversationsUpdated: 0,
    conversationsUnchanged: 0,
    messagesAdded: 7,
  });
  assert.deepEqual(store.importAll([taxes, postgres]), {
    conversationsAdded: 0,
    conversationsUpdated: 0,
    conversationsUnchanged: 2,
    messagesAdded: 0,
  });
  assert.deepEqual(store.stats(), [
    { source: "chatgpt", conversations: 1, messages: 5 },
    { source: "claude", conversations: 1, messages: 2 },
  ]);
});

test("a newer export adds only the new messages", () => {
  const store = seededStore();
  const continued = { ...postgres, messages: [...postgres.messages, message("m3", "Thanks, the trigram index works!", "m2")] };
  assert.deepEqual(store.importAll([continued]), {
    conversationsAdded: 0,
    conversationsUpdated: 1,
    conversationsUnchanged: 0,
    messagesAdded: 1,
  });
  assert.equal(store.search("works!").length, 1);
});

test("edited message content is re-indexed", () => {
  const store = seededStore();
  const edited = { ...postgres, messages: [message("m1", "Which index helps fuzzy matching?", null), postgres.messages[1]!] };
  store.importAll([edited]);
  assert.equal(store.search("fuzzy matching").length, 1);
  assert.equal(store.search("'%term%'").length, 0);
});

test("finds long Chinese terms through the trigram index", () => {
  const [hit, ...rest] = seededStore().search("扣繳憑單");
  assert.equal(rest.length, 0);
  assert.equal(hit?.title, "報稅");
  assert.equal(hit?.role, "assistant");
  assert.equal(hit?.snippet, "需要扣繳憑單和保險費收據");
});

test("finds terms shorter than a trigram", () => {
  const hits = seededStore().search("房貸");
  assert.equal(hits.length, 1, "one hit per conversation even when several messages match");
  assert.equal(hits[0]?.title, "報稅");
});

test("requires every term and supports quoted phrases", () => {
  const store = seededStore();
  assert.equal(store.search("PG_TRGM ilike").length, 1, "case-insensitive");
  assert.equal(store.search("postgres 房貸").length, 0);
  assert.equal(store.search('"GIN index"').length, 1);
  assert.equal(store.search('"index GIN"').length, 0);
});

test("treats query syntax and LIKE wildcards literally", () => {
  const store = seededStore();
  assert.doesNotThrow(() => store.search('index AND ( OR "'));
  assert.equal(store.search("%").length, 1, "only the message containing a literal %");
  assert.equal(store.search("").length, 0);
});

test("filters by source and limits results", () => {
  const store = seededStore();
  assert.equal(store.search("index", { source: "chatgpt" }).length, 0);
  assert.equal(store.search("index", { source: "claude" }).length, 1);
  store.importAll([conversation({ sourceId: "more", messages: [message("x", "another index question", null)] })]);
  assert.equal(store.search("index").length, 2);
  assert.equal(store.search("index", { limit: 1 }).length, 1);
});

test("shows the active branch of a conversation", () => {
  const store = seededStore();
  const id = store.search("扣繳憑單")[0]!.conversationId;
  const shown = store.getConversation(id);
  assert.deepEqual(shown?.messages.map((m) => m.sourceId), ["u1", "a1", "u2b", "a2b"]);
  assert.equal(store.getConversation(9999), undefined);
});

test("shows linear conversations in order", () => {
  const store = seededStore();
  const id = store.search("pg_trgm")[0]!.conversationId;
  assert.deepEqual(store.getConversation(id)?.messages.map((m) => m.sourceId), ["m1", "m2"]);
});
