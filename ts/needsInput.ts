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

export interface MenuState {
  /** The 1-based option number the menu cursor (❯/›/>) currently sits on. */
  cursor: number;
  /** Every visible option number, ascending — for range-checking a requested N. */
  options: number[];
  /** Same compact menu rendering as {@link classifyNeedsInput}. */
  question: string;
}

// An option row: an optional cursor glyph / bullet, then "N. " (the trailing
// space rejects version-like "3.5GB" that isn't a menu option).
const OPTION_LINE = /^[\s❯›>▶◉○●·*\-]*?(\d+)\.\s/;

/**
 * Parse the selection menu a `needs_input` agent is parked on into a cursor
 * position + the available option numbers, so a caller can compute how far the
 * cursor must move (Down/Up) to reach a target option. Returns null when the
 * screen isn't a menu (delegates that judgement to {@link classifyNeedsInput},
 * so `working` still wins) or no numbered cursor line is found. Pure — the
 * `ay select` action reuses the exact detection `ay ls` renders with.
 */
export function parseMenu(
  lines: string[],
  cfg: { needsInput?: RegExp[]; working?: RegExp[] },
): MenuState | null {
  const ni = classifyNeedsInput(lines, cfg);
  if (!ni) return null;
  const patterns = cfg.needsInput ?? [];
  // The cursor line is the last one carrying a needsInput match (matches how
  // classifyNeedsInput anchors its question window).
  let cursorLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((re) => reTest(re, lines[i]!))) cursorLine = i;
  }
  if (cursorLine < 0) return null;
  const cm = /(\d+)\./.exec(lines[cursorLine]!);
  if (!cm) return null;
  const cursor = parseInt(cm[1]!, 10);
  // Gather option numbers from the rows around the cursor (a menu is contiguous).
  const start = Math.max(0, cursorLine - 12);
  const end = Math.min(lines.length, cursorLine + 12);
  const options: number[] = [];
  for (let i = start; i < end; i++) {
    const m = OPTION_LINE.exec(lines[i]!);
    if (m) {
      const v = parseInt(m[1]!, 10);
      if (!options.includes(v)) options.push(v);
    }
  }
  if (!options.includes(cursor)) options.push(cursor);
  options.sort((a, b) => a - b);
  return { cursor, options, question: ni.question };
}

/**
 * True when the rendered screen still shows a "busy" marker (config `working`,
 * e.g. claude's `esc to interrupt`). Paired with a long-quiet log this is the
 * `stuck` signal: a live spinner writes to the log every frame, so a busy marker
 * on screen WITHOUT recent output means the agent wedged mid-stream (a silent
 * API stream stall) rather than finishing. Pure + synchronous like the rest of
 * this module so it's trivially unit-testable.
 */
export function isWorkingScreen(lines: string[], working?: RegExp[]): boolean {
  if (!working?.length) return false;
  const text = lines.join("\n");
  return working.some((re) => reTest(re, text));
}
