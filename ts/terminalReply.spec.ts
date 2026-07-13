import { describe, expect, it } from "vitest";
import { isTerminalReply } from "./terminalReply.ts";

describe("isTerminalReply", () => {
  it("matches single auto-replies (CPR, DECXCPR, DA1, DA2, DSR)", () => {
    expect(isTerminalReply("\x1b[5;10R")).toBe(true); // CPR (ESC[6n answer)
    expect(isTerminalReply("\x1b[?1;1R")).toBe(true); // DECXCPR (ESC[?6n answer)
    expect(isTerminalReply("\x1b[?1;1;1R")).toBe(true); // DECXCPR with page
    expect(isTerminalReply("\x1b[?1;2c")).toBe(true); // DA1
    expect(isTerminalReply("\x1b[>0;276;0c")).toBe(true); // DA2
    expect(isTerminalReply("\x1b[0n")).toBe(true); // DSR status OK
  });

  it("matches a burst of replies concatenated in one chunk", () => {
    // A viewer attach replays a tail full of queries; xterm answers them all
    // in one onData chunk.
    expect(isTerminalReply("\x1b[?1;1R\x1b[?1;1R\x1b[?1;1R")).toBe(true);
    expect(isTerminalReply("\x1b[1;1R\x1b[?1;2c\x1b[0n")).toBe(true);
  });

  it("never matches real typing", () => {
    expect(isTerminalReply("hello")).toBe(false);
    expect(isTerminalReply("\r")).toBe(false);
    expect(isTerminalReply("\x1b[A")).toBe(false); // arrow key
    expect(isTerminalReply("\x1b[1;5C")).toBe(false); // ctrl+arrow (no R/c/n final)
    expect(isTerminalReply("\x1b")).toBe(false);
    expect(isTerminalReply("")).toBe(false);
    expect(isTerminalReply("\x1b[R")).toBe(false); // malformed — not a reply xterm emits
  });

  it("never matches a chunk that mixes a reply with real input", () => {
    expect(isTerminalReply("\x1b[?1;1Ry")).toBe(false);
    expect(isTerminalReply("y\x1b[?1;1R")).toBe(false);
    expect(isTerminalReply("\x1b[1;1R\r")).toBe(false);
  });
});
