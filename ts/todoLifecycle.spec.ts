import { describe, expect, it } from "vitest";
import {
  LIFECYCLES,
  canTransition,
  initialState,
  isKnownKind,
  nextStates,
  requiredGate,
  statesOf,
} from "./todoLifecycle";

describe("todoLifecycle", () => {
  it("defines all five kinds with the exact graphs taku specified", () => {
    expect(Object.keys(LIFECYCLES).sort()).toEqual([
      "code",
      "decision",
      "doc",
      "human",
      "investigation",
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

  it("the human kind has no merge/ship/QA transitions at all (taku decision #6)", () => {
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
