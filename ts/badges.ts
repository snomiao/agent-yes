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
  /**
   * Short chip text, e.g. "goal". Keep it a couple of characters — the chip is
   * tiny. May contain `$1`, replaced with the pattern's first capture group
   * (see the dynamic footer-counter defs below).
   */
  label: string;
  /** Tooltip shown on hover, explaining what the badge means. */
  title: string;
  /**
   * Matched against the tail-rendered screen text (lines joined with \n).
   * A pattern with a capture group makes the badge DYNAMIC: the wire id
   * becomes `id:capture` (e.g. "shells:4 shells") and `$1` in label/title is
   * substituted with the captured text when the chip is rendered.
   */
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
  // ---- Dynamic footer counters -------------------------------------------
  // claude's status footer lists live counters between "·" separators, e.g.
  //   ⏸ manual mode on · 1 shell · ctrl+t to hide tasks · ← for agents · ↓ to manage
  //   ⏸ manual mode on · 3 monitors · esc to interrupt · ↓ to manage
  //   ⏸ manual mode on · ? for shortcuts · ← 3 agents
  //   ⏸ manual mode on · PR #310
  // Each pattern anchors on that chrome (the "· " separator / the "←" arrow),
  // not the bare phrase, so ordinary conversation text about "4 shells" can't
  // light the chip. The capture keeps the CLI's own singular/plural wording,
  // so the chip reads exactly like the footer ("1 shell", "4 shells").
  {
    id: "shells",
    label: "$1",
    title: "Background shells running in this session ($1 in the CLI footer)",
    pattern: /· (\d+ shells?)(?= ·|\s*$)/m,
  },
  {
    id: "monitors",
    label: "$1",
    title: "Active Monitor watchers in this session ($1 in the CLI footer)",
    pattern: /· (\d+ monitors?)(?= ·|\s*$)/m,
  },
  {
    id: "bg-agents",
    label: "$1",
    title: "Background subagents running in this session ($1 in the CLI footer)",
    pattern: /← (\d+ agents?)(?= ·|\s*$)/m,
  },
  {
    id: "pr",
    label: "$1",
    title: "This session is linked to a GitHub pull request ($1 in the CLI footer)",
    pattern: /· (PR #\d+)(?= ·|\s*$)/m,
  },
];

/**
 * Which badge ids match the given rendered screen lines. Pure so it's
 * unit-tested without a live PTY/log file. A def whose pattern captured a
 * group yields `id:capture` (e.g. "shells:4 shells") so the count travels
 * with the id over the wire; static defs yield the bare id as before.
 */
export function matchBadges(lines: string[], defs: BadgeDef[] = BADGE_DEFS): string[] {
  const text = lines.join("\n");
  return defs.flatMap((d) => {
    const m = d.pattern.exec(text);
    if (!m) return [];
    return [m[1] !== undefined ? `${d.id}:${m[1]}` : d.id];
  });
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
  // Dynamic ids carry their captured text after a ":" ("shells:4 shells") —
  // strip it so the base def resolves.
  const base = id.includes(":") ? id.slice(0, id.indexOf(":")) : id;
  return defs.find((d) => d.id === base) ?? (base === TYPING_BADGE.id ? TYPING_BADGE : undefined);
}

/**
 * Rendered chip text for a (possibly dynamic) badge id: resolves the def and
 * substitutes `$1` in its label with the id's captured text. Unknown ids fall
 * back to the raw id so a newer server's badge never renders blank.
 */
export function badgeLabel(id: string, defs: BadgeDef[] = BADGE_DEFS): string {
  const def = badgeDef(id, defs);
  if (!def) return id;
  const arg = id.includes(":") ? id.slice(id.indexOf(":") + 1) : "";
  return def.label.includes("$1") ? def.label.replace("$1", arg) : def.label;
}
