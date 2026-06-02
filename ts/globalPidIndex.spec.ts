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
