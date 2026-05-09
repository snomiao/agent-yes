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
