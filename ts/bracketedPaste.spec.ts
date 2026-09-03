import { describe, expect, it } from "vitest";
import {
  framePaste,
  PASTE_END,
  PASTE_START,
  shouldFramePaste,
  stripPasteMarkers,
} from "./bracketedPaste.ts";

describe("framePaste", () => {
  it("wraps a payload in the paste markers", () => {
    expect(framePaste("hello")).toBe(`${PASTE_START}hello${PASTE_END}`);
  });

  it("keeps the payload's own bytes, newlines included", () => {
    // The whole point: the newlines must survive as text, not act as submits.
    const body = "line one\nline two\nline three";
    expect(framePaste(body)).toBe(`${PASTE_START}${body}${PASTE_END}`);
  });

  it("does not emit an empty paste", () => {
    expect(framePaste("")).toBe("");
  });
});

describe("stripPasteMarkers", () => {
  // An embedded END marker would close our paste early and hand every following
  // byte to the CLI as live keystrokes — a message that drives the receiving
  // agent's TUI instead of being read by it.
  it("removes an embedded END marker so a body cannot escape its own paste", () => {
    const hostile = `innocent${PASTE_END}:q!\rrm -rf /`;
    const framed = framePaste(hostile);
    expect(framed.indexOf(PASTE_END)).toBe(framed.length - PASTE_END.length);
    expect(framed.split(PASTE_END)).toHaveLength(2);
  });

  it("removes an embedded START marker too", () => {
    expect(stripPasteMarkers(`a${PASTE_START}b`)).toBe("ab");
    expect(framePaste(`a${PASTE_START}b`).split(PASTE_START)).toHaveLength(2);
  });

  it("leaves a body with no markers untouched", () => {
    expect(stripPasteMarkers("plain \x1b[A text")).toBe("plain \x1b[A text");
  });
});

describe("shouldFramePaste", () => {
  it("frames for a supporting CLI", () => {
    expect(shouldFramePaste({ supported: true, body: "hi", isSlashCommand: false })).toBe(true);
  });

  it("never frames for a CLI that does not enable the mode", () => {
    // It would see ESC[200~ as literal text.
    expect(shouldFramePaste({ supported: false, body: "hi", isSlashCommand: false })).toBe(false);
  });

  it("does not frame a slash command — pasted text is not typing", () => {
    expect(shouldFramePaste({ supported: true, body: "/exit", isSlashCommand: true })).toBe(false);
  });

  it("frames regardless of length or line count", () => {
    // Both rules were tried by the lanes hitting this bug and both gave false
    // assurance: single-line 900-char bodies were lost, and the same body
    // survived at a different terminal width. There is no safe size.
    for (const body of ["x", "x".repeat(900), "a\nb", "a".repeat(900) + "\n" + "b".repeat(90)]) {
      expect(shouldFramePaste({ supported: true, body, isSlashCommand: false })).toBe(true);
    }
  });

  it("has nothing to frame for an empty body", () => {
    expect(shouldFramePaste({ supported: true, body: "", isSlashCommand: false })).toBe(false);
  });
});
