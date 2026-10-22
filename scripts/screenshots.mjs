// Takes the README screenshots: loads dist/ into Chromium, imports a small
// made-up history through the Back up & restore page, and captures the
// popup, a saved copy and the backup page into docs/images/.
// Run `npm run build` first. Usage: node scripts/screenshots.mjs
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const dist = resolve("dist");
const out = resolve("docs/images");
const day = 24 * 60 * 60 * 1000;
const now = Date.now();

const chats = [
  {
    source: "chatgpt",
    title: "Two weeks in Japan: itinerary",
    daysAgo: 2,
    messages: [
      ["user", "Plan a two-week Japan trip in November: Tokyo, Kyoto, Osaka, and somewhere quieter."],
      ["assistant", "Here's a relaxed route for your Japan trip: 5 nights in Tokyo, a night in Hakone for the onsen, 4 nights in Kyoto for the autumn leaves, then Osaka and a day trip to Nara."],
    ],
  },
  {
    source: "claude",
    title: "JR Pass or regional passes?",
    daysAgo: 9,
    messages: [
      ["user", "Is the JR Pass still worth it for a Japan trip of Tokyo → Kyoto → Osaka → Tokyo?"],
      ["assistant", "After the 2023 price rise, a 7-day JR Pass rarely pays off for that route. Individual shinkansen tickets plus a Kansai pass are usually cheaper for this trip."],
    ],
  },
  {
    source: "gemini",
    title: "Packing list for Japan in autumn",
    daysAgo: 16,
    messages: [
      ["user", "What should I pack for a Japan trip in late autumn?"],
      ["assistant", "Layers! Days can be 18°C and evenings 8°C. Bring a light down jacket, comfortable walking shoes you can slip off at temples, and a coin purse — Japan still uses a lot of cash."],
    ],
  },
  {
    source: "claude",
    title: "Postgres index for fuzzy search",
    daysAgo: 21,
    messages: [
      ["user", "Which index makes ILIKE '%term%' fast in Postgres?"],
      ["assistant", "Use a GIN index with the pg_trgm extension."],
    ],
  },
  {
    source: "chatgpt",
    title: "Sourdough starter troubleshooting",
    daysAgo: 30,
    messages: [
      ["user", "My sourdough starter smells like nail polish. Is it dead?"],
      ["assistant", "Not dead, just hungry. Feed it twice a day at room temperature for a few days."],
    ],
  },
  {
    source: "gemini",
    title: "報稅：房貸利息扣除",
    daysAgo: 45,
    messages: [
      ["user", "房貸利息可以扣除嗎？"],
      ["assistant", "可以，自用住宅購屋借款利息每年最多可扣除 30 萬元，但要先減掉儲蓄投資特別扣除額。"],
    ],
  },
];

const urls = {
  chatgpt: (id) => `https://chatgpt.com/c/${id}`,
  claude: (id) => `https://claude.ai/chat/${id}`,
  gemini: (id) => `https://gemini.google.com/app/${id}`,
};

const conversations = chats.map((chat, i) => {
  const sourceId = `demo-${i}`;
  const updatedAt = now - chat.daysAgo * day;
  return {
    source: chat.source,
    sourceId,
    key: `${chat.source}:${sourceId}`,
    title: chat.title,
    createdAt: updatedAt - 3600_000,
    updatedAt,
    url: urls[chat.source](sourceId),
    activeLeafSourceId: null,
    listedUpdatedAt: updatedAt,
    syncedAt: now,
    messages: chat.messages.map(([role, content], j) => ({
      sourceId: `m${j}`,
      parentSourceId: j === 0 ? null : `m${j - 1}`,
      role,
      content,
      createdAt: updatedAt - 3600_000 + j * 60_000,
      model: null,
    })),
  };
});

const work = mkdtempSync(join(tmpdir(), "threadbase-shots-"));
const backupPath = join(work, "demo.json");
writeFileSync(backupPath, JSON.stringify({ format: "threadbase-backup", version: 1, exportedAt: new Date(now).toISOString(), conversations }));

const context = await chromium.launchPersistentContext(join(work, "profile"), {
  channel: "chromium",
  deviceScaleFactor: 2,
  viewport: { width: 900, height: 900 },
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const id = new URL(worker.url()).host;

const data = await context.newPage();
await data.goto(`chrome-extension://${id}/data.html`);
await data.setInputFiles("#import-file", backupPath);
await data.waitForSelector("text=Added 6 conversations");

// Synced a few minutes ago, with Gemini waiting on a robot check.
const counts = { chatgpt: 2, claude: 2, gemini: 2 };
await worker.evaluate(
  async ({ counts, now }) => {
    for (const [source, n] of Object.entries(counts)) {
      await chrome.storage.local.set({
        [`status:${source}`]: {
          running: false, heartbeatAt: null, done: 0, total: 0, pendingMode: null,
          lastSuccessAt: now - (source === "gemini" ? 3 * 3600_000 : 4 * 60_000),
          lastResult: { listed: n, fetched: 0, failed: 0 },
          error: source === "gemini" ? "robot-check" : null,
        },
      });
    }
  },
  { counts, now },
);

const popup = await context.newPage();
await popup.setViewportSize({ width: 440, height: 600 });
await popup.goto(`chrome-extension://${id}/popup.html`);
await popup.fill("#query", "japan trip");
await popup.waitForSelector(".result-snippet:not(:empty)");
await popup.waitForTimeout(300);
await popup.locator("body").screenshot({ path: join(out, "popup.png") });

const viewer = await context.newPage();
await viewer.setViewportSize({ width: 820, height: 330 });
await viewer.goto(`chrome-extension://${id}/view.html?key=claude%3Ademo-1&q=${encodeURIComponent("japan trip")}`);
await viewer.waitForSelector("mark");
await viewer.screenshot({ path: join(out, "saved-copy.png") });

await data.setViewportSize({ width: 820, height: 560 });
await data.screenshot({ path: join(out, "backup.png") });

await context.close();
console.log(`Saved screenshots to ${out}`);
