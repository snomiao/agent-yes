// When the chat box's draft goes out. Pure, so the rules are unit tested
// without a DOM (test/input.test.ts); src/box.ts wires them to the textarea.
//
//   - DEBOUNCE_MS after the last keystroke;
//   - at once on Enter (Shift+Enter is a newline), but never while an IME
//     composition is open or on the Enter that confirms a candidate;
//   - on Android, whose keyboards report every key as 229, the line break
//     itself (beforeinput insertLineBreak / insertParagraph) is the cue;
//   - at once when dictation drops in more than BURST_CHARS ending a sentence.

/** Typing pauses this long before the draft is sent. */
export const DEBOUNCE_MS = 3_000;
/** A burst this long or longer (dictation) that ends a sentence sends at once. */
export const BURST_CHARS = 10;
export const ENDS_SENTENCE = /[。．.!?！？]$/;

export type KeyInfo = {
  key: string;
  shiftKey: boolean;
  keyCode?: number;
  isComposing?: boolean;
};

/** An Enter keydown that sends: not Shift+Enter, not inside or confirming an IME composition. */
export function enterSends(e: KeyInfo, composing: boolean): boolean {
  if (e.key !== "Enter" || e.shiftKey) return false;
  // Safari reports the Enter that confirms a candidate as 229 after compositionend.
  return !(e.isComposing || composing || e.keyCode === 229);
}

/** A beforeinput line break that sends (Android): not Shift+Enter, not composing. */
export function lineBreakSends(
  inputType: string,
  opts: { composing: boolean; isComposing?: boolean; shiftEnter: boolean },
): boolean {
  if (inputType !== "insertLineBreak" && inputType !== "insertParagraph") return false;
  return !(opts.composing || opts.isComposing || opts.shiftEnter);
}

/**
 * After the draft changed outside a composition: "send" now (a dictated
 * sentence), "arm" the debounce, or "idle" (nothing to send). `settledLen` is
 * the draft's length at the previous settled change.
 */
export function afterChange(
  text: string,
  settledLen: number,
  composing: boolean,
): "send" | "arm" | "idle" {
  if (composing) return "idle";
  if (text.length - settledLen > BURST_CHARS && ENDS_SENTENCE.test(text.trim())) return "send";
  return text.trim() ? "arm" : "idle";
}
