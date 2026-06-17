/**
 * Detect, from an agent's rendered TUI screen, whether it is blocked on an
 * interactive selection menu it did NOT auto-resolve — i.e. it `needs_input`.
 *
 * This is a QUERY-time classifier (used by `ay ls` / `ay status`), deliberately
 * not part of the run loop: the same drawn menu is observable regardless of which
 * runtime (Rust or TS) produced it, so detection is runtime-agnostic and needs no
 * new IPC or persisted state. The signal is the menu cursor sitting on a numbered
 * option (config `needsInput` patterns, e.g. claude `❯ N.`, codex `›/> N.`). An
 * agent that is actively `working` is never `needs_input`, even if an old menu
 * lingers in the scrollback.
 */

export interface NeedsInput {
  /** A compact rendering of the pending question/menu, for `ay status --json`. */
  question: string;
}

// Config regexes are authored without the global/sticky flags, but strip them
// defensively so `.test()` can't carry `lastIndex` state across calls.
function reTest(re: RegExp, s: string): boolean {
  return (re.global || re.sticky ? new RegExp(re.source, re.flags.replace(/[gy]/g, "")) : re).test(
    s,
  );
}

function isChromeLine(s: string): boolean {
  const t = s.trim();
  return (
    !t ||
    /^─+$/.test(t) ||
    /^esc to (interrupt|cancel)/i.test(t) ||
    /\? for shortcuts/.test(t) ||
    /\d+%\s*until auto-compact/i.test(t)
  );
}

/**
 * Returns a NeedsInput when the screen shows an unresolved selection menu, else
 * null. `cfg.working` short-circuits to null (an actively-working agent isn't
 * blocked). Pure + synchronous so it's trivially unit-testable.
 */
export function classifyNeedsInput(
  lines: string[],
  cfg: { needsInput?: RegExp[]; working?: RegExp[] },
): NeedsInput | null {
  const patterns = cfg.needsInput ?? [];
  if (patterns.length === 0) return null;

  const text = lines.join("\n");
  // `working` wins: a spinner means real work is happening, not a blocking prompt.
  if ((cfg.working ?? []).some((re) => reTest(re, text))) return null;
  if (!patterns.some((re) => reTest(re, text))) return null;

  // Build a compact question from the menu region: the last line carrying the
  // menu cursor, plus a little context above (the question) and the options below.
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((re) => reTest(re, lines[i]!))) last = i;
  }
  const start = Math.max(0, last - 6);
  const end = Math.min(lines.length, last + 6);
  const block = lines
    .slice(start, end)
    .map((l) => l.trim())
    .filter((l) => l && !isChromeLine(l));
  return { question: block.join(" • ").slice(0, 400) };
}
