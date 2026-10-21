import { toSearchRecord, type SearchRecord } from "./search.ts";
import { conversationKey, type NormalizedConversation, type SourceId, type StoredConversation } from "./types.ts";

/**
 * Conversations live in the extension's own IndexedDB, on this computer only.
 * Extension pages (popup, viewer) and the background worker share it; content
 * scripts run in the sites' origins and go through the background worker.
 */

const DB_NAME = "threadbase";
const DB_VERSION = 2;
const CONVERSATIONS = "conversations";
/** One compact SearchRecord per conversation (see search.ts), written together with it. */
const SEARCH = "search";

let opening: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) {
        db.createObjectStore(CONVERSATIONS, { keyPath: "key" }).createIndex("source", "source");
      }
      if (event.oldVersion < 2) {
        const search = db.createObjectStore(SEARCH, { keyPath: "key" });
        search.createIndex("order", ["order", "key"]);
        // Build search records for chats saved by earlier versions.
        const cursorRequest = request.transaction!.objectStore(CONVERSATIONS).openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          search.put(toSearchRecord(cursor.value as StoredConversation));
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => {
      // Let a newer version of the extension upgrade the database.
      request.result.onversionchange = () => {
        request.result.close();
        opening = undefined;
      };
      resolve(request.result);
    };
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
  await putConversations([stored]);
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

export function countAll(): Promise<number> {
  return run("readonly", (store) => store.count());
}

/**
 * Search records, most recently updated first, in pages of `count`. Pass the
 * returned `after` to read the next page; it's null after the last page.
 */
export async function recentSearchRecords(
  after: IDBValidKey | null,
  count: number,
): Promise<{ records: SearchRecord[]; after: IDBValidKey | null }> {
  const db = await open();
  const records = await new Promise<SearchRecord[]>((resolve, reject) => {
    const transaction = db.transaction(SEARCH, "readonly");
    const range = after === null ? null : IDBKeyRange.lowerBound(after, true);
    const request = transaction.objectStore(SEARCH).index("order").getAll(range, count);
    transaction.oncomplete = () => resolve(request.result as SearchRecord[]);
    transaction.onerror = () => reject(transaction.error);
  });
  const last = records.at(-1);
  return { records, after: records.length === count && last ? [last.order, last.key] : null };
}

export async function deleteAll(): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([CONVERSATIONS, SEARCH], "readwrite");
    transaction.objectStore(CONVERSATIONS).clear();
    transaction.objectStore(SEARCH).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/** Writes conversations as given, with their search records, in one transaction. */
export async function putConversations(conversations: StoredConversation[]): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([CONVERSATIONS, SEARCH], "readwrite");
    const store = transaction.objectStore(CONVERSATIONS);
    const search = transaction.objectStore(SEARCH);
    for (const conversation of conversations) {
      store.put(conversation);
      search.put(toSearchRecord(conversation));
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
