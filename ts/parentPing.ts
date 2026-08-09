/**
 * The sub-agent's own duty to PING ITS PARENT — pure edge/backoff state machine.
 *
 * `ay notifyd` already detects idle/needs_input/exited edges and files them into
 * the parent's inbox, but that is a PULL channel: nothing is delivered unless the
 * parent is running `ay notify watch`. The whole failure mode we care about is a
 * parent that spawned a fan-out and then went back to its own work — i.e. exactly
 * the parent that is NOT watching. `<ay-init-msg>` tells the child to report back,
 * but an LLM that runs out of steam mid-task, crashes, or simply forgets will not.
 *
 * So the CHILD'S WRAPPER pushes, unconditionally: when the agent it supervises
 * finishes (settled idle), gets stuck (parked on a question / wedged), or exits,
 * it injects a message straight into the parent's stdin via `ay send`. That is
 * the same channel a peer agent uses, so it lands in the parent's context whether
 * or not the parent ever asked for it.
 *
 * "Keep pinging": a single ping can be missed — the parent may be mid-tool-call,
 * or may have been compacted since. So an unresolved episode RE-pings on an
 * escalating backoff up to `maxRepeats`, and the whole episode resets the moment
 * the child goes active again (it got an answer, or picked the work back up).
 *
 * Pure + synchronous (the caller passes `now`) so it is unit-testable without a
 * PTY or a clock, mirroring `notifyRouter.ts`. The delivery side lives in
 * `parentPingSend.ts`; the wiring lives in `ts/index.ts`.
 */

/** What the child looks like right now, as classified by its own wrapper. */
export type SelfState = "active" | "idle" | "needs_input" | "exited";

/** Why we are pinging — becomes the report's headline. */
export type PingReason = "finished" | "stuck" | "exited";

export interface PingObservation {
  now: number;
  state: SelfState;
  /** Compact question text when state === "needs_input", else null. */
  question?: string | null;
}

export interface PingConfig {
  /** How long the child must sit continuously idle before we call it "finished". */
  idleConfirmMs: number;
  /** Delay before the FIRST repeat of an unacknowledged episode. */
  repeatBaseMs: number;
  /** Cap for the doubling backoff between repeats. */
  repeatMaxMs: number;
  /** How many times to re-ping one episode before giving up (0 = ping once). */
  maxRepeats: number;
}

export const DEFAULT_PING_CONFIG: PingConfig = {
  // Matches notifyRouter's DEFAULT_IDLE_CONFIRM_MS: long enough that a pause
  // between tool calls never reads as "done", short enough to be useful.
  idleConfirmMs: 30_000,
  repeatBaseMs: 120_000, // 2m → 4m → 8m → 15m (capped)
  repeatMaxMs: 900_000,
  maxRepeats: 4,
};

export interface PingState {
  /** Last observed state, so we can detect the transition INTO an episode. */
  state: SelfState | null;
  /** When the current idle run began, or null when not idle. */
  idleSince: number | null;
  /** The reason of the episode we are currently pinging about, or null. */
  episode: PingReason | null;
  /** The question text the current `stuck` episode was opened on. */
  episodeQuestion: string | null;
  /** How many pings this episode has already emitted (first send = 1). */
  sent: number;
  /** When the next repeat is due, or null when nothing is scheduled. */
  nextAt: number | null;
}

export function initialPingState(): PingState {
  return {
    state: null,
    idleSince: null,
    episode: null,
    episodeQuestion: null,
    sent: 0,
    nextAt: null,
  };
}

/** A decided ping, for the caller to deliver. */
export interface PingDecision {
  reason: PingReason;
  /** 1 for the first ping of an episode, 2+ for a repeat nobody answered. */
  attempt: number;
  question: string | null;
}

/** Exponential backoff for repeat N (1-based), capped. */
export function repeatDelayMs(attempt: number, cfg: PingConfig): number {
  const raw = cfg.repeatBaseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, cfg.repeatMaxMs);
}

/**
 * Advance by one tick. Returns the ping to send (or null) and the next state.
 *
 * Episode semantics:
 *  - `needs_input` opens a `stuck` episode immediately. A CHANGED question
 *    re-opens it (the agent is asking something new — that's fresh information,
 *    not a repeat), which also resets the backoff.
 *  - `idle` opens a `finished` episode only after `idleConfirmMs` of continuous
 *    idleness — hysteresis, so a breath between tool calls is not "done".
 *  - `exited` fires once, terminally, and cannot be superseded or repeated: the
 *    process is gone, so there is nothing left to re-observe.
 *  - `active` closes any open episode. The child is working again; whatever we
 *    reported is stale and the parent will hear about the next edge.
 */
export function stepParentPing(
  prev: PingState,
  obs: PingObservation,
  cfg: PingConfig = DEFAULT_PING_CONFIG,
): { state: PingState; ping: PingDecision | null } {
  const state: PingState = { ...prev };
  const question = obs.question ?? null;
  const wasExited = prev.episode === "exited";
  state.state = obs.state;

  // Terminal: once we've announced the exit there is nothing further to say.
  if (wasExited) {
    state.idleSince = null;
    state.nextAt = null;
    return { state, ping: null };
  }

  if (obs.state === "exited") {
    state.idleSince = null;
    state.episode = "exited";
    state.episodeQuestion = null;
    state.sent = 1;
    state.nextAt = null;
    return { state, ping: { reason: "exited", attempt: 1, question: null } };
  }

  if (obs.state === "active") {
    // Working again — the episode (if any) is resolved or moot.
    state.idleSince = null;
    state.episode = null;
    state.episodeQuestion = null;
    state.sent = 0;
    state.nextAt = null;
    return { state, ping: null };
  }

  if (obs.state === "needs_input") {
    state.idleSince = null;
    const isNewEpisode = prev.episode !== "stuck" || prev.episodeQuestion !== question;
    if (isNewEpisode) {
      state.episode = "stuck";
      state.episodeQuestion = question;
      state.sent = 1;
      state.nextAt = obs.now + repeatDelayMs(1, cfg);
      return { state, ping: { reason: "stuck", attempt: 1, question } };
    }
    return repeatIfDue(state, obs.now, cfg, question);
  }

  // obs.state === "idle"
  state.idleSince = prev.idleSince ?? obs.now;
  if (prev.episode === "finished") return repeatIfDue(state, obs.now, cfg, null);
  // A `stuck` episode that decayed into plain idle keeps its identity — the agent
  // is still parked on the same unanswered thing, just no longer matching the
  // question pattern (a menu that scrolled off the tail, say). Re-classifying it
  // as `finished` would tell the parent "done" about an agent that is blocked.
  if (prev.episode === "stuck") return repeatIfDue(state, obs.now, cfg, prev.episodeQuestion);
  if (obs.now - state.idleSince < cfg.idleConfirmMs) return { state, ping: null };
  state.episode = "finished";
  state.episodeQuestion = null;
  state.sent = 1;
  state.nextAt = obs.now + repeatDelayMs(1, cfg);
  return { state, ping: { reason: "finished", attempt: 1, question: null } };
}

/** Emit the next repeat of an already-open episode if its timer is due. */
function repeatIfDue(
  state: PingState,
  now: number,
  cfg: PingConfig,
  question: string | null,
): { state: PingState; ping: PingDecision | null } {
  if (state.nextAt === null || now < state.nextAt) return { state, ping: null };
  if (state.sent > cfg.maxRepeats) {
    state.nextAt = null; // gave up nagging; the inbox/`ay ls` still shows the state
    return { state, ping: null };
  }
  const attempt = state.sent + 1;
  state.sent = attempt;
  state.nextAt = attempt > cfg.maxRepeats ? null : now + repeatDelayMs(attempt, cfg);
  return { state, ping: { reason: state.episode!, attempt, question } };
}
