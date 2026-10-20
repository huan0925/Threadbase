import { allConversations, countBySource } from "../db.ts";
import { NOT_LOGGED_IN, readStatus, ROBOT_CHECK, sendToBackground, statusKey, type SyncStatus } from "../messages.ts";
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
          ? "No chats yet. Sync a service below, or just open chatgpt.com, claude.ai or gemini.google.com while signed in."
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
  const synced =
    status.lastSuccessAt !== null
      ? `${count.toLocaleString()} chat${count === 1 ? "" : "s"} · synced ${formatAgo(status.lastSuccessAt)}`
      : "Not synced yet";

  // Something only the user can do: say what, keep the sync details, and offer to open the site.
  const action =
    status.error === NOT_LOGGED_IN
      ? `Sign in to ${SITES[source]}`
      : status.error === ROBOT_CHECK
        ? `Confirm you're not a robot on ${SOURCE_NAMES[source]}`
        : null;

  let main: HTMLElement;
  let detail: string | null = null;
  if (status.running) {
    const text = status.total > 0 ? `Syncing ${status.done}/${status.total}…` : "Checking for new chats…";
    main = el("span", { className: "status", title: text }, [text]);
  } else if (action) {
    main = el("span", { className: "status needs-you", title: action }, [`⚠ ${action}`]);
    detail = synced;
  } else if (status.error) {
    const text = `Sync failed: ${status.error}`;
    main = el("span", { className: "status error", title: text }, [text]);
    detail = synced;
  } else {
    main = el("span", { className: "status", title: synced }, [synced]);
  }

  const button = action
    ? el("button", { className: "sync-button", onclick: () => void openSite(source) }, [`Open ${SOURCE_NAMES[source]}`])
    : el(
        "button",
        {
          className: "sync-button",
          disabled: status.running,
          onclick: () => void sendToBackground({ type: "start-sync", source }),
        },
        ["Sync"],
      );

  return el("div", { className: "source-row" }, [
    sourceTag(source),
    el("div", { className: "status-block" }, [main, ...(detail ? [el("span", { className: "detail" }, [detail])] : [])]),
    button,
  ]);
}

/** Shows the site's tab if one is open (such as a sync tab waiting on a check), else opens it. */
async function openSite(source: SourceId): Promise<void> {
  const [tab] = await chrome.tabs.query({ url: `https://${SITES[source]}/*` });
  if (tab?.id === undefined) {
    await chrome.tabs.create({ url: `https://${SITES[source]}/` });
    return;
  }
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
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
