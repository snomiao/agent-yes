# Shared Canvas — consistent multi-viewer terminal rendering (design)

> Status: **design + MVP.** Captures a brainstorm (with codex gpt-5.5). The MVP
> section is what we build first; later refinements are marked **DEFERRED**.

## Problem

agent-yes.com lets **multiple browsers watch/steer one terminal agent**. The
agent's PTY renders at **one** size; the host streams that rendered output (SSE)
to every viewer, and each viewer writes it into **its own** xterm.js at **its
own** window size. Different widths → different line-wrapping/reflow → the **same
content lands on different rows/columns per viewer**.

That breaks anything coordinate-based across viewers:

- The multi-peer **selection overlay** (presence) is exact only when viewers
  share a size; at different sizes the box mismatches the text.
- A shared **cursor**, and any future annotations, have the same problem.

## North star

**One canonical terminal grid per session; viewers adapt _visually_, not
_logically_.** Make "a selection points at the same character for everyone" a
product invariant. Every viewer renders at the **agent's canonical grid size**
and **CSS-scales / letterboxes** that grid into its pane — it never reflows to
its own pane size. Then all viewers see identical content and every
coordinate-based feature lines up for free.

This is the screen-share model: one canvas, each window scales it to fit.

## Render: scale, don't reflow

Each viewer creates its xterm at the agent's `cols×rows` and fits the pane with a
CSS `transform: scale(...)` (origin top-left, centered), **not** by resizing the
grid. codex's refinement — offer **fit modes** rather than one forced scale:

- **`fit`** (default): letterbox the whole grid into the pane. Selection/cursor
  are pixel-exact. A 200-col driver on a phone is small but consistent.
- **`100% + pan`**: render at native cell size, scroll/pan to read. Readability
  over overview (small screens).
- **`follow-cursor`** (**DEFERRED**, mobile): auto-pan to keep the driver's
  cursor region in view.

Reflow-to-pane is the thing we are removing — "200-col on a phone is hard to
read" is a **scale/pan UX** problem, not a reason to reflow (reflow reintroduces
the mismatch).

## Size authority: a single driver, by lease

The canonical grid size is owned by **one driver at a time**, not last-writer:

- Driver changes only on **strong intent** — typing, paste, the resize handle,
  or an explicit "take control". **Not** on focus, mouse-move, or selection.
- Hold by **lease**, not debounce: a driver keeps size authority for ~10–30s
  after its last input, so two people don't thrash the grid.
- **Reject `min-fit`** (shrinking everyone to the smallest viewer — one small
  watcher would cramp the agent and the local owner). A fixed default
  (e.g. `120×40`) is only a last-resort fallback.

## Session-mode ownership (the local-terminal case)

The biggest policy question: a user-spawned agent's PTY is **shared with the
user's local terminal**, so a remote driver's resize reflows the owner's local
view. Size authority therefore depends on session mode:

1. **user-spawned + local terminal attached** → the **local owner is the size
   authority**; remote viewers watch the (scaled) shared canvas. **Remote resize
   is off by default** — a remote must "request control" and be granted it.
2. **headless / hosted agent** (no local terminal) → the **active remote driver**
   is the authority.

## Why not content-anchoring

An alternative to converging size is to anchor a selection to the underlying
**text / a line identity** instead of grid coordinates. We reject this as the
basis: terminal output carries ANSI state, alt-screen, cursor moves, erases,
wide/combining chars; xterm line identity breaks on reflow; duplicate visible
text makes anchors ambiguous; selection meaning shifts at wrap/scrollback
boundaries. It could exist later as a separate **best-effort semantic
highlight**, but presence correctness should rest on size convergence.

## Biggest risk

**Resize itself.** A PTY resize re-lays-out the running TUI, the shell prompt,
and (for shared sessions) the local owner's screen. Minimizing _when_ we resize
the agent — single authority, lease, explicit remote control — is the whole game.

## MVP

> **one canonical terminal grid per session; viewers adapt visually, not logically.**

Built defensively so the common single-viewer path is unchanged:

- A viewer renders its xterm at the **agent's PTY size** (from `/api/size`) and
  **CSS-scales to fit** the pane. When the agent's size already equals the
  viewer's natural fit (the **single-viewer / driver** case), scale ≈ 1 and
  behaviour is identical to today — no regression.
- **Follow:** poll `/api/size` (piggyback the existing presence heartbeat); when
  the agent's grid changes (another viewer drove it), `term.resize()` to it and
  re-scale — never reflow.
- **Drive:** the viewer that interacts pushes its fit size on select (current
  behaviour) and so sets the canonical grid; watchers follow + scale and do not
  push.
- **Presence overlay** drops the proportional-column fallback — all viewers share
  the grid, so selection/cursor coordinates are exact.
- Window resize re-computes the **scale**, not the grid.

### Decisions

- **Agreed:** scale/letterbox, never reflow; single-driver size authority by
  lease on strong intent; reject min-fit; session-mode ownership (local owner
  wins, remote resize off by default for shared sessions); content-anchoring is
  not the basis.
- **DEFERRED:** the full lease/"take control" UX + a visible driver indicator;
  `follow-cursor` and `100%+pan` modes (MVP ships `fit`); mouse-coordinate
  correction for an interacting _watcher_ under scale (drivers are scale ≈ 1, so
  unaffected); how the agent advertises size changes (poll now, push over the
  stream later).

## Related code

- `lab/ui/index.html` — `select()` builds the xterm + FitAddon and pushes size;
  `renderPeerSelections` / `selSegments` (presence overlay); the `/api/size`
  resync + 3s presence heartbeat.
- `ts/serve.ts` — `/api/size`, `/api/resize` (winsize + SIGWINCH), `/api/presence`.
- `docs/agent-sharing.md` — the presence feature this builds on.
