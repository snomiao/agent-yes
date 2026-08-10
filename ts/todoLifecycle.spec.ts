import { describe, expect, it } from "vitest";
import {
  LIFECYCLES,
  transitionsOf,
  canTransition,
  initialState,
  isKnownKind,
  nextStates,
  requiredGate,
  statesOf,
} from "./todoLifecycle";

describe("todoLifecycle", () => {
  it("defines every kind with the exact graphs the operator specified", () => {
    expect(Object.keys(LIFECYCLES).sort()).toEqual([
      "code",
      "decision",
      "doc",
      "human",
      "investigation",
      "question",
    ]);
    expect(statesOf("code")).toEqual([
      "doing",
      "merged",
      "shipped",
      "verifying",
      "done",
      "verify-failed",
      "orphaned",
    ]);
    expect(statesOf("human")).toEqual(["pending", "decided", "done"]);
    expect(statesOf("question")).toEqual(["pending", "answered", "done"]);
  });

  // Every agent on a machine shares one store while routinely running
  // DIFFERENT builds, so an older binary reads records whose kind it has never
  // heard of. Indexing LIFECYCLES directly throws there, taking down ls and
  // reconcile for every task instead of just the uninterpretable one.
  it("transitionsOf degrades to [] for a kind this build does not know, instead of throwing", () => {
    expect(transitionsOf("question").length).toBeGreaterThan(0);
    expect(transitionsOf("a-kind-from-a-newer-build")).toEqual([]);
  });

  it("initialState is each graph's first listed state", () => {
    expect(initialState("code")).toBe("doing");
    expect(initialState("human")).toBe("pending");
    expect(initialState("doc")).toBe("drafting");
  });

  it("canTransition/nextStates follow the declared edges only", () => {
    expect(canTransition("code", "doing", "merged")).toBe(true);
    expect(canTransition("code", "doing", "done")).toBe(false); // no edge skips straight to done
    expect(nextStates("code", "verifying").sort()).toEqual(["done", "verify-failed"]);
  });

  it("requiredGate reports the gate name for gated edges, null for ungated/nonexistent edges", () => {
    expect(requiredGate("code", "verifying", "done")).toBe("verify-green");
    expect(requiredGate("code", "verifying", "verify-failed")).toBe("verify-red");
    expect(requiredGate("code", "doing", "merged")).toBeNull(); // ungated
    expect(requiredGate("code", "doing", "done")).toBeNull(); // no such edge
  });

  it("verify-failed reopens ONLY to the kind's doing state, never straight back to verifying", () => {
    expect(nextStates("code", "verify-failed")).toEqual(["doing"]);
  });

  it("the human kind has no merge/ship/QA transitions at all (operator decision #6)", () => {
    const humanStates = new Set(statesOf("human"));
    for (const s of ["merged", "shipped", "verifying", "verify-failed"]) {
      expect(humanStates.has(s)).toBe(false);
    }
  });

  it("isKnownKind is a type guard over the real kind set", () => {
    expect(isKnownKind("code")).toBe(true);
    expect(isKnownKind("bogus")).toBe(false);
  });
});
