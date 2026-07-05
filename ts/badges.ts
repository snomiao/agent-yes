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
];

/**
 * Which badge ids match the given rendered screen lines. Pure so it's
 * unit-tested without a live PTY/log file.
 */
export function matchBadges(lines: string[], defs: BadgeDef[] = BADGE_DEFS): string[] {
  const text = lines.join("\n");
  return defs.filter((d) => d.pattern.test(text)).map((d) => d.id);
}

export function badgeDef(id: string, defs: BadgeDef[] = BADGE_DEFS): BadgeDef | undefined {
  return defs.find((d) => d.id === id);
}
