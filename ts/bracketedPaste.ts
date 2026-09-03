/**
 * Deliver an `ay send` body as ONE paste instead of a burst of keystrokes.
 *
 * The bug this exists for: `ay send` writes the body into the agent's stdin as
 * raw bytes, and a TUI that does not know a paste is happening has to GUESS
 * from arrival timing where one ends. Claude's input does exactly that, and
 * when the guess SPLITS the burst the leading part is lost — the model is
 * handed only a tail, with no error at either end. Measured on a probe agent at
 * COLUMNS=200: a 1061-char envelope+body arrived as its last 41 characters; the
 * same payload at COLUMNS=80 arrived whole. Width is not the cause, it is a
 * proxy for render cost, and render cost is what moves the timing — which is
 * why the same body sometimes survives. That is the worst property of this bug:
 * a sender who "stayed under the limit" is not safe, they were lucky.
 *
 * NOT the same thing as the CLI showing a `[Pasted text #N]` placeholder. That
 * is COLLAPSING, it is normal, and the full text still reaches the model — a
 * 777-char body was confirmed delivered whole while displayed as one. Only a
 * split burst loses data. Reading the placeholder as the defect sends you
 * looking for a rendering bug that isn't there.
 *
 * `ESC[200~ … ESC[201~` (DECSET 2004) removes the guess: the terminal is told
 * where the paste begins and ends, so the receiving CLI keeps it as one unit.
 * The markers are consumed by the receiver, not inserted as text.
 *
 * ONLY for CLIs that turn the mode on. A CLI that does not would show the
 * markers as literal garbage, so this is opt-in per CLI (`bracketedPaste` in
 * default.config.yaml). Whether a CLI ACCEPTS framing is measurable, not a
 * guess — its PTY log contains the enable sequence. Note what that measurement
 * does and does not say: it proves the CLI honours a paste, not that it
 * segments an unframed burst the same way claude does. Enabling it for a CLI
 * that never had the bug is still correct — one paste is what a message is.
 *
 *   grep -ac $'\\x1b\\[?2004h' <the agent's .raw.log>
 */

/**
 * The submit Enter must be written AFTER the framed payload, never inside it.
 * Inside a paste a CR is content — it inserts a newline and submits nothing, so
 * the message would sit unsent in the composer. Callers therefore write
 * `framePaste(body)` first and the trailing code as a separate write; a refactor
 * that folds the trailing byte into the framed string would break delivery
 * silently, with no error at either end. Pinned by the byte-level FIFO test in
 * ts/subcommands.spec.ts, which asserts the CR lands after the END marker.
 */

/** DECSET 2004 paste start — what a terminal emits before pasted content. */
export const PASTE_START = "\x1b[200~";
/** DECSET 2004 paste end. */
export const PASTE_END = "\x1b[201~";

/**
 * Remove paste markers already present in a body.
 *
 * Not tidiness: an embedded `ESC[201~` would END our paste early, and every
 * byte after it would reach the CLI as live keystrokes — a message that could
 * drive the receiving agent's TUI instead of being read by it. A sender must
 * not be able to reach past its own message, so the markers are stripped before
 * the real ones are added.
 */
export function stripPasteMarkers(body: string): string {
  return body.split(PASTE_START).join("").split(PASTE_END).join("");
}

/**
 * Wrap `payload` as a single bracketed paste. Returns it unchanged when there
 * is nothing to send — an empty paste is a no-op that only costs bytes.
 */
export function framePaste(payload: string): string {
  if (!payload) return payload;
  return PASTE_START + stripPasteMarkers(payload) + PASTE_END;
}

/**
 * Whether this delivery should be framed.
 *
 * Deliberately NOT conditional on length or on the body being multi-line. Both
 * were tried as rules by the lanes hitting this and both gave false assurance:
 * single-line 900-char bodies were lost, and the same body survived at another
 * terminal width. There is no size a sender can stay under, so the framing is
 * unconditional for a supporting CLI.
 *
 * The one exclusion is a slash command. A CLI recognizes `/foo` only when it is
 * typed at the start of the line, and pasted text is not typing — framing one
 * would turn a command the sender meant to run into plain text. Those bodies
 * are short and single-line, which is the shape that was never at risk anyway.
 */
export function shouldFramePaste(opts: {
  supported: boolean;
  body: string;
  isSlashCommand: boolean;
}): boolean {
  return opts.supported && Boolean(opts.body) && !opts.isSlashCommand;
}
