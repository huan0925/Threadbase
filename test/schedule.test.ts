import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_STATUS } from "../src/messages.ts";
import { AUTO_SYNC_INTERVAL_MS, decideSyncMode, STALE_SYNC_MS } from "../src/schedule.ts";

const now = 1_800_000_000_000;

test("first visit runs a full sync", () => {
  assert.equal(decideSyncMode(EMPTY_STATUS, now), "full");
});

test("later visits run a quick sync at most every interval", () => {
  const synced = { ...EMPTY_STATUS, lastSuccessAt: now - 1000 };
  assert.equal(decideSyncMode(synced, now), null);
  assert.equal(decideSyncMode({ ...synced, lastSuccessAt: now - AUTO_SYNC_INTERVAL_MS }, now), "quick");
});

test("a sync the user asked for runs regardless of the interval", () => {
  assert.equal(decideSyncMode({ ...EMPTY_STATUS, lastSuccessAt: now, pendingMode: "full" }, now), "full");
});

test("doesn't start a second sync while one is running, unless it went stale", () => {
  const running = { ...EMPTY_STATUS, running: true, heartbeatAt: now - 1000, pendingMode: "full" as const };
  assert.equal(decideSyncMode(running, now), null);
  assert.equal(decideSyncMode({ ...running, heartbeatAt: now - STALE_SYNC_MS }, now), "full");
});
