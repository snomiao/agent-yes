/**
 * Reactive layer for the `ay todo` engine (Milestone 2): makes the engine
 * self-driving for agent-facing signals `agent-yes` already tracks, instead
 * of requiring every state change to be typed by hand.
 *
 * `reconcileTodos` is pure — decision logic only, no I/O — exactly the same
 * "decide" / "do" split `symval-dev-cli`'s existing `watchdog.ts`
 * (`decideActions`) already uses successfully: the hard-to-get-right parts
 * (edge cases) live in a function that takes plain data in and returns plain
 * data out, so they are trivially unit-testable without a real store, real
 * processes, or real time. Applying the returned actions to a real
 * `TodoStore` (I/O) is a separate, thin step (see `todoCli.ts`'s `reconcile`
 * verb) deliberately kept out of this file — including revalidating each
 * action against a FRESH record immediately before writing, since the
 * snapshot this function decided from can be stale by the time the caller
 * applies it (codex-review Important, see the action shapes below).
 */

import { DONE_STATE, LIFECYCLES, ORPHANED_STATE } from "./todoLifecycle.ts";
import { unblockedTasks } from "./todoDigest.ts";
import type { TodoRecord } from "./todoStore.ts";

/** The minimal shape this module needs from a live-agent record — matches `GlobalPidRecord` from `globalPidIndex.ts` (the same cross-runtime registry `ay ls` reads), kept narrow so this file has no import-time dependency on it. */
export interface LiveAgent {
  agent_id?: string | null;
  status: "active" | "idle" | "exited";
  exit_code?: number | null;
}

export type TodoAction =
  // `expectedOwner` is carried so the applying caller can revalidate against
  // a FRESH record before writing: the decision was made from a snapshot,
  // and another process may have reassigned the task (to a still-live
  // owner) in the meantime — applying blindly by `taskId` alone would
  // orphan a task that no longer belongs to the dead agent at all
  // (codex-review Important).
  | { type: "orphan"; taskId: string; from: string; expectedOwner: string; candidates: string[] }
  // Same reasoning: `expectedAgentId` lets the applying caller refuse to
  // clear the block if it changed to something else (e.g. a newer manual
  // `blocked-by-human`) since this action was decided (codex-review Important).
  | { type: "clear-waiting-on-agent"; taskId: string; expectedAgentId: string }
  | { type: "notify-unblocked"; taskId: string; owner: string }
  | { type: "auto-verify"; taskId: string };

/**
 * `TodoRecord.owner` is opaque — a human name/handle OR a tracked agent's
 * stable id, this module cannot tell which just by looking at the string.
 * The only safe signal is whether the identifier appears in the live-agent
 * registry AT ALL: a KNOWN agent id whose latest record says `exited` is
 * confirmed dead and orphan-eligible; an identifier with NO record at all is
 * assumed to be a human owner (who was never going to appear there) and is
 * never orphaned on that basis alone. Getting this backwards would orphan
 * every human-owned task on every tick, since a human obviously never shows
 * up in the agent process table.
 */
function deadOwnerAgent(ownerId: string, agents: LiveAgent[]): boolean {
  const rec = agents.find((a) => a.agent_id === ownerId);
  return rec !== undefined && rec.status === "exited";
}

/** Up to `limit` OTHER agent ids currently idle — candidates to hand an orphaned task to. */
function idleCandidates(excludeAgentId: string, agents: LiveAgent[], limit = 3): string[] {
  return agents
    .filter((a): a is LiveAgent & { agent_id: string } => !!a.agent_id)
    .filter((a) => a.agent_id !== excludeAgentId && a.status === "idle")
    .map((a) => a.agent_id)
    .slice(0, limit);
}

/**
 * Decide what should happen given the current tasks and the current live-agent
 * snapshot. Four rules, each traceable to a specific requirement (see
 * `docs/2026-07-23-todo-lifecycle-execplan.md`'s Milestone 2 section):
 *
 *  - owner's agent process is gone and the task isn't finished → `orphan`.
 *  - a `waiting-on-agent` block whose agent went idle or exited successfully
 *    (exit code 0) → `clear-waiting-on-agent`.
 *  - a task currently in `unblockedTasks()` with an owner → `notify-unblocked`,
 *    reported on EVERY call (no dedup/state file): there is no real delivery
 *    channel wired yet (see `todoCli.ts`'s `reconcile` verb doc comment), so
 *    persisting "already notified" would silently retire the one signal an
 *    owner would ever get with nobody having actually received it
 *    (codex-review Important) — the same no-dedup convention `renderDigest`'s
 *    own "unblocked" section already uses.
 *  - a task in a state whose outgoing edge's gate is registered → `auto-verify`
 *    (the actual gate CALL is real I/O and happens in the caller via `store.verify()`;
 *    this only decides which tasks are eligible to try).
 *
 * An orphaned task is skipped for the OTHER rules this same tick (its owner is
 * gone, so it cannot also be "waiting on" that same dead agent in a meaningful
 * way, and it is no longer eligible for auto-verify either).
 */
export function reconcileTodos(
  tasks: TodoRecord[],
  agents: LiveAgent[],
  registeredGates: Set<string>,
): TodoAction[] {
  const actions: TodoAction[] = [];
  const orphanedThisTick = new Set<string>();

  for (const t of tasks) {
    if (t.state === DONE_STATE || t.state === ORPHANED_STATE) continue;
    if (t.owner && deadOwnerAgent(t.owner, agents)) {
      actions.push({
        type: "orphan",
        taskId: t._id,
        from: t.state,
        expectedOwner: t.owner,
        candidates: idleCandidates(t.owner, agents),
      });
      orphanedThisTick.add(t._id);
      continue;
    }
    if (t.block?.type === "waiting-on-agent") {
      const agentId = t.block.agentId;
      const agent = agents.find((a) => a.agent_id === agentId);
      if (
        agent &&
        (agent.status === "idle" || (agent.status === "exited" && agent.exit_code === 0))
      ) {
        actions.push({ type: "clear-waiting-on-agent", taskId: t._id, expectedAgentId: agentId });
      }
    }
    const hasEligibleGate = LIFECYCLES[t.kind].transitions.some(
      (edge) => edge.from === t.state && edge.gate && registeredGates.has(edge.gate),
    );
    if (hasEligibleGate) {
      actions.push({ type: "auto-verify", taskId: t._id });
    }
  }

  for (const t of unblockedTasks(tasks)) {
    if (orphanedThisTick.has(t._id) || !t.owner) continue;
    actions.push({ type: "notify-unblocked", taskId: t._id, owner: t.owner });
  }

  return actions;
}
