import { activeBranch } from "./search.ts";
import { conversationKey, SOURCE_NAMES, type NormalizedMessage, type SourceId, type StoredConversation } from "./types.ts";

/**
 * Backups are one JSON file holding every saved conversation exactly as
 * stored, so importing one restores Threadbase as it was: search, saved
 * copies, and which chats a sync can skip.
 */

export const BACKUP_FORMAT = "threadbase-backup";
export const BACKUP_VERSION = 1;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  conversations: StoredConversation[];
}

export function createBackup(conversations: StoredConversation[], now = Date.now()): Backup {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date(now).toISOString(), conversations };
}

export class BackupError extends Error {
  override name = "BackupError";
}

export interface ParsedBackup {
  conversations: StoredConversation[];
  /** Entries that weren't valid conversations and were left out. */
  skipped: number;
}

/** Reads a backup file, keeping every valid conversation. Throws BackupError if it isn't a backup at all. */
export function parseBackup(text: string): ParsedBackup {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BackupError("This file isn't a Threadbase backup (it isn't JSON).");
  }
  if (!isObject(data) || data.format !== BACKUP_FORMAT || !Array.isArray(data.conversations)) {
    throw new BackupError("This file isn't a Threadbase backup.");
  }
  if (typeof data.version !== "number" || data.version > BACKUP_VERSION) {
    throw new BackupError("This backup was made by a newer version of Threadbase. Update Threadbase, then import it again.");
  }
  const conversations: StoredConversation[] = [];
  for (const entry of data.conversations) {
    const conversation = toConversation(entry);
    if (conversation) conversations.push(conversation);
  }
  return { conversations, skipped: data.conversations.length - conversations.length };
}

function toConversation(entry: unknown): StoredConversation | null {
  if (!isObject(entry) || !isSource(entry.source) || !nonEmptyString(entry.sourceId)) return null;
  if (typeof entry.title !== "string" || typeof entry.url !== "string" || !Array.isArray(entry.messages)) return null;
  const messages: NormalizedMessage[] = [];
  for (const message of entry.messages) {
    if (!isObject(message) || !nonEmptyString(message.sourceId) || typeof message.content !== "string") return null;
    if (!["user", "assistant", "system", "tool"].includes(message.role as string)) return null;
    messages.push({
      sourceId: message.sourceId,
      parentSourceId: stringOrNull(message.parentSourceId),
      role: message.role as NormalizedMessage["role"],
      content: message.content,
      createdAt: numberOrNull(message.createdAt),
      model: stringOrNull(message.model),
    });
  }
  return {
    source: entry.source,
    sourceId: entry.sourceId,
    // Recomputed rather than trusted, so an edited file can't misfile a chat.
    key: conversationKey(entry.source, entry.sourceId),
    title: entry.title,
    createdAt: numberOrNull(entry.createdAt),
    updatedAt: numberOrNull(entry.updatedAt),
    url: entry.url,
    activeLeafSourceId: stringOrNull(entry.activeLeafSourceId),
    messages,
    listedUpdatedAt: numberOrNull(entry.listedUpdatedAt),
    syncedAt: numberOrNull(entry.syncedAt) ?? 0,
  };
}

/**
 * The conversations an import should write: those not saved yet, and those
 * the backup has a newer copy of. A copy already saved that is as new or
 * newer is kept, so importing an old backup never undoes a later sync.
 */
export function conversationsToImport(
  existing: Map<string, StoredConversation>,
  incoming: StoredConversation[],
): StoredConversation[] {
  const chosen = new Map<string, StoredConversation>();
  for (const conversation of incoming) {
    const current = chosen.get(conversation.key) ?? existing.get(conversation.key);
    if (!current || isNewer(conversation, current)) chosen.set(conversation.key, conversation);
  }
  return [...chosen.values()];
}

function isNewer(a: StoredConversation, b: StoredConversation): boolean {
  const updatedA = a.updatedAt ?? a.createdAt ?? 0;
  const updatedB = b.updatedAt ?? b.createdAt ?? 0;
  return updatedA !== updatedB ? updatedA > updatedB : a.syncedAt > b.syncedAt;
}

const ROLE_HEADINGS = { user: "You", assistant: "Assistant", system: "System", tool: "Tool" } as const;

/** Every conversation as readable Markdown, newest first, showing the branch the user last saw. */
export function toMarkdown(conversations: StoredConversation[], now = Date.now()): string {
  const sorted = [...conversations].sort(
    (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
  );
  const parts = [`# Threadbase export\n\n${sorted.length} conversations, exported ${isoDate(now)}.`];
  for (const conversation of sorted) {
    const date = conversation.updatedAt ?? conversation.createdAt;
    const meta = [SOURCE_NAMES[conversation.source], date === null ? null : isoDate(date), `<${conversation.url}>`];
    const messages = activeBranch(conversation).map((message) => {
      const heading = [ROLE_HEADINGS[message.role], message.model].filter(Boolean).join(" · ");
      return `### ${heading}\n\n${message.content}`;
    });
    parts.push(
      [`## ${conversation.title.trim() || "Untitled"}`, meta.filter(Boolean).join(" · "), ...messages].join("\n\n"),
    );
  }
  return `${parts.join("\n\n---\n\n")}\n`;
}

/** File name for a download made now, such as threadbase-2026-10-21.json. */
export function backupFileName(extension: "json" | "md", now = Date.now()): string {
  return `threadbase-${isoDate(now)}.${extension}`;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSource(value: unknown): value is SourceId {
  return typeof value === "string" && Object.hasOwn(SOURCE_NAMES, value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
