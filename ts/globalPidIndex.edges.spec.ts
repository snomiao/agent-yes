import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import path from "path";
import { tmpdir } from "os";
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

describe("registry recovery and orphan log retention", () => {
  let root: string;
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
    exit_reason: null,
    ...over,
  });
  beforeEach(async () => {
    cwd = process.cwd();
    root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ay-index-edges-")));
    process.chdir(root);
    vi.stubEnv("AGENT_YES_HOME", path.join(root, "state"));
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 2222) return true;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.chdir(cwd);
    await fs.rm(root, { recursive: true, force: true });
  });
  async function index(rows: GlobalPidRecord[]) {
    const file = getGlobalPidIndexPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n"));
  }
  async function oldLog(name: string) {
    const file = path.join(root, ".agent-yes", name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "old log");
    await fs.utimes(file, new Date(0), new Date(0));
    return file;
  }
  it("does not compact missing or unreadable registries", async () => {
    await expect(maybeCompactGlobalPids()).resolves.toBeUndefined();
    await fs.mkdir(getGlobalPidIndexPath(), { recursive: true });
    await expect(maybeCompactGlobalPids()).resolves.toBeUndefined();
    expect(await pruneOldLogs(1)).toBe(0);
    await expect(readGlobalPids()).rejects.toThrow();
    await expect(updateGlobalPidStatus(1111, { status: "idle" })).resolves.toBeUndefined();
    await expect(appendGlobalPid(record())).resolves.toBeUndefined();
  });
  it("ignores malformed records and updates for unknown processes", async () => {
    await index([]);
    await fs.writeFile(getGlobalPidIndexPath(), 'not-json\n{"cli":"claude"}\n');
    expect(await readGlobalPids()).toEqual([]);
    await updateGlobalPidStatus(1111, { status: "idle" });
    expect(await readGlobalPids()).toEqual([]);
  });
  it("compacts an all-exited registry to an empty file", async () => {
    await index(Array.from({ length: 500 }, () => record()));
    await maybeCompactGlobalPids();
    expect(await fs.readFile(getGlobalPidIndexPath(), "utf8")).toBe("");
  });
  it("retains live sessions, null logs and sessions with no timestamp", async () => {
    const file = await oldLog("1111.raw.log");
    const rows = [
      record({ started_at: undefined as unknown as number, log_file: file }),
      record({ pid: 2222, status: "active", log_file: file }),
      record({ pid: 3333 }),
    ];
    await index(rows);
    expect(await pruneOldLogs(1000)).toBe(0);
    expect(await fs.readFile(file, "utf8")).toBe("old log");
  });
  it("sweeps only old orphan pid logs while retaining live, recent and unrelated files", async () => {
    const old = await oldLog("1111.raw.log");
    const live = await oldLog("2222.log");
    const zero = await oldLog("0.log");
    const unrelated = await oldLog("inbox.jsonl");
    const recent = await oldLog("3333.debug.log");
    await fs.utimes(recent, new Date(), new Date());
    await fs.mkdir(path.join(root, ".agent-yes", "4444.log"));
    await index([record({ cwd: path.join(root, "missing") })]);
    const result = await sweepOrphanLogs(1000);
    expect(result.removed).toEqual([old]);
    expect(result.freedBytes).toBe(7);
    for (const file of [live, zero, unrelated, recent])
      expect(await fs.readFile(file, "utf8")).toBe("old log");
  });
  it("collects orphan logs even when the registry is unreadable", async () => {
    const old = await oldLog("1111.lines.log");
    await fs.mkdir(getGlobalPidIndexPath(), { recursive: true });
    expect((await sweepOrphanLogs(1)).removed).toEqual([old]);
  });
  it("combines index retention with orphan discovery without counting a file twice", async () => {
    const indexed = await oldLog("1111.raw.log");
    const orphan = await oldLog("3333.log");
    await index([record({ cwd: root, log_file: indexed })]);
    const result = await gcLogs(1);
    expect(new Set(result.removed)).toEqual(new Set([indexed, orphan]));
    expect(result.freedBytes).toBe(14);
  });
  it("uses the configured retention period for the default sweep", async () => {
    vi.stubEnv("AGENT_YES_LOG_RETENTION_DAYS", "1");
    const file = await oldLog("1111.log");
    expect((await gcLogs()).removed).toContain(file);
  });
});
