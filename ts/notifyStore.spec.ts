import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  acquireLock,
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
  shouldStealLock,
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

describe("notifyStore — lock steal decision (C1: holder liveness, not wait time)", () => {
  const now = 1_000_000;
  const opts = (over = {}) => ({
    staleMs: 30_000,
    hardMs: 60_000,
    elapsed: 0,
    selfPid: 1,
    isAlive: (p: number) => p === 42, // only pid 42 is "alive"
    ...over,
  });

  it("does NOT steal a LIVE holder with a fresh heartbeat, even after a long wait", () => {
    const owner = JSON.stringify({ pid: 42, ts: now - 1_000 });
    // 50s elapsed but holder alive + fresh → must NOT steal (this was the bug).
    expect(shouldStealLock(owner, now, opts({ elapsed: 50_000 }))).toBe(false);
  });

  it("steals a DEAD holder", () => {
    const owner = JSON.stringify({ pid: 99, ts: now }); // 99 not alive
    expect(shouldStealLock(owner, now, opts())).toBe(true);
  });

  it("steals a live holder whose heartbeat is STALE (wedged)", () => {
    const owner = JSON.stringify({ pid: 42, ts: now - 40_000 }); // alive but stale
    expect(shouldStealLock(owner, now, opts())).toBe(true);
  });

  it("does NOT steal a torn/empty owner within the grace (mkdir→writeFile window)", () => {
    // A just-created lock whose owner file isn't written yet must be respected,
    // else two writers race into the critical section and duplicate a seq.
    expect(shouldStealLock("", now, opts({ elapsed: 0, graceMs: 1000 }))).toBe(false);
    expect(shouldStealLock("{ torn", now, opts({ elapsed: 100, graceMs: 1000 }))).toBe(false);
  });

  it("steals a torn/empty owner once the grace elapses (holder crashed mid-acquire)", () => {
    expect(shouldStealLock("", now, opts({ elapsed: 1500, graceMs: 1000 }))).toBe(true);
  });

  it("hardMs backstop steals even a fresh-looking holder after an extreme wait", () => {
    const owner = JSON.stringify({ pid: 42, ts: now });
    expect(shouldStealLock(owner, now, opts({ elapsed: 61_000 }))).toBe(true);
  });
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

  it("many concurrent appends get unique, contiguous seqs (lock serializes)", async () => {
    // 30 writers race on the same inbox. Ownership is proven only by mkdir, so
    // even under the steal path no two writers share the critical section →
    // seqs are 1..30 with no gap or duplicate.
    const seqs = await Promise.all(
      Array.from({ length: 30 }, () => appendEvent(999, baseEvent("idle"))),
    );
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    const inbox = await readInbox(host, 999);
    expect(inbox.length).toBe(30);
    expect(new Set(inbox.map((e) => e.seq)).size).toBe(30); // no duplicates
  });

  it("trusts the sidecar seq counter across a GC that shrank the inbox (I2)", async () => {
    // Fill past rotateKeep's minKeep(100), ack most, then GC to a smaller inbox;
    // the counter must keep seq monotonic so the next append is maxSeq+1, NOT
    // max(remaining events)+1.
    for (let i = 0; i < 130; i++) await appendEvent(999, baseEvent("idle"));
    await setCursor(host, 999, 120, "parent");
    await gcInboxes(host, new Set([999]), new Set([999]), 1); // trims acked (<=120)
    const after = await readInbox(host, 999);
    expect(after.length).toBeLessThan(130); // did shrink
    const nextSeq = await appendEvent(999, baseEvent("needs_input"));
    expect(nextSeq).toBe(131); // continues from the counter, no seq reuse
  });

  it("refreshes the lock owner heartbeat while held (I2: a long GC can't be stolen)", async () => {
    const { mkdtemp } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const lockDir = path.join(await mkdtemp(path.join(tmpdir(), "ay-lock-")), "L");
    // staleMs 1500 → beat every max(500, 500) = 500ms.
    const release = await acquireLock(lockDir, 1500);
    const ownerFile = path.join(lockDir, "owner");
    const ts1 = JSON.parse(await readFile(ownerFile, "utf8")).ts as number;
    await new Promise((r) => setTimeout(r, 700)); // past one beat interval
    const ts2 = JSON.parse(await readFile(ownerFile, "utf8")).ts as number;
    expect(ts2).toBeGreaterThan(ts1); // heartbeat advanced → holder stays "fresh"
    await release();
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

  it("concurrent GC and appends never lose an event (read+write both under lock)", async () => {
    // Seed enough to trigger rotation, ack a chunk so GC has something to trim.
    for (let i = 0; i < 40; i++) await appendEvent(999, baseEvent("idle"));
    await setCursor(host, 999, 15, "parent");
    // Fire a GC pass concurrently with a burst of appends. Because GC reads AND
    // writes inside the inbox lock, no append can be clobbered by a stale-snapshot
    // rewrite — every appended seq must survive.
    const appends = Array.from({ length: 20 }, () => appendEvent(999, baseEvent("needs_input")));
    const [seqs] = await Promise.all([
      Promise.all(appends),
      gcInboxes(host, new Set([999]), new Set([999]), 1),
    ]);
    const inbox = await readInbox(host, 999);
    const present = new Set(inbox.map((e) => e.seq));
    for (const s of seqs) expect(present.has(s)).toBe(true); // no append lost
    // Seqs are still unique (no duplication from a racing rewrite).
    expect(inbox.length).toBe(new Set(inbox.map((e) => e.seq)).size);
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
