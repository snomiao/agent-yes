const ESC = String.fromCharCode(0x1b);
const C1 = String.fromCharCode(0x9b);
const BEL = String.fromCharCode(0x07);
const BACKSLASH = String.fromCharCode(0x5c);
// String Terminator (ESC \) as REGEX SOURCE text: a literal backslash inside a
// regex pattern is itself an escape character, so matching one literal
// backslash requires two backslash characters in the pattern source.
const ST_PATTERN_SOURCE = ESC + BACKSLASH + BACKSLASH;

// OSC sequences (window/tab title updates, hyperlinks, etc.): ESC ] ...
// terminated by either BEL or ST (ESC \) — both are valid per-spec and used
// by real terminal apps. Not covered by the CSI pattern below — without this,
// e.g. a periodic title update would count as "visible" content to callers
// that gate activity on non-empty output.
// The terminator is required, not optional: an unterminated ESC]... (the
// terminator never arrives, e.g. a truncated chunk boundary) must NOT strip
// through to end-of-string — that would eat real trailing text as if it were
// part of the title sequence. The body excludes ESC too (not just BEL) so an
// ST-terminated sequence can't accidentally run on and swallow real text up
// to some unrelated, later BEL.
const OSC_PATTERN = new RegExp(
  ESC + "][^" + BEL + ESC + "]*(?:" + BEL + "|" + ST_PATTERN_SOURCE + ")",
  "g",
);

// Matches control characters in the C0 and C1 ranges, including Delete (U+007F)
const CSI_PATTERN = new RegExp(
  "[" + ESC + C1 + "][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]",
  "g",
);

export function removeControlCharacters(str: string): string {
  return str.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "");
}
