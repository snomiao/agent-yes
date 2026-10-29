import { describe, expect, test } from "bun:test";
import { afterChange, enterSends, lineBreakSends } from "../src/input.ts";

describe("enterSends", () => {
  test("plain Enter sends", () => {
    expect(enterSends({ key: "Enter", shiftKey: false, keyCode: 13 }, false)).toBe(true);
  });
  test("Shift+Enter is a newline", () => {
    expect(enterSends({ key: "Enter", shiftKey: true, keyCode: 13 }, false)).toBe(false);
  });
  test("never inside an IME composition, nor on the Enter that confirms a candidate", () => {
    expect(enterSends({ key: "Enter", shiftKey: false, isComposing: true }, false)).toBe(false);
    expect(enterSends({ key: "Enter", shiftKey: false }, true)).toBe(false);
    expect(enterSends({ key: "Enter", shiftKey: false, keyCode: 229 }, false)).toBe(false);
  });
  test("other keys do nothing", () => {
    expect(enterSends({ key: "a", shiftKey: false }, false)).toBe(false);
  });
});

describe("lineBreakSends (Android: every key is 229)", () => {
  const free = { composing: false, shiftEnter: false };
  test("the line break itself sends", () => {
    expect(lineBreakSends("insertLineBreak", free)).toBe(true);
    expect(lineBreakSends("insertParagraph", free)).toBe(true);
  });
  test("but not after Shift+Enter, nor while composing", () => {
    expect(lineBreakSends("insertLineBreak", { ...free, shiftEnter: true })).toBe(false);
    expect(lineBreakSends("insertLineBreak", { ...free, composing: true })).toBe(false);
    expect(lineBreakSends("insertParagraph", { ...free, isComposing: true })).toBe(false);
  });
  test("ordinary text is not a send", () => {
    expect(lineBreakSends("insertText", free)).toBe(false);
  });
});

describe("afterChange", () => {
  test("typing arms the debounce; an empty draft does not", () => {
    expect(afterChange("h", 0, false)).toBe("arm");
    expect(afterChange("   ", 0, false)).toBe("idle");
  });
  test("a dictated sentence (a burst over 10 chars ending a sentence) sends at once", () => {
    expect(afterChange("Fix the swipe please.", 0, false)).toBe("send");
    expect(afterChange("スワイプを直してください。", 0, false)).toBe("send");
    expect(afterChange("hello there? ", 0, false)).toBe("send");
  });
  test("a short or unfinished burst only arms", () => {
    expect(afterChange("ok.", 0, false)).toBe("arm");
    expect(afterChange("Fix the swipe please", 0, false)).toBe("arm");
  });
  test("typed one key at a time, a full stop does not send", () => {
    expect(afterChange("Fix the swipe please.", 20, false)).toBe("arm");
  });
  test("nothing while composing", () => {
    expect(afterChange("スワイプを直してください。", 0, true)).toBe("idle");
  });
});
