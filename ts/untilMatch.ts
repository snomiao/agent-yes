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
 * Find the first line satisfying the matcher, or null.
 *
 * Used for `--match-backlog` (scan the context window `tail` prints before it
 * starts following) and for the final drain after the agent exits.
 */
export function firstMatch(lines: readonly string[], match: UntilMatcher): string | null {
  for (const line of lines) if (match(line)) return line;
  return null;
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

/** Why an `--until` follow stopped. Maps 1:1 to the process exit code. */
export type UntilOutcome = "match" | "exited" | "timeout" | "stopped";

/**
 * Exit code for an `--until` run. Mirrors the code family already established by
 * `ay status --wait` / `ay result --wait`, so an orchestrator can branch on the
 * status without parsing stdout:
 *
 *   0  the pattern appeared
 *   1  the agent exited without ever printing it (it's done; it never will)
 *   2  `--timeout` elapsed, or we were signalled away, with no match
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
  }
}
