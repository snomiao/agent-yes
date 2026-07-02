import { describe, expect, it } from "vitest";
import { removeControlCharacters } from "./removeControlCharacters";

describe("removeControlCharacters", () => {
  it("should remove ANSI escape sequences", () => {
    const input = "\u001b[31mRed text\u001b[0m";
    const expected = "Red text";
    expect(removeControlCharacters(input)).toBe(expected);
  });

  it("should remove cursor positioning codes", () => {
    const input = "\u001b[1;1HHello\u001b[2;1HWorld";
    const expected = "HelloWorld";
    expect(removeControlCharacters(input)).toBe(expected);
  });

  it("should remove color codes", () => {
    const input = "\u001b[32mGreen\u001b[0m \u001b[31mRed\u001b[0m";
    const expected = "Green Red";
    expect(removeControlCharacters(input)).toBe(expected);
  });

  it("should remove complex ANSI sequences", () => {
    const input = "\u001b[1;33;40mYellow on black\u001b[0m";
    const expected = "Yellow on black";
    expect(removeControlCharacters(input)).toBe(expected);
  });

  it("should handle empty string", () => {
    expect(removeControlCharacters("")).toBe("");
  });

  it("should handle string with no control characters", () => {
    const input = "Plain text with no escape sequences";
    expect(removeControlCharacters(input)).toBe(input);
  });

  it("should remove CSI sequences with multiple parameters", () => {
    const input = "\u001b[38;5;196mBright red\u001b[0m";
    const expected = "Bright red";
    expect(removeControlCharacters(input)).toBe(expected);
  });

  it("should remove C1 control characters", () => {
    const input = "\u009b[32mGreen text\u009b[0m";
    const expected = "Green text";
    expect(removeControlCharacters(input)).toBe(expected);
  });

  it("should handle mixed control and regular characters", () => {
    const input = "Start\u001b[1mBold\u001b[0mMiddle\u001b[4mUnderline\u001b[0mEnd";
    const expected = "StartBoldMiddleUnderlineEnd";
    expect(removeControlCharacters(input)).toBe(expected);
  });

  it("should preserve spaces and newlines", () => {
    const input = "Line 1\u001b[31m\nRed Line 2\u001b[0m\n\nLine 4";
    const expected = "Line 1\nRed Line 2\n\nLine 4";
    expect(removeControlCharacters(input)).toBe(expected);
  });

  it("should handle cursor movement sequences", () => {
    const input = "\u001b[2AUp\u001b[3BDown\u001b[4CRight\u001b[5DLeft";
    const expected = "UpDownRightLeft";
    expect(removeControlCharacters(input)).toBe(expected);
  });

  it("should handle erase sequences", () => {
    const input = "Text\u001b[2JClear\u001b[KLine";
    const expected = "TextClearLine";
    expect(removeControlCharacters(input)).toBe(expected);
  });

  it("should remove OSC sequences (e.g. window title updates)", () => {
    const input = "Before\u001b]0;window title\u0007After";
    const expected = "BeforeAfter";
    expect(removeControlCharacters(input)).toBe(expected);
  });

  it("does NOT strip trailing text when an OSC sequence is unterminated (no BEL)", () => {
    const input = "Before\u001b]0;titleAfter";
    expect(removeControlCharacters(input)).toBe(input);
  });
});
