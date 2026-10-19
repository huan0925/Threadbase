import { conversationKey, type NormalizedConversation, type SourceId, type StoredConversation } from "./types.ts";

/**
 * Conversations live in the extension's own IndexedDB, on this computer only.
 * Extension pages (popup, viewer) and the background worker share it; content
 * scripts run in the sites' origins and go through the background worker.
 */

const DB_NAME = "threadbase";
const DB_VERSION = 1;
const CONVERSATIONS = "conversations";

let opening: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(CONVERSATIONS, { keyPath: "key" });
      store.createIndex("source", "source");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opening;
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(CONVERSATIONS, mode);
    const request = fn(transaction.objectStore(CONVERSATIONS));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function saveConversation(
  conversation: NormalizedConversation,
  listedUpdatedAt: number | null,
): Promise<void> {
  const stored: StoredConversation = {
    ...conversation,
    key: conversationKey(conversation.source, conversation.sourceId),
    listedUpdatedAt,
    syncedAt: Date.now(),
  };
  await run("readwrite", (store) => store.put(stored));
}

export function getConversation(key: string): Promise<StoredConversation | undefined> {
  return run("readonly", (store) => store.get(key) as IDBRequest<StoredConversation | undefined>);
}

export function allConversations(): Promise<StoredConversation[]> {
  return run("readonly", (store) => store.getAll() as IDBRequest<StoredConversation[]>);
}

/** Conversation id → list update time recorded at its last sync. */
export async function knownUpdates(source: SourceId): Promise<[string, number | null][]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const entries: [string, number | null][] = [];
    const transaction = db.transaction(CONVERSATIONS, "readonly");
    const request = transaction.objectStore(CONVERSATIONS).index("source").openCursor(IDBKeyRange.only(source));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const value = cursor.value as StoredConversation;
      entries.push([value.sourceId, value.listedUpdatedAt]);
      cursor.continue();
    };
    transaction.oncomplete = () => resolve(entries);
    transaction.onerror = () => reject(transaction.error);
  });
}

export function countBySource(source: SourceId): Promise<number> {
  return run("readonly", (store) => store.index("source").count(IDBKeyRange.only(source)));
}

export function deleteAll(): Promise<undefined> {
  return run("readwrite", (store) => store.clear());
}
