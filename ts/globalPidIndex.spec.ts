import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir, homedir } from "os";
import path from "path";

// homedir() is what the module derives `~/.agent-yes/pids.jsonl` from.
// Stub it to a fresh tempdir per test so we don't touch the user's real
// global index file.
let testHome: string;

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => testHome,
  };
});

beforeEach(async () => {
  testHome = await mkdtemp(path.join(tmpdir(), "agent-yes-test-"));
  // Reset module cache so the import below picks up the new home.
  vi.resetModules();
});

afterEach(async () => {
  await rm(testHome, { recursive: true, force: true }).catch(() => null);
});

async function loadModule() {
  return await import("./globalPidIndex.ts");
}

describe("globalPidIndex", () => {
  it("appends a record and reads it back with last-line-wins merge", async () => {
    const mod = await loadModule();
    await mod.appendGlobalPid({
      pid: 11111,
      cli: "claude",
      prompt: "hello",
      cwd: "/tmp/x",
      log_file: "/tmp/x/.agent-yes/11111.raw.log",
      fifo_file: "/tmp/x/.agent-yes/fifo/11111.stdin",
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: 1000,
    });

    const records = await mod.readGlobalPids();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      pid: 11111,
      cli: "claude",
      status: "active",
    });
  });

  it("round-trips agent_id and preserves it through a status update", async () => {
    const mod = await loadModule();
    await mod.appendGlobalPid({
      pid: 31313,
      cli: "claude",
      prompt: null,
      cwd: "/a",
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: 1,
      agent_id: "deadbeef0001",
    });
    // updateStatus appends a merged record by pid; agent_id must survive since
    // the patch doesn't include it (last-line-wins merge spreads the prior doc).
    await mod.updateGlobalPidStatus(31313, { status: "idle" });

    const records = await mod.readGlobalPids();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ pid: 31313, status: "idle", agent_id: "deadbeef0001" });
  });

  it("merges multiple appends for the same pid (last write wins)", async () => {
    const mod = await loadModule();
    await mod.appendGlobalPid({
      pid: 22222,
      cli: "codex",
      prompt: null,
      cwd: "/a",
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: 1,
    });
    await mod.updateGlobalPidStatus(22222, {
      status: "exited",
      exit_code: 0,
      exit_reason: "completed",
    });

    const records = await mod.readGlobalPids();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      pid: 22222,
      status: "exited",
      exit_code: 0,
      exit_reason: "completed",
    });
  });

  it("liveOnly filter drops records with status=exited even if pid is alive", async () => {
    const mod = await loadModule();
    // Use this very process's pid — guaranteed alive.
    const livePid = process.pid;
    await mod.appendGlobalPid({
      pid: livePid,
      cli: "claude",
      prompt: null,
      cwd: "/a",
      log_file: null,
      status: "exited",
      exit_code: 0,
      exit_reason: null,
      started_at: 1,
    });
    const live = await mod.readGlobalPids({ liveOnly: true });
    expect(live).toHaveLength(0);
    const all = await mod.readGlobalPids();
    expect(all).toHaveLength(1);
  });

  it("liveOnly filter drops dead pids", async () => {
    const mod = await loadModule();
    // PID 999999 is virtually never live in CI.
    await mod.appendGlobalPid({
      pid: 999999,
      cli: "claude",
      prompt: null,
      cwd: "/a",
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: 1,
    });
    const live = await mod.readGlobalPids({ liveOnly: true });
    expect(live).toHaveLength(0);
  });

  it("getGlobalPidIndexPath returns a stable path under homedir", async () => {
    const mod = await loadModule();
    const p = mod.getGlobalPidIndexPath();
    expect(p).toBe(path.join(testHome, ".agent-yes", "pids.jsonl"));
  });

  it("readGlobalPids returns [] when the file does not exist", async () => {
    const mod = await loadModule();
    const records = await mod.readGlobalPids();
    expect(records).toEqual([]);
  });

  it("updateGlobalPidStatus can set and clear title", async () => {
    const mod = await loadModule();
    await mod.appendGlobalPid({
      pid: 4242,
      cli: "claude",
      prompt: null,
      cwd: "/repo",
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
    });
    await mod.updateGlobalPidStatus(4242, { title: "✳ fixing tests" });
    let rec = (await mod.readGlobalPids()).find((r: any) => r.pid === 4242);
    expect(rec?.title).toBe("✳ fixing tests");
    await mod.updateGlobalPidStatus(4242, { title: null });
    rec = (await mod.readGlobalPids()).find((r: any) => r.pid === 4242);
    expect(rec?.title).toBeNull();
  });

  it("updateGlobalPidStatus is a no-op for unknown pids", async () => {
    const mod = await loadModule();
    await mod.updateGlobalPidStatus(7777, { status: "exited" });
    const records = await mod.readGlobalPids();
    expect(records).toEqual([]);
  });

  it("maybeCompactGlobalPids no-ops when below threshold", async () => {
    const mod = await loadModule();
    await mod.appendGlobalPid({
      pid: 1234,
      cli: "claude",
      prompt: null,
      cwd: "/a",
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: 1,
    });
    const before = (await import("fs/promises")).readFile;
    const beforeContent = await before(mod.getGlobalPidIndexPath(), "utf-8");
    await mod.maybeCompactGlobalPids();
    const afterContent = await before(mod.getGlobalPidIndexPath(), "utf-8");
    expect(afterContent).toBe(beforeContent);
  });

  it("maybeCompactGlobalPids collapses event spam to one line per pid", async () => {
    const mod = await loadModule();
    // Emit > 500 status events across two pids (one alive, one will be exited+dead)
    for (let i = 0; i < 260; i++) {
      await mod.appendGlobalPid({
        pid: process.pid,
        cli: "claude",
        prompt: null,
        cwd: "/a",
        log_file: null,
        status: "active",
        exit_code: null,
        exit_reason: null,
        started_at: 1,
      });
      await mod.appendGlobalPid({
        pid: 999999, // dead
        cli: "codex",
        prompt: null,
        cwd: "/b",
        log_file: null,
        status: "exited",
        exit_code: 0,
        exit_reason: "done",
        started_at: 1,
      });
    }
    const fs = await import("fs/promises");
    const before = (await fs.readFile(mod.getGlobalPidIndexPath(), "utf-8")).split("\n").length;
    await mod.maybeCompactGlobalPids();
    const after = (await fs.readFile(mod.getGlobalPidIndexPath(), "utf-8")).split("\n").length;
    // Compaction must have shrunk the file dramatically and dropped the
    // dead-and-exited pid 999999 entirely.
    expect(after).toBeLessThan(before / 10);
    const records = await mod.readGlobalPids();
    expect(records.map((r) => r.pid)).toEqual([process.pid]);
  });

  it("maybeCompactGlobalPids on missing file is a noop", async () => {
    const mod = await loadModule();
    await mod.maybeCompactGlobalPids(); // no throw, no error
  });

  it("updateGlobalPidStatus can repoint log_file (raw -> rendered)", async () => {
    const mod = await loadModule();
    await mod.appendGlobalPid({
      pid: 4242,
      cli: "claude",
      prompt: null,
      cwd: "/a",
      log_file: "/a/.agent-yes/4242.raw.log",
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: 1,
    });
    await mod.updateGlobalPidStatus(4242, { log_file: "/a/.agent-yes/4242.log" });
    const records = await mod.readGlobalPids();
    expect(records[0]?.log_file).toBe("/a/.agent-yes/4242.log");
  });

  describe("pruneOldLogs", () => {
    it("deletes log siblings of old, dead sessions but keeps live/recent ones", async () => {
      const mod = await loadModule();
      const { mkdir, writeFile } = await import("fs/promises");
      const { existsSync } = await import("fs");
      const dir = path.join(testHome, "logs");
      await mkdir(dir, { recursive: true });

      // Old + dead pid: should be pruned (raw + rendered + sidecars).
      const deadRaw = path.join(dir, "999999.raw.log");
      const deadRendered = path.join(dir, "999999.log");
      const deadLines = path.join(dir, "999999.lines.log");
      for (const f of [deadRaw, deadRendered, deadLines]) await writeFile(f, "x");

      // Live pid (this process), old timestamp: must be kept (still running).
      const liveRaw = path.join(dir, `${process.pid}.raw.log`);
      await writeFile(liveRaw, "x");

      // Dead pid but recent: must be kept (inside retention window).
      const recentRaw = path.join(dir, "999998.raw.log");
      await writeFile(recentRaw, "x");

      const oldTs = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
      await mod.appendGlobalPid({
        pid: 999999,
        cli: "claude",
        prompt: null,
        cwd: "/a",
        log_file: deadRaw,
        status: "exited",
        exit_code: 0,
        exit_reason: null,
        started_at: oldTs,
      });
      await mod.appendGlobalPid({
        pid: process.pid,
        cli: "claude",
        prompt: null,
        cwd: "/a",
        log_file: liveRaw,
        status: "active",
        exit_code: null,
        exit_reason: null,
        started_at: oldTs,
      });
      await mod.appendGlobalPid({
        pid: 999998,
        cli: "claude",
        prompt: null,
        cwd: "/a",
        log_file: recentRaw,
        status: "exited",
        exit_code: 0,
        exit_reason: null,
        started_at: Date.now(),
      });

      const removed = await mod.pruneOldLogs();

      expect(removed).toBe(3); // deadRaw + deadRendered + deadLines
      expect(existsSync(deadRaw)).toBe(false);
      expect(existsSync(deadRendered)).toBe(false);
      expect(existsSync(deadLines)).toBe(false);
      expect(existsSync(liveRaw)).toBe(true);
      expect(existsSync(recentRaw)).toBe(true);
    });

    it("returns 0 and does not throw when the index is empty", async () => {
      const mod = await loadModule();
      expect(await mod.pruneOldLogs()).toBe(0);
    });

    it("skips records with no log_file and honors an explicit maxAge", async () => {
      const mod = await loadModule();
      await mod.appendGlobalPid({
        pid: 999999,
        cli: "claude",
        prompt: null,
        cwd: "/a",
        log_file: null,
        status: "exited",
        exit_code: 0,
        exit_reason: null,
        started_at: 1,
      });
      // Old + dead but no log_file to delete → nothing removed, no throw.
      expect(await mod.pruneOldLogs(1)).toBe(0);
    });

    it("respects $AGENT_YES_LOG_RETENTION_DAYS for the default window", async () => {
      const mod = await loadModule();
      const { mkdir, writeFile } = await import("fs/promises");
      const { existsSync } = await import("fs");
      const dir = path.join(testHome, "logs");
      await mkdir(dir, { recursive: true });
      const raw = path.join(dir, "999999.raw.log");
      await writeFile(raw, "x");
      const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
      await mod.appendGlobalPid({
        pid: 999999,
        cli: "claude",
        prompt: null,
        cwd: "/a",
        log_file: raw,
        status: "exited",
        exit_code: 0,
        exit_reason: null,
        started_at: twoDaysAgo,
      });

      const original = process.env.AGENT_YES_LOG_RETENTION_DAYS;
      try {
        process.env.AGENT_YES_LOG_RETENTION_DAYS = "1"; // 1-day window → 2-day-old log is stale
        expect(await mod.pruneOldLogs()).toBe(1);
        expect(existsSync(raw)).toBe(false);
      } finally {
        if (original === undefined) delete process.env.AGENT_YES_LOG_RETENTION_DAYS;
        else process.env.AGENT_YES_LOG_RETENTION_DAYS = original;
      }
    });
  });

  describe("sweepOrphanLogs", () => {
    const DAY = 24 * 60 * 60 * 1000;

    // The sweep always includes the caller's own cwd. Pin it inside the temp
    // home so the suite can never reach the real repo's `.agent-yes/`.
    beforeEach(() => {
      vi.spyOn(process, "cwd").mockReturnValue(testHome);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Backdate a file so it falls outside the retention window. */
    async function backdate(file: string, ageMs: number) {
      const { utimes } = await import("fs/promises");
      const when = new Date(Date.now() - ageMs);
      await utimes(file, when, when);
    }

    it("reclaims a dead pid's logs that no index record points at", async () => {
      const mod = await loadModule();
      const { mkdir, writeFile } = await import("fs/promises");
      const { existsSync } = await import("fs");

      // A project dir the index reaches only via a *sibling* record — the
      // orphan's own record was already compacted away.
      const projectCwd = path.join(testHome, "proj");
      const dir = path.join(projectCwd, ".agent-yes");
      await mkdir(dir, { recursive: true });

      const orphanRaw = path.join(dir, "999999.raw.log");
      const orphanDebug = path.join(dir, "999999.debug.log");
      for (const f of [orphanRaw, orphanDebug]) {
        await writeFile(f, "0123456789"); // 10 bytes each
        await backdate(f, 30 * DAY);
      }

      // The only record in the index belongs to a different, live session.
      const liveRaw = path.join(dir, `${process.pid}.raw.log`);
      await writeFile(liveRaw, "x");
      await backdate(liveRaw, 30 * DAY);
      await mod.appendGlobalPid({
        pid: process.pid,
        cli: "claude",
        prompt: null,
        cwd: projectCwd,
        log_file: liveRaw,
        status: "active",
        exit_code: null,
        exit_reason: null,
        started_at: Date.now(),
      });

      const res = await mod.sweepOrphanLogs();

      expect(res.removed.sort()).toEqual([orphanDebug, orphanRaw].sort());
      expect(res.freedBytes).toBe(20);
      expect(existsSync(orphanRaw)).toBe(false);
      expect(existsSync(orphanDebug)).toBe(false);
      expect(existsSync(liveRaw)).toBe(true); // pid still running
    });

    it("keeps logs inside the retention window and non-log files", async () => {
      const mod = await loadModule();
      const { mkdir, writeFile } = await import("fs/promises");
      const { existsSync } = await import("fs");

      const projectCwd = path.join(testHome, "proj");
      const dir = path.join(projectCwd, ".agent-yes");
      await mkdir(dir, { recursive: true });

      const recent = path.join(dir, "999998.raw.log"); // dead pid, but fresh
      await writeFile(recent, "x");

      // Runtime state that shares the dir and must never be swept.
      const inbox = path.join(dir, "inbox.jsonl");
      const sqlite = path.join(dir, "pid.sqlite");
      const records = path.join(dir, "pid-records.jsonl");
      for (const f of [inbox, sqlite, records]) {
        await writeFile(f, "x");
        await backdate(f, 30 * DAY);
      }

      await mod.appendGlobalPid({
        pid: 999998,
        cli: "claude",
        prompt: null,
        cwd: projectCwd,
        log_file: recent,
        status: "exited",
        exit_code: 0,
        exit_reason: null,
        started_at: Date.now(),
      });

      const res = await mod.sweepOrphanLogs();

      expect(res.removed).toEqual([]);
      for (const f of [recent, inbox, sqlite, records]) expect(existsSync(f)).toBe(true);
    });

    it("does not throw when the index is empty and the cwd has no .agent-yes", async () => {
      const mod = await loadModule();
      const res = await mod.sweepOrphanLogs();
      expect(res.removed).toEqual([]);
      expect(res.freedBytes).toBe(0);
    });
  });

  describe("gcLogs", () => {
    beforeEach(() => {
      vi.spyOn(process, "cwd").mockReturnValue(testHome);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("counts a file once when both passes would claim it", async () => {
      const mod = await loadModule();
      const { mkdir, writeFile, utimes } = await import("fs/promises");
      const { existsSync } = await import("fs");

      const projectCwd = path.join(testHome, "proj");
      const dir = path.join(projectCwd, ".agent-yes");
      await mkdir(dir, { recursive: true });

      // Dead + old in BOTH senses: the index still has its record (so the
      // retention pass claims it) and its mtime is stale (so the sweep would
      // too). It must be reported exactly once.
      const raw = path.join(dir, "999999.raw.log");
      await writeFile(raw, "01234"); // 5 bytes
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await utimes(raw, old, old);
      await mod.appendGlobalPid({
        pid: 999999,
        cli: "claude",
        prompt: null,
        cwd: projectCwd,
        log_file: raw,
        status: "exited",
        exit_code: 0,
        exit_reason: null,
        started_at: old.getTime(),
      });

      const res = await mod.gcLogs();

      expect(res.removed).toEqual([raw]);
      expect(res.freedBytes).toBe(5);
      expect(existsSync(raw)).toBe(false);
    });
  });

  it("skips corrupt lines without throwing", async () => {
    const mod = await loadModule();
    await mod.appendGlobalPid({
      pid: 5555,
      cli: "claude",
      prompt: null,
      cwd: "/a",
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: 1,
    });
    // Inject a corrupt line directly.
    const { appendFile } = await import("fs/promises");
    await appendFile(mod.getGlobalPidIndexPath(), "not-json-at-all\n");

    const records = await mod.readGlobalPids();
    expect(records).toHaveLength(1);
    expect(records[0]?.pid).toBe(5555);
  });
});
