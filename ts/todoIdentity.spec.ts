import { describe, expect, it } from "vitest";
import { ownerLiveness, resolveSelf } from "./todoIdentity.ts";
import type { GlobalPidRecord } from "./globalPidIndex.ts";

const rec = (over: Partial<GlobalPidRecord>): GlobalPidRecord =>
  ({
    pid: 100,
    cli: "claude",
    prompt: null,
    cwd: "/repo",
    log_file: null,
    status: "active",
    exit_code: null,
    exit_reason: null,
    started_at: 0,
    ...over,
  }) as GlobalPidRecord;

describe("resolveSelf", () => {
  it("maps AGENT_YES_PID to the record whose wrapper_pid it is", async () => {
    const self = await resolveSelf({ AGENT_YES_PID: "500" }, async () => [
      rec({ pid: 1, wrapper_pid: 9, agent_id: "other" }),
      rec({ pid: 2, wrapper_pid: 500, agent_id: "mine", cwd: "/repo/lane" }),
    ]);
    expect(self).toEqual({ agentId: "mine", pid: 2, cwd: "/repo/lane", title: undefined });
  });

  it("falls back to a pid match for a process that IS the wrapper", async () => {
    const self = await resolveSelf({ AGENT_YES_PID: "77" }, async () => [
      rec({ pid: 77, agent_id: "wrapper-self" }),
    ]);
    expect(self?.agentId).toBe("wrapper-self");
  });

  it("returns null in a human shell (no AGENT_YES_PID)", async () => {
    expect(await resolveSelf({}, async () => [rec({ pid: 1, agent_id: "a" })])).toBeNull();
  });

  // The load-bearing case: an owner string that is not an `agent_id` matches
  // nothing in `deadOwnerAgent`, so it reads as a human owner and is never
  // orphaned. Returning null here is what lets the CLI say so out loud
  // instead of writing a pid that would quietly disable orphan recovery.
  it("returns null when the record carries no stable agent_id, rather than substituting a pid", async () => {
    expect(
      await resolveSelf({ AGENT_YES_PID: "500" }, async () => [
        rec({ pid: 2, wrapper_pid: 500, agent_id: null }),
      ]),
    ).toBeNull();
  });

  it("returns null when AGENT_YES_PID matches no record at all", async () => {
    expect(await resolveSelf({ AGENT_YES_PID: "999" }, async () => [rec({ pid: 1 })])).toBeNull();
  });

  it("ignores a non-numeric AGENT_YES_PID instead of matching NaN", async () => {
    expect(
      await resolveSelf({ AGENT_YES_PID: "not-a-pid" }, async () => [rec({ pid: 1 })]),
    ).toBeNull();
  });
});

describe("ownerLiveness", () => {
  const agents = [
    rec({ agent_id: "running", status: "active" }),
    rec({ agent_id: "napping", status: "idle" }),
    rec({ agent_id: "gone", status: "exited" }),
  ];

  it("reports the agent's registry status", () => {
    expect(ownerLiveness("running", agents)).toBe("active");
    expect(ownerLiveness("napping", agents)).toBe("idle");
    expect(ownerLiveness("gone", agents)).toBe("exited");
  });

  it("reports unknown for a human owner and for no owner", () => {
    expect(ownerLiveness("alice", agents)).toBe("unknown");
    expect(ownerLiveness(undefined, agents)).toBe("unknown");
  });
});
