import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { claudeImporter } from "../src/index.ts";

const data: unknown = JSON.parse(readFileSync(new URL("./fixtures/claude-conversations.json", import.meta.url), "utf8"));
const [postgres, travel] = [...claudeImporter.parse(data)];

test("detects Claude exports", () => {
  assert.equal(claudeImporter.detect(data), true);
  assert.equal(claudeImporter.detect([{ mapping: {} }]), false);
});

test("maps conversation metadata", () => {
  assert.ok(postgres);
  assert.equal(postgres.source, "claude");
  assert.equal(postgres.title, "Postgres index for search");
  assert.equal(postgres.createdAt, Date.parse("2025-01-10T09:00:00Z"));
  assert.equal(postgres.url, "https://claude.ai/chat/5eed0000-0000-4000-8000-000000000001");
});

test("extracts text, artifacts and attachment names but not thinking", () => {
  assert.ok(postgres);
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
  assert.ok(postgres);
  assert.deepEqual(
    postgres.messages.map((m) => [m.sourceId, m.parentSourceId]),
    [
      ["m1", null],
      ["m2", "m1"],
      ["m4", "m2"],
      ["m5", "m4"],
    ],
  );
  assert.equal(postgres.activeLeafSourceId, "m5");
});

test("chains older exports without parent links", () => {
  assert.ok(travel);
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
