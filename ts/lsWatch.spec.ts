import { expect, test } from "vitest";
import { diffLsStates, type LsAgentState } from "./lsWatch.ts";

const agent = (
  pid: number,
  state: LsAgentState["state"],
  question: string | null = null,
): LsAgentState => ({
  pid,
  cli: "claude",
  cwd: "/repo",
  state,
  question,
});

test("first observation of each agent is a baseline event (prev_state null)", () => {
  const { events, next } = diffLsStates(new Map(), [agent(1, "active"), agent(2, "idle")], 100);
  expect(events).toHaveLength(2);
  expect(events.every((e) => e.prev_state === null)).toBe(true);
  expect(next.size).toBe(2);
});

test("no event when nothing changed", () => {
  const prev = new Map([[1, agent(1, "active")]]);
  const { events } = diffLsStates(prev, [agent(1, "active")], 200);
  expect(events).toHaveLength(0);
});

test("emits a transition when state changes (active -> needs_input)", () => {
  const prev = new Map([[1, agent(1, "active")]]);
  const { events } = diffLsStates(prev, [agent(1, "needs_input", "Pick auth?")], 300);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    pid: 1,
    state: "needs_input",
    question: "Pick auth?",
    prev_state: "active",
  });
});

test("re-emits when the question text changes within needs_input", () => {
  const prev = new Map([[1, agent(1, "needs_input", "Q1")]]);
  const { events } = diffLsStates(prev, [agent(1, "needs_input", "Q2")], 400);
  expect(events).toHaveLength(1);
  expect(events[0]!.question).toBe("Q2");
});

test("synthesizes a stopped event when an agent is reaped between ticks", () => {
  const prev = new Map([[1, agent(1, "active")]]);
  const { events, next } = diffLsStates(prev, [], 500);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ pid: 1, state: "stopped", prev_state: "active" });
  expect(next.size).toBe(0);
});

test("does not double-emit stopped for an agent already seen stopped then gone", () => {
  // Already known as stopped, then it drops out of the set → no synthetic event.
  const prev = new Map([[1, agent(1, "stopped")]]);
  const { events } = diffLsStates(prev, [], 600);
  expect(events).toHaveLength(0);
});
