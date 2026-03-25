import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { JsonlStore } from "./JsonlStore";
import { rm, readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import os from "os";

const TEST_DIR = path.join(os.tmpdir(), "jsonlstore-test-" + process.pid);
const TEST_FILE = path.join(TEST_DIR, "test.jsonl");

describe("JsonlStore", () => {
  let store: JsonlStore;

  beforeEach(async () => {
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures (e.g. Windows lock files from previous test)
    }
    await mkdir(TEST_DIR, { recursive: true });
    store = new JsonlStore(TEST_FILE);
  });

  afterEach(async () => {
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  describe("load", () => {
    it("should return empty map for new file", async () => {
      const docs = await store.load();
      expect(docs.size).toBe(0);
    });

    it("should load existing JSONL data", async () => {
      await writeFile(TEST_FILE, '{"_id":"1","name":"Alice"}\n{"_id":"2","name":"Bob"}\n');
      const docs = await store.load();
      expect(docs.size).toBe(2);
      expect(docs.get("1")).toEqual({ _id: "1", name: "Alice" });
    });

    it("should merge duplicate IDs (last wins)", async () => {
      await writeFile(
        TEST_FILE,
        '{"_id":"1","name":"Alice","age":30}\n{"_id":"1","name":"Alice Updated"}\n',
      );
      const docs = await store.load();
      expect(docs.size).toBe(1);
      expect(docs.get("1")).toEqual({ _id: "1", name: "Alice Updated", age: 30 });
    });

    it("should handle $$deleted tombstones", async () => {
      await writeFile(TEST_FILE, '{"_id":"1","name":"Alice"}\n{"_id":"1","$$deleted":true}\n');
      const docs = await store.load();
      expect(docs.size).toBe(0);
    });

    it("should skip lines without _id", async () => {
      await writeFile(TEST_FILE, '{"name":"no id"}\n{"_id":"1","name":"valid"}\n');
      const docs = await store.load();
      expect(docs.size).toBe(1);
    });

    it("should skip corrupt lines gracefully", async () => {
      await writeFile(
        TEST_FILE,
        '{"_id":"1","name":"ok"}\n{corrupt json\n{"_id":"2","name":"also ok"}\n',
      );
      const docs = await store.load();
      expect(docs.size).toBe(2);
    });

    it("should recover from temp file when main file missing", async () => {
      const tempFile = TEST_FILE + "~";
      await writeFile(tempFile, '{"_id":"1","name":"recovered"}\n');
      const docs = await store.load();
      expect(docs.size).toBe(1);
      expect(docs.get("1")!.name).toBe("recovered");
    });
  });

  describe("getAll / getById / find / findOne", () => {
    beforeEach(async () => {
      await writeFile(
        TEST_FILE,
        '{"_id":"1","name":"Alice","age":30}\n{"_id":"2","name":"Bob","age":25}\n{"_id":"3","name":"Charlie","age":35}\n',
      );
      await store.load();
    });

    it("getAll returns all documents", () => {
      expect(store.getAll()).toHaveLength(3);
    });

    it("getById returns correct doc", () => {
      expect(store.getById("2")).toEqual({ _id: "2", name: "Bob", age: 25 });
    });

    it("getById returns undefined for missing id", () => {
      expect(store.getById("999")).toBeUndefined();
    });

    it("find returns matching docs", () => {
      const result = store.find((d) => d.age > 28);
      expect(result).toHaveLength(2);
    });

    it("findOne returns first match", () => {
      const result = store.findOne((d) => d.age > 28);
      expect(result).toBeDefined();
      expect(result!.age).toBeGreaterThan(28);
    });

    it("findOne returns undefined when no match", () => {
      expect(store.findOne((d) => d.age > 100)).toBeUndefined();
    });
  });

  describe("append", () => {
    it("should append and return doc with generated id", async () => {
      await store.load();
      const doc = await store.append({ name: "test" } as any);
      expect(doc._id).toBeDefined();
      expect(doc.name).toBe("test");
      expect(store.getAll()).toHaveLength(1);
    });

    it("should append with provided _id", async () => {
      await store.load();
      const doc = await store.append({ _id: "custom-id", name: "test" } as any);
      expect(doc._id).toBe("custom-id");
    });

    it("should merge with existing doc of same _id", async () => {
      await store.load();
      await store.append({ _id: "x", name: "first", value: 1 } as any);
      await store.append({ _id: "x", name: "second" } as any);
      const doc = store.getById("x")!;
      expect(doc.name).toBe("second");
      expect(doc.value).toBe(1);
    });
  });

  describe("updateById", () => {
    it("should update existing doc", async () => {
      await store.load();
      await store.append({ _id: "u1", name: "original", status: "active" } as any);
      await store.updateById("u1", { status: "done" });
      expect(store.getById("u1")!.status).toBe("done");
      expect(store.getById("u1")!.name).toBe("original");
    });

    it("should no-op for non-existent id", async () => {
      await store.load();
      await store.updateById("nonexistent", { status: "done" });
      expect(store.getAll()).toHaveLength(0);
    });
  });

  describe("deleteById", () => {
    it("should remove doc from memory and write tombstone", async () => {
      await store.load();
      await store.append({ _id: "d1", name: "to delete" } as any);
      expect(store.getAll()).toHaveLength(1);

      await store.deleteById("d1");
      expect(store.getAll()).toHaveLength(0);
      expect(store.getById("d1")).toBeUndefined();

      // Tombstone should be written to file
      const content = await readFile(TEST_FILE, "utf-8");
      expect(content).toContain('"$$deleted":true');
    });
  });

  describe("compact", () => {
    it("should deduplicate entries", async () => {
      await store.load();
      await store.append({ _id: "c1", name: "v1" } as any);
      await store.updateById("c1", { name: "v2" });
      await store.updateById("c1", { name: "v3" });

      // Before compact: 3 lines
      const before = (await readFile(TEST_FILE, "utf-8")).trim().split("\n");
      expect(before).toHaveLength(3);

      await store.compact();

      // After compact: 1 line
      const after = (await readFile(TEST_FILE, "utf-8")).trim().split("\n");
      expect(after).toHaveLength(1);
      expect(JSON.parse(after[0]!).name).toBe("v3");
    });

    it("should handle empty store", async () => {
      await store.load();
      await store.compact();
      const content = await readFile(TEST_FILE, "utf-8");
      expect(content).toBe("");
    });
  });
});
