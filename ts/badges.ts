/**
 * Badge/flag matchers: small regex patterns run against an agent's last
 * rendered screen (the same tail window `ay tail` shows — see
 * extractBadges in subcommands.ts) to surface a short status chip in the
 * web console's agent list. Extensible: add more entries to BADGE_DEFS as
 * useful patterns turn up (a known error banner, a loop-state flag, etc.).
 * Pure and CLI-agnostic — a definition just won't match on CLIs that never
 * print its pattern.
 */

export interface BadgeDef {
  /** Stable id, used as the wire value and as the key when re-deriving the label. */
  id: string;
  /** Short chip text, e.g. "goal". Keep it a couple of characters — the chip is tiny. */
  label: string;
  /** Tooltip shown on hover, explaining what the badge means. */
  title: string;
  /** Matched against the tail-rendered screen text (lines joined with \n). */
  pattern: RegExp;
}

export const BADGE_DEFS: BadgeDef[] = [
  {
    id: "goal-active",
    label: "goal",
    title: "A /goal Stop-hook loop is active on this agent",
    pattern: /\/goal active/i,
  },
  {
    id: "session-limit",
    label: "limit",
    title: "Usage session limit hit — waiting for the reset time shown on screen",
    pattern: /you['’]?ve hit your session limit/i,
  },
  {
    // The CLI is auto-retrying an API call on its OWN backoff — claude prints
    // "✻ Waiting for API response · will retry in 2m 17s · check your network"
    // and recovers by itself. agent-yes injects NOTHING here (unlike the runtime's
    // autoRetry, which types "retry"); this badge just annotates "waiting on the
    // API, no action needed" so the agent doesn't read as plainly busy. Anchored
    // on the FULL banner (not a bare "will retry in") so an agent merely
    // *discussing* retries can't light it up; `[\s\S]{0,40}` spans the "· "
    // separator and any line-wrap between the two phrases.
    id: "retrying",
    label: "retry",
    title: "Waiting for the API — the CLI is auto-retrying on its own backoff (no action needed)",
    pattern: /Waiting for API response[\s\S]{0,40}will retry in \d/i,
  },
];

/**
 * Which badge ids match the given rendered screen lines. Pure so it's
 * unit-tested without a live PTY/log file.
 */
export function matchBadges(lines: string[], defs: BadgeDef[] = BADGE_DEFS): string[] {
  const text = lines.join("\n");
  return defs.filter((d) => d.pattern.test(text)).map((d) => d.id);
}

/**
 * A time-derived flag (NOT screen-matched): lit when the user typed at this
 * agent's terminal within the last few seconds. The ls code appends its id from
 * the Rust runner's stdin-activity marker, so it resolves through `badgeDef`
 * like any other chip — but `matchBadges` never produces it (it isn't in
 * BADGE_DEFS, and its pattern can't match), keeping screen matching pure.
 */
export const TYPING_BADGE: BadgeDef = {
  id: "typing",
  label: "typing",
  title: "The user is typing at this agent's terminal — ay send backs off until they pause",
  pattern: /(?!)/, // never matches; presence comes from stdin activity, not the screen
};

export function badgeDef(id: string, defs: BadgeDef[] = BADGE_DEFS): BadgeDef | undefined {
  return defs.find((d) => d.id === id) ?? (id === TYPING_BADGE.id ? TYPING_BADGE : undefined);
}
