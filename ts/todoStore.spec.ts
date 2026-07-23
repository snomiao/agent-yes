import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { rm } from "fs/promises";
import path from "path";
import { TodoStore, CycleError, openStore } from "./todoStore";

const isWindows = process.platform === "win32";
const TEST_ROOT = isWindows
  ? path.join(process.env.TEMP || "C:\\Temp", "todostore-test-" + process.pid)
  : "/tmp/todostore-test-" + process.pid;

describe("TodoStore", () => {
  beforeEach(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
  });
  afterEach(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it("create() assigns sequential ids and the kind's initial state", async () => {
    const s = await openStore(TEST_ROOT);
    const a = await s.create({ summary: "write the spec", kind: "doc" });
    const b = await s.create({ summary: "ship the feature", kind: "code" });
    expect(a._id).toBe("T1");
    expect(a.state).toBe("drafting");
    expect(b._id).toBe("T2");
    expect(b.state).toBe("doing");
  });

  it("transition() across an ungated edge succeeds with no approval needed", async () => {
    const s = await openStore(TEST_ROOT);
    const t = await s.create({ summary: "x", kind: "code" });
    const moved = await s.transition(t._id, "merged");
    expect(moved.state).toBe("merged");
  });

  it("transition() across a nonexistent edge is refused", async () => {
    const s = await openStore(TEST_ROOT);
    const t = await s.create({ summary: "x", kind: "code" });
    await expect(s.transition(t._id, "done")).rejects.toThrow(/no transition/);
  });

  it("transition() across a gated edge is refused until the gate is satisfied", async () => {
    const s = await openStore(TEST_ROOT);
    const t = await s.create({ summary: "x", kind: "doc", owner: "worker" });
    await s.transition(t._id, "review");
    await expect(s.transition(t._id, "done")).rejects.toThrow(/requires gate "human-approved"/);
  });

  it("INDEPENDENT VERIFICATION: approve() refuses when the validator is the task's own owner (self-certification blocked)", async () => {
    const s = await openStore(TEST_ROOT);
    const t = await s.create({ summary: "x", kind: "doc", owner: "worker" });
    await s.transition(t._id, "review");
    await expect(s.approve(t._id, "human-approved", "worker")).rejects.toThrow(
      /independent verification required/,
    );
    // case-insensitive match
    await expect(s.approve(t._id, "human-approved", "WORKER")).rejects.toThrow(
      /independent verification required/,
    );
  });

  it("approve() by a DIFFERENT identity succeeds, records evidence, and unblocks the transition", async () => {
    const s = await openStore(TEST_ROOT);
    const t = await s.create({ summary: "x", kind: "doc", owner: "worker" });
    await s.transition(t._id, "review");
    const approved = await s.approve(t._id, "human-approved", "reviewer", {
      note: "looks good",
      link: "https://example/pr/1",
    });
    expect(approved.satisfiedGates).toEqual(["human-approved"]);
    expect(approved.verifyEvidence).toHaveLength(1);
    expect(approved.verifyEvidence[0]).toMatchObject({
      gate: "human-approved",
      validator: "reviewer",
      note: "looks good",
      link: "https://example/pr/1",
    });

    const done = await s.transition(t._id, "done");
    expect(done.state).toBe("done");
    // the satisfied-gate flag is consumed by the transition — cannot be replayed
    expect(done.satisfiedGates).toEqual([]);
    // evidence is NOT duplicated: transition() does not append a second entry
    expect(done.verifyEvidence).toHaveLength(1);
  });

  it("approve() with an empty owner allows any validator (nothing to compare against) but still requires one", async () => {
    const s = await openStore(TEST_ROOT);
    const t = await s.create({ summary: "x", kind: "doc" }); // no owner
    await s.transition(t._id, "review");
    const approved = await s.approve(t._id, "human-approved", "anyone");
    expect(approved.satisfiedGates).toEqual(["human-approved"]);
    await expect(s.approve(t._id, "human-approved", "")).rejects.toThrow(
      /requires a validatorIdentity/,
    );
  });

  it("approve() refuses a gate name that is not on any edge from the task's current state", async () => {
    const s = await openStore(TEST_ROOT);
    const t = await s.create({ summary: "x", kind: "doc", owner: "worker" });
    await expect(s.approve(t._id, "human-approved", "reviewer")).rejects.toThrow(
      /not a gate on any transition/,
    ); // still in "drafting"
  });

  it("REGISTERED gates cannot be satisfied by transition() OR approve() — only verify()", async () => {
    const s = await openStore(TEST_ROOT);
    s.registerGate({ name: "verify-green", check: async () => ({ passed: true }) });
    const t = await s.create({ summary: "x", kind: "code", owner: "worker" });
    await s.transition(t._id, "merged");
    await s.transition(t._id, "shipped");
    await s.transition(t._id, "verifying");
    await expect(s.transition(t._id, "done")).rejects.toThrow(/registered gate.*verify\(/);
    await expect(s.approve(t._id, "verify-green", "someone-else")).rejects.toThrow(
      /cannot be approved manually/,
    );
  });

  it("verify() with a passing registered gate moves to the gated state and records the gate name as validator", async () => {
    const s = await openStore(TEST_ROOT);
    s.registerGate({
      name: "verify-green",
      check: async () => ({ passed: true, note: "canary green", link: "https://ci/run/1" }),
    });
    const t = await s.create({ summary: "x", kind: "code", owner: "worker" });
    await s.transition(t._id, "merged");
    await s.transition(t._id, "shipped");
    await s.transition(t._id, "verifying");
    const verified = await s.verify(t._id);
    expect(verified.state).toBe("done");
    expect(verified.verifyEvidence.at(-1)).toMatchObject({
      gate: "verify-green",
      validator: "gate:verify-green",
      note: "canary green",
      link: "https://ci/run/1",
    });
  });

  it("verify() with a failing check takes the SIBLING edge (verify-failed), not done — the failure is a real distinct state, not silently dropped", async () => {
    const s = await openStore(TEST_ROOT);
    s.registerGate({
      name: "verify-green",
      check: async () => ({ passed: false, note: "canary red: 2 tests failed" }),
    });
    const t = await s.create({ summary: "x", kind: "code", owner: "worker" });
    await s.transition(t._id, "merged");
    await s.transition(t._id, "shipped");
    await s.transition(t._id, "verifying");
    const result = await s.verify(t._id);
    expect(result.state).toBe("verify-failed");
    expect(result.verifyEvidence.at(-1)?.note).toBe("canary red: 2 tests failed");
  });

  it("verify-failed reopens ONLY back to doing, via a normal transition() call (real doing->verifying cycle preserved)", async () => {
    const s = await openStore(TEST_ROOT);
    s.registerGate({ name: "verify-green", check: async () => ({ passed: false }) });
    const t = await s.create({ summary: "x", kind: "code", owner: "worker" });
    await s.transition(t._id, "merged");
    await s.transition(t._id, "shipped");
    await s.transition(t._id, "verifying");
    const failed = await s.verify(t._id);
    expect(failed.state).toBe("verify-failed");
    const reopened = await s.transition(t._id, "doing");
    expect(reopened.state).toBe("doing");
    await expect(s.transition(t._id, "verifying")).rejects.toThrow(/no transition/); // must go through merged/shipped again
    const remerged = await s.transition(t._id, "merged");
    expect(remerged.state).toBe("merged");
  });

  it("verify() with no registered gate for the current state throws", async () => {
    const s = await openStore(TEST_ROOT);
    const t = await s.create({ summary: "x", kind: "code" });
    await expect(s.verify(t._id)).rejects.toThrow(/no gated transition/); // still "doing", which has no gated outgoing edge
  });

  it("dep add/rm: sorted, deduped, rejects self-dep, missing target, and transitive cycles", async () => {
    const s = await openStore(TEST_ROOT);
    const a = await s.create({ summary: "a", kind: "code" });
    const b = await s.create({ summary: "b", kind: "code" });
    const c = await s.create({ summary: "c", kind: "code" });
    await expect(s.addDep(a._id, a._id)).rejects.toThrow(/cannot depend on itself/);
    await expect(s.addDep(a._id, "T99")).rejects.toThrow(/no such task/);
    const added = await s.addDep(c._id, a._id);
    expect(added.blockedBy).toEqual([a._id]);
    await s.addDep(b._id, a._id);
    await s.addDep(c._id, b._id);
    // a <- b <- c  (c depends on both a and b); a depending on c would cycle
    await expect(s.addDep(a._id, c._id)).rejects.toThrow(CycleError);
    const removed = await s.rmDep(c._id, a._id);
    expect(removed.blockedBy).toEqual([b._id]);
  });

  it("list() filters by kind/state/owner/tag/blocked", async () => {
    const s = await openStore(TEST_ROOT);
    await s.create({ summary: "a", kind: "code", owner: "Alice", tags: ["proj-x"] });
    const b = await s.create({ summary: "b", kind: "doc" });
    await s.setBlock(b._id, { type: "blocked-by-human", who: "bob" });
    expect(s.list({ owner: "alice" }).map((t) => t.summary)).toEqual(["a"]); // case-insensitive
    expect(s.list({ tag: "proj-x" }).map((t) => t.summary)).toEqual(["a"]);
    expect(s.list({ kind: "doc" }).map((t) => t.summary)).toEqual(["b"]);
    expect(s.list({ blocked: true }).map((t) => t.summary)).toEqual(["b"]);
  });

  it("a done task with a leftover block is not counted by --blocked (mirrors symval-dev-cli's equivalent fix)", async () => {
    const s = await openStore(TEST_ROOT);
    const t = await s.create({ summary: "a", kind: "human" });
    await s.setBlock(t._id, { type: "blocked-by-human", who: "x" });
    await s.approve(t._id, "human-replied", "x");
    await s.transition(t._id, "decided");
    await s.transition(t._id, "done");
    expect(s.list({ blocked: true })).toEqual([]);
  });

  it("re-opening the store (new TodoStore.open call) sees writes made before it, including from a different instance", async () => {
    const s1 = await openStore(TEST_ROOT);
    await s1.create({ summary: "persisted", kind: "code" });
    const s2 = await openStore(TEST_ROOT);
    expect(s2.list().map((t) => t.summary)).toEqual(["persisted"]);
    expect(s2.get("T1")?._id).toBe("T1");
  });
});
