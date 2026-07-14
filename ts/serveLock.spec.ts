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
    // A freshly-exited child pid is reliably dead. Spawn the current runtime
    // (bun or node — both take -e) so this also runs on Windows, via
    // node:child_process (not Bun.spawn) for the node vitest matrix.
    const { spawnSync } = await import("node:child_process");
    const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid!;

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

// Coverage for the held-lock lifecycle: heartbeat refresh, thief detection,
// live-owner takeover, and the bounded grace wait.
describe("acquireWebrtcHostLock — held-lock lifecycle", () => {
  let home: string;
  let savedHome: string | undefined;
  const releases: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "ay-serve-lock2-"));
    savedHome = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = home;
  });

  afterEach(async () => {
    for (const r of releases.splice(0)) await r().catch(() => {});
    if (savedHome === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = savedHome;
    await rm(home, { recursive: true, force: true });
  });

  const ownerFile = () => path.join(home, "webrtc-host.lock", "owner.json");
  const readOwnerFile = async () => JSON.parse(await readFile(ownerFile(), "utf-8")) as ServeLockOwner;

  it("heartbeats refresh beat_at while held", async () => {
    const got = await acquireWebrtcHostLock({ graceMs: 0, beatMs: 40 });
    expect(got.ok).toBe(true);
    if (got.ok) releases.push(got.release);
    const before = (await readOwnerFile()).beat_at;
    await new Promise((r) => setTimeout(r, 150));
    const after = (await readOwnerFile()).beat_at;
    expect(after).toBeGreaterThan(before);
  });

  it("heartbeat stops itself once a thief owns the file (never clobbers the thief)", async () => {
    const got = await acquireWebrtcHostLock({ graceMs: 0, beatMs: 40 });
    expect(got.ok).toBe(true);
    if (got.ok) releases.push(got.release);
    const { writeFile: wf } = await import("fs/promises");
    const thief: ServeLockOwner = { pid: process.pid + 1, started_at: Date.now(), beat_at: 42 };
    await wf(ownerFile(), JSON.stringify(thief));
    await new Promise((r) => setTimeout(r, 150));
    expect((await readOwnerFile()).pid).toBe(thief.pid); // our beat backed off
    expect((await readOwnerFile()).beat_at).toBe(42);
  });

  it("takeover stops a live owner and takes the room", async () => {
    const { spawn } = await import("node:child_process");
    // Long-lived victim via the current runtime — /bin/sh doesn't exist on win32.
    const victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    const victimPid = victim.pid!;
    const { mkdir: mkd, writeFile: wf } = await import("fs/promises");
    await mkd(path.join(home, "webrtc-host.lock"), { recursive: true });
    await wf(
      ownerFile(),
      JSON.stringify({ pid: victimPid, started_at: Date.now(), beat_at: Date.now() }),
    );

    const got = await acquireWebrtcHostLock({ takeover: true, graceMs: 0, takeoverWaitMs: 100 });
    expect(got.ok).toBe(true);
    if (got.ok) releases.push(got.release);
    expect((await readOwnerFile()).pid).toBe(process.pid);
    // The victim was killed (SIGTERM or the escalation SIGKILL).
    await new Promise((r) => setTimeout(r, 100));
    expect(victim.exitCode !== null || victim.signalCode !== null).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "escalates to SIGKILL when the owner ignores SIGTERM",
    async () => {
    const { spawn } = await import("node:child_process");
    const stubborn = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 30"], { stdio: "ignore" });
    const pid = stubborn.pid!;
    await new Promise((r) => setTimeout(r, 100)); // let the trap install
    const { mkdir: mkd, writeFile: wf } = await import("fs/promises");
    await mkd(path.join(home, "webrtc-host.lock"), { recursive: true });
    await wf(ownerFile(), JSON.stringify({ pid, started_at: Date.now(), beat_at: Date.now() }));

    const got = await acquireWebrtcHostLock({ takeover: true, graceMs: 0, takeoverWaitMs: 200 });
    expect(got.ok).toBe(true);
    if (got.ok) releases.push(got.release);
    await new Promise((r) => setTimeout(r, 100));
    expect(stubborn.signalCode).toBe("SIGKILL");
    },
  );

  it("waits out the grace window against a live owner, then reports it", async () => {
    const holder = await acquireWebrtcHostLock({ graceMs: 0 });
    expect(holder.ok).toBe(true);
    if (holder.ok) releases.push(holder.release);
    const t0 = Date.now();
    const got = await acquireWebrtcHostLock({ graceMs: 300 });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.owner?.pid).toBe(process.pid);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250); // actually waited a beat
  });
});
