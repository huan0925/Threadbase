import assert from "node:assert/strict";
import { test } from "node:test";
import {
  argsByRpc,
  chatTurns,
  geminiSyncUrl,
  isSignedIn,
  listChats,
  nextListToken,
  normalizeGeminiConversation,
  parseBatchResponse,
  rewriteSyncCall,
} from "../src/providers/gemini.ts";
import { batchexecuteBody, fixture } from "./helpers.ts";

type Turn = unknown[];
const chat = fixture<[Turn[], ...unknown[]]>("gemini-chat.json");
const conversation = normalizeGeminiConversation("c_aaaa1111bbbb2222", "報稅文件", chat[0]);

test("parses batchexecute responses", () => {
  assert.deepEqual(parseBatchResponse(batchexecuteBody("abc", [1, ["x"]]), "abc"), [1, ["x"]]);
  assert.throws(() => parseBatchResponse(batchexecuteBody("abc", [1]), "other"), /no result for other/);
  const failed = `)]}'\n\n50\n${JSON.stringify([["wrb.fr", "abc", null, null, null, [3], "generic"]])}\n`;
  assert.throws(() => parseBatchResponse(failed, "abc"), /^Error: Gemini rejected abc \(status \[3\]\)$/);
});

test("maps conversation metadata", () => {
  assert.equal(conversation.source, "gemini");
  assert.equal(conversation.title, "報稅文件");
  assert.equal(conversation.url, "https://gemini.google.com/app/aaaa1111bbbb2222");
  assert.equal(conversation.createdAt, 1792301371362);
  assert.equal(conversation.updatedAt, 1792301486535);
});

test("orders turns oldest first and keeps the reply the user chose", () => {
  assert.deepEqual(
    conversation.messages.map((m) => [m.sourceId, m.parentSourceId, m.role, m.content]),
    [
      ["r_turn1:prompt", null, "user", "報稅要準備什麼文件？"],
      ["rc_cand1b", "r_turn1:prompt", "assistant", "需要身分證、扣繳憑單和保險費收據。"],
      ["r_turn2:prompt", "rc_cand1b", "user", "那房貸利息可以扣多少？"],
      ["rc_turn2a", "r_turn2:prompt", "assistant", "自用住宅購屋借款利息，每戶每年上限 30 萬元。"],
    ],
  );
});

test("falls back to the first candidate and tolerates missing fields", () => {
  const [, older] = chat[0] as [Turn, Turn];
  const alone = normalizeGeminiConversation("c_x", "", [older]);
  assert.equal(alone.title, "Untitled");
  assert.deepEqual(alone.messages.map((m) => m.sourceId), ["r_turn1:prompt", "rc_cand1a"]);
  assert.deepEqual(normalizeGeminiConversation("c_y", "t", [[null, null, null, null, null]]).messages, []);
});

const listItem = (id: string, title: string, seconds: number) =>
  [id, title, null, null, null, [seconds, 500000000], ...Array(19).fill(null)];

/** A request body as the page builds it. */
const body = (...calls: [string, unknown[]][]) =>
  new URLSearchParams({
    "f.req": JSON.stringify([calls.map(([rpcid, args]) => [rpcid, JSON.stringify(args), null, "generic"])]),
    at: "token",
  }).toString();

test("lists chats with their update times", () => {
  const payload = [null, "next-page", [listItem("c_1", "First", 1792301486), ["not-a-chat"], listItem("c_2", "", 1)]];
  assert.deepEqual(listChats(payload), [
    { id: "c_1", title: "First", updatedAt: 1792301486500 },
    { id: "c_2", title: "", updatedAt: null },
  ]);
  assert.deepEqual(listChats(null), []);
});

test("reads turns from a chat payload", () => {
  assert.equal(chatTurns(chat).length, 2);
  assert.deepEqual(chatTurns([]), []);
});

test("reads each RPC's arguments from a request body", () => {
  const calls = argsByRpc(body(["MaZiqc", [35, null, [1]]], ["hNvQHb", ["c_1", 10]]));
  assert.deepEqual([...calls], [
    ["MaZiqc", [35, null, [1]]],
    ["hNvQHb", ["c_1", 10]],
  ]);
  assert.equal(argsByRpc("not a body").size, 0);
});

test("enlarges only the page sizes of list and read calls", () => {
  const rewritten = rewriteSyncCall(
    body(["MaZiqc", [35, null, [1]]], ["hNvQHb", ["c_1", 10, null, 1]], ["otAQ7b", [1]]),
    { enlarge: true, listToken: null },
  );
  assert.ok(rewritten);
  assert.equal(rewritten.usedListToken, false);
  const calls = argsByRpc(rewritten.body);
  assert.deepEqual(calls.get("MaZiqc"), [100, null, [1]]);
  assert.deepEqual(calls.get("hNvQHb"), ["c_1", 100, null, 1]);
  assert.deepEqual(calls.get("otAQ7b"), [1]);
  assert.equal(new URLSearchParams(rewritten.body).get("at"), "token", "other fields are kept");
  assert.equal(rewriteSyncCall(body(["otAQ7b", [1]]), { enlarge: true, listToken: null }), null);
  assert.equal(rewriteSyncCall(body(["MaZiqc", [200, null]]), { enlarge: true, listToken: null }), null, "never shrinks");
  assert.equal(rewriteSyncCall(body(["MaZiqc", [35, null]]), { enlarge: false, listToken: null }), null);
});

test("points a first-page list call at the next page", () => {
  const rewritten = rewriteSyncCall(body(["MaZiqc", [35, null, [1]]]), { enlarge: false, listToken: "page-2" });
  assert.equal(rewritten?.usedListToken, true);
  assert.deepEqual(argsByRpc(rewritten!.body).get("MaZiqc"), [35, "page-2", [1]]);
  const both = rewriteSyncCall(body(["MaZiqc", [35, null, [1]]]), { enlarge: true, listToken: "page-2" });
  assert.deepEqual(argsByRpc(both!.body).get("MaZiqc"), [100, "page-2", [1]]);
  const alreadyPaged = rewriteSyncCall(body(["MaZiqc", [35, "page-9", [1]]]), { enlarge: false, listToken: "page-2" });
  assert.equal(alreadyPaged, null, "the page's own later pages are left alone");
});

test("reads the list's next-page token", () => {
  assert.equal(nextListToken([null, "page-2", []]), "page-2");
  assert.equal(nextListToken([null, null, []]), null);
  assert.equal(nextListToken([null, "", []]), null);
});

test("builds sync tab URLs", () => {
  assert.equal(geminiSyncUrl(null, true), "https://gemini.google.com/app?threadbase=enlarge");
  assert.equal(geminiSyncUrl("c_abcd1234", false), "https://gemini.google.com/app/abcd1234?threadbase=plain");
});

test("detects a signed-in page by its XSRF token", () => {
  assert.equal(isSignedIn(`WIZ_global_data = {"SNlM0e": "token"}`), true);
  assert.equal(isSignedIn(`WIZ_global_data = {"cfb2h": "x"}`), false);
});
