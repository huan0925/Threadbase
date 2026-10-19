import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const main = new URL("../src/main.ts", import.meta.url).pathname;
const fixture = (name: string) =>
  new URL(`../../../packages/importers/test/fixtures/${name}`, import.meta.url).pathname;
const db = join(mkdtempSync(join(tmpdir(), "threadbase-cli-")), "test.db");

function run(...args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--conditions=source", "--disable-warning=ExperimentalWarning", main, "--db", db, ...args],
    { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
  );
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("imports exports from several providers and searches across them", () => {
  const imported = run("import", fixture("chatgpt-conversations.json"), fixture("claude-conversations.json"));
  assert.equal(imported.code, 0, imported.stderr);
  assert.match(imported.stdout, /ChatGPT: 2 conversations .*\(2 new, 0 updated, 0 unchanged; 8 new messages\)/);
  assert.match(imported.stdout, /Claude: 2 conversations .*\(2 new, 0 updated, 0 unchanged; 6 new messages\)/);

  const again = run("import", fixture("claude-conversations.json"));
  assert.match(again.stdout, /\(0 new, 0 updated, 2 unchanged; 0 new messages\)/);

  const stats = run("stats");
  assert.equal(
    stats.stdout,
    "ChatGPT: 2 conversations, 8 messages\nClaude: 2 conversations, 6 messages\nSearch: full-text index\n",
  );

  const search = run("search", "轉接頭");
  assert.equal(search.code, 0);
  assert.match(search.stdout, /\[Claude\] Untitled · 2024-06-01 · #\d+/);
  assert.match(search.stdout, /https:\/\/claude\.ai\/chat\/5eed0000-0000-4000-8000-000000000002/);

  const json = JSON.parse(run("search", "index", "--json").stdout);
  assert.deepEqual(json.map((hit: { source: string }) => hit.source), ["claude"]);
});

test("shows a conversation's active branch", () => {
  const [hit] = JSON.parse(run("search", "扣繳憑單", "--json").stdout);
  const shown = run("show", String(hit.conversationId));
  assert.equal(shown.code, 0);
  assert.match(shown.stdout, /^報稅文件整理\nChatGPT · 2024-03-12\n/);
  assert.match(shown.stdout, /房貸利息可以扣除嗎/);
  assert.doesNotMatch(shown.stdout, /那房貸呢/, "abandoned branch is hidden");
});

test("reports bad input with a non-zero exit code", () => {
  assert.equal(run("search").code, 1);
  assert.equal(run("show", "abc").code, 1);
  assert.equal(run("show", "9999").code, 1);
  assert.equal(run("search", "x", "--limit", "0").code, 1);
  assert.match(run("import", "/nonexistent.json").stderr, /Failed to import \/nonexistent\.json/);
  assert.equal(run("bogus").code, 1);
  assert.equal(run("--help").code, 0);
});
