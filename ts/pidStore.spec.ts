import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PidStore } from "./pidStore";
import { rm, readFile } from "fs/promises";
import path from "path";

const TEST_DIR = "/tmp/pidstore-test-" + process.pid;

describe("PidStore", () => {
  let store: PidStore;

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    store = new PidStore(TEST_DIR);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("registerProcess", () => {
    it("should register a new process", async () => {
      const rec = await store.registerProcess({
        pid: 12345,
        cli: "claude",
        args: ["--yes"],
        prompt: "hello",
        cwd: "/tmp",
      });

      expect(rec.pid).toBe(12345);
      expect(rec.cli).toBe("claude");
      expect(rec.args).toBe(JSON.stringify(["--yes"]));
      expect(rec.prompt).toBe("hello");
      expect(rec.cwd).toBe("/tmp");
      expect(rec.status).toBe("active");
      expect(rec.exitReason).toBe("");
      expect(rec.startedAt).toBeTypeOf("number");
      expect(rec._id).toBeTypeOf("string");
    });

    it("should upsert when registering same pid", async () => {
      await store.registerProcess({
        pid: 12345,
        cli: "claude",
        args: ["--yes"],
        cwd: "/tmp",
      });

      const rec = await store.registerProcess({
        pid: 12345,
        cli: "codex",
        args: ["--full-auto"],
        cwd: "/home",
      });

      expect(rec.pid).toBe(12345);
      expect(rec.cli).toBe("codex");
      expect(rec.args).toBe(JSON.stringify(["--full-auto"]));
      expect(rec.cwd).toBe("/home");
      expect(rec.status).toBe("active");

      const all = store.getAllRecords();
      expect(all.filter((r) => r.pid === 12345)).toHaveLength(1);
    });

    it("should register multiple processes", async () => {
      await store.registerProcess({ pid: 100, cli: "a", args: [], cwd: "/tmp" });
      await store.registerProcess({ pid: 200, cli: "b", args: [], cwd: "/tmp" });
      await store.registerProcess({ pid: 300, cli: "c", args: [], cwd: "/tmp" });

      const all = store.getAllRecords();
      expect(all).toHaveLength(3);
      expect(all.map((r) => r.pid).sort()).toEqual([100, 200, 300]);
    });

    it("should set logFile and fifoFile paths", async () => {
      const rec = await store.registerProcess({
        pid: 42,
        cli: "test",
        args: [],
        cwd: "/tmp",
      });

      expect(rec.logFile).toContain("42.log");
      expect(rec.fifoFile).toContain("42.stdin");
    });
  });

  describe("updateStatus", () => {
    it("should update status to idle", async () => {
      await store.registerProcess({ pid: 111, cli: "test", args: [], cwd: "/tmp" });
      await store.updateStatus(111, "idle");

      const all = store.getAllRecords();
      const rec = all.find((r) => r.pid === 111);
      expect(rec?.status).toBe("idle");
    });

    it("should update status to exited with exit reason and code", async () => {
      await store.registerProcess({ pid: 222, cli: "test", args: [], cwd: "/tmp" });
      await store.updateStatus(222, "exited", { exitReason: "crash", exitCode: 1 });

      const all = store.getAllRecords();
      const rec = all.find((r) => r.pid === 222);
      expect(rec?.status).toBe("exited");
      expect(rec?.exitReason).toBe("crash");
      expect(rec?.exitCode).toBe(1);
    });
  });

  describe("getAllRecords", () => {
    it("should return empty array when no records", () => {
      const all = store.getAllRecords();
      expect(all).toEqual([]);
    });

    it("should return all records", async () => {
      await store.registerProcess({ pid: 1, cli: "a", args: [], cwd: "/tmp" });
      await store.registerProcess({ pid: 2, cli: "b", args: [], cwd: "/tmp" });

      const all = store.getAllRecords();
      expect(all).toHaveLength(2);
    });
  });

  describe("cleanStaleRecords", () => {
    it("should mark non-alive processes as exited", async () => {
      await store.registerProcess({ pid: 9999999, cli: "ghost", args: [], cwd: "/tmp" });

      await store.cleanStaleRecords();

      const all = store.getAllRecords();
      const rec = all.find((r) => r.pid === 9999999);
      expect(rec?.status).toBe("exited");
      expect(rec?.exitReason).toBe("stale-cleanup");
    });
  });

  describe("findActiveFifo", () => {
    it("should return null when no active records", async () => {
      await store.close();
      const fifo = await PidStore.findActiveFifo(TEST_DIR);
      expect(fifo).toBeNull();
      store = new PidStore(TEST_DIR);
      await store.init();
    });

    it("should return fifo of most recent non-exited process", async () => {
      const fifoTestDir = TEST_DIR + "-fifo";
      await rm(fifoTestDir, { recursive: true, force: true });

      const fifoStore = new PidStore(fifoTestDir);
      await fifoStore.init();
      await fifoStore.registerProcess({ pid: process.pid, cli: "self", args: [], cwd: "/tmp" });
      await fifoStore.close();

      const fifo = await PidStore.findActiveFifo(fifoTestDir);
      expect(fifo).toBeTypeOf("string");
      expect(fifo!).toContain(`${process.pid}.stdin`);

      await rm(fifoTestDir, { recursive: true, force: true });
    });
  });

  describe("persistence", () => {
    it("should persist and reload data across close/reopen", async () => {
      await store.registerProcess({ pid: 12345, cli: "claude", args: ["--yes"], cwd: "/tmp" });
      await store.updateStatus(12345, "idle");
      await store.close();

      // Reopen
      store = new PidStore(TEST_DIR);
      await store.init();
      // stale cleanup will mark pid 12345 as exited since it doesn't exist
      // so just check it was loaded
      const all = store.getAllRecords();
      expect(all).toHaveLength(1);
      expect(all[0]!.pid).toBe(12345);
      expect(all[0]!.cli).toBe("claude");
    });
  });

  describe("paths", () => {
    it("getLogDir should return correct path", () => {
      expect(store.getLogDir()).toBe(path.resolve(TEST_DIR, ".agent-yes", "logs"));
    });

    it("getFifoPath should return correct path", () => {
      const fifo = store.getFifoPath(42);
      expect(fifo).toBe(path.resolve(TEST_DIR, ".agent-yes", "fifo", "42.stdin"));
    });
  });

  describe("gitignore", () => {
    it("should create .gitignore in store dir", async () => {
      const gitignorePath = path.join(TEST_DIR, ".agent-yes", ".gitignore");
      const content = await Bun.file(gitignorePath).text();
      expect(content).toContain("*.jsonl");
      expect(content).toContain("logs/");
    });
  });

  describe("JSONL file format", () => {
    it("should store data as human-readable JSONL", async () => {
      await store.registerProcess({ pid: 1111, cli: "test-cli", args: ["--flag"], cwd: "/tmp" });
      await store.updateStatus(1111, "idle");

      const jsonlPath = path.join(TEST_DIR, ".agent-yes", "pid-records.jsonl");
      const content = await readFile(jsonlPath, "utf-8");
      const lines = content.trim().split("\n");

      // Should have 2 lines: initial insert + status update
      expect(lines).toHaveLength(2);

      // Each line should be valid JSON
      const doc1 = JSON.parse(lines[0]!);
      expect(doc1.pid).toBe(1111);
      expect(doc1.cli).toBe("test-cli");
      expect(doc1.status).toBe("active");

      const doc2 = JSON.parse(lines[1]!);
      expect(doc2.status).toBe("idle");
      expect(doc2._id).toBe(doc1._id);
    });

    it("should compact on close (deduplicate)", async () => {
      await store.registerProcess({ pid: 2222, cli: "test", args: [], cwd: "/tmp" });
      await store.updateStatus(2222, "idle");
      await store.updateStatus(2222, "active");
      await store.updateStatus(2222, "exited", { exitReason: "done", exitCode: 0 });

      const jsonlPath = path.join(TEST_DIR, ".agent-yes", "pid-records.jsonl");

      // Before compact: 4 lines (1 insert + 3 updates)
      const before = (await readFile(jsonlPath, "utf-8")).trim().split("\n");
      expect(before).toHaveLength(4);

      await store.close();

      // After compact: 1 line (deduplicated)
      const after = (await readFile(jsonlPath, "utf-8")).trim().split("\n");
      expect(after).toHaveLength(1);

      const doc = JSON.parse(after[0]!);
      expect(doc.pid).toBe(2222);
      expect(doc.status).toBe("exited");
      expect(doc.exitReason).toBe("done");
      expect(doc.exitCode).toBe(0);

      // Re-init for afterEach
      store = new PidStore(TEST_DIR);
      await store.init();
    });

    it("should handle crash recovery: skip partial last line", async () => {
      await store.registerProcess({ pid: 3333, cli: "test", args: [], cwd: "/tmp" });
      await store.close();

      // Simulate crash: append a partial line
      const jsonlPath = path.join(TEST_DIR, ".agent-yes", "pid-records.jsonl");
      const { appendFile } = await import("fs/promises");
      await appendFile(jsonlPath, '{"_id":"corrupt","pid":9999\n');

      // Reopen should skip the corrupt line
      store = new PidStore(TEST_DIR);
      await store.init();
      const all = store.getAllRecords();
      expect(all).toHaveLength(1);
      expect(all[0]!.pid).toBe(3333);
    });
  });
});
