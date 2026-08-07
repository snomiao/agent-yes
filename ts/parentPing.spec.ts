import { describe, expect, it } from "vitest";
import {
  DEFAULT_PING_CONFIG,
  initialPingState,
  repeatDelayMs,
  stepParentPing,
  type PingConfig,
  type PingObservation,
  type PingState,
} from "./parentPing.ts";

const CFG: PingConfig = {
  idleConfirmMs: 30_000,
  repeatBaseMs: 100_000,
  repeatMaxMs: 400_000,
  maxRepeats: 2,
};

/** Drive a sequence of observations, collecting every ping decided. */
function run(obs: PingObservation[], cfg = CFG) {
  let state: PingState = initialPingState();
  const pings = [];
  for (const o of obs) {
    const r = stepParentPing(state, o, cfg);
    state = r.state;
    if (r.ping) pings.push(r.ping);
  }
  return { state, pings };
}

describe("repeatDelayMs", () => {
  it("doubles per attempt and caps", () => {
    expect(repeatDelayMs(1, CFG)).toBe(100_000);
    expect(repeatDelayMs(2, CFG)).toBe(200_000);
    expect(repeatDelayMs(3, CFG)).toBe(400_000);
    expect(repeatDelayMs(4, CFG)).toBe(400_000); // capped
  });
});

describe("finished (settled idle)", () => {
  it("does not fire before idleConfirmMs — a breath between tool calls is not 'done'", () => {
    const { pings } = run([
      { now: 0, state: "idle" },
      { now: 10_000, state: "idle" },
      { now: 29_999, state: "idle" },
    ]);
    expect(pings).toEqual([]);
  });

  it("fires once the idle run clears idleConfirmMs", () => {
    const { pings } = run([
      { now: 0, state: "idle" },
      { now: 30_000, state: "idle" },
      { now: 35_000, state: "idle" },
    ]);
    expect(pings).toEqual([{ reason: "finished", attempt: 1, question: null }]);
  });

  it("resets the idle timer when the agent picks work back up", () => {
    const { pings } = run([
      { now: 0, state: "idle" },
      { now: 20_000, state: "active" },
      { now: 25_000, state: "idle" },
      { now: 50_000, state: "idle" }, // only 25s into the NEW idle run
    ]);
    expect(pings).toEqual([]);
  });

  it("re-arms after activity, so a second round of work reports again", () => {
    const { pings } = run([
      { now: 0, state: "idle" },
      { now: 40_000, state: "idle" }, // finished #1
      { now: 50_000, state: "active" },
      { now: 60_000, state: "idle" },
      { now: 100_000, state: "idle" }, // finished #2
    ]);
    expect(pings.map((p) => [p.reason, p.attempt])).toEqual([
      ["finished", 1],
      ["finished", 1],
    ]);
  });
});

describe("stuck (needs_input)", () => {
  it("fires immediately — a blocked agent has no hysteresis to earn", () => {
    const { pings } = run([{ now: 0, state: "needs_input", question: "Approve edit?" }]);
    expect(pings).toEqual([{ reason: "stuck", attempt: 1, question: "Approve edit?" }]);
  });

  it("does not re-fire on the same unchanged question", () => {
    const { pings } = run([
      { now: 0, state: "needs_input", question: "Approve edit?" },
      { now: 1_000, state: "needs_input", question: "Approve edit?" },
      { now: 2_000, state: "needs_input", question: "Approve edit?" },
    ]);
    expect(pings).toHaveLength(1);
  });

  it("re-fires on a CHANGED question — that is new information, not a repeat", () => {
    const { pings } = run([
      { now: 0, state: "needs_input", question: "Approve edit?" },
      { now: 1_000, state: "needs_input", question: "Run tests?" },
    ]);
    expect(pings.map((p) => p.question)).toEqual(["Approve edit?", "Run tests?"]);
    expect(pings.every((p) => p.attempt === 1)).toBe(true);
  });

  it("a stuck episode that decays to plain idle stays 'stuck', never 'finished'", () => {
    const { pings } = run([
      { now: 0, state: "needs_input", question: "Approve edit?" },
      { now: 1_000, state: "idle" },
      { now: 200_000, state: "idle" },
    ]);
    expect(pings.map((p) => p.reason)).toEqual(["stuck", "stuck"]);
  });
});

describe("keep pinging until something changes", () => {
  it("repeats an unanswered episode on the backoff, up to maxRepeats", () => {
    const { pings } = run([
      { now: 0, state: "needs_input", question: "q" }, // attempt 1
      { now: 99_000, state: "needs_input", question: "q" }, // not due
      { now: 100_000, state: "needs_input", question: "q" }, // attempt 2
      { now: 300_000, state: "needs_input", question: "q" }, // attempt 3
      { now: 900_000, state: "needs_input", question: "q" }, // maxRepeats exhausted
      { now: 999_999, state: "needs_input", question: "q" },
    ]);
    expect(pings.map((p) => p.attempt)).toEqual([1, 2, 3]);
  });

  it("stops nagging once the agent goes active again", () => {
    const { pings } = run([
      { now: 0, state: "needs_input", question: "q" },
      { now: 100_000, state: "active" },
      { now: 500_000, state: "active" },
    ]);
    expect(pings).toHaveLength(1);
  });
});

describe("exited", () => {
  it("fires once and is terminal — nothing follows it", () => {
    const { pings } = run([
      { now: 0, state: "active" },
      { now: 1_000, state: "exited" },
      { now: 2_000, state: "exited" },
      { now: 3_000, state: "idle" },
      { now: 400_000, state: "idle" },
    ]);
    expect(pings).toEqual([{ reason: "exited", attempt: 1, question: null }]);
  });

  it("supersedes an open stuck episode", () => {
    const { pings } = run([
      { now: 0, state: "needs_input", question: "q" },
      { now: 1_000, state: "exited" },
    ]);
    expect(pings.map((p) => p.reason)).toEqual(["stuck", "exited"]);
  });
});

describe("defaults", () => {
  it("ships a 30s idle confirm, matching notifyRouter", () => {
    expect(DEFAULT_PING_CONFIG.idleConfirmMs).toBe(30_000);
  });

  it("uses the shipped defaults when no config is passed", () => {
    let s = initialPingState();
    let r = stepParentPing(s, { now: 0, state: "idle" });
    expect(r.ping).toBeNull();
    r = stepParentPing(r.state, { now: 29_000, state: "idle" });
    expect(r.ping).toBeNull();
    r = stepParentPing(r.state, { now: 31_000, state: "idle" });
    expect(r.ping?.reason).toBe("finished");
  });
});
