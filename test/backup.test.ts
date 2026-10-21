import assert from "node:assert/strict";
import { test } from "node:test";
import { backupFileName, BackupError, conversationsToImport, createBackup, parseBackup, toMarkdown } from "../src/backup.ts";
import type { StoredConversation } from "../src/types.ts";

function stored(sourceId: string, partial: Partial<StoredConversation> = {}): StoredConversation {
  return {
    source: "claude",
    sourceId,
    key: `claude:${sourceId}`,
    title: `Chat ${sourceId}`,
    createdAt: 100,
    updatedAt: 200,
    url: `https://claude.ai/chat/${sourceId}`,
    activeLeafSourceId: null,
    messages: [
      { sourceId: "m1", parentSourceId: null, role: "user", content: "房貸利息可以扣除嗎", createdAt: 100, model: null },
      { sourceId: "m2", parentSourceId: "m1", role: "assistant", content: "可以。", createdAt: 110, model: "opus" },
    ],
    listedUpdatedAt: 200,
    syncedAt: 1000,
    ...partial,
  };
}

test("a backup round-trips through JSON", () => {
  const conversations = [stored("a"), stored("b", { source: "gemini", key: "gemini:b" })];
  const backup = createBackup(conversations, Date.UTC(2026, 9, 21));
  assert.equal(backup.exportedAt, "2026-10-21T00:00:00.000Z");
  assert.deepEqual(parseBackup(JSON.stringify(backup)), { conversations, skipped: 0 });
});

test("parseBackup rejects files that aren't backups", () => {
  assert.throws(() => parseBackup("not json"), BackupError);
  assert.throws(() => parseBackup(JSON.stringify({ conversations: [] })), BackupError);
  assert.throws(() => parseBackup(JSON.stringify([stored("a")])), BackupError);
  assert.throws(
    () => parseBackup(JSON.stringify({ ...createBackup([]), version: 99 })),
    /newer version of Threadbase/,
  );
});

test("parseBackup skips invalid entries and recomputes keys", () => {
  const text = JSON.stringify({
    ...createBackup([]),
    conversations: [
      { ...stored("a"), key: "chatgpt:wrong" },
      { ...stored("b"), source: "bard" },
      { ...stored("c"), messages: [{ sourceId: "m1", role: "robot", content: "x" }] },
      null,
    ],
  });
  const { conversations, skipped } = parseBackup(text);
  assert.deepEqual(conversations.map((c) => c.key), ["claude:a"]);
  assert.equal(skipped, 3);
});

test("importing adds new chats and keeps the newer copy of each", () => {
  const existing = new Map([
    ["claude:same", stored("same")],
    ["claude:older-here", stored("older-here", { updatedAt: 100 })],
    ["claude:newer-here", stored("newer-here", { updatedAt: 900 })],
  ]);
  const incoming = [
    stored("new"),
    stored("same"),
    stored("older-here", { updatedAt: 300 }),
    stored("newer-here", { updatedAt: 300 }),
  ];
  assert.deepEqual(conversationsToImport(existing, incoming).map((c) => c.key), ["claude:new", "claude:older-here"]);
});

test("with equal update times, the later sync wins", () => {
  const existing = new Map([["claude:a", stored("a", { syncedAt: 1000 })]]);
  assert.equal(conversationsToImport(existing, [stored("a", { syncedAt: 500 })]).length, 0);
  assert.equal(conversationsToImport(existing, [stored("a", { syncedAt: 2000 })]).length, 1);
});

test("toMarkdown lists conversations newest first with their messages", () => {
  const markdown = toMarkdown([stored("old", { title: "Old", updatedAt: 0 }), stored("new", { title: "New" })], 0);
  assert.ok(markdown.indexOf("## New") < markdown.indexOf("## Old"));
  assert.match(markdown, /Claude · 1970-01-01 · <https:\/\/claude\.ai\/chat\/new>/);
  assert.match(markdown, /### You\n\n房貸利息可以扣除嗎/);
  assert.match(markdown, /### Assistant · opus\n\n可以。/);
});

test("backup files are named by date", () => {
  assert.equal(backupFileName("json", Date.UTC(2026, 9, 21, 12)), "threadbase-2026-10-21.json");
});
