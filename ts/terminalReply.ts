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

/**
 * Is this payload nothing but replies a terminal sends UNPROMPTED BY ANY PERSON —
 * answers to queries the application itself made?
 *
 * Deliberately NARROWER than `isTerminalReply`, even though it also covers OSC
 * colour replies, because the two answer different questions. `isTerminalReply`
 * decides whether to refresh `last_stdin_at`; being wrong there mislabels a
 * console as "just typed". This one decides whether a byte is stored in the
 * message log at all; being wrong here DELETES SOMETHING A PERSON DID. Where a
 * shape is ambiguous, this predicate declines.
 *
 * Two families that `isTerminalReply` accepts are excluded for exactly that
 * reason, and the exclusions are measurements, not caution:
 *
 *  - PLAIN CPR `ESC[<n>;<n>R`. xterm's modified F3 is `ESC[1;<mod>R` — the same
 *    shape. "Only the final byte separates an input from a reply" is false: `R`
 *    ends both. Measured over 128,827 stored rows, plain CPR appears ONCE while
 *    the `?`-prefixed DECXCPR form — which no key can produce — appears 46,693
 *    times. Keeping plain CPR buys one row and costs a real keypress.
 *  - SGR MOUSE `ESC[<b;x;yM|m`. `M` is press/wheel/motion and `m` is release, so
 *    a person clicking a button inside a TUI emits the same bytes as the pointer
 *    drifting across it. 36,616 rows, the second largest family — and no shape
 *    separates the deliberate click from the drift. A discriminator has to come
 *    from the producer, which is the only place the intent is known.
 */
export const isUnpromptedTerminalReply = (s: string): boolean =>
  /^(?:\x1b\[(?:\?\d+(?:;\d+)*R|\?[\d;]*c|>[\d;]*c|\d*n)|\x1b\](?:10|11|12|4;\d+);rgb:[0-9a-fA-F]{1,4}(?:\/[0-9a-fA-F]{1,4})*(?:\x1b\\|\x07))+$/.test(
    s,
  );
