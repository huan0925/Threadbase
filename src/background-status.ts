import { readStatus, writeStatus, type SyncStatus } from "./messages.ts";
import type { SourceId } from "./types.ts";

// Status and sync-state updates are read-modify-write; run them one at a time
// so concurrent messages (progress, captures, sync-end) can't overwrite each other.
let queue: Promise<unknown> = Promise.resolve();

export function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

/** Patches a source's sync status; call only from outside serialized() to avoid waiting on itself. */
export function updateStatus(
  source: SourceId,
  patch: Partial<SyncStatus> | ((status: SyncStatus) => Partial<SyncStatus>),
): Promise<SyncStatus> {
  return serialized(() => patchStatus(source, patch));
}

/** Patches a source's sync status from inside serialized(). */
export async function patchStatus(
  source: SourceId,
  patch: Partial<SyncStatus> | ((status: SyncStatus) => Partial<SyncStatus>),
): Promise<SyncStatus> {
  return writeStatus(source, typeof patch === "function" ? patch(await readStatus(source)) : patch);
}
