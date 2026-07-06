import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { acquireDaemonLock, daemonStatus, reconcileFromInboxes } from "./notifyDaemon.ts";
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
    await writeFile(daemonLockOwnerPath(), JSON.stringify({ pid: 424242, started_at: 1 }));
    // 424242 reported dead → steal.
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

  it("steals a lock with a torn/missing owner file (treated as stale)", async () => {
    await mkdir(daemonLockDir(), { recursive: true });
    await writeFile(daemonLockOwnerPath(), "{ not json");
    expect(await acquireDaemonLock(() => true)).toBe(true);
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

  it("seeds a child still live with the SAME start time (no re-emit)", async () => {
    await appendEvent(1, exitedEv(555, 1000));
    const seeded = await reconcileFromInboxes(host, new Map([[555, 1000]]));
    expect(seeded.get(555)?.exitedEmitted).toBe(true);
  });

  it("does NOT seed a pid whose live start time differs (reused pid emits fresh)", async () => {
    await appendEvent(1, exitedEv(555, 1000));
    // pid 555 now belongs to a NEW child (started_at 2000) → must not inherit
    // the old child's exitedEmitted, else its own exit would be suppressed.
    const seeded = await reconcileFromInboxes(host, new Map([[555, 2000]]));
    expect(seeded.has(555)).toBe(false);
  });

  it("does NOT seed a reaped child absent from the registry", async () => {
    await appendEvent(1, exitedEv(555, 1000));
    const seeded = await reconcileFromInboxes(host, new Map());
    expect(seeded.has(555)).toBe(false);
  });

  it("does NOT seed an event with no child_started_at (C2: can't verify → re-emit)", async () => {
    // A pre-C2 / synthetic event without a start time can't be identity-checked,
    // so it must not seed (better a duplicate edge than a suppressed one).
    await appendEvent(1, { ...exitedEv(555, 1000), child_started_at: 0 });
    const seeded = await reconcileFromInboxes(host, new Map([[555, 1000]]));
    expect(seeded.has(555)).toBe(false);
  });
});
