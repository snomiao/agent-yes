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
