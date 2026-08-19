import { describe, expect, it } from "vitest";
import {
  REPLY_BURST,
  REPLY_HARD_CAP,
  REPLY_WINDOW_MS,
  isTerminalReply,
  makeTerminalReplyGuard,
} from "./terminalReply.ts";

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

describe("makeTerminalReplyGuard", () => {
  const CPR = "\x1b[?1;1R";
  it("answers the query — the first replies in a window pass", () => {
    const allow = makeTerminalReplyGuard();
    expect(allow(1, CPR, 0)).toBe(true);
    expect(allow(1, CPR, 1)).toBe(true);
    expect(allow(1, CPR, 2)).toBe(true);
  });
  it("drops the sustained loop: identical replies beyond the burst", () => {
    const allow = makeTerminalReplyGuard();
    for (let i = 0; i < REPLY_BURST; i++) expect(allow(1, CPR, i)).toBe(true);
    expect(allow(1, CPR, 10)).toBe(false);
    expect(allow(1, CPR, 20)).toBe(false);
  });
  it("lets a genuinely moved cursor through", () => {
    const allow = makeTerminalReplyGuard();
    for (let i = 0; i < 8; i++) allow(1, CPR, i);
    expect(allow(1, "\x1b[?9;4R", 9)).toBe(true); // different position = information
  });
  it("caps even alternating payloads", () => {
    const allow = makeTerminalReplyGuard();
    let passed = 0;
    for (let i = 0; i < 200; i++) if (allow(1, i % 2 ? CPR : "\x1b[?2;2R", 5)) passed++;
    expect(passed).toBeLessThanOrEqual(REPLY_HARD_CAP);
  });
  it("recovers after the window elapses", () => {
    const allow = makeTerminalReplyGuard();
    for (let i = 0; i < 50; i++) allow(1, CPR, 0);
    expect(allow(1, CPR, REPLY_WINDOW_MS)).toBe(true);
  });
  it("tracks each agent independently", () => {
    const allow = makeTerminalReplyGuard();
    for (let i = 0; i < 50; i++) allow(1, CPR, 0);
    expect(allow(2, CPR, 0)).toBe(true);
  });
});
