import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright";
import type { SyncStatus } from "../../src/messages.ts";
import type { ChatGPTConversation } from "../../src/providers/chatgpt.ts";
import type { ClaudeConversation } from "../../src/providers/claude.ts";
import { batchexecuteBody, fixture } from "../helpers.ts";

/**
 * Loads the built extension (dist/) into Chromium and points chatgpt.com,
 * claude.ai and gemini.google.com at a local HTTPS server playing all three. Host-level redirection
 * (rather than Playwright request routing) also covers tabs the extension
 * opens itself.
 */

const dist = fileURLToPath(new URL("../../dist", import.meta.url));
const chatgptConversations = fixture<ChatGPTConversation[]>("chatgpt-conversations.json");
const claudeConversations = fixture<ClaudeConversation[]>("claude-conversations.json");
const geminiChat = fixture<unknown[]>("gemini-chat.json");

const fakeSites = {
  chatgptLoggedIn: true,
  claudeLoggedIn: true,
  chatgpt: [...chatgptConversations],
  /** Page sizes the Gemini page's list and read calls asked for, in order. */
  geminiPageSizes: [] as number[],
  /** Makes Gemini refuse page sizes above the page's defaults. */
  geminiRejectEnlarged: false,
  /** Page tokens the Gemini page's list calls asked for (null for the first page). */
  geminiListTokens: [] as (string | null)[],
};

let server: Server;
let context: BrowserContext;
let worker: Worker;
let extensionId: string;

before(async () => {
  const certDir = mkdtempSync(join(tmpdir(), "threadbase-cert-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=threadbase-test",
    "-addext", "subjectAltName=DNS:chatgpt.com,DNS:claude.ai,DNS:gemini.google.com",
    "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"),
  ], { stdio: "ignore" });
  server = createServer(
    { key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")) },
    async (request, response) => {
      const url = new URL(request.url ?? "/", `https://${request.headers.host}`);
      let body = "";
      for await (const chunk of request) body += chunk;
      const reply =
        url.hostname === "claude.ai"
          ? serveClaude(url)
          : url.hostname === "gemini.google.com"
            ? serveGemini(url, body, request.headers)
            : serveChatGPT(url, request.headers.authorization);
      if ("text" in reply) {
        response.writeHead(200, { "content-type": "application/json" }).end(reply.text);
      } else if ("html" in reply) {
        response.writeHead(200, { "content-type": "text/html" }).end(reply.html);
      } else {
        response.writeHead(reply.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(reply.json ?? {}));
      }
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "threadbase-e2e-")), {
    channel: "chromium",
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${port}, MAP claude.ai 127.0.0.1:${port}, MAP gemini.google.com 127.0.0.1:${port}`,
      "--ignore-certificate-errors",
      "--no-proxy-server",
    ],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
  // DEBUG_E2E=1 prints page console output and page errors.
  if (process.env.DEBUG_E2E) {
    context.on("page", (page) => {
      page.on("console", (message) => console.log(`[${page.url()}] ${message.text()}`));
      page.on("pageerror", (error) => console.log(`[${page.url()}] error: ${error.message}`));
    });
  }
});

after(async () => {
  await context?.close();
  server?.close();
});

type Reply = { html: string } | { text: string } | { status?: number; json?: unknown };

function serveChatGPT(url: URL, authorization: string | undefined): Reply {
  const authorized = authorization === "Bearer test-token";
  if (url.pathname === "/api/auth/session") {
    return { json: fakeSites.chatgptLoggedIn ? { accessToken: "test-token" } : {} };
  }
  if (url.pathname === "/backend-api/conversations") {
    if (!authorized) return { status: 401 };
    // One conversation per page, to exercise pagination.
    const offset = Number(url.searchParams.get("offset"));
    const items = fakeSites.chatgpt.slice(offset, offset + 1).map((c) => ({
      id: c.conversation_id,
      title: c.title,
      update_time: c.update_time,
    }));
    return { json: { items, total: fakeSites.chatgpt.length } };
  }
  const detail = url.pathname.match(/^\/backend-api\/conversation\/(.+)$/);
  if (detail) {
    if (!authorized) return { status: 401 };
    const conversation = fakeSites.chatgpt.find((c) => c.conversation_id === detail[1]);
    return conversation ? { json: conversation } : { status: 404 };
  }
  return { html: "<title>ChatGPT (fake)</title><p>fake chatgpt.com</p>" };
}

function serveClaude(url: URL): Reply {
  if (url.pathname.startsWith("/api/") && !fakeSites.claudeLoggedIn) return { status: 403 };
  if (url.pathname === "/api/organizations") return { json: [{ uuid: "org-1", capabilities: ["chat"] }] };
  if (url.pathname === "/api/organizations/org-1/chat_conversations") {
    return { json: claudeConversations.map((c) => ({ uuid: c.uuid, name: c.name, updated_at: c.updated_at })) };
  }
  const detail = url.pathname.match(/^\/api\/organizations\/org-1\/chat_conversations\/(.+)$/);
  if (detail) {
    const conversation = claudeConversations.find((c) => c.uuid === detail[1]);
    return conversation ? { json: conversation } : { status: 404 };
  }
  return { html: "<title>Claude (fake)</title><p>fake claude.ai</p>" };
}

/**
 * The fake Gemini behaves like the real one where it matters to Threadbase:
 * the page's own scripts list chats (MaZiqc) on load and read the open chat
 * (hNvQHb), and the server answers only calls the page built (a stand-in
 * header added by the page's code).
 */
function geminiTurn(id: string, turn: string, prompt: string, reply: string, seconds: number) {
  return [[id, `r_${turn}`], null, [[prompt]], [[[`rc_${turn}`, [reply]]]], [seconds, 0]];
}

const geminiChats: { id: string; title: string; updatedAt: [number, number]; payload: unknown }[] = [
  { id: "c_aaaa1111bbbb2222", title: "報稅文件", updatedAt: [1792301486, 535038000], payload: geminiChat },
];

function serveGemini(url: URL, body: string, headers: Record<string, string | string[] | undefined>): Reply {
  if (url.pathname === "/_/BardChatUi/data/batchexecute") {
    const form = new URLSearchParams(body);
    const [[[rpcid, argsJson]]] = JSON.parse(form.get("f.req")!) as [[[string, string]]];
    const args = JSON.parse(argsJson) as unknown[];
    const reject = () => ({ text: `)]}'\n\n${JSON.stringify([["wrb.fr", rpcid, null, null, null, [13], "generic"]])}\n` });
    if (headers["x-built-by-page"] !== "1" || form.get("at") !== "xsrf-live") return reject();
    if (rpcid === "MaZiqc") {
      const count = args[0] as number;
      const token = args[1] as string | null;
      fakeSites.geminiPageSizes.push(count);
      fakeSites.geminiListTokens.push(token);
      if (fakeSites.geminiRejectEnlarged && count > 35) return reject();
      // Like a real server, pages are capped (here at 2 chats) whatever the count.
      const offset = token ? Number(token.replace("page-", "")) : 0;
      const end = offset + Math.min(count, 2);
      const items = geminiChats.slice(offset, end).map((c) => [c.id, c.title, null, null, null, c.updatedAt]);
      const next = end < geminiChats.length ? `page-${end}` : null;
      return { text: batchexecuteBody(rpcid, [null, next, items]) };
    }
    if (rpcid === "hNvQHb") {
      fakeSites.geminiPageSizes.push(args[1] as number);
      if (fakeSites.geminiRejectEnlarged && (args[1] as number) > 10) return reject();
      const chat = geminiChats.find((c) => c.id === args[0]);
      return chat ? { text: batchexecuteBody(rpcid, chat.payload) } : reject();
    }
    return reject();
  }
  return {
    html: `<title>Gemini (fake)</title>
<script>WIZ_global_data={"SNlM0e":"xsrf-test","cfb2h":"bl-test","FdrFJe":"-1"}</script>
<nav id="chats">${geminiChats.map((c) => `<a href="/app/${c.id.slice(2)}">${c.title}</a>`).join("")}</nav>
<script>
  WIZ_global_data.SNlM0e = "xsrf-live";
  const url = (rpcid) => "/_/BardChatUi/data/batchexecute?rpcids=" + rpcid + "&rt=c";
  const body = (rpcid, args) =>
    "f.req=" + encodeURIComponent(JSON.stringify([[[rpcid, JSON.stringify(args), null, "generic"]]])) +
    "&at=" + encodeURIComponent(WIZ_global_data.SNlM0e);
  const headers = { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8", "x-built-by-page": "1" };

  // The two calls use different transports, as a real page's might.
  const xhr = new XMLHttpRequest();
  xhr.open("POST", url("MaZiqc"));
  xhr.responseType = "arraybuffer";
  for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
  xhr.send(body("MaZiqc", [35, null, [null, null, 1, null, null, null, null, null, null, 1]]));

  function read(id) {
    fetch(new Request(url("hNvQHb"), { method: "POST", headers, body: body("hNvQHb", ["c_" + id, 10, null, 1, [0], [4], null, 1]) }));
  }
  const open = location.pathname.startsWith("/app/") ? location.pathname.split("/")[2] : null;
  if (open) read(open);
  // Like the real app, the chat list opens chats in the page, without a reload.
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (!link) return;
    event.preventDefault();
    history.pushState({}, "", link.getAttribute("href"));
    read(link.getAttribute("href").split("/")[2]);
  });
</script>`,
  };
}

async function status(source: string): Promise<Partial<SyncStatus>> {
  return worker.evaluate(
    async (key) => ((await chrome.storage.local.get(key))[key] ?? {}) as Partial<SyncStatus>,
    `status:${source}`,
  );
}

async function waitForStatus(
  source: string,
  predicate: (status: Partial<SyncStatus>) => boolean,
  timeoutMs = 20_000,
): Promise<Partial<SyncStatus>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await status(source);
    if (predicate(current)) return current;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${source} status; last: ${JSON.stringify(current)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function openPopup(): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return popup;
}

async function resultTitles(popup: Page, query: string): Promise<string[]> {
  await popup.fill("#query", query);
  await popup.waitForTimeout(300);
  return popup.locator(".result-title").allTextContents();
}

test("visiting each site syncs its whole history automatically", async () => {
  const chatgpt = await context.newPage();
  await chatgpt.goto("https://chatgpt.com/");
  const chatgptStatus = await waitForStatus("chatgpt", (s) => typeof s.lastSuccessAt === "number");
  assert.deepEqual(chatgptStatus.lastResult, { listed: 2, fetched: 2, failed: 0 });
  assert.equal(chatgptStatus.error, null);

  const claude = await context.newPage();
  await claude.goto("https://claude.ai/");
  const claudeStatus = await waitForStatus("claude", (s) => typeof s.lastSuccessAt === "number");
  assert.deepEqual(claudeStatus.lastResult, { listed: 2, fetched: 2, failed: 0 });

  // Gemini: the user's tab only lists chats; a sync tab opens to read them.
  const gemini = await context.newPage();
  await gemini.goto("https://gemini.google.com/app");
  const geminiStatus = await waitForStatus("gemini", (s) => typeof s.lastSuccessAt === "number");
  assert.deepEqual(geminiStatus.lastResult, { listed: 1, fetched: 1, failed: 0 });
  // The user's tab lists 35; the sync tab lists 100, then opens the chat from
  // its list in the page and reads 100 turns.
  assert.deepEqual(fakeSites.geminiPageSizes, [35, 100, 100], "the sync tab asks for larger pages");
  await gemini.waitForTimeout(500);
  assert.equal(context.pages().filter((p) => p.url().startsWith("https://gemini.google.com")).length, 1, "sync tab closed");

  await chatgpt.close();
  await claude.close();
  await gemini.close();
});

test("the popup searches across services", async () => {
  const popup = await openPopup();
  await popup.waitForSelector("text=Search 5 conversations");

  assert.deepEqual(await resultTitles(popup, "房貸"), ["報稅文件", "報稅文件整理"], "Gemini's chat is newer");
  // SCREENSHOT_DIR=… npm run test:e2e saves what the popup looks like.
  if (process.env.SCREENSHOT_DIR) await popup.screenshot({ path: join(process.env.SCREENSHOT_DIR, "popup.png") });
  assert.deepEqual(await resultTitles(popup, "pg_trgm ilike"), ["Postgres index for search"]);
  assert.deepEqual(await resultTitles(popup, "nothing-matches-this"), []);
  await popup.waitForSelector("text=No matches.");

  const rows = await popup.locator(".source-row .status").allTextContents();
  assert.match(rows[0]!, /^2 chats · synced just now$/);
  assert.match(rows[1]!, /^2 chats · synced just now$/);
  assert.match(rows[2]!, /^1 chat · synced just now$/);
  await popup.close();
});

test("the saved copy shows the active branch with matches highlighted", async () => {
  const popup = await openPopup();
  assert.deepEqual(await resultTitles(popup, "扣除"), ["報稅文件整理"]);
  const [viewer] = await Promise.all([context.waitForEvent("page"), popup.click("text=Saved copy")]);
  await viewer.waitForSelector(".message");

  const text = await viewer.locator("#viewer").innerText();
  assert.match(text, /房貸利息可以扣除嗎/);
  assert.doesNotMatch(text, /那房貸呢/, "abandoned branch is hidden");
  assert.ok((await viewer.locator("mark").count()) > 0);
  await viewer.close();
  await popup.close();
});

test("Sync opens the site in a background tab, syncs new chats and closes it", async () => {
  fakeSites.chatgpt.push({
    ...chatgptConversations[1]!,
    conversation_id: "c0ffee00-0000-4000-8000-000000000003",
    title: "壽司店推薦",
    update_time: 1720000000,
  });
  const popup = await openPopup();
  const before = await status("chatgpt");
  await popup.locator(".source-row", { hasText: "ChatGPT" }).locator("button").click();

  const after = await waitForStatus("chatgpt", (s) => s.lastSuccessAt !== before.lastSuccessAt && !s.running);
  assert.deepEqual(after.lastResult, { listed: 3, fetched: 1, failed: 0 }, "only the new chat is downloaded");
  await popup.waitForSelector("text=Search 6 conversations");
  assert.deepEqual(await resultTitles(popup, "壽司"), ["壽司店推薦"]);

  await popup.waitForTimeout(500);
  const open = context.pages().map((p) => p.url());
  assert.ok(!open.some((url) => url.startsWith("https://chatgpt.com")), `background tab was closed; open: ${open}`);
  await popup.close();
});

test("Gemini falls back to the page's own page sizes when larger ones are refused", async () => {
  geminiChats.unshift({
    id: "c_bbbb2222cccc3333",
    title: "週末去哪",
    updatedAt: [1792400000, 0],
    payload: [[geminiTurn("c_bbbb2222cccc3333", "w1", "週末去哪玩？", "可以去陽明山走走。", 1792400000)], null, null, []],
  });
  fakeSites.geminiRejectEnlarged = true;
  fakeSites.geminiPageSizes = [];
  const popup = await openPopup();
  const before = await status("gemini");
  await popup.locator(".source-row", { hasText: "Gemini" }).locator("button").click();

  const after = await waitForStatus("gemini", (s) => s.lastSuccessAt !== before.lastSuccessAt && !s.running);
  assert.deepEqual(after.lastResult, { listed: 2, fetched: 1, failed: 0 }, "only the new chat is read");
  // Refused list of 100, then a fresh plain load lists 35 and opens the chat in the page.
  assert.deepEqual(fakeSites.geminiPageSizes, [100, 35, 10], "retried with the page's defaults");
  assert.deepEqual(await resultTitles(popup, "陽明山"), ["週末去哪"]);
  await popup.close();
});

test("a full Gemini sync pages through the whole chat list", async () => {
  geminiChats.push({
    id: "c_cccc3333dddd4444",
    title: "舊的食譜",
    updatedAt: [1700000000, 0],
    payload: [[geminiTurn("c_cccc3333dddd4444", "o1", "番茄炒蛋怎麼做？", "先炒蛋，再加番茄。", 1700000000)], null, null, []],
  });
  fakeSites.geminiListTokens = [];
  const popup = await openPopup();
  const before = await status("gemini");
  await popup.locator(".source-row", { hasText: "Gemini" }).locator("button").click();

  const after = await waitForStatus("gemini", (s) => s.lastSuccessAt !== before.lastSuccessAt && !s.running, 40_000);
  assert.deepEqual(after.lastResult, { listed: 3, fetched: 1, failed: 0 }, "the chat on page 2 is found and read");
  assert.deepEqual(fakeSites.geminiListTokens, [null, "page-2"], "reloads for the next page, then stops");
  assert.deepEqual(await resultTitles(popup, "番茄"), ["舊的食譜"]);
  await popup.close();
});

test("scheduled syncs run quietly in background tabs", async () => {
  fakeSites.chatgpt.push({
    ...chatgptConversations[1]!,
    conversation_id: "c0ffee00-0000-4000-8000-000000000004",
    title: "電影推薦",
    update_time: 1730000000,
  });
  geminiChats.unshift({
    id: "c_dddd4444eeee5555",
    title: "盆栽照顧",
    updatedAt: [1792500000, 0],
    payload: [[geminiTurn("c_dddd4444eeee5555", "p1", "多肉植物多久澆水？", "大約兩週一次。", 1792500000)], null, null, []],
  });
  fakeSites.claudeLoggedIn = false;

  // Pretend the last syncs were long ago, then let the schedule fire now.
  await worker.evaluate(async () => {
    const keys = ["status:chatgpt", "status:claude", "status:gemini"];
    const statuses = await chrome.storage.local.get(keys);
    for (const key of keys) statuses[key] = { ...(statuses[key] as object), lastSuccessAt: 1 };
    await chrome.storage.local.set(statuses);
    await chrome.alarms.create("auto-sync", { when: Date.now() + 100 });
  });

  const chatgpt = await waitForStatus("chatgpt", (s) => (s.lastSuccessAt ?? 0) > 1 && !s.running, 40_000);
  assert.deepEqual(chatgpt.lastResult, { listed: 4, fetched: 1, failed: 0 });
  const gemini = await waitForStatus("gemini", (s) => (s.lastSuccessAt ?? 0) > 1 && !s.running, 40_000);
  assert.equal(gemini.lastResult?.fetched, 1, "the new Gemini chat is read");
  const claude = await waitForStatus("claude", (s) => s.error === "not-logged-in" && !s.running, 40_000);
  assert.equal(claude.lastSuccessAt, 1);

  await new Promise((r) => setTimeout(r, 500));
  const open = context.pages().map((p) => p.url());
  assert.ok(
    !open.some((url) => /chatgpt\.com|claude\.ai|gemini\.google\.com/.test(url)),
    `quiet syncs close their tabs, even signed out; open: ${open}`,
  );

  const popup = await openPopup();
  assert.deepEqual(await resultTitles(popup, "電影"), ["電影推薦"]);
  assert.deepEqual(await resultTitles(popup, "多肉"), ["盆栽照顧"]);
  assert.equal(await popup.locator("#auto-sync").inputValue(), "60", "hourly by default");
  await popup.close();
});

test("a signed-out site asks the user to sign in and leaves the tab open", async () => {
  fakeSites.claudeLoggedIn = false;
  const popup = await openPopup();
  await popup.locator(".source-row", { hasText: "Claude" }).locator("button").click();

  await waitForStatus("claude", (s) => s.error === "not-logged-in" && !s.running);
  await popup.waitForSelector("text=⚠ Sign in to claude.ai");
  assert.equal(await popup.locator(".source-row", { hasText: "Claude" }).locator("button").textContent(), "Open Claude");
  assert.ok(context.pages().some((p) => p.url().startsWith("https://claude.ai")), "tab stays open for signing in");
  await popup.close();
});
