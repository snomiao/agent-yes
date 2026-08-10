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
  // `options` (choice-shape, A7): the human picks one via /ask's buttons.
  // `actionLink` (action-shape, A7): the human must personally complete
  // something at that URL (e.g. an OAuth/CAPTCHA flow) — /ask renders an
  // "open link, then confirm" button instead of a choice list. At most one
  // of the two is expected to be set; neither is required (a bare question
  // with no options/actionLink just needs an acknowledgement).
  | {
      type: "blocked-by-human";
      who: string;
      question?: string;
      options?: string[];
      actionLink?: string;
    }
  | { type: "blocked-by-external"; signal: string; checkFn?: string }
  | { type: "waiting-on-agent"; agentId: string }
  // `ay ask`: this task's owner asked `agentId` a question and is waiting for
  // the answer. Deliberately NOT modelled as either neighbouring shape —
  //   - `waiting-on-agent` is auto-cleared by reconcile as soon as that agent
  //     goes idle or exits 0. Right for "wait until it finishes", exactly
  //     wrong here: an agent going idle WITHOUT answering would clear the
  //     block and make an unanswered question look unblocked.
  //   - `blocked-by-human` is precisely what the `/ask` decision panel selects
  //     on (`listAsksForProject`), so reusing it would push agent-to-agent
  //     asks into a human's inbox.
  // Keeping the answerer on the record instead of clearing it is also what
  // lets `ay todo ls` answer "is the agent that owes me an answer still alive?"
  | { type: "waiting-on-answer"; agentId: string; question?: string };

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
    // An answer arrives as an `ay answer` call from the agent that owes it, so
    // there is nothing to poll — but that agent's own lifecycle events are
    // still worth watching, since it can die owing the answer.
    case "waiting-on-answer":
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
      return `waiting on ${block.who}${block.question ? `: ${block.question}` : ""}${block.actionLink ? ` (action: ${block.actionLink})` : ""}`;
    case "blocked-by-external":
      return `waiting on external signal: ${block.signal}`;
    case "waiting-on-agent":
      return `waiting on agent ${block.agentId}`;
    case "waiting-on-answer":
      return `waiting for an answer from ${block.agentId}${block.question ? `: ${block.question}` : ""}`;
  }
}

/**
 * The agent this block is waiting on, if any — the one identifier a caller
 * needs to ask "is that party still alive?". Centralised so every surface
 * (list rendering, reconcile, JSON output) agrees on which block shapes name
 * an agent, instead of each one re-listing the cases and quietly missing the
 * next shape that gets added.
 */
export function blockedOnAgent(block: TodoBlock | null | undefined): string | null {
  if (!block) return null;
  return block.type === "waiting-on-agent" || block.type === "waiting-on-answer"
    ? block.agentId
    : null;
}
