import { countAll, countBySource, getConversation, recentSearchRecords } from "../db.ts";
import { NOT_LOGGED_IN, readStatus, ROBOT_CHECK, sendToBackground, statusKey, type SyncStatus } from "../messages.ts";
import { matchRecord, matchSnippet, parseQuery, type SearchMatch, type SearchRecord } from "../search.ts";
import { AUTO_SYNC_CHOICES, AUTO_SYNC_KEY, readAutoSyncMinutes } from "../settings.ts";
import { SOURCE_NAMES, type SourceId, type StoredConversation } from "../types.ts";
import { el, formatAgo, formatDate, highlighted, sourceTag } from "./dom.ts";

const SOURCES: SourceId[] = ["chatgpt", "claude", "gemini"];
const SITES: Record<SourceId, string> = { chatgpt: "chatgpt.com", claude: "claude.ai", gemini: "gemini.google.com" };
const MAX_RESULTS = 50;
/** Search records read from the database at a time. */
const PAGE_SIZE = 500;

const queryInput = document.querySelector<HTMLInputElement>("#query")!;
const results = document.querySelector<HTMLElement>("#results")!;
const sources = document.querySelector<HTMLElement>("#sources")!;

/**
 * Search records read so far, newest first. Searches scan these, reading
 * more pages only until they have a page of results, so the popup opens
 * without reading every chat and most searches stop early.
 */
let records: SearchRecord[] = [];
let after: IDBValidKey | null = null;
let readAll = false;
let reading: Promise<void> | undefined;
let total = 0;
/** Bumped by every search, so a superseded search stops. */
let generation = 0;
const conversations = new Map<string, Promise<StoredConversation | undefined>>();

function readMore(): Promise<void> {
  const into = records;
  reading ??= recentSearchRecords(after, PAGE_SIZE)
    .then((page) => {
      if (into !== records) return; // reset() started over meanwhile
      records.push(...page.records);
      after = page.after;
      readAll = page.after === null;
    })
    .finally(() => {
      reading = undefined;
    });
  return reading;
}

/** Forgets what was read, after a sync changed the saved chats. */
async function reset(): Promise<void> {
  records = [];
  reading = undefined;
  after = null;
  readAll = false;
  conversations.clear();
  total = await countAll();
  void runSearch();
}

async function runSearch(): Promise<void> {
  const current = ++generation;
  const query = queryInput.value.trim();
  if (!query) {
    results.replaceChildren(
      el("p", { className: "empty" }, [
        total === 0
          ? "No chats yet. Sync a service below, or just open chatgpt.com, claude.ai or gemini.google.com while signed in."
          : `Search ${total.toLocaleString()} conversation${total === 1 ? "" : "s"} across your AI services.`,
      ]),
    );
    return;
  }
  const terms = parseQuery(query);
  const matches: SearchMatch[] = [];
  let scanned = 0;
  for (;;) {
    while (scanned < records.length && matches.length < MAX_RESULTS) {
      const match = matchRecord(records[scanned++]!, terms);
      if (match) matches.push(match);
    }
    if (matches.length >= MAX_RESULTS || readAll) break;
    renderResults(matches, scanned);
    await readMore();
    if (current !== generation) return;
  }
  renderResults(matches, null);
}

/** `scanned` is how many chats were searched so far, or null when the search is done. */
function renderResults(matches: SearchMatch[], scanned: number | null): void {
  const searching =
    scanned === null
      ? []
      : [el("p", { className: "searching" }, [`Searching… ${scanned.toLocaleString()} of ${total.toLocaleString()} chats`])];
  if (matches.length === 0) {
    results.replaceChildren(...(scanned === null ? [el("p", { className: "empty" }, ["No matches."])] : searching));
    return;
  }
  results.replaceChildren(...matches.map(renderHit), ...searching);
}

function renderHit(match: SearchMatch): HTMLElement {
  const { record, terms } = match;
  const viewUrl = chrome.runtime.getURL(
    `view.html?key=${encodeURIComponent(record.key)}&q=${encodeURIComponent(queryInput.value)}`,
  );
  const snippet = el("div", { className: "result-snippet" });
  if (match.messageIndex !== null) void fillSnippet(snippet, match);
  return el("article", { className: "result" }, [
    el(
      "button",
      {
        className: "result-title",
        title: `Open in ${SOURCE_NAMES[record.source]}`,
        onclick: () => void chrome.tabs.create({ url: record.url }),
      },
      highlighted(record.title, terms),
    ),
    el("div", { className: "result-meta" }, [
      sourceTag(record.source),
      formatDate(record.updatedAt ?? record.createdAt),
      el("button", { className: "link-button", onclick: () => void chrome.tabs.create({ url: viewUrl }) }, [
        "Saved copy",
      ]),
    ]),
    snippet,
  ]);
}

/** Excerpts come from the saved conversation's original text, read only for the results shown. */
async function fillSnippet(target: HTMLElement, match: SearchMatch): Promise<void> {
  let conversation = conversations.get(match.record.key);
  if (!conversation) {
    conversation = getConversation(match.record.key);
    conversations.set(match.record.key, conversation);
  }
  const loaded = await conversation;
  if (loaded) target.replaceChildren(...highlighted(matchSnippet(loaded, match), match.terms));
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
  debounce = setTimeout(() => void runSearch(), 120);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const finished = SOURCES.some((source) => {
    const change = changes[statusKey(source)];
    return change && (change.oldValue as SyncStatus | undefined)?.running && !(change.newValue as SyncStatus).running;
  });
  void renderSources();
  if (finished) void reset();
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

document.querySelector("#open-data")!.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("data.html") });
});

void reset();
void renderSources();
void renderAutoSync();
