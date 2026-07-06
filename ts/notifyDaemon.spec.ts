import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  acquireDaemonLock,
  daemonStatus,
  reconcileFromInboxes,
  requestDaemonStop,
} from "./notifyDaemon.ts";
import { stat } from "fs/promises";
import { daemonLockDir, daemonLockOwnerPath } from "./notifyInbox.ts";
import { appendEvent, hostId } from "./notifyStore.ts";
import type { NotifyEvent } from "./notifyInbox.ts";

// The lock steal/keep race codex flagged: a crashed daemon's stale lock must be
// stealable (else runDaemon deadlocks forever), while a LIVE owner's lock must
// be respected (else two daemons run). Liveness is injected so both branches are
// deterministic.
describe("notifyd singleton lock", () => {
  let home: string;
  const prev = process.env.AGENT_YES_HOME;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "ay-notify-lock-"));
    process.env.AGENT_YES_HOME = home;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = prev;
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  it("acquires the lock on a clean install (parent dir absent, no ENOENT trap)", async () => {
    // notify/ does not exist yet — the classic clean-install bug was mkdir(lock)
    // throwing ENOENT and being misread as "held". Must acquire cleanly.
    expect(await acquireDaemonLock(() => false)).toBe(true);
    const owner = JSON.parse(await readFile(daemonLockOwnerPath(), "utf8"));
    expect(owner.pid).toBe(process.pid);
  });

  it("steals a stale lock whose owner is dead (no permanent deadlock)", async () => {
    await mkdir(daemonLockDir(), { recursive: true });
    await writeFile(
      daemonLockOwnerPath(),
      JSON.stringify({ pid: 424242, started_at: 1, ts: Date.now() }),
    );
    // 424242 reported dead → steal (dead pid, no wait needed).
    expect(await acquireDaemonLock(() => false)).toBe(true);
    const owner = JSON.parse(await readFile(daemonLockOwnerPath(), "utf8"));
    expect(owner.pid).toBe(process.pid);
  });

  it("refuses the lock when a LIVE owner holds it (no double daemon)", async () => {
    await mkdir(daemonLockDir(), { recursive: true });
    // A complete, live, fresh owner (a real daemon always heartbeats its ts).
    await writeFile(
      daemonLockOwnerPath(),
      JSON.stringify({ pid: 424242, started_at: 1, ts: Date.now() }),
    );
    expect(await acquireDaemonLock((pid) => pid === 424242)).toBe(false);
    const owner = JSON.parse(await readFile(daemonLockOwnerPath(), "utf8"));
    expect(owner.pid).toBe(424242); // untouched
  });

  it("steals a live-but-STALE owner (heartbeat not refreshed → wedged/gone)", async () => {
    await mkdir(daemonLockDir(), { recursive: true });
    await writeFile(
      daemonLockOwnerPath(),
      JSON.stringify({ pid: 424242, started_at: 1, ts: 1 }), // ancient ts
    );
    expect(await acquireDaemonLock((pid) => pid === 424242)).toBe(true);
  });

  it("eventually steals a torn owner, but only AFTER the grace (no double daemon)", async () => {
    // A torn owner is also the mkdir→writeOwner window of a concurrent daemon
    // start, so it is respected within the grace (~1s) and stolen only past it —
    // the same invariant as the per-inbox lock (the steal decision itself is
    // unit-tested via shouldStealLock in notifyStore.spec).
    await mkdir(daemonLockDir(), { recursive: true });
    await writeFile(daemonLockOwnerPath(), "{ not json");
    const t0 = Date.now();
    expect(await acquireDaemonLock(() => true)).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900); // waited out the grace
  });

  it("a second live-owner acquire from a DIFFERENT pid is refused", async () => {
    // First acquire writes owner = our pid. A second caller that sees a different
    // live owner must back off (mkdir(recursive:false) is the exclusive proof;
    // the owner is alive so it isn't stolen).
    expect(await acquireDaemonLock(() => true)).toBe(true);
    const owner = JSON.parse(await readFile(daemonLockOwnerPath(), "utf8"));
    // Rewrite the owner to a DIFFERENT, "alive" pid to simulate another daemon.
    await writeFile(
      daemonLockOwnerPath(),
      JSON.stringify({ ...owner, pid: owner.pid + 1 }),
    );
    expect(await acquireDaemonLock((pid) => pid === owner.pid + 1)).toBe(false);
  });
});

describe("notifyd identity (status/stop safety)", () => {
  let home: string;
  const prev = process.env.AGENT_YES_HOME;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "ay-notify-id-"));
    process.env.AGENT_YES_HOME = home;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = prev;
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  it("trusts a live owner with a fresh heartbeat", async () => {
    await mkdir(daemonLockDir(), { recursive: true });
    await writeFile(
      daemonLockOwnerPath(),
      JSON.stringify({ pid: process.pid, started_at: 1, ts: Date.now() }),
    );
    expect(await daemonStatus()).toBe(process.pid);
  });

  it("returns null for a STALE heartbeat even if the pid is alive (pid-reuse guard)", async () => {
    // process.pid is alive, but its owner ts is ancient — a recycled pid that
    // isn't refreshing THIS file must not be trusted or killed.
    await mkdir(daemonLockDir(), { recursive: true });
    await writeFile(
      daemonLockOwnerPath(),
      JSON.stringify({ pid: process.pid, started_at: 1, ts: 1 }),
    );
    expect(await daemonStatus()).toBeNull();
  });

  it("returns null when no owner file exists", async () => {
    expect(await daemonStatus()).toBeNull();
  });

  it("returns null for an INCOMPLETE owner missing started_at (I1)", async () => {
    await mkdir(daemonLockDir(), { recursive: true });
    // pid alive + fresh ts, but no started_at → identity incomplete, not trusted.
    await writeFile(
      daemonLockOwnerPath(),
      JSON.stringify({ pid: process.pid, ts: Date.now() }),
    );
    expect(await daemonStatus()).toBeNull();
  });

  it("requestDaemonStop removes the lock (cooperative) for a valid owner", async () => {
    await mkdir(daemonLockDir(), { recursive: true });
    await writeFile(
      daemonLockOwnerPath(),
      JSON.stringify({ pid: process.pid, started_at: 1, ts: Date.now(), token: "T" }),
    );
    expect(await requestDaemonStop()).toBe(process.pid);
    await expect(stat(daemonLockDir())).rejects.toThrow(); // lock removed
  });

  it("requestDaemonStop refuses an owner with no fencing token (can't confirm identity)", async () => {
    await mkdir(daemonLockDir(), { recursive: true });
    await writeFile(
      daemonLockOwnerPath(),
      JSON.stringify({ pid: process.pid, started_at: 1, ts: Date.now() }), // no token
    );
    expect(await requestDaemonStop()).toBeNull();
    await expect(stat(daemonLockDir())).resolves.toBeTruthy(); // lock untouched
  });
});

describe("startup reconcile pid-reuse guard", () => {
  let home: string;
  const prev = process.env.AGENT_YES_HOME;
  const host = hostId();
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "ay-notify-rec-"));
    process.env.AGENT_YES_HOME = home;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = prev;
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  const exitedEv = (childPid: number, childStartedAt: number): Omit<NotifyEvent, "seq"> => ({
    ts: 1,
    host,
    parent_pid: 1,
    child_pid: childPid,
    child_started_at: childStartedAt,
    cli: "claude",
    cwd: "/repo",
    edge: "exited",
    prev_state: "active",
    state: "stopped",
    question: null,
  });

  it("seeds a child still live with the SAME start time (no re-emit) + copies identity", async () => {
    await appendEvent(1, { ...exitedEv(555, 1000), parent_started_at: 42 });
    const seeded = await reconcileFromInboxes(host, new Map([[555, 1000]]), new Set([1]));
    expect(seeded.get(555)?.exitedEmitted).toBe(true);
    // I2: identity copied into the seeded state so the hot-path guard can fire.
    expect(seeded.get(555)?.started_at).toBe(1000);
    expect(seeded.get(555)?.parent_started_at).toBe(42);
  });

  it("does NOT seed the idle emitted flag — a restart RE-CONFIRMS idle (never suppress)", async () => {
    const idleEv: Omit<NotifyEvent, "seq"> = {
      ts: 1,
      host,
      parent_pid: 1,
      child_pid: 555,
      child_started_at: 1000,
      cli: "claude",
      cwd: "/repo",
      edge: "idle",
      prev_state: "active",
      state: "idle",
      question: null,
    };
    await appendEvent(1, idleEv);
    const cs = (await reconcileFromInboxes(host, new Map([[555, 1000]]), new Set([1]))).get(555)!;
    // Identity is seeded (hot-path guard), but the idle episode is NOT marked
    // emitted → the post-restart idle observation re-confirms and re-emits.
    expect(cs.started_at).toBe(1000);
    expect(cs.idleEmitted).toBe(false);
    expect(cs.idleSince).toBeNull();
  });

  it("does NOT seed a pid whose live start time differs (reused pid emits fresh)", async () => {
    await appendEvent(1, exitedEv(555, 1000));
    // pid 555 now belongs to a NEW child (started_at 2000) → must not inherit
    // the old child's exitedEmitted, else its own exit would be suppressed.
    const seeded = await reconcileFromInboxes(host, new Map([[555, 2000]]), new Set([1]));
    expect(seeded.has(555)).toBe(false);
  });

  it("does NOT seed a reaped child absent from the registry", async () => {
    await appendEvent(1, exitedEv(555, 1000));
    const seeded = await reconcileFromInboxes(host, new Map(), new Set([1]));
    expect(seeded.has(555)).toBe(false);
  });

  it("does NOT seed an event with no child_started_at (C2: can't verify → re-emit)", async () => {
    // A pre-C2 / synthetic event without a start time can't be identity-checked,
    // so it must not seed (better a duplicate edge than a suppressed one).
    await appendEvent(1, { ...exitedEv(555, 1000), child_started_at: 0 });
    const seeded = await reconcileFromInboxes(host, new Map([[555, 1000]]), new Set([1]));
    expect(seeded.has(555)).toBe(false);
  });

  it("does NOT seed an inbox whose parent is NOT currently watched (I1)", async () => {
    // Parent 1's inbox exists, but no one is watching parent 1 now → the daemon
    // must not hold its state (else it could later write a synthetic exited into
    // an unwatched inbox, violating "nothing happens unless you watch").
    await appendEvent(1, exitedEv(555, 1000));
    const seeded = await reconcileFromInboxes(host, new Map([[555, 1000]]), new Set()); // none watched
    expect(seeded.size).toBe(0);
  });
});
