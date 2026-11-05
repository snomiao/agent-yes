// #516: proper-lockfile keys its in-process registry by the first argument to
// lock(). Locking a shared directory (with a per-file lockfilePath) made two
// stores in one directory overwrite each other's entry, and the orphaned
// refresh timer of the first then threw from a timer callback. Each store must
// lock its own file instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm } from "fs/promises";
import os from "os";
import path from "path";
import { JsonlStore } from "./JsonlStore";

const DIR = path.join(os.tmpdir(), `lock-registry-test-${process.pid}`);

describe("lock registry (#516)", () => {
  beforeEach(async () => {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  it("two stores sharing a directory do not break each other's lock refresh", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => void uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const a = new JsonlStore<{ n: number }>(path.join(DIR, "a.jsonl"));
      const b = new JsonlStore<{ n: number }>(path.join(DIR, "b.jsonl"));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      // Hold A's lock while B takes and releases its own in the same directory.
      let finishA!: () => void;
      const holdA = new Promise<void>((r) => (finishA = r));
      const aBusy = (a as unknown as { withLock(f: () => Promise<void>): Promise<void> }).withLock(
        () => holdA,
      );
      await vi.advanceTimersByTimeAsync(10);
      await b.append({ n: 1 });
      // Let A's mtime-refresh timer fire (stale/2 = 5 s) after B released.
      await vi.advanceTimersByTimeAsync(6_000);
      finishA();
      await aBusy;
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
