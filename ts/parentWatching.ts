/**
 * "Is my parent already monitoring me?" — the suppression signal for the
 * automatic finished/stuck/exited push.
 *
 * A parent harness that HAS a monitor loop (Claude Code's Monitor tool, an
 * `ay ls --watch` NDJSON stream, `ay notify watch`, or just a polling `ay tail`)
 * already sees the child go idle / needs_input / stopped, with better fidelity
 * and on its own schedule. Injecting an `<ay-report …>` into that parent's stdin
 * on top of it is pure noise — worse than noise, since a message lands in the
 * parent's composer and interrupts whatever it was doing.
 *
 * So the push is a FALLBACK, not a duplicate channel: it fires only when nobody
 * is looking. Two independent signals count as "looking", and either is enough:
 *
 *   1. A live `ay notify watch` heartbeat for this parent (the explicit,
 *      purpose-built watcher — see notifyStore's watcher registry).
 *   2. This parent tailed/read THIS child within the read window — the same
 *      recency ledger `ay send`'s misdelivery guard uses. This is what catches
 *      an ad-hoc monitor loop that just polls `ay tail`/`ay ls`, which is what a
 *      harness-driven parent actually does.
 *
 * Failing OPEN (assume not watching, so we do send) is deliberate: a duplicate
 * report is a minor annoyance, a silently stranded parent is the bug this whole
 * feature exists to fix.
 */

import { logger } from "./logger.ts";

/** How the wrapper's automatic report behaves. `AGENT_YES_REPORT_PARENT`. */
export type ReportMode = "auto" | "always" | "never";

/**
 * Parse the mode from the env value. Anything unrecognised (including unset)
 * is `auto` — the setting is an escape hatch, not something to fail a run over.
 */
export function parseReportMode(raw: string | undefined): ReportMode {
  const v = raw?.trim().toLowerCase();
  return v === "always" || v === "never" ? v : "auto";
}

/**
 * Decide whether to actually deliver a report. Pure, so the policy is testable
 * without touching the fs.
 *
 * `always` and `never` are absolute. `auto` sends only when the parent shows no
 * sign of monitoring — EXCEPT that `exited` always goes out: it is terminal, it
 * is the one edge a poll can miss entirely (the child's record can be reaped
 * between two polls), and it can never repeat, so it cannot become spam.
 */
export function shouldDeliverReport(opts: {
  mode: ReportMode;
  parentIsWatching: boolean;
  reason: "finished" | "stuck" | "exited";
}): boolean {
  if (opts.mode === "never") return false;
  if (opts.mode === "always") return true;
  if (opts.reason === "exited") return true;
  return !opts.parentIsWatching;
}

/**
 * Whether `parentWrapperPid` currently appears to be monitoring the agent
 * `selfAgentPid`. Best-effort and fail-open (returns false on any error).
 */
export async function isParentWatching(
  parentWrapperPid: number,
  parentAgentPid: number,
  selfAgentPid: number,
  now = Date.now(),
): Promise<boolean> {
  try {
    const { liveWatchers } = await import("./notifyStore.ts");
    const watchers = await liveWatchers(now);
    if (watchers.has(parentWrapperPid)) return true;
  } catch (error) {
    logger.debug("[parent-ping] watcher lookup failed:", error);
  }
  try {
    // Imported lazily and only when a report is about to fire (a handful of
    // times per agent lifetime), so subcommands.ts never lands on the wrapper's
    // startup path.
    const { lastReadAt, READ_WINDOW_MS } = await import("./subcommands.ts");
    const last = await lastReadAt(`agent:${parentAgentPid}`, selfAgentPid);
    if (last !== null && now - last <= READ_WINDOW_MS) return true;
  } catch (error) {
    logger.debug("[parent-ping] read-recency lookup failed:", error);
  }
  return false;
}
