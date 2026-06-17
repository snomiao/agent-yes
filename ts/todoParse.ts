/**
 * Parse an agent's todo/task list out of its RENDERED TUI screen.
 *
 * Source of truth for EVERY CLI (claude, codex, gemini, …) is the screen the
 * agent draws — never a CLI-specific session file. The durable copy is the
 * per-pid raw log (`<cwd>/.agent-yes/<pid>.raw.log`); rendering it through a
 * headless xterm (see renderRawLog) collapses the reflow/redraw frames into the
 * final coherent text, which is what we scan here.
 *
 * The todo list in these TUIs renders as a tree block anchored by the `⎿`
 * branch glyph, one marker per line:
 *
 *     ⎿  ☒ Wire up the parser
 *        ☒ Add the badge
 *        ◼ Compute in /api/ls      ← in progress
 *        ◻ Render in the console   ← pending
 *        ◻ Tests
 *
 * Badge = `${done}/${total}` (done is the numerator → "2/5").
 *
 * This parse is deliberately conservative: we only report a count when a block
 * is confidently detected (the `⎿` anchor + ≥2 consecutive marker lines), so an
 * agent that merely prints a check glyph in prose never produces a phantom badge.
 */

// Marker glyphs, by state. Kept as single code points so a line is classified by
// its first non-indent glyph.
const DONE = new Set(["✔", "☑", "✓", "☒"]);
const IN_PROGRESS = new Set(["◼"]);
const PENDING = new Set(["◻", "☐"]);
const ANCHOR = "⎿";

export interface TaskCounts {
  done: number;
  total: number;
}

type Marker = "done" | "inprogress" | "pending";

// Classify a rendered line: strip leading whitespace and an optional leading `⎿`
// (+ its whitespace), then look at the first glyph. Returns null for non-marker
// lines (prose, blank lines, wrapped titles).
function markerOf(line: string): Marker | null {
  let s = line.replace(/^\s+/, "");
  if (s.startsWith(ANCHOR)) s = s.slice(ANCHOR.length).replace(/^\s+/, "");
  const ch = [...s][0];
  if (ch === undefined) return null;
  if (DONE.has(ch)) return "done";
  if (IN_PROGRESS.has(ch)) return "inprogress";
  if (PENDING.has(ch)) return "pending";
  return null;
}

/**
 * Find the MOST RECENT confidently-detected todo block in the rendered lines and
 * return its {done, total}. Returns null when none qualifies (caller omits the
 * badge entirely — never shows "0/0").
 *
 * A block is a maximal run of consecutive marker lines. It only counts when it
 * is anchored — the `⎿` glyph appears on the run's first line or the line
 * directly above it — and has ≥2 marker lines. The last qualifying block wins,
 * since the agent's current todo state is the one drawn most recently.
 */
export function parseTaskCounts(lines: string[]): TaskCounts | null {
  let best: TaskCounts | null = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    if (markerOf(lines[i]!) === null) {
      i++;
      continue;
    }
    // Start of a marker run at i.
    let hasAnchor = i > 0 && lines[i - 1]!.includes(ANCHOR);
    const counts = { done: 0, inprogress: 0, pending: 0 };
    let j = i;
    for (; j < n; j++) {
      const mk = markerOf(lines[j]!);
      if (mk === null) break;
      if (lines[j]!.includes(ANCHOR)) hasAnchor = true;
      counts[mk]++;
    }
    const total = counts.done + counts.inprogress + counts.pending;
    if (hasAnchor && total >= 2) best = { done: counts.done, total };
    i = j === i ? i + 1 : j;
  }
  return best;
}
