import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("reads conversations.json out of an extracted export folder", async () => {
  const folder = join(dir, "claude-export");
  mkdirSync(join(folder, "nested"), { recursive: true });
  copyFileSync(fixture("claude-conversations.json"), join(folder, "nested", "conversations.json"));
  writeFileSync(join(folder, "users.json"), "[]");
  const { importer, conversations } = await loadExport(folder);
  assert.equal(importer.source, "claude");
  assert.equal(conversations.length, 2);

  const emptyFolder = join(dir, "empty-folder");
  mkdirSync(emptyFolder);
  await assert.rejects(loadExport(emptyFolder), /No conversations\.json found in folder/);
});

test("rejects a forced source that doesn't match", async () => {
  await assert.rejects(loadExport(fixture("claude-conversations.json"), "chatgpt"), /doesn't look like a chatgpt/);
  await assert.rejects(loadExport(fixture("claude-conversations.json"), "bard"), /Unknown source "bard"/);
});

test("explains that Claude's export manifest isn't the data", async () => {
  const manifest = join(dir, "claude-export.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      instructions: "Download each file using the export_url.",
      version: "1.0",
      data_files: [
        { batch_index: 0, part: 0, category: "projects", filename: "projects-000.zip", export_url: "https://example.com/p" },
        { batch_index: 1, part: 0, category: "conversations", filename: "conversations-000.zip", export_url: "https://example.com/c" },
      ],
    }),
  );
  await assert.rejects(loadExport(manifest), /list of download links.*export_url for conversations-000\.zip/);
});

test("reports unrecognized and empty files", async () => {
  const users = join(dir, "users.json");
  writeFileSync(users, JSON.stringify([{ uuid: "u", full_name: "Someone" }]));
  await assert.rejects(loadExport(users), /doesn't look like a supported chat export\. Import the export's \.zip/);

  const empty = join(dir, "empty.json");
  writeFileSync(empty, "[]");
  await assert.rejects(loadExport(empty), /contains no conversations/);
});
