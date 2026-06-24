/**
 * Pure transition-diffing core for `ay ls --watch` — a single NDJSON event
 * stream of agent state changes across ALL (filtered) agents, so a fan-out
 * orchestrator watches one process instead of spawning N per-pid
 * `ay status <pid> --watch`es.
 *
 * The polling/timer lives in `cmdLs`; this module is the pure, synchronous diff
 * between "what I knew last tick" and "what I see now", so it is trivially
 * unit-testable. Keeping it runtime-agnostic and side-effect-free mirrors
 * `needsInput.ts`.
 */

export type LiveState = "active" | "idle" | "stopped" | "needs_input" | "stuck";

/** The observable state of one agent at a single tick. */
export interface LsAgentState {
  pid: number;
  cli: string;
  cwd: string;
  state: LiveState;
  /** Pending menu text when state === "needs_input", else null. */
  question: string | null;
}

/** One emitted transition (NDJSON line under `ay ls --watch`). */
export interface LsWatchEvent {
  ts: number;
  pid: number;
  cli: string;
  cwd: string;
  state: LiveState;
  question: string | null;
  /**
   * The state this agent was last seen in, or null when this is the first time
   * we observe the agent (the baseline emit). Lets a consumer distinguish a
   * genuine transition from the initial snapshot.
   */
  prev_state: LiveState | null;
}

/**
 * Diff the previous per-pid states against the current snapshot and return the
 * transition events to emit plus the next prev-map. Pure: no I/O, no clock —
 * the caller passes `ts`.
 *
 * Emits an event when:
 *  - an agent is seen for the first time (baseline, `prev_state: null`)
 *  - its `state` or `question` changed since last tick
 *  - it vanished from the live set without us ever seeing it `stopped` (reaped
 *    between ticks) — a synthetic `stopped` event so a "done" transition is
 *    never silently dropped.
 */
export function diffLsStates(
  prev: Map<number, LsAgentState>,
  cur: LsAgentState[],
  ts: number,
): { events: LsWatchEvent[]; next: Map<number, LsAgentState> } {
  const events: LsWatchEvent[] = [];
  const next = new Map<number, LsAgentState>();
  const curPids = new Set<number>();

  for (const a of cur) {
    curPids.add(a.pid);
    next.set(a.pid, a);
    const p = prev.get(a.pid);
    if (!p) {
      events.push({ ...toEvent(a, ts), prev_state: null });
    } else if (p.state !== a.state || p.question !== a.question) {
      events.push({ ...toEvent(a, ts), prev_state: p.state });
    }
  }

  // Agents that dropped out of the live set (reaped) before we observed their
  // exit: synthesize a stopped transition so consumers see the agent finish.
  for (const [pid, p] of prev) {
    if (!curPids.has(pid) && p.state !== "stopped") {
      events.push({
        ts,
        pid,
        cli: p.cli,
        cwd: p.cwd,
        state: "stopped",
        question: null,
        prev_state: p.state,
      });
    }
  }

  return { events, next };
}

function toEvent(a: LsAgentState, ts: number): Omit<LsWatchEvent, "prev_state"> {
  return { ts, pid: a.pid, cli: a.cli, cwd: a.cwd, state: a.state, question: a.question };
}
