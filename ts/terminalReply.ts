/** One query reply a terminal sends back: CPR / DECXCPR (`R`), DA1 / DA2 (`c`),
 * DSR (`n`). */
const REPLY = String.raw`\x1b\[(?:\??\d+(?:;\d+)*R|\?[\d;]*c|>[\d;]*c|\d*n)`;

/**
 * One terminal-generated event that is NOT an answer to a protocol query and is
 * NOT typing: an OSC colour reply (10 fg / 11 bg / 12 cursor / 4;n palette,
 * terminated by ST or BEL), or an SGR mouse tracking report, emitted whenever
 * the pointer moves over the terminal.
 */
const DEVICE_EVENT = String.raw`\x1b\](?:10|11|12|4;\d+);rgb:[0-9a-fA-F]{1,4}(?:/[0-9a-fA-F]{1,4})*(?:\x1b\\|\x07)|\x1b\[<\d+;\d+;\d+[Mm]`;

// Each is anchored over ONE-OR-MORE: a burst (a tail replay on viewer attach, a
// pointer drag) arrives concatenated in a single chunk.
const REPLY_ONLY = new RegExp(`^(?:${REPLY})+$`);
const DEVICE_ONLY = new RegExp(`^(?:${DEVICE_EVENT})+$`);
const CHATTER = new RegExp(`^(?:${REPLY}|${DEVICE_EVENT})+$`);

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
 * Real typing — including arrow keys like `ESC[A` — never matches: an input and
 * a reply are both CSI, and only the final byte separates them.
 */
export const isTerminalReply = (s: string): boolean => REPLY_ONLY.test(s);

/**
 * Is this payload purely terminal device events (see `DEVICE_EVENT`)?
 *
 * Kept separate from `isTerminalReply` deliberately. That predicate gates
 * `last_stdin_at` in the serve daemon, and widening it would change when the
 * console reports "just typed" — a different question from whether something is
 * a message. Callers that want both compose them with `isTerminalChatter`.
 */
export const isTerminalDeviceEvent = (s: string): boolean => DEVICE_ONLY.test(s);

/**
 * Everything a terminal puts on an agent's stdin that neither a human nor an
 * agent meant to send — query replies AND device events.
 *
 * One anchored alternation over BOTH alphabets, NOT `isTerminalReply(s) ||
 * isTerminalDeviceEvent(s)`. The `||` form cannot see a burst that mixes the two
 * families, because each half anchors over its own alphabet and a mixed chunk
 * satisfies neither. That burst is exactly what a terminal sends on attach —
 * measured once in a 63,129-row corpus:
 *
 *     ESC[1;1R   ESC]10;rgb:…ST   ESC]11;rgb:…ST   ESC[?1;2c
 *
 * one write carrying a cursor report, both colour replies, and a device
 * attributes answer. Rare — and it is the one that would have been kept forever.
 */
export const isTerminalChatter = (s: string): boolean => CHATTER.test(s);
