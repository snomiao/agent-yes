/**
 * Is this /api/send payload PURELY terminal auto-reply chatter — the responses
 * a viewer's xterm generates to the agent TUI's protocol queries (Cursor
 * Position Report incl. the DECXCPR `?`-prefixed form, Device Attributes,
 * Device Status Report) — rather than a keystroke?
 *
 * Used by the serve daemon to keep such writes out of `last_stdin_at`, so a
 * redraw/resize (or a TUI polling `ESC[?6n` every render) can't pin the
 * console's stdin-flash + stdin age at "just typed".
 *
 * Anchored over ONE-OR-MORE replies: a burst of queries (e.g. tail replay on
 * viewer attach) is answered in a single onData chunk, so several replies
 * arrive concatenated in one payload. Real typing — including arrow keys like
 * `ESC[A` — never matches any alternative.
 */
export const isTerminalReply = (s: string): boolean =>
  /^(?:\x1b\[(?:\??\d+(?:;\d+)*R|\?[\d;]*c|>[\d;]*c|\d*n))+$/.test(s);

/** Identical auto-replies allowed per pid per window before it reads as a loop. */
export const REPLY_WINDOW_MS = 1000;
export const REPLY_BURST = 3;
/** Absolute per-pid ceiling per window, so alternating payloads can't bypass. */
export const REPLY_HARD_CAP = 20;

/**
 * Loop-breaker for terminal auto-replies. Forwarding them unconditionally is a
 * FEEDBACK LOOP: the TUI emits `ESC[?6n` on render, the viewer's xterm answers,
 * the daemon writes that answer to the TUI's stdin, it repaints and queries
 * again. Every attached viewer answers the same query, so the rate multiplies by
 * viewer count. Measured on a live room: 7197 writes in 45s (~160/s), 100% of
 * them an 8-byte DECXCPR reply and zero real keystrokes — enough to pin a core
 * and drive multi-second GC pauses in the WebRTC share host, which then stall
 * the DataChannel and dump the backlog in one burst.
 *
 * The query is still ANSWERED (a TUI that blocks on CPR must not be starved) —
 * we only refuse to sustain the loop. A reply passes when the position it
 * reports actually changed (real information) and identical replies pass up to
 * REPLY_BURST per window; REPLY_HARD_CAP bounds even an alternating payload.
 *
 * `now` is injectable so the window logic is testable without a fake clock.
 */
export function makeTerminalReplyGuard() {
  const seen = new Map<number, { last: string; n: number; at: number }>();
  return (pid: number, msg: string, now: number = Date.now()): boolean => {
    const g = seen.get(pid);
    if (!g || now - g.at >= REPLY_WINDOW_MS) {
      seen.set(pid, { last: msg, n: 1, at: now });
      return true;
    }
    g.n++;
    if (g.n > REPLY_HARD_CAP) return false;
    if (msg !== g.last) {
      g.last = msg; // the cursor genuinely moved — that answer carries information
      return true;
    }
    return g.n <= REPLY_BURST;
  };
}
