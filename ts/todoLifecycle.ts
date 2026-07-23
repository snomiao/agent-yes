/**
 * Declarative lifecycle graphs for the `ay todo` engine.
 *
 * A task has a "kind" (what shape of work it is) and each kind owns an
 * ordered set of states plus the transitions allowed between them. Some
 * transitions require a "gate" — a named condition that must be satisfied
 * before the transition is allowed. The engine (see `todoStore.ts`) enforces
 * gates at a single choke point, so `done`-family states can never be reached
 * by a plain manual flip: only a registered gate reporting success can move a
 * task into one.
 *
 * This file is pure data plus pure functions — no I/O, no process/agent
 * awareness, so it can be tested in complete isolation and reused by any
 * project that adopts `ay todo`, not just one particular team's workflow.
 * Deliberately generic: nothing here names a specific product, company, or
 * external tool. A consuming project supplies the concrete meaning of a gate
 * (e.g. what "the tests passed" means for them) via `registerGate` in
 * `todoStore.ts` — this module only knows gates by name.
 */

export type LifecycleKind = "code" | "decision" | "doc" | "investigation" | "human";

export interface LifecycleTransition {
  from: string;
  to: string;
  /** Name of the gate that must pass before this transition is allowed. Absent = always allowed. */
  gate?: string;
}

export interface LifecycleGraph {
  states: string[];
  transitions: LifecycleTransition[];
}

/**
 * States considered "finished" across every kind. A finished task is never
 * reopened by automation (see `todoAutomation.ts` in a later milestone) —
 * only a human explicitly reopening it (e.g. `verify-failed` → the kind's
 * doing state) moves a task out of a finished-adjacent state.
 */
export const DONE_STATE = "done";

export const LIFECYCLES: Record<LifecycleKind, LifecycleGraph> = {
  code: {
    states: ["doing", "merged", "shipped", "verifying", "done", "verify-failed", "orphaned"],
    transitions: [
      { from: "doing", to: "merged" },
      { from: "merged", to: "shipped" },
      { from: "shipped", to: "verifying" },
      { from: "verifying", to: "done", gate: "verify-green" },
      { from: "verifying", to: "verify-failed", gate: "verify-red" },
      // Reopening always returns to "doing", never straight back to "verifying" —
      // every re-attempt goes through a real doing→verifying cycle so a failure
      // is never silently re-run away without a fresh doing step.
      { from: "verify-failed", to: "doing" },
    ],
  },
  decision: {
    states: ["deciding", "decided", "done"],
    transitions: [
      { from: "deciding", to: "decided", gate: "human-decided" },
      { from: "decided", to: "done" },
    ],
  },
  doc: {
    states: ["drafting", "review", "done"],
    transitions: [
      { from: "drafting", to: "review" },
      { from: "review", to: "done", gate: "human-approved" },
    ],
  },
  investigation: {
    states: ["investigating", "reported", "done"],
    transitions: [
      { from: "investigating", to: "reported" },
      { from: "reported", to: "done", gate: "human-acknowledged" },
    ],
  },
  // Structurally different from the four work-shaped kinds above: no merge,
  // ship, or verify step at all. Used for every task whose entire content is
  // "a human needs to decide or answer something."
  human: {
    states: ["pending", "decided", "done"],
    transitions: [
      { from: "pending", to: "decided", gate: "human-replied" },
      { from: "decided", to: "done" },
    ],
  },
};

/** The state a newly-created task of `kind` starts in (its graph's first state). */
export function initialState(kind: LifecycleKind): string {
  const first = LIFECYCLES[kind].states[0];
  if (!first) throw new Error(`lifecycle kind "${kind}" has no states`);
  return first;
}

/** States reachable in one transition from `currentState`, regardless of gates. */
export function nextStates(kind: LifecycleKind, currentState: string): string[] {
  return LIFECYCLES[kind].transitions.filter((t) => t.from === currentState).map((t) => t.to);
}

/** Whether `from`→`to` is a transition that exists in `kind`'s graph at all (gate not evaluated here). */
export function canTransition(kind: LifecycleKind, from: string, to: string): boolean {
  return LIFECYCLES[kind].transitions.some((t) => t.from === from && t.to === to);
}

/** The gate name required for `from`→`to`, or null if the edge is ungated or does not exist. */
export function requiredGate(kind: LifecycleKind, from: string, to: string): string | null {
  const t = LIFECYCLES[kind].transitions.find((e) => e.from === from && e.to === to);
  return t?.gate ?? null;
}

/** All valid state names for `kind` — used to validate stored records and CLI input. */
export function statesOf(kind: LifecycleKind): string[] {
  return LIFECYCLES[kind].states;
}

export function isKnownKind(value: string): value is LifecycleKind {
  return value in LIFECYCLES;
}
