import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { rm } from "fs/promises";
import path from "path";
import { TodoStore, CycleError, openStore, acquireIdLock, releaseIdLock } from "./todoStore";

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
    // whitespace must not bypass the check either direction (codex-review Important)
    await expect(s.approve(t._id, "human-approved", "worker ")).rejects.toThrow(
      /independent verification required/,
    );
    const t2 = await s.create({ summary: "y", kind: "doc", owner: " worker " });
    await s.transition(t2._id, "review");
    await expect(s.approve(t2._id, "human-approved", "worker")).rejects.toThrow(
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

  it("verify() with an explicit gateName that matches no edge from the current state throws", async () => {
    const s = await openStore(TEST_ROOT);
    s.registerGate({ name: "verify-green", check: async () => ({ passed: true }) });
    const t = await s.create({ summary: "x", kind: "code" });
    await s.transition(t._id, "merged");
    await s.transition(t._id, "shipped");
    await s.transition(t._id, "verifying");
    await expect(s.verify(t._id, "no-such-gate")).rejects.toThrow(/no registered gate found/);
  });

  it("verify() failing with no sibling edge to fall back to throws instead of silently dropping the failure", async () => {
    const s = await openStore(TEST_ROOT);
    s.registerGate({
      name: "human-approved",
      check: async () => ({ passed: false, note: "not ready" }),
    });
    const t = await s.create({ summary: "x", kind: "doc" });
    await s.transition(t._id, "review"); // "review" has ONE outgoing gated edge (to done) — no sibling
    await expect(s.verify(t._id)).rejects.toThrow(/no alternate transition/);
  });

  it("isRegisteredGate reports registration status by name", async () => {
    const s = await openStore(TEST_ROOT);
    expect(s.isRegisteredGate("verify-green")).toBe(false);
    s.registerGate({ name: "verify-green", check: async () => ({ passed: true }) });
    expect(s.isRegisteredGate("verify-green")).toBe(true);
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

  it("a cleared block ACTUALLY clears after a fresh reload — not just in the instance that cleared it (codex-review Critical)", async () => {
    const s1 = await openStore(TEST_ROOT);
    const t = await s1.create({ summary: "x", kind: "code" });
    await s1.setBlock(t._id, { type: "blocked-by-human", who: "someone" });
    await s1.setBlock(t._id, null);
    // the bug: JSON.stringify({block: undefined}) drops the key, so the
    // clearing update line carried no `block` field at all, and the merge
    // `{...existing, ...doc}` left the OLD block value in place once a
    // DIFFERENT (or freshly reloaded) instance read it back from disk.
    const s2 = await openStore(TEST_ROOT);
    expect(s2.get(t._id)?.block).toBeFalsy();
  });

  it("N concurrent OS processes calling create() against the same store never collide on an id (codex-review Critical)", async () => {
    const N = 8;
    const script = path.join(TEST_ROOT, "create-once.ts");
    const { writeFileSync, mkdirSync } = await import("fs");
    mkdirSync(TEST_ROOT, { recursive: true });
    writeFileSync(
      script,
      `import { openStore } from ${JSON.stringify(path.join(import.meta.dirname, "todoStore.ts"))};\n` +
        `const s = await openStore(${JSON.stringify(TEST_ROOT)});\n` +
        `const t = await s.create({ summary: "concurrent", kind: "code" });\n` +
        `console.log(t._id);\n`,
    );
    // node:child_process, not Bun.spawn — vitest here runs under the node matrix too
    const { spawn } = await import("node:child_process");
    const runOne = () =>
      new Promise<string>((resolve, reject) => {
        const p = spawn("bun", [script], { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        p.stdout.on("data", (chunk) => (out += chunk.toString()));
        p.on("error", reject);
        p.on("close", () => resolve(out.trim()));
      });
    const outputs = await Promise.all(Array.from({ length: N }, runOne));
    expect(new Set(outputs).size).toBe(N); // every id distinct — none silently overwritten
    const s = await openStore(TEST_ROOT);
    expect(s.list()).toHaveLength(N); // every task actually persisted, not clobbered
  }, 30_000);

  it("a held id lock makes create() throw a timeout, never silently proceed unlocked (codex-review round-2 Critical)", async () => {
    const s = await openStore(TEST_ROOT);
    const { mkdirSync: mkSync, writeFileSync: wf } = await import("fs");
    const lockPath = path.join(TEST_ROOT, ".agent-yes", "todos.jsonl.idlock");
    mkSync(path.dirname(lockPath), { recursive: true });
    wf(lockPath, "someone-elses-token"); // simulate another process holding the lock, freshly
    await expect(s.create({ summary: "x", kind: "code" })).rejects.toThrow(/timed out waiting for/);
    // and the lock must NOT have been deleted by the failed attempt (that
    // would let a second unlocked caller in right after this one)
    const { readFileSync: rf } = await import("fs");
    expect(rf(lockPath, "utf8")).toBe("someone-elses-token"); // untouched — not stolen, not released
  }, 15_000);

  it("acquireIdLock/releaseIdLock: release is ownership-safe — a stolen-then-reissued lock survives the ORIGINAL holder's release call (codex-review round-3 Critical)", async () => {
    const lockPath = path.join(TEST_ROOT, ".agent-yes", "todos.jsonl.idlock");
    const { mkdirSync: mkSync } = await import("fs");
    mkSync(path.dirname(lockPath), { recursive: true });

    const tokenA = await acquireIdLock(lockPath, { staleMs: 10_000 });
    expect(tokenA).not.toBeNull();

    // Simulate: tokenA's holder ran long enough to go stale; a second
    // acquirer legitimately steals and reissues the lock under tokenB.
    const { utimesSync } = await import("fs");
    utimesSync(lockPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const tokenB = await acquireIdLock(lockPath, { staleMs: 10_000 });
    expect(tokenB).not.toBeNull();
    expect(tokenB).not.toBe(tokenA);

    // The ORIGINAL (stale) holder now reaches its own release call. Without
    // the ownership check, this would delete tokenB's live lock.
    releaseIdLock(lockPath, tokenA!);
    const { readFileSync: rf } = await import("fs");
    expect(rf(lockPath, "utf8")).toBe(tokenB); // tokenB's lock is untouched

    // tokenB's own release, by contrast, DOES remove it (it still owns it).
    releaseIdLock(lockPath, tokenB!);
    const { existsSync } = await import("fs");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("acquireIdLock returns null (never throws, never proceeds) when the wait budget is exhausted against a live lock", async () => {
    const lockPath = path.join(TEST_ROOT, ".agent-yes", "todos.jsonl.idlock");
    const { mkdirSync: mkSync, writeFileSync: wf } = await import("fs");
    mkSync(path.dirname(lockPath), { recursive: true });
    wf(lockPath, "someone-elses-fresh-token");
    const result = await acquireIdLock(lockPath, { staleMs: 10_000, maxAttempts: 3 });
    expect(result).toBeNull();
  });

  it("verify() on a NON-primary registered gate must not fall back to the sibling on failure (codex-review Critical exploit: register only the failure-oriented gate)", async () => {
    const s = await openStore(TEST_ROOT);
    // Only "verify-red" (the SECOND/non-primary gated edge from "verifying")
    // is registered — "verify-green" (the primary edge, listed first in
    // todoLifecycle.ts) is NOT. A naive "always fall back to the sibling on
    // not-passed" implementation would read this false as license to reach
    // the sibling edge, which happens to be "done".
    s.registerGate({
      name: "verify-red",
      check: async () => ({ passed: false, note: "not confirmed red" }),
    });
    const t = await s.create({ summary: "x", kind: "code" });
    await s.transition(t._id, "merged");
    await s.transition(t._id, "shipped");
    await s.transition(t._id, "verifying");
    await expect(s.verify(t._id)).rejects.toThrow(/non-primary gate.*not passed/);
    expect(s.get(t._id)?.state).toBe("verifying"); // unchanged — definitely not "done"
  });

  it("verify() on a non-primary gate DOES apply its own edge when it reports passed", async () => {
    const s = await openStore(TEST_ROOT);
    s.registerGate({
      name: "verify-red",
      check: async () => ({ passed: true, note: "confirmed red" }),
    });
    const t = await s.create({ summary: "x", kind: "code" });
    await s.transition(t._id, "merged");
    await s.transition(t._id, "shipped");
    await s.transition(t._id, "verifying");
    const result = await s.verify(t._id);
    expect(result.state).toBe("verify-failed");
  });
});
