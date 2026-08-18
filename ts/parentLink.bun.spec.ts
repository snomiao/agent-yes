import { describe, expect, it } from "bun:test";
import { resolveSpawner, spawnerFromRecords } from "./parentLink.ts";
import type { GlobalPidRecord } from "./globalPidIndex.ts";

const rec = (over: Partial<GlobalPidRecord> = {}): GlobalPidRecord => ({
  pid: 100,
  cli: "claude",
  prompt: null,
  cwd: "/repo",
  log_file: null,
  status: "active",
  exit_code: null,
  exit_reason: null,
  started_at: 1,
  wrapper_pid: 99,
  agent_id: "agt_a",
  ...over,
});

describe("spawnerFromRecords", () => {
  it("matches on wrapper_pid — that is the value a child inherits as AGENT_YES_PID", () => {
    expect(spawnerFromRecords([rec()], 99)).toEqual({
      cli: "claude",
      pid: 100,
      agentId: "agt_a",
      cwd: "/repo",
    });
  });

  it("returns null when nothing matches (parent aged out, or lives on another host)", () => {
    expect(spawnerFromRecords([rec()], 12345)).toBeNull();
    expect(spawnerFromRecords([], 99)).toBeNull();
  });

  it("prefers a LIVE record over a recycled wrapper pid's exited one", () => {
    const dead = rec({ pid: 100, status: "exited", agent_id: "agt_old" });
    const live = rec({ pid: 200, status: "active", agent_id: "agt_new" });
    expect(spawnerFromRecords([dead, live], 99)?.agentId).toBe("agt_new");
  });

  it("falls back to an exited record rather than losing the link entirely", () => {
    const dead = rec({ status: "exited", agent_id: "agt_old" });
    expect(spawnerFromRecords([dead], 99)?.agentId).toBe("agt_old");
  });

  it("normalises a missing agent_id to null so the caller falls back to the pid", () => {
    expect(spawnerFromRecords([rec({ agent_id: undefined })], 99)?.agentId).toBeNull();
  });
});

describe("resolveSpawner", () => {
  it("short-circuits on a non-parent without touching the registry", async () => {
    await expect(resolveSpawner(undefined)).resolves.toBeNull();
    await expect(resolveSpawner(null)).resolves.toBeNull();
    await expect(resolveSpawner(0)).resolves.toBeNull();
    await expect(resolveSpawner(-1)).resolves.toBeNull();
    await expect(resolveSpawner(1.5)).resolves.toBeNull();
  });

  it("returns null (never throws) when the registry has no such parent", async () => {
    // A pid that cannot be a live wrapper in this test process's registry.
    await expect(resolveSpawner(2 ** 30)).resolves.toBeNull();
  });
});
