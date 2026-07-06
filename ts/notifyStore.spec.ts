import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  appendEvent,
  clearWatcher,
  gcInboxes,
  heartbeatWatcher,
  hostId,
  listInboxParents,
  liveWatchers,
  minConsumerCursor,
  readInbox,
  setCursor,
} from "./notifyStore.ts";
import { inboxPath, type NotifyEvent } from "./notifyInbox.ts";

const host = hostId();
const baseEvent = (edge: NotifyEvent["edge"], over: Partial<NotifyEvent> = {}) => ({
  ts: 1_000,
  host,
  parent_pid: 999,
  child_pid: 555,
  cli: "claude",
  cwd: "/repo",
  edge,
  prev_state: "active",
  state: edge === "exited" ? "stopped" : edge,
  question: null,
  ...over,
});

describe("notifyStore (fs)", () => {
  let home: string;
  const prev = process.env.AGENT_YES_HOME;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "ay-notify-store-"));
    process.env.AGENT_YES_HOME = home;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = prev;
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  it("appends events with a strictly increasing per-inbox seq (locked)", async () => {
    // Concurrent appends must still get unique, increasing seqs.
    const seqs = await Promise.all([
      appendEvent(999, baseEvent("idle")),
      appendEvent(999, baseEvent("needs_input")),
      appendEvent(999, baseEvent("exited")),
    ]);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3]);
    const inbox = await readInbox(host, 999);
    expect(inbox.map((e) => e.seq).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("registers and expires watcher heartbeats", async () => {
    await heartbeatWatcher(1, 111);
    await heartbeatWatcher(2, 222);
    expect([...(await liveWatchers())].sort()).toEqual([1, 2]);
    await clearWatcher(1);
    expect([...(await liveWatchers())]).toEqual([2]);
    // A far-future `now` makes both heartbeats stale.
    expect((await liveWatchers(Date.now() + 10 * 60_000)).size).toBe(0);
  });

  it("minConsumerCursor returns the smallest cursor across consumers (0 if none)", async () => {
    expect(await minConsumerCursor(host, 999)).toBe(0);
    await setCursor(host, 999, 8, "parent");
    await setCursor(host, 999, 3, "auditor");
    expect(await minConsumerCursor(host, 999)).toBe(3);
  });

  it("GC deletes a dead-parent inbox but keeps a referenced one", async () => {
    await appendEvent(999, baseEvent("idle"));
    await appendEvent(888, baseEvent("idle", { parent_pid: 888 }));
    expect((await listInboxParents(host)).sort((a, b) => a - b)).toEqual([888, 999]);
    // 999 dead + unreferenced → GC; 888 referenced by a live child → keep.
    await gcInboxes(host, new Set<number>(), new Set([888]));
    expect(await listInboxParents(host)).toEqual([888]);
  });

  it("GC rotation never drops unacked events even past the byte cap", async () => {
    for (let i = 0; i < 50; i++) await appendEvent(999, baseEvent("idle"));
    // Ack up to seq 20 for the sole consumer; cap of 1 byte forces rotation.
    await setCursor(host, 999, 20, "parent");
    await gcInboxes(host, new Set([999]), new Set([999]), 1);
    const inbox = await readInbox(host, 999);
    // Every unacked event (seq > 20) survives.
    for (let seq = 21; seq <= 50; seq++) expect(inbox.some((e) => e.seq === seq)).toBe(true);
    // The file did shrink (some acked events evicted) OR stayed — either way, no
    // unacked loss. Confirm the inbox still exists.
    await expect(stat(inboxPath(host, 999))).resolves.toBeTruthy();
  });
});
