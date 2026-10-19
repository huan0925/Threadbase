import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { loadExport } from "../src/index.ts";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "threadbase-load-"));

test("auto-detects the source of a conversations.json", async () => {
  assert.equal((await loadExport(fixture("chatgpt-conversations.json"))).importer.source, "chatgpt");
  assert.equal((await loadExport(fixture("claude-conversations.json"))).importer.source, "claude");
});

test("reads conversations.json out of the export zip", async () => {
  const zipPath = join(dir, "export.zip");
  writeFileSync(
    zipPath,
    zipSync({
      "conversations.json": readFileSync(fixture("claude-conversations.json")),
      "users.json": strToU8("[]"),
    }),
  );
  const { importer, conversations } = await loadExport(zipPath);
  assert.equal(importer.source, "claude");
  assert.equal(conversations.length, 2);
});

test("rejects a forced source that doesn't match", async () => {
  await assert.rejects(loadExport(fixture("claude-conversations.json"), "chatgpt"), /doesn't look like a chatgpt/);
  await assert.rejects(loadExport(fixture("claude-conversations.json"), "bard"), /Unknown source "bard"/);
});

test("reports unrecognized and empty files", async () => {
  const other = join(dir, "other.json");
  writeFileSync(other, JSON.stringify([{ hello: "world" }]));
  await assert.rejects(loadExport(other), /doesn't look like a supported chat export/);

  const empty = join(dir, "empty.json");
  writeFileSync(empty, "[]");
  await assert.rejects(loadExport(empty), /contains no conversations/);
});
