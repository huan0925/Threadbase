import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGeminiClient,
  normalizeGeminiConversation,
  parseBatchResponse,
  readTokens,
} from "../src/providers/gemini.ts";
import { batchexecuteBody, fakeSite, fixture } from "./helpers.ts";

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

const APP_PAGE = `<script>window.WIZ_global_data = {"cfb2h":"boq_assistant-bard-web-server_20261015.07_p0","FdrFJe":"-123456789","SNlM0e":"xsrf-token:123"};</script>`;

function geminiSite(listPages: Record<string, unknown>, chats: Record<string, unknown>) {
  const calls: { rpcid: string; args: unknown[]; at: string | null; query: URLSearchParams }[] = [];
  const site = fakeSite({
    "/app": () => new Response(APP_PAGE, { headers: { "content-type": "text/html" } }),
    "/_/BardChatUi/data/batchexecute": (_attempt: number, request: { url: URL; body: URLSearchParams }) => {
      const form = new URLSearchParams(request.body);
      const [[[rpcid, argsJson]]] = JSON.parse(form.get("f.req")!) as [[[string, string]]];
      const args = JSON.parse(argsJson) as unknown[];
      calls.push({ rpcid, args, at: form.get("at"), query: request.url.searchParams });
      // List pages are keyed "filter:token", where filter 1 is pinned chats and 0 the rest.
      const payload =
        rpcid === "MaZiqc" ? listPages[`${(args[2] as number[])[0]}:${args[1]}`] : chats[String(args[0])];
      return new Response(batchexecuteBody(rpcid, payload ?? []));
    },
  });
  return { ...site, calls };
}

const listItem = (id: string, title: string, seconds: number) =>
  [id, title, null, null, null, [seconds, 500000000], ...Array(19).fill(null)];

test("client lists pinned chats, then pages through the rest", async () => {
  const site = geminiSite(
    {
      "1:null": [null, null, [listItem("c_pin", "Pinned", 1700000000)]],
      "0:null": [null, "page-2", [listItem("c_1", "First", 1792301486), listItem("c_2", "Second", 1792300000)]],
      "0:page-2": [null, null, [listItem("c_3", "Third", 1792200000), listItem("c_2", "Second", 1792300000)]],
    },
    {},
  );
  const client = createGeminiClient(site.fetch);
  const listed = [];
  for await (const summary of client.listConversations()) listed.push(summary);

  assert.deepEqual(listed, [
    { id: "c_pin", title: "Pinned", updatedAt: 1700000000500 },
    { id: "c_1", title: "First", updatedAt: 1792301486500 },
    { id: "c_2", title: "Second", updatedAt: 1792300000500 },
    { id: "c_3", title: "Third", updatedAt: 1792200000500 },
  ]);
  assert.equal(site.requests.filter((r) => r.path === "/app").length, 1, "tokens are fetched once");
  const [first] = site.calls;
  assert.equal(first?.at, "xsrf-token:123");
  assert.equal(first?.query.get("rpcids"), "MaZiqc");
  assert.equal(first?.query.get("bl"), "boq_assistant-bard-web-server_20261015.07_p0");
  assert.equal(first?.query.get("f.sid"), "-123456789");
  assert.equal(first?.query.get("source-path"), "/app");
  assert.equal(first?.query.get("hl"), "en");
  assert.deepEqual(
    site.calls.map((c) => c.args),
    [
      [35, null, [1, null, 1]],
      [35, null, [0, null, 1]],
      [35, "page-2", [0, null, 1]],
    ],
  );
});

test("client fetches every page of a long chat and titles it from the list", async () => {
  const [newer, older] = chat[0] as [Turn, Turn];
  const site = geminiSite(
    { "0:null": [null, null, [listItem("c_aaaa1111bbbb2222", "報稅文件", 1792301486)]] },
    {},
  );
  // The second page (requested with the token) returns the older turn.
  const pages = new Map([["null", [[newer], "more-turns", null, []]], ["more-turns", [[older], null, null, []]]]);
  const originalFetch = site.fetch;
  const client = createGeminiClient(async (url, init) => {
    const form = new URLSearchParams(init?.body as URLSearchParams);
    const freq = form.get("f.req");
    if (freq?.includes("hNvQHb")) {
      const args = JSON.parse(JSON.parse(freq)[0][0][1]) as unknown[];
      assert.deepEqual(args.slice(3), [1, [1], [4], null, 1]);
      return new Response(batchexecuteBody("hNvQHb", pages.get(String(args[2]))));
    }
    return originalFetch(url, init);
  });
  for await (const _ of client.listConversations());
  const result = await client.getConversation("c_aaaa1111bbbb2222");
  assert.equal(result.title, "報稅文件");
  assert.equal(result.messages.length, 4);
  assert.equal(result.messages[1]?.sourceId, "rc_cand1b");
});

test("client sends the page's tokens, language and the extension headers Gemini requires", async () => {
  const site = geminiSite({ "0:null": [null, null, [listItem("c_1", "First", 1792301486)]] }, {});
  const client = createGeminiClient(site.fetch, {
    scripts: () => `WIZ_global_data = {"SNlM0e": "page-token","cfb2h":"page-bl","FdrFJe":"page-sid"}`,
    language: () => "zh-TW",
  });
  for await (const _ of client.listConversations());
  assert.ok(!site.requests.some((r) => r.path === "/app"), "no extra page fetch");
  const [call] = site.calls;
  assert.equal(call?.at, "page-token");
  assert.equal(call?.query.get("bl"), "page-bl");
  assert.equal(call?.query.get("f.sid"), "page-sid");
  assert.equal(call?.query.get("hl"), "zh-TW");

  const batchHeaders = site.requests.filter((r) => r.path.startsWith("/_/BardChatUi")).map((r) => r.headers);
  const ext = JSON.parse(batchHeaders[0]!["x-goog-ext-525001261-jspb"]!) as unknown[];
  assert.deepEqual(ext.slice(0, 16), [1, null, null, null, null, null, null, null, [4, 5, 6, 8], null, null, null, null, null, null, null]);
  assert.match(String(ext[16]), /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/, "uppercase session UUID");
  assert.ok(batchHeaders.every((h) => h["x-goog-ext-525001261-jspb"] === batchHeaders[0]!["x-goog-ext-525001261-jspb"]), "one session id per client");
  assert.equal(batchHeaders[0]!["x-goog-ext-73010989-jspb"], "[0]");
  assert.equal(batchHeaders[0]!["X-Same-Domain"], "1");
});

test("reads tokens only when the XSRF token is present", () => {
  assert.equal(readTokens(`{"cfb2h":"x"}`), null);
  assert.deepEqual(readTokens(`{"SNlM0e":"t"}`), { at: "t", bl: null, sid: null });
  assert.deepEqual(readTokens(`{"SNlM0e": "t", "cfb2h": "b"}`), { at: "t", bl: "b", sid: null }, "spaces after colons");
});

test("client reports a signed-out session", async () => {
  const site = fakeSite({ "/app": () => new Response("<html>Sign in to Gemini</html>") });
  const client = createGeminiClient(site.fetch);
  await assert.rejects(client.listConversations()[Symbol.asyncIterator]().next(), { name: "NotLoggedInError" });
});
