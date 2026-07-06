/**
 * Pure edge-detection + debounce state machine for subagent→parent
 * notifications. The heart of `ay notifyd`: given each tick's observed child
 * states, decide which EDGES to push to which parent, exactly once per episode,
 * without spamming on transient flicker.
 *
 * Design (frozen with codex + the two agents who hit the pain):
 *  - Signal is the query-layer `deriveLiveState` state — NOT a bare no-output
 *    timer. `idle` already means "idle prompt visible AND no working spinner",
 *    so a long, silent tool call (a 2-minute test run) is classified `active`
 *    and never produces a false idle edge. This is the load-bearing P1 guard.
 *  - Three edges, child→parent only (never cascade a parent's own state):
 *      needs_input : immediate; re-fire only when the COMPACT question changes.
 *      exited      : immediate, once.
 *      idle        : only after the child has been continuously `idle` for
 *                    `idleConfirmMs` (hysteresis), once per idle episode.
 *  - Edge, not level: a state that stays idle emits one edge, not one per tick.
 *  - Reaped-child safety: a child that vanishes from the live set without our
 *    seeing `stopped` gets a synthetic `exited` (mirrors `diffLsStates`).
 *
 * Pure + synchronous (no clock, no fs — the caller passes `now`) so it is
 * trivially unit-testable, like `lsWatch.ts` / `needsInput.ts`. The poll loop,
 * inbox writes, payload enrichment, and startup reconcile live in
 * `subcommands.ts` (`cmdNotifyd`); persistence lives in `notifyInbox.ts`.
 */

import type { NotifyEdge } from "./notifyInbox.ts";

/** One child's observed state this tick (from `deriveLiveState` + the registry). */
export interface ChildObservation {
  pid: number;
  wrapper_pid?: number;
  /** The parent this child links to (parent wrapper pid). Required to route. */
  parent_pid: number;
  cli: string;
  cwd: string;
  /** `deriveLiveState` state: active | idle | stopped | needs_input | stuck. */
  state: string;
  /** Compact question when state === "needs_input", else null. */
  question: string | null;
}

/** A decided notification, before the daemon enriches it (seq/ts/tail/git). */
export interface PendingNotification {
  parent_pid: number;
  child_pid: number;
  child_wrapper_pid?: number;
  cli: string;
  cwd: string;
  edge: NotifyEdge;
  prev_state: string | null;
  state: string;
  question: string | null;
}

/** Per-child debounce memory, carried across ticks. */
export interface ChildRouterState {
  parent_pid: number;
  wrapper_pid?: number;
  cli: string;
  cwd: string;
  /** Last observed state. */
  state: string;
  /** When the current idle episode began (ms), or null if not idle. */
  idleSince: number | null;
  /** Whether we already emitted the idle edge for the current episode. */
  idleEmitted: boolean;
  /** Whether we are inside a needs_input episode we've emitted at least once. */
  inNeedsInput: boolean;
  /** The compact question of the last emitted needs_input (for change re-fire). */
  needsInputQuestion: string | null;
  /** Whether we already emitted the exited edge for this child. */
  exitedEmitted: boolean;
}

export type RouterState = Map<number, ChildRouterState>;

export interface RouterConfig {
  /** How long a child must stay continuously idle before we emit an idle edge. */
  idleConfirmMs: number;
}

const DEFAULT_IDLE_CONFIRM_MS = 30_000;

/**
 * Advance the router by one tick. Returns the notifications to push plus the
 * next RouterState. Only children with a numeric `parent_pid` are considered —
 * the caller is responsible for including only opted-in children.
 *
 * First-observation (baseline / startup-reconcile) semantics: a child we've
 * never seen that is ALREADY terminal emits immediately for `needs_input` /
 * `stopped`, and starts its idle timer at `now` for `idle` (so a child parked
 * idle when the daemon starts still notifies after the confirm window). To avoid
 * re-emitting the same baseline on every daemon restart, the caller SEEDS the
 * prior state from each inbox's already-written edges (see cmdNotifyd).
 */
export function stepRouter(
  prev: RouterState,
  observations: ChildObservation[],
  now: number,
  config: Partial<RouterConfig> = {},
): { events: PendingNotification[]; next: RouterState } {
  const idleConfirmMs = config.idleConfirmMs ?? DEFAULT_IDLE_CONFIRM_MS;
  const events: PendingNotification[] = [];
  const next: RouterState = new Map();
  const seen = new Set<number>();

  for (const obs of observations) {
    if (typeof obs.parent_pid !== "number" || obs.parent_pid <= 0) continue;
    seen.add(obs.pid);
    const p = prev.get(obs.pid);
    const cs: ChildRouterState = {
      parent_pid: obs.parent_pid,
      wrapper_pid: obs.wrapper_pid,
      cli: obs.cli,
      cwd: obs.cwd,
      state: obs.state,
      idleSince: p?.idleSince ?? null,
      idleEmitted: p?.idleEmitted ?? false,
      inNeedsInput: p?.inNeedsInput ?? false,
      needsInputQuestion: p?.needsInputQuestion ?? null,
      exitedEmitted: p?.exitedEmitted ?? false,
    };
    const prevState = p?.state ?? null;
    const emit = (edge: NotifyEdge) =>
      events.push({
        parent_pid: obs.parent_pid,
        child_pid: obs.pid,
        child_wrapper_pid: obs.wrapper_pid,
        cli: obs.cli,
        cwd: obs.cwd,
        edge,
        prev_state: prevState,
        state: obs.state,
        question: edge === "needs_input" ? obs.question : null,
      });

    switch (obs.state) {
      case "needs_input": {
        // Leaving idle/other → reset those episodes.
        cs.idleSince = null;
        cs.idleEmitted = false;
        // Fire on entry, or when the compact question changed (a NEW question).
        // Compare the compact (chrome-stripped) question so a spinner/elapsed-
        // seconds cosmetic redraw doesn't double-fire.
        if (!cs.inNeedsInput || cs.needsInputQuestion !== obs.question) {
          emit("needs_input");
          cs.inNeedsInput = true;
          cs.needsInputQuestion = obs.question;
        }
        break;
      }
      case "idle": {
        cs.inNeedsInput = false;
        cs.needsInputQuestion = null;
        // Continue the episode if we were already idle; else start it now.
        if (p?.state === "idle" && p.idleSince != null) {
          cs.idleSince = p.idleSince;
          cs.idleEmitted = p.idleEmitted;
        } else {
          cs.idleSince = now;
          cs.idleEmitted = false;
        }
        if (!cs.idleEmitted && now - (cs.idleSince ?? now) >= idleConfirmMs) {
          emit("idle");
          cs.idleEmitted = true;
        }
        break;
      }
      case "stopped": {
        cs.idleSince = null;
        cs.idleEmitted = false;
        cs.inNeedsInput = false;
        cs.needsInputQuestion = null;
        if (!cs.exitedEmitted) {
          emit("exited");
          cs.exitedEmitted = true;
        }
        break;
      }
      // "active", "stuck", or any unknown busy state: real work (or a wedge) is
      // happening — reset the idle/needs_input episodes so a later idle counts
      // as a fresh episode, and emit nothing.
      default: {
        cs.idleSince = null;
        cs.idleEmitted = false;
        cs.inNeedsInput = false;
        cs.needsInputQuestion = null;
        break;
      }
    }

    next.set(obs.pid, cs);
  }

  // Reaped-child safety: a child we were tracking dropped out of the live set
  // without our observing `stopped`. Synthesize one exited edge (once) so a
  // "done" transition is never dropped, then forget it.
  for (const [pid, cs] of prev) {
    if (seen.has(pid)) continue;
    if (!cs.exitedEmitted) {
      events.push({
        parent_pid: cs.parent_pid,
        child_pid: pid,
        child_wrapper_pid: cs.wrapper_pid,
        cli: cs.cli,
        cwd: cs.cwd,
        edge: "exited",
        prev_state: cs.state,
        state: "stopped",
        question: null,
      });
    }
    // Do not carry a vanished child forward — it is gone from the registry.
  }

  return { events, next };
}
