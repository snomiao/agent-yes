const ESC = String.fromCharCode(0x1b);
const C1 = String.fromCharCode(0x9b);
const BEL = String.fromCharCode(0x07);

// OSC sequences (window/tab title updates, hyperlinks, etc.): ESC ] ... BEL.
// Terminated by BEL (the common case for real-world terminal apps); not
// covered by the CSI pattern below — without this, e.g. a periodic title
// update would count as "visible" content to callers that gate activity on
// non-empty output.
// BEL is required, not optional: an unterminated ESC]... (BEL never arrives,
// e.g. a truncated chunk boundary) must NOT strip through to end-of-string —
// that would eat real trailing text as if it were part of the title sequence.
const OSC_PATTERN = new RegExp(ESC + "][^" + BEL + "]*" + BEL, "g");

// Matches control characters in the C0 and C1 ranges, including Delete (U+007F)
const CSI_PATTERN = new RegExp(
  "[" + ESC + C1 + "][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]",
  "g",
);

export function removeControlCharacters(str: string): string {
  return str.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "");
}
