/**
 * Multi-viewer PTY size negotiation — the tmux "smallest client wins" rule.
 *
 * Every writable web viewer reports its readable capacity (the cols×rows its
 * pane can render at its chosen font size) via /api/presence. The host resizes
 * the agent's PTY to the elementwise minimum across live viewers, so the
 * narrowest screen (a phone) gets a grid it can actually read while wider
 * viewers simply render fewer columns. When the last capacity-reporting viewer
 * leaves, the negotiated size is withdrawn and the PTY falls back to the real
 * terminal's size (the wrapper re-reads the tty once the winsize file is gone).
 *
 * Pure logic only — the serve layer owns presence bookkeeping, the winsize
 * file, and SIGWINCH delivery.
 */

export interface SizeCap {
  cols: number;
  rows: number;
}

/** Reject junk caps (a viewer mid-layout can report 0×0 or absurd numbers). */
const CAP_MIN_COLS = 20;
const CAP_MIN_ROWS = 5;
const CAP_MAX_COLS = 500;
const CAP_MAX_ROWS = 200;

/** Never negotiate below this — TUIs (claude, codex) break down when the grid
 * gets absurdly narrow, so a tiny watch-sized viewer can't wedge the agent. */
export const NEGO_FLOOR_COLS = 40;
export const NEGO_FLOOR_ROWS = 10;

/** Parse a presence-reported cap into a sane SizeCap, or null if unusable. */
export function sanitizeCap(cap: unknown): SizeCap | null {
  if (typeof cap !== "object" || cap === null) return null;
  const c = Math.floor(Number((cap as SizeCap).cols) || 0);
  const r = Math.floor(Number((cap as SizeCap).rows) || 0);
  if (c < CAP_MIN_COLS || c > CAP_MAX_COLS) return null;
  if (r < CAP_MIN_ROWS || r > CAP_MAX_ROWS) return null;
  return { cols: c, rows: r };
}

/**
 * Elementwise minimum over the live viewers' capacities, clamped to the floor.
 * Returns null when no viewer reports a capacity — meaning "withdraw the
 * negotiated size, let the real tty size rule again".
 */
export function negotiateSize(caps: ReadonlyArray<SizeCap>): SizeCap | null {
  let cols = Infinity;
  let rows = Infinity;
  for (const cap of caps) {
    if (cap.cols < cols) cols = cap.cols;
    if (cap.rows < rows) rows = cap.rows;
  }
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  return {
    cols: Math.max(NEGO_FLOOR_COLS, cols),
    rows: Math.max(NEGO_FLOOR_ROWS, rows),
  };
}
