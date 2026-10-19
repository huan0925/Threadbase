import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chatgptImporter } from "../src/index.ts";

const data: unknown = JSON.parse(readFileSync(new URL("./fixtures/chatgpt-conversations.json", import.meta.url), "utf8"));
const [taxes, sourdough] = [...chatgptImporter.parse(data)];

test("detects ChatGPT exports", () => {
  assert.equal(chatgptImporter.detect(data), true);
  assert.equal(chatgptImporter.detect([{ uuid: "x", chat_messages: [] }]), false);
  assert.equal(chatgptImporter.detect({}), false);
});

test("maps conversation metadata", () => {
  assert.ok(taxes);
  assert.equal(taxes.source, "chatgpt");
  assert.equal(taxes.sourceId, "c0ffee00-0000-4000-8000-000000000001");
  assert.equal(taxes.title, "報稅文件整理");
  assert.equal(taxes.createdAt, 1710201600123);
  assert.equal(taxes.url, "https://chatgpt.com/c/c0ffee00-0000-4000-8000-000000000001");
});

test("skips hidden system prompts and custom instructions", () => {
  assert.ok(taxes);
  const ids = taxes.messages.map((m) => m.sourceId);
  assert.ok(!ids.includes("sys"));
  assert.ok(!ids.includes("ctx"));
  assert.equal(taxes.messages[0]?.sourceId, "u1");
  assert.equal(taxes.messages[0]?.parentSourceId, null, "first kept message reattaches to the root");
});

test("keeps every branch and records the active leaf", () => {
  assert.ok(taxes);
  assert.deepEqual(
    taxes.messages.map((m) => m.sourceId),
    ["u1", "a1", "u2a", "a2a", "u2b", "a2b"],
  );
  assert.equal(taxes.messages.find((m) => m.sourceId === "u2b")?.parentSourceId, "a1");
  assert.equal(taxes.activeLeafSourceId, "a2b");
  assert.equal(taxes.messages.find((m) => m.sourceId === "a1")?.model, "gpt-4o");
});

test("flattens multimodal parts and drops reasoning", () => {
  assert.ok(sourdough);
  assert.deepEqual(
    sourdough.messages.map((m) => [m.role, m.content]),
    [
      ["user", "[image]\nIs my sourdough starter ready to bake with?"],
      ["assistant", "It has doubled and is bubbly, so it is ready. Try the float test to be sure."],
    ],
  );
  assert.equal(sourdough.messages[1]?.parentSourceId, "b1", "skipped thoughts node is bypassed");
});
