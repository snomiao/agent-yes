/**
 * Pure predicate core for `ay tail --until <pattern>` — "follow this agent's
 * output and return as soon as this text shows up".
 *
 * Every other wait primitive in the CLI keys on *state* (`ay status --wait`,
 * `ay ls --watch`, `ay notify watch`) or on a deposited envelope
 * (`ay result --wait`). None of them can express "wake me when lane-b prints
 * `All tests passed`", which is what an orchestrator actually has to block on
 * after firing work at an agent whose CLI reports progress as text.
 *
 * The matcher is split out here — no I/O, no clock, no terminal — so the
 * grep-vs-regex / case-folding rules are unit-testable on their own, mirroring
 * `lsWatch.ts` and `needsInput.ts`. The follow loop, liveness poll and timeout
 * live in `subcommands.ts`.
 *
 * Semantics are deliberately grep's, not the config matchers': a plain
 * `--until` pattern is a LITERAL substring, case-sensitive, and `--regex` opts
 * into a real expression. A caller (often a model) that types
 * `--until "cost: $0.02"` must not have `$` silently treated as an anchor, and
 * an unanchored regex passed by accident must not match every line.
 */

/** How to interpret an `--until` pattern. */
export interface UntilSpec {
  pattern: string;
  /** Treat `pattern` as a JS regular expression instead of a literal. */
  regex: boolean;
  /** Case-insensitive match (`-i`), for both literal and regex modes. */
  ignoreCase: boolean;
}

/** Tests one rendered output line for the `--until` condition. */
export type UntilMatcher = (line: string) => boolean;

/**
 * Compile an `--until` spec into a line predicate.
 *
 * Throws on an empty pattern (a match-everything predicate would return on the
 * agent's next line of output, which is never what the caller meant) and on an
 * invalid regex, so the failure surfaces at argument-parse time rather than as
 * an instant bogus exit 0.
 */
export function compileUntil(spec: UntilSpec): UntilMatcher {
  const { pattern, regex, ignoreCase } = spec;
  if (pattern.length === 0) throw new Error("--until requires a non-empty pattern");

  if (!regex) {
    if (!ignoreCase) return (line) => line.includes(pattern);
    const needle = pattern.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch (e) {
    throw new Error(`invalid --until regex: ${(e as Error).message}`);
  }
  // No /g or /y, so `test` carries no lastIndex state between lines.
  return (line) => re.test(line);
}

/**
 * A matcher plus the "how many hits are enough" threshold (`--count`), as a small
 * stateful tally.
 *
 * The same tally is fed by all three sources a wait can see — the live stream, the
 * printed context window under `--match-backlog`, and the final log drained after
 * the agent exits — so `--count 3` means three hits total, wherever they land,
 * rather than three per source.
 *
 * Note what a "hit" is: one FINALIZED rendered line that matches. A full-screen
 * TUI repaint can re-finalize the same visible row, so `--count` counts lines
 * printed, not logical events — fine for "the third test file finished", wrong for
 * counting a value that a live-updating panel rewrites in place.
 */
export interface UntilTally {
  /** Feed one line; returns true once `needed` hits have accumulated. */
  feed(line: string): boolean;
  /** Feed many; returns true once the threshold is reached (stops early). */
  feedAll(lines: readonly string[]): boolean;
  /** Hits so far. */
  readonly hits: number;
  /** How many are required. */
  readonly needed: number;
  /** The most recent matching line, or null. */
  readonly last: string | null;
  /** Whether the threshold has been reached. */
  readonly done: boolean;
}

export function makeTally(match: UntilMatcher, needed = 1): UntilTally {
  if (!Number.isInteger(needed) || needed < 1)
    throw new Error(`--count must be a positive integer (got ${needed})`);
  let hits = 0;
  let last: string | null = null;
  const tally: UntilTally = {
    get hits() {
      return hits;
    },
    needed,
    get last() {
      return last;
    },
    get done() {
      return hits >= needed;
    },
    feed(line) {
      if (hits < needed && match(line)) {
        hits++;
        last = line;
      }
      return hits >= needed;
    },
    feedAll(lines) {
      for (const line of lines) if (tally.feed(line)) return true;
      return hits >= needed;
    },
  };
  return tally;
}

/**
 * The lines strictly after the LAST occurrence of `anchor` — the tail of a log
 * that a follower has not seen yet, given the newest line it had seen.
 *
 * Needed because an exiting agent's log is not the file the follower was reading:
 * the runtime renders the scrollback to a new path and unlinks the raw log, so the
 * final lines must be recovered from a file with unknown overlap. Aligning on the
 * newest already-seen line — from the END, so a repeated shell prompt resolves to
 * the most recent one — bounds that overlap without byte offsets.
 *
 * Returns null when there is no anchor or it isn't present: the caller must then
 * skip the drain rather than fall back to scanning everything, which could report
 * a match printed before the wait even began.
 */
export function linesAfterAnchor(lines: readonly string[], anchor: string | null): string[] | null {
  if (anchor === null) return null;
  const at = lines.lastIndexOf(anchor);
  if (at < 0) return null;
  return lines.slice(at + 1);
}

/**
 * The verdict half of a wait: feed it lines, ask whether the wait is over.
 *
 * Both followers (the local vterm stream and the remote SSE stream) run the same
 * judge, so the precedence rule — `--fail-on` is tested BEFORE `--until`, and a
 * line matching both is a failure — can't drift between them. A caller that
 * branches on exit 0 must never be told "matched" by the very line saying it went
 * wrong.
 */
export interface UntilJudge {
  /** Feed one line; returns true once the wait is settled. */
  test(line: string): boolean;
  /** Feed many; returns true once settled (stops early). */
  testAll(lines: readonly string[]): boolean;
  readonly settled: boolean;
  /** "match" | "failed" once settled, else null. */
  readonly outcome: Extract<UntilOutcome, "match" | "failed"> | null;
  /** The line that settled it, or null. */
  readonly matched: string | null;
}

export function makeJudge(tally: UntilTally, failTally: UntilTally | null): UntilJudge {
  let outcome: Extract<UntilOutcome, "match" | "failed"> | null = null;
  let matched: string | null = null;
  const judge: UntilJudge = {
    get settled() {
      return outcome !== null;
    },
    get outcome() {
      return outcome;
    },
    get matched() {
      return matched;
    },
    test(line) {
      if (outcome !== null) return true;
      if (failTally?.feed(line)) {
        outcome = "failed";
        matched = failTally.last;
        return true;
      }
      if (tally.feed(line)) {
        outcome = "match";
        matched = tally.last;
        return true;
      }
      return false;
    },
    testAll(lines) {
      for (const line of lines) if (judge.test(line)) return true;
      return outcome !== null;
    },
  };
  return judge;
}

/** Why an `--until` follow stopped. Maps 1:1 to the process exit code. */
export type UntilOutcome = "match" | "exited" | "timeout" | "stopped" | "failed";

/**
 * Exit code for an `--until` run. Mirrors the code family already established by
 * `ay status --wait` / `ay result --wait`, so an orchestrator can branch on the
 * status without parsing stdout:
 *
 *   0  the pattern appeared
 *   1  the agent exited without ever printing it (it's done; it never will)
 *   2  `--timeout` elapsed, or we were signalled away, with no match
 *   3  a `--fail-on` pattern appeared first — the thing went wrong, and waiting
 *      out the timeout would only delay finding out
 *
 * `stopped` (Ctrl-C / SIGTERM, e.g. an outer `timeout(1)`) deliberately shares
 * exit 2 with a timeout rather than the plain-follow 0: for a caller using this
 * as a predicate, "I was killed" must never read as "the pattern matched".
 */
export function untilExitCode(outcome: UntilOutcome): number {
  switch (outcome) {
    case "match":
      return 0;
    case "exited":
      return 1;
    case "timeout":
    case "stopped":
      return 2;
    case "failed":
      return 3;
  }
}
