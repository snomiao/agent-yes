import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  memAvailableMb,
  spawnGateEnabled,
  spawnRejectionReason,
  waitForSpawnCapacity,
} from "./spawnGate.ts";

// Build a minimal live pid record. Using the test runner's own pid guarantees
// `isProcessAlive` (process.kill(pid, 0)) succeeds, so the record counts as live.
const liveRecord = (pid: number) =>
  JSON.stringify({
    pid,
    cli: "claude",
    prompt: null,
    cwd: "/tmp",
    log_file: null,
    status: "active",
    exit_code: null,
    exit_reason: null,
    started_at: 0,
  });

describe("spawnGate", () => {
  let original: string | undefined;
  let tmp: string;
  const writePids = (lines: string[]) =>
    writeFileSync(path.join(tmp, "pids.jsonl"), lines.join("\n") + "\n");

  beforeEach(() => {
    original = process.env.AGENT_YES_HOME;
    tmp = mkdtempSync(path.join(tmpdir(), "ay-gate-"));
    process.env.AGENT_YES_HOME = tmp;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = original;
    delete process.env.AGENT_YES_MAX_AGENTS;
    delete process.env.AGENT_YES_MIN_FREE_MB;
    delete process.env.AGENT_YES_SPAWN_WAIT_MS;
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("memAvailableMb", () => {
    it("returns a positive number on this host", async () => {
      const mb = await memAvailableMb();
      expect(mb).not.toBeNull();
      expect(mb!).toBeGreaterThan(0);
    });
  });

  describe("spawnGateEnabled", () => {
    it("is false when nothing is configured", () => {
      expect(spawnGateEnabled()).toBe(false);
    });
    it("is true when a cap or floor is set", () => {
      process.env.AGENT_YES_MAX_AGENTS = "5";
      expect(spawnGateEnabled()).toBe(true);
    });
  });

  describe("spawnRejectionReason", () => {
    it("returns null when no limits are configured", async () => {
      expect(await spawnRejectionReason()).toBeNull();
    });

    it("rejects when live agents reach the cap", async () => {
      writePids([liveRecord(process.pid)]);
      process.env.AGENT_YES_MAX_AGENTS = "1";
      expect(await spawnRejectionReason()).toMatch(/too many agents running \(1\/1\)/);
    });

    it("admits when live agents are under the cap", async () => {
      writePids([liveRecord(process.pid)]);
      process.env.AGENT_YES_MAX_AGENTS = "5";
      expect(await spawnRejectionReason()).toBeNull();
    });

    it("ignores dead pids when counting live agents", async () => {
      // pid 2^31-1 is effectively never a live process → not counted.
      writePids([liveRecord(2147483646)]);
      process.env.AGENT_YES_MAX_AGENTS = "1";
      expect(await spawnRejectionReason()).toBeNull();
    });

    it("rejects when free memory is below the floor", async () => {
      process.env.AGENT_YES_MIN_FREE_MB = String(Number.MAX_SAFE_INTEGER);
      expect(await spawnRejectionReason()).toMatch(/host is low on memory/);
    });

    it("admits when free memory is above the floor", async () => {
      process.env.AGENT_YES_MIN_FREE_MB = "1";
      expect(await spawnRejectionReason()).toBeNull();
    });
  });

  describe("waitForSpawnCapacity", () => {
    it("returns immediately (no sleep) when the gate is disabled", async () => {
      const sleeps: number[] = [];
      await waitForSpawnCapacity({ sleep: async (ms) => void sleeps.push(ms) });
      expect(sleeps).toEqual([]);
    });

    it("backs off with φ growth and fails open at the deadline", async () => {
      writePids([liveRecord(process.pid)]);
      process.env.AGENT_YES_MAX_AGENTS = "1"; // always over → never admits

      let t = 0;
      const sleeps: number[] = [];
      let proceededAfter: number | null = null;
      await waitForSpawnCapacity({
        maxWaitMs: 5000,
        now: () => t,
        sleep: async (ms) => {
          sleeps.push(ms);
          t += ms;
        },
        onProceedAnyway: (_r, waited) => {
          proceededAfter = waited;
        },
      });

      // 1000, then ×φ (1618), then clamped to the remaining 2382ms before deadline.
      expect(sleeps[0]).toBe(1000);
      expect(sleeps[1]).toBe(1618);
      expect(sleeps.reduce((a, b) => a + b, 0)).toBe(5000);
      expect(proceededAfter).toBe(5000);
    });

    it("admits as soon as capacity frees, without proceeding-anyway", async () => {
      writePids([liveRecord(process.pid)]);
      process.env.AGENT_YES_MAX_AGENTS = "1";

      const sleeps: number[] = [];
      let proceeded = false;
      await waitForSpawnCapacity({
        maxWaitMs: 600_000,
        sleep: async (ms) => {
          sleeps.push(ms);
          // free up capacity after two backoff cycles
          if (sleeps.length >= 2) process.env.AGENT_YES_MAX_AGENTS = "10";
        },
        onProceedAnyway: () => {
          proceeded = true;
        },
      });

      expect(sleeps.length).toBe(2);
      expect(proceeded).toBe(false);
    });
  });
});
