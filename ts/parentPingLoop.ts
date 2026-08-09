/**
 * Wiring for the sub-agent→parent ping: a small poller the wrapper owns for its
 * OWN agent, feeding `stepParentPing` and delivering whatever it decides.
 *
 * Kept out of ts/index.ts (already ~1400 lines) and out of the auto-response
 * heartbeat: this must not share a tick budget with the thing that answers
 * permission prompts, and its classification is a different question ("is my
 * agent done/stuck?") from the heartbeat's ("does this line need a keystroke?").
 *
 * No-parent is the common case (a human-launched top-level agent), and it costs
 * nothing: we resolve the spawner once and simply never start a timer.
 */

import { classifyNeedsInput } from "./needsInput.ts";
import { logger } from "./logger.ts";
import { resolveSpawner } from "./parentLink.ts";
import { replyTargetOf } from "./initMsg.ts";
import {
  DEFAULT_PING_CONFIG,
  initialPingState,
  stepParentPing,
  type PingConfig,
  type PingState,
  type SelfState,
} from "./parentPing.ts";
import { buildPingBody, deliverPing, type PingSelf } from "./parentPingSend.ts";
import {
  isParentWatching,
  parseReportMode,
  shouldDeliverReport,
  type ReportMode,
} from "./parentWatching.ts";

const POLL_MS = 5_000;

export interface ScreenPatterns {
  ready?: RegExp[];
  working?: RegExp[];
  needsInput?: RegExp[];
}

/**
 * Classify the wrapper's own agent from its rendered screen.
 *
 * Order matters and is the same precedence `deriveLiveState` uses: a `working`
 * spinner beats everything (a long silent tool call is NOT done), then a pending
 * menu, then an idle prompt. Anything unrecognised falls back to `active` —
 * always the safe default, because a false `active` costs a delayed report while
 * a false `idle` tells the parent "finished" about an agent mid-task.
 */
export function classifySelfState(lines: string[], conf: ScreenPatterns): SelfState {
  const text = lines.join("\n");
  if (conf.working?.some((re) => re.test(text))) return "active";
  if (classifyNeedsInput(lines, conf)) return "needs_input";
  if (conf.ready?.some((re) => re.test(text))) return "idle";
  return "active";
}

export interface ParentPingLoop {
  /** Stop polling (the exit ping stays available). */
  stop(): void;
  /**
   * Report the agent's termination. Awaited on the wrapper's exit path so the
   * message is actually handed off before the process goes away.
   */
  pingExit(exitCode: number | null): Promise<void>;
  /** Resolves once the spawner lookup settled — for tests and for `ay` to know
   *  whether a parent link exists at all. */
  ready: Promise<boolean>;
}

/**
 * Start watching our own agent and reporting to whoever spawned it.
 *
 * `screen()` returns the currently-rendered tail lines (the wrapper's xterm
 * proxy); it is called on every poll, so it must be cheap and must not throw.
 */
export function startParentPingLoop(opts: {
  /** Parent WRAPPER pid inherited via AGENT_YES_PID, or undefined for a root agent. */
  parentPid: number | undefined;
  /** This wrapper's own pid — what `ay send` must attribute the report to. */
  selfWrapperPid: number;
  self: PingSelf;
  patterns: ScreenPatterns;
  screen: () => string[];
  pollMs?: number;
  config?: PingConfig;
  /**
   * Override `AGENT_YES_REPORT_PARENT`. `auto` (default) stays quiet while the
   * parent is demonstrably monitoring this child — a parent harness with its own
   * monitor loop already sees idle/needs_input/working, and an injected report on
   * top of that interrupts it for nothing. See ts/parentWatching.ts.
   */
  mode?: ReportMode;
  /** Test seam. */
  now?: () => number;
}): ParentPingLoop {
  const cfg = opts.config ?? DEFAULT_PING_CONFIG;
  const now = opts.now ?? (() => Date.now());
  const mode: ReportMode = opts.mode ?? parseReportMode(process.env.AGENT_YES_REPORT_PARENT);
  let state: PingState = initialPingState();
  let target: string | null = null;
  let parentAgentPid: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  // One ping in flight at a time: `ay send` can take seconds (paste settle on the
  // parent's side), and overlapping sends would interleave two reports into one
  // composer line.
  let inFlight: Promise<unknown> = Promise.resolve();

  const send = (
    decision: ReturnType<typeof stepParentPing>["ping"],
    tail: string | null,
  ): Promise<void> => {
    if (!decision || !target) return Promise.resolve();
    const t = target;
    inFlight = inFlight
      .then(async () => {
        // Checked at SEND time, not at poll time: whether the parent is watching
        // can change between the edge firing and the report going out, and this
        // is the moment the answer actually matters. Only reached a handful of
        // times per agent lifetime, so the lookup's cost is irrelevant.
        const watching =
          mode === "auto" && opts.parentPid !== undefined && parentAgentPid !== null
            ? await isParentWatching(opts.parentPid, parentAgentPid, opts.self.pid, now())
            : false;
        if (!shouldDeliverReport({ mode, parentIsWatching: watching, reason: decision.reason })) {
          logger.debug(
            `[parent-ping] ${decision.reason} suppressed (mode=${mode}, parent watching=${watching})`,
          );
          return;
        }
        const body = buildPingBody(decision, opts.self, tail);
        const ok = await deliverPing({
          target: t,
          body,
          selfWrapperPid: opts.selfWrapperPid,
        });
        logger.debug(
          `[parent-ping] ${decision.reason} attempt ${decision.attempt} → ${t}: ${ok ? "sent" : "FAILED"}`,
        );
      })
      .catch(() => {});
    return inFlight as Promise<void>;
  };

  const ready = resolveSpawner(opts.parentPid)
    .then((spawner) => {
      if (!spawner || stopped) return false;
      target = replyTargetOf(spawner);
      parentAgentPid = spawner.pid;
      timer = setInterval(() => {
        let lines: string[] = [];
        try {
          lines = opts.screen();
        } catch {
          return; // a render hiccup is not a signal
        }
        const stepped = stepParentPing(
          state,
          { now: now(), state: classifySelfState(lines, opts.patterns) },
          cfg,
        );
        state = stepped.state;
        if (stepped.ping) void send(stepped.ping, lines.join("\n"));
      }, opts.pollMs ?? POLL_MS);
      timer.unref?.();
      return true;
    })
    .catch(() => false);

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    ready,
    async pingExit(exitCode) {
      await ready;
      this.stop();
      if (!target) return;
      let tail: string | null = null;
      try {
        tail = opts.screen().join("\n");
      } catch {
        /* ignore */
      }
      opts.self.exitCode = exitCode;
      const stepped = stepParentPing(state, { now: now(), state: "exited" }, cfg);
      state = stepped.state;
      if (!stepped.ping) return;
      await send(stepped.ping, tail);
    },
  };
}
