/** How often Threadbase syncs on its own, in minutes (0 = never); chosen in the popup. */
export const AUTO_SYNC_KEY = "settings:autoSyncMinutes";
export const AUTO_SYNC_CHOICES = [0, 30, 60, 180, 360] as const;
export const DEFAULT_AUTO_SYNC_MINUTES = 60;

export async function readAutoSyncMinutes(): Promise<number> {
  const value = (await chrome.storage.local.get(AUTO_SYNC_KEY))[AUTO_SYNC_KEY];
  return typeof value === "number" ? value : DEFAULT_AUTO_SYNC_MINUTES;
}
