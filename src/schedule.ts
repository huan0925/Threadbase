import type { SyncStatus } from "./messages.ts";
import type { SyncMode } from "./sync.ts";

/** Opening a site syncs automatically at most this often. */
export const AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;
/** A running sync that hasn't reported in this long is assumed dead (tab closed mid-sync). */
export const STALE_SYNC_MS = 2 * 60 * 1000;

/**
 * Decides whether a site's tab should sync now. A sync the user asked for
 * always runs (unless one is already running); otherwise the first sync is a
 * full one and later visits run a quick one at most every AUTO_SYNC_INTERVAL_MS.
 */
export function decideSyncMode(status: SyncStatus, now: number): SyncMode | null {
  const running = status.running && status.heartbeatAt !== null && now - status.heartbeatAt < STALE_SYNC_MS;
  if (running) return null;
  if (status.pendingMode) return status.pendingMode;
  if (status.lastSuccessAt === null) return "full";
  return now - status.lastSuccessAt >= AUTO_SYNC_INTERVAL_MS ? "quick" : null;
}

/**
 * Whether a scheduled sync should run for a source: not while one is running,
 * and not if the source synced within most of the interval anyway (say,
 * because the user opened the site).
 */
export function dueForScheduledSync(status: SyncStatus, now: number, intervalMinutes: number): boolean {
  const running = status.running && status.heartbeatAt !== null && now - status.heartbeatAt < STALE_SYNC_MS;
  if (running || intervalMinutes <= 0) return false;
  return status.lastSuccessAt === null || now - status.lastSuccessAt >= intervalMinutes * 60_000 * 0.9;
}
