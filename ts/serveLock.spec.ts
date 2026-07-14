import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireWebrtcHostLock,
  isOwnerStale,
  SERVE_LOCK_STALE_MS,
  type ServeLockOwner,
} from "./serveLock.ts";

// Guards the single-WebRTC-host invariant: two `ay serve --webrtc` in one home
// fight over the persisted room (live outage: orphan host + crash-looping
// managed daemon + unloadable share link). The loser must fail FAST with the
// owner's identity, and a dead/stale owner must never wedge the next start.
describe("acquireWebrtcHostLock", () => {
  let home: string;
  let savedHome: string | undefined;
  const releases: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "ay-serve-lock-"));
    savedHome = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = home;
  });

  afterEach(async () => {
    for (const r of releases.splice(0)) await r().catch(() => {});
    if (savedHome === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = savedHome;
    await rm(home, { recursive: true, force: true });
  });

  it("acquires, stamps an owner, and a second acquire fails fast with that owner", async () => {
    const first = await acquireWebrtcHostLock({ graceMs: 0 });
    expect(first.ok).toBe(true);
    if (first.ok) releases.push(first.release);

    const owner = JSON.parse(
      await readFile(path.join(home, "webrtc-host.lock", "owner.json"), "utf-8"),
    ) as ServeLockOwner;
    expect(owner.pid).toBe(process.pid);

    const second = await acquireWebrtcHostLock({ graceMs: 0 });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.owner?.pid).toBe(process.pid);
  });

  it("release frees the lock for the next acquire", async () => {
    const first = await acquireWebrtcHostLock({ graceMs: 0 });
    expect(first.ok).toBe(true);
    if (first.ok) await first.release();

    const second = await acquireWebrtcHostLock({ graceMs: 0 });
    expect(second.ok).toBe(true);
    if (second.ok) releases.push(second.release);
  });

  it("steals a stale lock whose heartbeat went quiet (SIGKILLed host)", async () => {
    // Forge an owner: alive pid but ancient beat — a host whose interval died.
    const lockDir = path.join(home, "webrtc-host.lock");
    const { mkdir, writeFile } = await import("fs/promises");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        started_at: Date.now() - 60_000,
        beat_at: Date.now() - SERVE_LOCK_STALE_MS - 1_000,
      }),
    );
    const got = await acquireWebrtcHostLock({ graceMs: 0 });
    expect(got.ok).toBe(true);
    if (got.ok) releases.push(got.release);
  });

  it("steals a lock whose owner pid is dead", async () => {
    // A freshly-exited child pid is reliably dead. node:child_process (not
    // Bun.spawn) — these specs also run under the node vitest matrix.
    const { spawnSync } = await import("node:child_process");
    const deadPid = spawnSync("/bin/sh", ["-c", "exit 0"]).pid!;

    const lockDir = path.join(home, "webrtc-host.lock");
    const { mkdir, writeFile } = await import("fs/promises");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: deadPid, started_at: Date.now(), beat_at: Date.now() }),
    );
    const got = await acquireWebrtcHostLock({ graceMs: 0 });
    expect(got.ok).toBe(true);
    if (got.ok) releases.push(got.release);
  });
});

describe("isOwnerStale", () => {
  const now = 1_000_000;
  const owner = (beatAgo: number): ServeLockOwner => ({
    pid: 4242,
    started_at: now - 60_000,
    beat_at: now - beatAgo,
  });

  it("absent/torn owner is stale (mkdir won but the write died)", () => {
    expect(isOwnerStale(null, now, () => true)).toBe(true);
  });

  it("dead pid is stale regardless of heartbeat", () => {
    expect(isOwnerStale(owner(0), now, () => false)).toBe(true);
  });

  it("live pid with a fresh beat is NOT stale", () => {
    expect(isOwnerStale(owner(SERVE_LOCK_STALE_MS - 1), now, () => true)).toBe(false);
  });

  it("live pid with a quiet heartbeat past the window is stale", () => {
    expect(isOwnerStale(owner(SERVE_LOCK_STALE_MS + 1), now, () => true)).toBe(true);
  });
});
