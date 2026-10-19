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
import { fixture } from "../helpers.ts";

/**
 * Loads the built extension (dist/) into Chromium and points chatgpt.com and
 * claude.ai at a local HTTPS server playing both sites. Host-level redirection
 * (rather than Playwright request routing) also covers tabs the extension
 * opens itself.
 */

const dist = fileURLToPath(new URL("../../dist", import.meta.url));
const chatgptConversations = fixture<ChatGPTConversation[]>("chatgpt-conversations.json");
const claudeConversations = fixture<ClaudeConversation[]>("claude-conversations.json");

const fakeSites = {
  chatgptLoggedIn: true,
  claudeLoggedIn: true,
  chatgpt: [...chatgptConversations],
};

let server: Server;
let context: BrowserContext;
let worker: Worker;
let extensionId: string;

before(async () => {
  const certDir = mkdtempSync(join(tmpdir(), "threadbase-cert-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=threadbase-test",
    "-addext", "subjectAltName=DNS:chatgpt.com,DNS:claude.ai",
    "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"),
  ], { stdio: "ignore" });
  server = createServer(
    { key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")) },
    (request, response) => {
      const url = new URL(request.url ?? "/", `https://${request.headers.host}`);
      const reply = url.hostname === "claude.ai" ? serveClaude(url) : serveChatGPT(url, request.headers.authorization);
      if ("html" in reply) {
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
      `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${port}, MAP claude.ai 127.0.0.1:${port}`,
      "--ignore-certificate-errors",
      "--no-proxy-server",
    ],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
});

after(async () => {
  await context?.close();
  server?.close();
});

type Reply = { html: string } | { status?: number; json?: unknown };

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

  await chatgpt.close();
  await claude.close();
});

test("the popup searches across services", async () => {
  const popup = await openPopup();
  await popup.waitForSelector("text=Search 4 conversations");

  assert.deepEqual(await resultTitles(popup, "房貸"), ["報稅文件整理"]);
  // SCREENSHOT_DIR=… npm run test:e2e saves what the popup looks like.
  if (process.env.SCREENSHOT_DIR) await popup.screenshot({ path: join(process.env.SCREENSHOT_DIR, "popup.png") });
  assert.deepEqual(await resultTitles(popup, "pg_trgm ilike"), ["Postgres index for search"]);
  assert.deepEqual(await resultTitles(popup, "nothing-matches-this"), []);
  await popup.waitForSelector("text=No matches.");

  const rows = await popup.locator(".source-row .status").allTextContents();
  assert.match(rows[0]!, /^2 chats · synced just now$/);
  assert.match(rows[1]!, /^2 chats · synced just now$/);
  await popup.close();
});

test("the saved copy shows the active branch with matches highlighted", async () => {
  const popup = await openPopup();
  await resultTitles(popup, "房貸");
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
  await popup.waitForSelector("text=Search 5 conversations");
  assert.deepEqual(await resultTitles(popup, "壽司"), ["壽司店推薦"]);

  await popup.waitForTimeout(500);
  assert.ok(!context.pages().some((p) => p.url().startsWith("https://chatgpt.com")), "background tab was closed");
  await popup.close();
});

test("a signed-out site asks the user to sign in and leaves the tab open", async () => {
  fakeSites.claudeLoggedIn = false;
  const popup = await openPopup();
  await popup.locator(".source-row", { hasText: "Claude" }).locator("button").click();

  await waitForStatus("claude", (s) => s.error === "not-logged-in" && !s.running);
  await popup.waitForSelector("text=Sign in to claude.ai, then sync again");
  assert.ok(context.pages().some((p) => p.url().startsWith("https://claude.ai")), "tab stays open for signing in");
  await popup.close();
});
