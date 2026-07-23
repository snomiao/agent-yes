/**
 * Typed blocks for the `ay todo` engine.
 *
 * A task that cannot currently proceed records WHY, as one of four typed
 * shapes rather than a free-text string. The type tells the engine (and any
 * automation built on top of it, see `todoAutomation.ts` in a later
 * milestone) exactly how to detect that the wait is over:
 *
 *   - blocked-by-task: waiting on another task in the same store. Clears
 *     itself the moment that task reaches its kind's `done` state — this is
 *     pure data (see `todoDigest.ts`'s `unblockedTasks`), no monitor needed.
 *   - blocked-by-human: waiting on a specific person to answer or decide
 *     something. Needs NO monitor at all — a human's reply always arrives as
 *     a message that human chooses to send (e.g. via the `/ask` decision
 *     panel, a later milestone), so there is nothing to poll.
 *   - blocked-by-external: waiting on some signal outside this store and
 *     outside any tracked agent (a CI run, a release, a third-party event).
 *     Needs an actual poll/monitor loop.
 *   - waiting-on-agent: waiting on a specific tracked agent process to reach
 *     some point (finish, go idle, etc). Cleared by that agent's own
 *     lifecycle events (via `ay notify`, wired in a later milestone).
 */

export type TodoBlock =
  | { type: "blocked-by-task"; taskId: string }
  | { type: "blocked-by-human"; who: string; question?: string; options?: string[] }
  | { type: "blocked-by-external"; signal: string; checkFn?: string }
  | { type: "waiting-on-agent"; agentId: string };

export type MonitorHint = "none" | "notify-agent" | "poll-external";

/**
 * How a block of this type should be watched. Kept as one pure function so
 * every caller (CLI rendering, automation, `/ask` aggregation) agrees on the
 * same classification instead of re-deriving it ad hoc.
 */
export function monitorHint(block: TodoBlock): MonitorHint {
  switch (block.type) {
    case "blocked-by-task":
    case "blocked-by-human":
      return "none";
    case "waiting-on-agent":
      return "notify-agent";
    case "blocked-by-external":
      return "poll-external";
  }
}

/** One-line human-readable summary, used by CLI/digest rendering. */
export function describeBlock(block: TodoBlock): string {
  switch (block.type) {
    case "blocked-by-task":
      return `blocked by task ${block.taskId}`;
    case "blocked-by-human":
      return `waiting on ${block.who}${block.question ? `: ${block.question}` : ""}`;
    case "blocked-by-external":
      return `waiting on external signal: ${block.signal}`;
    case "waiting-on-agent":
      return `waiting on agent ${block.agentId}`;
  }
}
