import { describe, expect, it } from "bun:test";
import { isTerminalChatter, isTerminalDeviceEvent, isTerminalReply } from "./terminalReply.ts";

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

// The byte shapes below are terminal protocol observed in a live incident; no
// fleet data is involved in reproducing them.
describe("isTerminalDeviceEvent", () => {
  it("matches OSC colour replies (ST- and BEL-terminated) and SGR mouse reports", () => {
    expect(isTerminalDeviceEvent("\x1b]11;rgb:0d0d/1111/1717\x1b\\")).toBe(true); // bg, ST
    expect(isTerminalDeviceEvent("\x1b]10;rgb:c9c9/d1d1/d9d9\x07")).toBe(true); // fg, BEL
    expect(isTerminalDeviceEvent("\x1b]12;rgb:ff/00/00\x1b\\")).toBe(true); // cursor colour
    expect(isTerminalDeviceEvent("\x1b]4;1;rgb:1111/2222/3333\x1b\\")).toBe(true); // palette
    expect(isTerminalDeviceEvent("\x1b[<65;24;18M")).toBe(true); // pointer motion
    expect(isTerminalDeviceEvent("\x1b[<0;12;27m")).toBe(true); // button release
  });

  it("matches a drag — several mouse reports in one chunk", () => {
    expect(isTerminalDeviceEvent("\x1b[<35;61;12M\x1b[<35;60;12M\x1b[<35;59;12M")).toBe(true);
  });

  it("never matches typing, keys, or a query reply", () => {
    expect(isTerminalDeviceEvent("hello")).toBe(false);
    expect(isTerminalDeviceEvent("\x1b[B")).toBe(false); // arrow key
    expect(isTerminalDeviceEvent("\x1b[?1;1R")).toBe(false); // that is isTerminalReply's
    expect(isTerminalDeviceEvent("")).toBe(false);
  });

  it("never matches a chunk that mixes an event with real input", () => {
    expect(isTerminalDeviceEvent("\x1b[<65;24;18My")).toBe(false);
    expect(isTerminalDeviceEvent("y\x1b[<65;24;18M")).toBe(false);
  });
});

describe("isTerminalChatter", () => {
  it("accepts either family alone", () => {
    expect(isTerminalChatter("\x1b[?59;3R")).toBe(true);
    expect(isTerminalChatter("\x1b[<65;24;18M")).toBe(true);
    expect(isTerminalChatter("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")).toBe(true);
  });

  it("accepts a MIXED burst that neither family predicate can see", () => {
    // The attach handshake: cursor report + both colour replies + device
    // attributes, in one write. `isTerminalReply || isTerminalDeviceEvent`
    // returns false for this, which is why the union is one regex.
    const attach =
      "\x1b[1;1R\x1b]10;rgb:1f1f/2323/2828\x1b\\\x1b]11;rgb:ffff/ffff/ffff\x1b\\\x1b[?1;2c";
    expect(isTerminalReply(attach)).toBe(false);
    expect(isTerminalDeviceEvent(attach)).toBe(false);
    expect(isTerminalChatter(attach)).toBe(true);
  });

  it("never matches keys, prose, or a chunk that merely contains chatter", () => {
    for (const key of [
      "\x1b[A",
      "\x1b[B",
      "\x1b[C",
      "\x1b[D",
      "\x1b[H",
      "\x1b[F",
      "\x1b[3~",
      "\x1b[I",
      "\x1b[O",
    ])
      expect(isTerminalChatter(key), `key ${JSON.stringify(key)}`).toBe(false);
    expect(isTerminalChatter("\x7f")).toBe(false); // backspace
    expect(isTerminalChatter("\r")).toBe(false);
    expect(isTerminalChatter("the deploy is green")).toBe(false);
    expect(isTerminalChatter("cursor came back as \x1b[?59;3R — ignore it")).toBe(false);
    expect(isTerminalChatter("\x1b[?59;3R done")).toBe(false);
    expect(isTerminalChatter("")).toBe(false);
  });
});
