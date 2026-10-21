import { backupFileName, BackupError, conversationsToImport, createBackup, parseBackup, toMarkdown } from "../backup.ts";
import { allConversations, putConversations } from "../db.ts";

const summary = document.querySelector<HTMLElement>("#summary")!;
const result = document.querySelector<HTMLElement>("#result")!;
const exportJson = document.querySelector<HTMLButtonElement>("#export-json")!;
const exportMarkdown = document.querySelector<HTMLButtonElement>("#export-md")!;
const importFile = document.querySelector<HTMLInputElement>("#import-file")!;

function plural(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

function report(text: string, error = false): void {
  result.textContent = text;
  result.classList.toggle("error", error);
}

async function renderSummary(): Promise<void> {
  const count = (await allConversations()).length;
  summary.textContent = `${plural(count, "conversation")} saved in this browser.`;
  exportJson.disabled = exportMarkdown.disabled = count === 0;
}

/** Saves text as a file through the browser's normal download (no extra permission needed). */
function download(text: string, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: fileName });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

exportJson.addEventListener("click", async () => {
  const conversations = await allConversations();
  download(JSON.stringify(createBackup(conversations)), backupFileName("json"), "application/json");
  report(`Downloaded a backup of ${plural(conversations.length, "conversation")}.`);
});

exportMarkdown.addEventListener("click", async () => {
  const conversations = await allConversations();
  download(toMarkdown(conversations), backupFileName("md"), "text/markdown");
  report(`Downloaded ${plural(conversations.length, "conversation")} as Markdown.`);
});

importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  importFile.value = "";
  if (!file) return;
  report("Importing…");
  try {
    const backup = parseBackup(await file.text());
    const existing = new Map((await allConversations()).map((conversation) => [conversation.key, conversation]));
    const toWrite = conversationsToImport(existing, backup.conversations);
    await putConversations(toWrite);
    const added = toWrite.filter((conversation) => !existing.has(conversation.key)).length;
    const updated = toWrite.length - added;
    const kept = backup.conversations.length - toWrite.length;
    const parts = [`Added ${plural(added, "conversation")}`, `updated ${updated}`, `kept ${kept} you already had`];
    if (backup.skipped > 0) parts.push(`skipped ${backup.skipped} unreadable`);
    report(`${parts.join(", ")}.`);
    await renderSummary();
  } catch (error) {
    report(error instanceof BackupError ? error.message : `Import failed: ${String(error)}`, true);
  }
});

void renderSummary();
