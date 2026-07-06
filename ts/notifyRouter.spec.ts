import { describe, expect, it } from "vitest";
import { classifyNeedsInput } from "./needsInput.ts";
import {
  type ChildObservation,
  type RouterState,
  stepRouter,
} from "./notifyRouter.ts";

// Mirror the claude `needsInput`/`working` config (rs/default.config.yaml): the
// menu cursor sits on a NUMBERED option, and a spinner marker means "working".
const CFG = {
  needsInput: [/❯ ?\d+\./m],
  working: [/esc to interrupt/, /to run in background/],
};

const child = (over: Partial<ChildObservation> = {}): ChildObservation => ({
  pid: 100,
  wrapper_pid: 100,
  started_at: 7000,
  parent_pid: 1,
  parent_started_at: 3000,
  cli: "claude",
  cwd: "/repo",
  state: "active",
  question: null,
  ...over,
});

const step = (prev: RouterState, obs: ChildObservation[], now: number, idleConfirmMs = 30_000) =>
  stepRouter(prev, obs, now, { idleConfirmMs });

describe("notifyRouter — idle hysteresis (P1)", () => {
  it("does NOT emit idle until the child has been idle for idleConfirmMs", () => {
    let s: RouterState = new Map();
    let r = step(s, [child({ state: "idle" })], 0);
    expect(r.events).toEqual([]); // timer just started
    s = r.next;

    r = step(s, [child({ state: "idle" })], 10_000);
    expect(r.events).toEqual([]); // still within the window
    s = r.next;

    r = step(s, [child({ state: "idle" })], 30_000);
    expect(r.events.map((e) => e.edge)).toEqual(["idle"]); // confirmed
    s = r.next;

    r = step(s, [child({ state: "idle" })], 40_000);
    expect(r.events).toEqual([]); // edge, not level — one per episode
  });

  it("treats active→idle→active→idle as two separate idle episodes", () => {
    let s: RouterState = new Map();
    s = step(s, [child({ state: "idle" })], 0).next;
    s = step(s, [child({ state: "idle" })], 30_000).next; // episode 1 emits
    // work resumes — resets the episode
    s = step(s, [child({ state: "active" })], 35_000).next;
    let r = step(s, [child({ state: "idle" })], 40_000);
    expect(r.events).toEqual([]); // new episode, timer restarts
    s = r.next;
    r = step(s, [child({ state: "idle" })], 70_000);
    expect(r.events.map((e) => e.edge)).toEqual(["idle"]); // episode 2 emits
  });

  it("a long silent working spell (state stays active) never emits idle", () => {
    // The load-bearing guard: a 2-minute test run is `active`, not `idle`, so no
    // amount of elapsed wall-clock produces a false idle edge.
    let s: RouterState = new Map();
    for (const t of [0, 30_000, 60_000, 120_000]) {
      const r = step(s, [child({ state: "active" })], t);
      expect(r.events).toEqual([]);
      s = r.next;
    }
  });
});

describe("notifyRouter — needs_input", () => {
  it("emits immediately on entering needs_input, with the question", () => {
    const r = step(new Map(), [child({ state: "needs_input", question: "Approve? 1.Yes 2.No" })], 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.edge).toBe("needs_input");
    expect(r.events[0]!.question).toBe("Approve? 1.Yes 2.No");
  });

  it("does not re-fire while the same question stays on screen", () => {
    let s: RouterState = new Map();
    s = step(s, [child({ state: "needs_input", question: "Q1" })], 0).next;
    const r = step(s, [child({ state: "needs_input", question: "Q1" })], 1_000);
    expect(r.events).toEqual([]);
  });

  it("re-fires when the compact question changes (a genuinely new question)", () => {
    let s: RouterState = new Map();
    s = step(s, [child({ state: "needs_input", question: "Q1" })], 0).next;
    const r = step(s, [child({ state: "needs_input", question: "Q2" })], 1_000);
    expect(r.events.map((e) => e.edge)).toEqual(["needs_input"]);
    expect(r.events[0]!.question).toBe("Q2");
  });
});

describe("notifyRouter — exited", () => {
  it("emits exactly once on stop", () => {
    let s: RouterState = new Map();
    let r = step(s, [child({ state: "stopped" })], 0);
    expect(r.events.map((e) => e.edge)).toEqual(["exited"]);
    s = r.next;
    r = step(s, [child({ state: "stopped" })], 1_000);
    expect(r.events).toEqual([]);
  });

  it("synthesizes an exited edge when a tracked child vanishes (reaped)", () => {
    let s: RouterState = new Map();
    s = step(s, [child({ state: "active" })], 0).next; // now tracked
    const r = step(s, [], 1_000); // child gone from the live set
    expect(r.events.map((e) => e.edge)).toEqual(["exited"]);
    expect(r.events[0]!.child_pid).toBe(100);
    // C2/I3: the synthetic exited must carry BOTH start times even though the
    // child is gone from the current observation — else the pid-reuse guards
    // (child on reconcile, parent on the read side) can't verify identity and
    // a recycled pid's edge could be suppressed or mis-delivered.
    expect(r.events[0]!.child_started_at).toBe(7000);
    expect(r.events[0]!.parent_started_at).toBe(3000);
    expect(r.next.has(100)).toBe(false); // forgotten
  });

  it("does not synthesize a second exited if we already emitted stopped", () => {
    let s: RouterState = new Map();
    s = step(s, [child({ state: "stopped" })], 0).next; // emitted exited
    const r = step(s, [], 1_000); // then reaped
    expect(r.events).toEqual([]);
  });
});

describe("notifyRouter — routing scope", () => {
  it("ignores children with no parent_pid (top-level agents)", () => {
    const r = step(new Map(), [child({ state: "needs_input", parent_pid: 0, question: "Q" })], 0);
    expect(r.events).toEqual([]);
  });

  it("addresses each edge to the child's parent_pid", () => {
    const r = step(new Map(), [child({ state: "stopped", parent_pid: 42 })], 0);
    expect(r.events[0]!.parent_pid).toBe(42);
  });
});

// P1 regression: the real render the parent hit — a child parked at an idle
// prompt with a RESOLVED prior menu lingering in scrollback must NOT be
// misclassified as needs_input (which would mask the idle edge).
describe("notifyRouter — idle-prompt fixture (P1 regression)", () => {
  const idlePromptWithResolvedMenu = [
    "  Do you want to proceed?",
    "  1. Yes",
    "  2. No, keep planning",
    "  ⎿  Selected 1. Yes",
    "",
    "● Committed as abc1234 and pushed to origin/feat-x.",
    "",
    "╭──────────────────────────────────────────╮",
    "│ > push it                                │",
    "╰──────────────────────────────────────────╯",
    "  ? for shortcuts",
  ];

  it("a resolved menu in scrollback is NOT needs_input (cursor not on a number)", () => {
    // The numbered options linger but no `❯ N.` cursor remains — so the screen
    // is quiet, classified idle, not needs_input.
    expect(classifyNeedsInput(idlePromptWithResolvedMenu, CFG)).toBeNull();
  });

  it("an ACTIVE menu (cursor on a number) still classifies as needs_input", () => {
    const activeMenu = [
      "  Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No, keep planning",
    ];
    expect(classifyNeedsInput(activeMenu, CFG)).not.toBeNull();
  });

  it("a working spinner wins over a lingering menu (no false needs_input)", () => {
    const workingWithOldMenu = ["❯ 2. No, keep planning", "● Running tests… (esc to interrupt)"];
    expect(classifyNeedsInput(workingWithOldMenu, CFG)).toBeNull();
  });

  it("end-to-end: such an idle child emits ONE idle edge after the confirm window", () => {
    // Feeding the router the `idle` state (what deriveLiveState yields for the
    // fixture above) produces exactly one idle edge per episode.
    let s: RouterState = new Map();
    s = step(s, [child({ state: "idle" })], 0).next;
    const r = step(s, [child({ state: "idle" })], 30_000);
    expect(r.events.map((e) => e.edge)).toEqual(["idle"]);
  });
});

describe("notifyRouter — carry-forward vs exited (C2: watcher-lapse ≠ child-death)", () => {
  it("carries forward an unobserved SAME child (alive, matching start time)", () => {
    // Track a child, then a tick with NO observation of it but the SAME child
    // still alive (matching started_at → parent's watcher merely lapsed).
    let s: RouterState = new Map();
    s = stepRouter(s, [child({ pid: 100, started_at: 7000, state: "active" })], 0).next;
    const r = stepRouter(s, [], 1_000, { aliveChildStartedAt: new Map([[100, 7000]]) });
    expect(r.events).toEqual([]); // no false exited
    expect(r.next.has(100)).toBe(true); // carried forward
    expect(r.next.get(100)!.started_at).toBe(7000); // identity preserved
  });

  it("synthesizes exited when the child's pid is not alive at all", () => {
    let s: RouterState = new Map();
    s = stepRouter(s, [child({ pid: 100, state: "active" })], 0).next;
    const r = stepRouter(s, [], 1_000, { aliveChildStartedAt: new Map() }); // pid dead
    expect(r.events.map((e) => e.edge)).toEqual(["exited"]);
    expect(r.events[0]!.child_started_at).toBe(7000);
  });

  it("synthesizes exited IMMEDIATELY when the pid is reused by a different child during a lapse", () => {
    // The identity-aware fix: pid 100 is alive but its start time now differs
    // (7000 → 9000) — the old child died and its pid was reused. We must NOT
    // carry it forward as if still running; emit the old child's exited now, no
    // waiting for the watcher to return.
    let s: RouterState = new Map();
    s = stepRouter(s, [child({ pid: 100, started_at: 7000, state: "active" })], 0).next;
    const r = stepRouter(s, [], 1_000, { aliveChildStartedAt: new Map([[100, 9000]]) });
    expect(r.events.map((e) => e.edge)).toEqual(["exited"]);
    expect(r.events[0]!.child_started_at).toBe(7000); // the OLD child's identity
    expect(r.next.has(100)).toBe(false); // dropped
  });

  it("recovers the old child's exited on watcher RETURN (same-child lapse then reuse)", () => {
    // Child tracked; watcher lapses with the SAME child still alive (carried);
    // when the watcher returns, the pid is observed with a NEW start time → the
    // old child's exited is recovered by the hot-path guard, new child fresh.
    let s: RouterState = new Map();
    s = stepRouter(s, [child({ pid: 100, started_at: 1000, state: "idle" })], 0).next;
    s = stepRouter(s, [], 1_000, { aliveChildStartedAt: new Map([[100, 1000]]) }).next; // carried
    const r = stepRouter(
      s,
      [child({ pid: 100, started_at: 2000, state: "needs_input", question: "New?" })],
      2_000,
    );
    const edges = r.events.map((e) => e.edge);
    expect(edges).toContain("exited"); // old child (1000) recovered
    expect(r.events.find((e) => e.edge === "exited")!.child_started_at).toBe(1000);
    expect(edges).toContain("needs_input"); // new child (2000) fresh
    expect(r.next.get(100)!.started_at).toBe(2000);
  });
});

describe("notifyRouter — hot-path pid reuse (Important)", () => {
  it("treats a same-pid child with a NEW start time as a fresh child", () => {
    // Old child exits at pid 100; then pid 100 is recycled by a NEW child that
    // goes needs_input. The new child's needs_input must fire (not be suppressed
    // by the old child's state), and the old child gets a synthetic exited.
    let s: RouterState = new Map();
    s = step(s, [child({ pid: 100, started_at: 1000, state: "idle" })], 0).next;
    s = step(s, [child({ pid: 100, started_at: 1000, state: "idle" })], 30_000).next; // old idle-emitted
    const r = step(
      s,
      [child({ pid: 100, started_at: 2000, state: "needs_input", question: "New?" })],
      31_000,
    );
    const edges = r.events.map((e) => e.edge);
    expect(edges).toContain("exited"); // old child (started_at 1000) closed out
    expect(edges).toContain("needs_input"); // new child (started_at 2000) fires
    expect(r.events.find((e) => e.edge === "exited")!.child_started_at).toBe(1000);
    expect(r.events.find((e) => e.edge === "needs_input")!.child_started_at).toBe(2000);
    // The next state reflects the NEW child only.
    expect(r.next.get(100)!.started_at).toBe(2000);
    expect(r.next.get(100)!.exitedEmitted).toBe(false);
  });

  it("does NOT inherit emitted-memory from a tracked state with no start time (fail-safe)", () => {
    // Old state seeded WITHOUT a start time (unverifiable). A same-pid child now
    // observed with a start time must NOT inherit idleEmitted/exitedEmitted — else
    // its first edge is suppressed. It rebuilds fresh (a duplicate is acceptable),
    // and NO synthetic exited is emitted (it may be the same child).
    const seeded: RouterState = new Map([
      [
        100,
        {
          parent_pid: 1,
          started_at: undefined, // unverifiable
          cli: "claude",
          cwd: "/repo",
          state: "idle",
          idleSince: 0,
          idleEmitted: true, // already emitted for the OLD episode
          inNeedsInput: false,
          needsInputQuestion: null,
          exitedEmitted: false,
        },
      ],
    ]);
    const r = stepRouter(seeded, [child({ pid: 100, started_at: 5000, state: "idle" })], 0, {
      idleConfirmMs: 30_000,
    });
    expect(r.events.some((e) => e.edge === "exited")).toBe(false); // no false exited
    expect(r.next.get(100)!.idleEmitted).toBe(false); // fresh — not inherited
    expect(r.next.get(100)!.started_at).toBe(5000);
  });

  it("does not double-close an old child that had already exited", () => {
    let s: RouterState = new Map();
    s = step(s, [child({ pid: 100, started_at: 1000, state: "stopped" })], 0).next; // exited emitted
    const r = step(s, [child({ pid: 100, started_at: 2000, state: "idle" })], 1_000);
    // Old child already exited → no second exited; new child just starts its idle timer.
    expect(r.events).toEqual([]);
    expect(r.next.get(100)!.started_at).toBe(2000);
  });
});

describe("notifyRouter — startup reconcile (baseline)", () => {
  it("emits needs_input immediately for a child already blocked at daemon start", () => {
    const r = step(new Map(), [child({ state: "needs_input", question: "Q" })], 5_000);
    expect(r.events.map((e) => e.edge)).toEqual(["needs_input"]);
  });

  it("emits exited immediately for a child already stopped at daemon start", () => {
    const r = step(new Map(), [child({ state: "stopped" })], 5_000);
    expect(r.events.map((e) => e.edge)).toEqual(["exited"]);
  });

  it("a child already idle at start emits only after the confirm window (from now)", () => {
    let s: RouterState = new Map();
    let r = step(s, [child({ state: "idle" })], 5_000);
    expect(r.events).toEqual([]); // timer anchored at first observation
    s = r.next;
    r = step(s, [child({ state: "idle" })], 35_000);
    expect(r.events.map((e) => e.edge)).toEqual(["idle"]);
  });

  it("respects a SEEDED prior state (no duplicate baseline across daemon restart)", () => {
    // The daemon seeds prior emitted state from the inbox so a restart doesn't
    // re-emit. A seeded exitedEmitted child that is still `stopped` stays quiet —
    // the seed carries the SAME start time as the observation, so the identity is
    // verifiable and the emitted-memory is (correctly) inherited.
    const seeded: RouterState = new Map([
      [
        100,
        {
          parent_pid: 1,
          wrapper_pid: 100,
          started_at: 7000, // matches the child() factory → verifiable identity
          cli: "claude",
          cwd: "/repo",
          state: "stopped",
          idleSince: null,
          idleEmitted: false,
          inNeedsInput: false,
          needsInputQuestion: null,
          exitedEmitted: true,
        },
      ],
    ]);
    const r = step(seeded, [child({ state: "stopped" })], 0);
    expect(r.events).toEqual([]);
  });
});
