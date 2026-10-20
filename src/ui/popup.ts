import { allConversations, countBySource } from "../db.ts";
import { readStatus, sendToBackground, statusKey, type SyncStatus } from "../messages.ts";
import { search, toSearchable, type SearchableConversation, type SearchHit } from "../search.ts";
import { AUTO_SYNC_CHOICES, AUTO_SYNC_KEY, readAutoSyncMinutes } from "../settings.ts";
import { SOURCE_NAMES, type SourceId } from "../types.ts";
import { el, formatAgo, formatDate, highlighted, sourceTag } from "./dom.ts";

const SOURCES: SourceId[] = ["chatgpt", "claude", "gemini"];
const SITES: Record<SourceId, string> = { chatgpt: "chatgpt.com", claude: "claude.ai", gemini: "gemini.google.com" };
const MAX_RESULTS = 50;

const queryInput = document.querySelector<HTMLInputElement>("#query")!;
const results = document.querySelector<HTMLElement>("#results")!;
const sources = document.querySelector<HTMLElement>("#sources")!;

let index: SearchableConversation[] = [];

async function loadIndex(): Promise<void> {
  index = (await allConversations()).map(toSearchable);
  renderResults();
}

function renderResults(): void {
  const query = queryInput.value.trim();
  if (!query) {
    results.replaceChildren(
      el("p", { className: "empty" }, [
        index.length === 0
          ? "No chats yet. Sync a service below, or just open chatgpt.com or claude.ai while signed in."
          : `Search ${index.length.toLocaleString()} conversations across your AI services.`,
      ]),
    );
    return;
  }
  const hits = search(index, query, { limit: MAX_RESULTS });
  results.replaceChildren(
    ...(hits.length > 0 ? hits.map(renderHit) : [el("p", { className: "empty" }, ["No matches."])]),
  );
}

function renderHit(hit: SearchHit): HTMLElement {
  const { conversation, terms } = hit;
  const viewUrl = chrome.runtime.getURL(
    `view.html?key=${encodeURIComponent(conversation.key)}&q=${encodeURIComponent(queryInput.value)}`,
  );
  return el("article", { className: "result" }, [
    el(
      "button",
      {
        className: "result-title",
        title: `Open in ${SOURCE_NAMES[conversation.source]}`,
        onclick: () => void chrome.tabs.create({ url: conversation.url }),
      },
      highlighted(conversation.title, terms),
    ),
    el("div", { className: "result-meta" }, [
      sourceTag(conversation.source),
      formatDate(conversation.updatedAt ?? conversation.createdAt),
      el("button", { className: "link-button", onclick: () => void chrome.tabs.create({ url: viewUrl }) }, [
        "Saved copy",
      ]),
    ]),
    ...(hit.snippet ? [el("div", { className: "result-snippet" }, highlighted(hit.snippet, terms))] : []),
  ]);
}

async function renderSources(): Promise<void> {
  const rows = await Promise.all(
    SOURCES.map(async (source) => renderSourceRow(source, await readStatus(source), await countBySource(source))),
  );
  sources.replaceChildren(...rows);
}

function renderSourceRow(source: SourceId, status: SyncStatus, count: number): HTMLElement {
  let text: string;
  let error = false;
  if (status.running) {
    text = status.total > 0 ? `Syncing ${status.done}/${status.total}…` : "Checking for new chats…";
  } else if (status.error === "not-logged-in") {
    text = `Sign in to ${SITES[source]}, then sync again`;
    error = true;
  } else if (status.error) {
    text = `Sync failed: ${status.error}`;
    error = true;
  } else if (status.lastSuccessAt !== null) {
    text = `${count.toLocaleString()} chat${count === 1 ? "" : "s"} · synced ${formatAgo(status.lastSuccessAt)}`;
  } else {
    text = "Not synced yet";
  }
  return el("div", { className: "source-row" }, [
    sourceTag(source),
    el("span", { className: `status${error ? " error" : ""}`, title: text }, [text]),
    el(
      "button",
      {
        className: "sync-button",
        disabled: status.running,
        onclick: () => void sendToBackground({ type: "start-sync", source }),
      },
      ["Sync"],
    ),
  ]);
}

let debounce: ReturnType<typeof setTimeout> | undefined;
queryInput.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(renderResults, 120);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const finished = SOURCES.some((source) => {
    const change = changes[statusKey(source)];
    return change && (change.oldValue as SyncStatus | undefined)?.running && !(change.newValue as SyncStatus).running;
  });
  void renderSources();
  if (finished) void loadIndex();
});

const autoSync = document.querySelector<HTMLSelectElement>("#auto-sync")!;

function autoSyncLabel(minutes: number): string {
  if (minutes === 0) return "Off";
  return minutes < 60 ? `Every ${minutes} min` : `Every ${minutes / 60} h`;
}

async function renderAutoSync(): Promise<void> {
  const current = await readAutoSyncMinutes();
  autoSync.replaceChildren(
    ...AUTO_SYNC_CHOICES.map((minutes) =>
      el("option", { value: String(minutes), selected: minutes === current }, [autoSyncLabel(minutes)]),
    ),
  );
}

autoSync.addEventListener("change", () => {
  void chrome.storage.local.set({ [AUTO_SYNC_KEY]: Number(autoSync.value) });
});

void loadIndex();
void renderSources();
void renderAutoSync();
