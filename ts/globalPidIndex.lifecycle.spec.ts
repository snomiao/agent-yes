import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  appendGlobalPid,
  gcLogs,
  getGlobalPidIndexPath,
  maybeCompactGlobalPids,
  pruneOldLogs,
  readGlobalPids,
  sweepOrphanLogs,
  updateGlobalPidStatus,
  type GlobalPidRecord,
} from "./globalPidIndex.ts";
let home: string;
let cwd: string;
const record = (over: Partial<GlobalPidRecord> = {}): GlobalPidRecord => ({
  pid: 1111,
  cli: "claude",
  prompt: null,
  cwd: "",
  log_file: null,
  status: "exited",
  started_at: 1,
  exit_code: 0,
  exit_reason: "normal",
  ...over,
});
beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "registry-lifecycle-")));
  vi.stubEnv("AGENT_YES_HOME", home);
  cwd = process.cwd();
  process.chdir(home);
});
afterEach(async () => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
const index = (rows: unknown[]) =>
  writeFile(getGlobalPidIndexPath(), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

describe("parent registry lifecycle and retention", () => {
  it("skips malformed identities without discarding valid lifecycle records", async () => {
    await index([{ pid: "1111" }, record()]);
    expect(await readGlobalPids()).toEqual([record()]);
  });

  it("survives a missing index during compaction and reclaims an empty exited index", async () => {
    await expect(maybeCompactGlobalPids()).resolves.toBeUndefined();
    await index(Array.from({ length: 500 }, () => record()));
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("gone");
    });
    await maybeCompactGlobalPids();
    expect(await readFile(getGlobalPidIndexPath(), "utf8")).toBe("");
  });

  it("fails reads visibly but keeps best-effort mutations and cleanup nonfatal", async () => {
    await mkdir(getGlobalPidIndexPath());
    await expect(readGlobalPids()).rejects.toThrow();
    await expect(appendGlobalPid(record())).resolves.toBeUndefined();
    await expect(updateGlobalPidStatus(1111, { status: "idle" })).resolves.toBeUndefined();
    await expect(maybeCompactGlobalPids()).resolves.toBeUndefined();
    await expect(pruneOldLogs()).resolves.toBe(0);
    await expect(sweepOrphanLogs()).resolves.toEqual({ removed: [], freedBytes: 0 });
  });

  it("keeps legacy records with no timestamp or log path during retention", async () => {
    await index([{ ...record(), started_at: undefined }, record({ pid: 2222 })]);
    expect(await pruneOldLogs(1)).toBe(0);
  });

  it("uses configured retention and defaults invalid values without deleting recent logs", async () => {
    const log = path.join(home, "1111.raw.log");
    await writeFile(log, "old output");
    await index([record({ log_file: log, started_at: Date.now() - 2 * 86400000 })]);
    vi.stubEnv("AGENT_YES_LOG_RETENTION_DAYS", "invalid");
    expect(await pruneOldLogs()).toBe(0);
    vi.stubEnv("AGENT_YES_LOG_RETENTION_DAYS", "1");
    expect(await gcLogs()).toEqual({ removed: [log], freedBytes: 10 });
    expect(await readFile(log, "utf8").catch(() => null)).toBeNull();
  });

  it("sweeps old orphan files but keeps live, recent, invalid, and unrelated entries", async () => {
    const dir = path.join(home, ".agent-yes");
    await mkdir(dir);
    const old = path.join(dir, "1111.raw.log");
    await writeFile(old, "orphan");
    await utimes(old, new Date(1), new Date(1));
    for (const name of ["0.log", "2222.log", "3333.log", "notes.txt"]) {
      await writeFile(path.join(dir, name), "keep");
    }
    await utimes(path.join(dir, "2222.log"), new Date(1), new Date(1));
    await mkdir(path.join(dir, "4444.log"));
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 2222) return true;
      throw new Error("gone");
    });
    await index([record({ pid: 5555, log_file: null, cwd: "" })]);
    expect(await sweepOrphanLogs(10000)).toEqual({ removed: [old], freedBytes: 6 });
    expect(await readFile(path.join(dir, "3333.log"), "utf8")).toBe("keep");
    expect(await gcLogs(10000)).toEqual({ removed: [], freedBytes: 0 });
  });
});
