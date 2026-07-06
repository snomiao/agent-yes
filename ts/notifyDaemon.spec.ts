import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { acquireDaemonLock } from "./notifyDaemon.ts";
import { daemonLockDir, daemonLockOwnerPath } from "./notifyInbox.ts";

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
    await writeFile(daemonLockOwnerPath(), JSON.stringify({ pid: 424242, started_at: 1 }));
    // 424242 reported alive → must NOT steal.
    expect(await acquireDaemonLock((pid) => pid === 424242)).toBe(false);
    const owner = JSON.parse(await readFile(daemonLockOwnerPath(), "utf8"));
    expect(owner.pid).toBe(424242); // untouched
  });

  it("steals a lock with a torn/missing owner file (treated as stale)", async () => {
    await mkdir(daemonLockDir(), { recursive: true });
    await writeFile(daemonLockOwnerPath(), "{ not json");
    expect(await acquireDaemonLock(() => true)).toBe(true);
  });
});
