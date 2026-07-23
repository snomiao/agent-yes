import { describe, expect, it } from "vitest";
import { reconcileTodos, type LiveAgent } from "./todoAutomation";
import type { TodoRecord } from "./todoStore";

function task(over: Partial<TodoRecord> & { _id: string }): TodoRecord {
  return {
    kind: "code",
    state: "doing",
    summary: `task ${over._id}`,
    description: "",
    blockedBy: [],
    tags: [],
    satisfiedGates: [],
    verifyEvidence: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function agent(over: Partial<LiveAgent> & { agent_id: string }): LiveAgent {
  return { status: "active", ...over };
}

describe("reconcileTodos: orphan detection", () => {
  it("orphans a task whose owner is a KNOWN agent id with a record confirming it exited, and does NOT orphan one whose owner is still live", () => {
    const tasks = [
      task({ _id: "T1", owner: "dead-agent", state: "doing" }),
      task({ _id: "T2", owner: "live-agent", state: "doing" }),
    ];
    const agents = [
      agent({ agent_id: "dead-agent", status: "exited" }),
      agent({ agent_id: "live-agent", status: "active" }),
    ];
    const actions = reconcileTodos(tasks, agents, new Set());
    expect(actions).toEqual([
      { type: "orphan", taskId: "T1", from: "doing", expectedOwner: "dead-agent", candidates: [] },
    ]);
  });

  it("does not orphan a task whose owner's record shows status active (not exited)", () => {
    const tasks = [task({ _id: "T1", owner: "a1", state: "doing" })];
    const agents = [agent({ agent_id: "a1", status: "active" })];
    expect(reconcileTodos(tasks, agents, new Set())).toEqual([]);
  });

  it("does not orphan a task whose owner id has NO record at all in the agent registry — assumed to be a human owner, not a tracked agent (a human obviously never appears there)", () => {
    const tasks = [task({ _id: "T1", owner: "taku", state: "doing" })];
    expect(reconcileTodos(tasks, [], new Set())).toEqual([]);
  });

  it("does not orphan a finished (done) or already-orphaned task even with a dead owner", () => {
    const tasks = [
      task({ _id: "T1", owner: "dead", state: "done" }),
      task({ _id: "T2", owner: "dead", state: "orphaned" }),
    ];
    expect(reconcileTodos(tasks, [], new Set())).toEqual([]);
  });

  it("does not orphan a task with no owner set at all (nothing to check liveness of)", () => {
    const tasks = [task({ _id: "T1", state: "doing" })];
    expect(reconcileTodos(tasks, [], new Set())).toEqual([]);
  });

  it("surfaces up to 3 OTHER currently-idle agents as reassignment candidates, excluding the dead owner and any non-idle agent", () => {
    const tasks = [task({ _id: "T1", owner: "dead", state: "doing" })];
    const agents = [
      agent({ agent_id: "dead", status: "exited" }), // the dead owner itself -> never a candidate for its own task
      agent({ agent_id: "idle-1", status: "idle" }),
      agent({ agent_id: "idle-2", status: "idle" }),
      agent({ agent_id: "idle-3", status: "idle" }),
      agent({ agent_id: "idle-4", status: "idle" }), // beyond the limit of 3
      agent({ agent_id: "busy-1", status: "active" }), // not idle -> excluded
    ];
    const actions = reconcileTodos(tasks, agents, new Set());
    expect(actions).toEqual([
      {
        type: "orphan",
        taskId: "T1",
        from: "doing",
        expectedOwner: "dead",
        candidates: ["idle-1", "idle-2", "idle-3"],
      },
    ]);
  });
});

describe("reconcileTodos: waiting-on-agent auto-clear", () => {
  it("clears a waiting-on-agent block once that agent goes idle", () => {
    const tasks = [
      task({ _id: "T1", state: "doing", block: { type: "waiting-on-agent", agentId: "a1" } }),
    ];
    const agents = [agent({ agent_id: "a1", status: "idle" })];
    expect(reconcileTodos(tasks, agents, new Set())).toEqual([
      { type: "clear-waiting-on-agent", taskId: "T1", expectedAgentId: "a1" },
    ]);
  });

  it("clears a waiting-on-agent block once that agent exits with code 0 (a clean completion), but NOT a nonzero exit or a still-active agent", () => {
    const clean = [
      task({ _id: "T1", state: "doing", block: { type: "waiting-on-agent", agentId: "a1" } }),
    ];
    expect(
      reconcileTodos(clean, [agent({ agent_id: "a1", status: "exited", exit_code: 0 })], new Set()),
    ).toEqual([{ type: "clear-waiting-on-agent", taskId: "T1", expectedAgentId: "a1" }]);

    const failed = [
      task({ _id: "T2", state: "doing", block: { type: "waiting-on-agent", agentId: "a2" } }),
    ];
    expect(
      reconcileTodos(
        failed,
        [agent({ agent_id: "a2", status: "exited", exit_code: 1 })],
        new Set(),
      ),
    ).toEqual([]);

    const stillActive = [
      task({ _id: "T3", state: "doing", block: { type: "waiting-on-agent", agentId: "a3" } }),
    ];
    expect(
      reconcileTodos(stillActive, [agent({ agent_id: "a3", status: "active" })], new Set()),
    ).toEqual([]);
  });

  it("does not clear a waiting-on-agent block when the referenced agent has no record at all yet (ambiguous — leave it, do not guess)", () => {
    const tasks = [
      task({ _id: "T1", state: "doing", block: { type: "waiting-on-agent", agentId: "unknown" } }),
    ];
    expect(reconcileTodos(tasks, [], new Set())).toEqual([]);
  });
});

describe("reconcileTodos: unblocked-notify", () => {
  it("fires notify-unblocked for a currently-unblocked owned task EVERY call — there is no dedup/state file yet (no real delivery channel exists to consume the edge against, codex-review round-7 Important)", () => {
    const blocker = task({ _id: "T1", state: "done" });
    const waiter = task({ _id: "T2", state: "doing", owner: "worker", blockedBy: ["T1"] });
    const first = reconcileTodos([blocker, waiter], [], new Set());
    expect(first).toEqual([{ type: "notify-unblocked", taskId: "T2", owner: "worker" }]);

    // still reported on the very next call, unlike the old per-episode dedup
    const second = reconcileTodos([blocker, waiter], [], new Set());
    expect(second).toEqual([{ type: "notify-unblocked", taskId: "T2", owner: "worker" }]);
  });

  it("stops firing once the task is no longer in the unblocked set (re-blocked on a new, not-yet-done dependency)", () => {
    const blocker = task({ _id: "T1", state: "done" });
    const newBlocker = task({ _id: "T3", state: "doing" });
    const reblocked = task({ _id: "T2", state: "doing", owner: "worker", blockedBy: ["T3"] });
    expect(reconcileTodos([blocker, newBlocker, reblocked], [], new Set())).toEqual([]);
  });

  it("does not fire notify-unblocked for an unblocked task with no owner", () => {
    const blocker = task({ _id: "T1", state: "done" });
    const waiter = task({ _id: "T2", state: "doing", blockedBy: ["T1"] }); // no owner
    expect(reconcileTodos([blocker, waiter], [], new Set())).toEqual([]);
  });

  it("does not fire notify-unblocked for a task orphaned in the SAME tick", () => {
    // owner is dead AND (coincidentally) its blockers are all done — orphan
    // takes priority, no double-signal for the same task in one tick
    const blocker = task({ _id: "T1", state: "done" });
    const waiter = task({ _id: "T2", state: "doing", owner: "dead", blockedBy: ["T1"] });
    const agents = [agent({ agent_id: "dead", status: "exited" })];
    const actions = reconcileTodos([blocker, waiter], agents, new Set());
    expect(actions).toEqual([
      { type: "orphan", taskId: "T2", from: "doing", expectedOwner: "dead", candidates: [] },
    ]);
  });
});

describe("reconcileTodos: auto-verify eligibility", () => {
  it("flags a task in a state whose outgoing edge's gate IS registered, and does not flag one whose gate is not registered", () => {
    const eligible = task({ _id: "T1", kind: "code", state: "verifying" }); // verifying -> done gate "verify-green"
    const ineligible = task({ _id: "T2", kind: "code", state: "doing" }); // doing -> merged, no gate at all
    const actions = reconcileTodos([eligible, ineligible], [], new Set(["verify-green"]));
    expect(actions).toEqual([{ type: "auto-verify", taskId: "T1" }]);
  });

  it("does not flag a task whose gate exists on the graph but is not currently registered", () => {
    const t = task({ _id: "T1", kind: "code", state: "verifying" });
    expect(reconcileTodos([t], [], new Set())).toEqual([]);
  });

  it("does not flag an already-orphaned task even if it sits in a gate-eligible state", () => {
    const t = task({ _id: "T1", kind: "code", state: "orphaned", owner: "taku" });
    expect(reconcileTodos([t], [], new Set(["verify-green"]))).toEqual([]);
  });
});
