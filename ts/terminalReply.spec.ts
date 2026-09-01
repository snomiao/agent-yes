import { describe, expect, it } from "vitest";
import { isTerminalReply, isUnpromptedTerminalReply } from "./terminalReply.ts";

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

// Byte shapes below are terminal protocol observed in a live incident; no fleet
// data is involved in reproducing them.
describe("isUnpromptedTerminalReply", () => {
  it("matches the replies a terminal sends that nobody asked for", () => {
    expect(isUnpromptedTerminalReply("\x1b[?59;3R")).toBe(true); // DECXCPR
    expect(isUnpromptedTerminalReply("\x1b[?1;4R")).toBe(true);
    expect(isUnpromptedTerminalReply("\x1b[?1;2c")).toBe(true); // DA1
    expect(isUnpromptedTerminalReply("\x1b[>0;276;0c")).toBe(true); // DA2
    expect(isUnpromptedTerminalReply("\x1b[0n")).toBe(true); // DSR
    expect(isUnpromptedTerminalReply("\x1b]11;rgb:0d0d/1111/1717\x1b\\")).toBe(true); // OSC 11, ST
    expect(isUnpromptedTerminalReply("\x1b]10;rgb:c9c9/d1d1/d9d9\x07")).toBe(true); // OSC 10, BEL
    expect(isUnpromptedTerminalReply("\x1b]4;1;rgb:1111/2222/3333\x1b\\")).toBe(true); // palette
  });

  it("matches a burst, including one that mixes CSI and OSC families", () => {
    expect(isUnpromptedTerminalReply("\x1b[?59;29R" + "\x1b[?59;3R".repeat(6))).toBe(true);
    // The attach handshake: cursor report, both colour replies, device
    // attributes — one write. Two predicates OR'd together cannot see this,
    // because each would anchor over only its own alphabet.
    expect(
      isUnpromptedTerminalReply(
        "\x1b[?1;1R\x1b]10;rgb:1f1f/2323/2828\x1b\\\x1b]11;rgb:ffff/ffff/ffff\x1b\\\x1b[?1;2c",
      ),
    ).toBe(true);
  });

  it("REFUSES plain CPR, because xterm's modified F3 is the same shape", () => {
    // `ESC[1;2R` is modified F3, not a cursor report — `R` ends both, so the
    // final byte does NOT separate an input from a reply. Measured over 128,827
    // stored rows: plain CPR appears once, `?`-prefixed DECXCPR 46,693 times.
    expect(isUnpromptedTerminalReply("\x1b[1;2R")).toBe(false);
    expect(isUnpromptedTerminalReply("\x1b[1;1R")).toBe(false);
    expect(isUnpromptedTerminalReply("\x1b[5;10R")).toBe(false);
    // serve's predicate still accepts these; that difference is deliberate.
    expect(isTerminalReply("\x1b[1;2R")).toBe(true);
  });

  it("REFUSES SGR mouse, because a click in a TUI is something a person did", () => {
    // `M` is press/wheel/motion and `m` is release. Pointer drift and a
    // deliberate button click emit the same bytes.
    expect(isUnpromptedTerminalReply("\x1b[<65;24;18M")).toBe(false);
    expect(isUnpromptedTerminalReply("\x1b[<0;12;27m")).toBe(false);
    expect(isUnpromptedTerminalReply("\x1b[<35;61;12M\x1b[<35;60;12M")).toBe(false);
  });

  it("never matches keys, prose, or a chunk that merely contains a reply", () => {
    for (const key of [
      "\x1b[A",
      "\x1b[B",
      "\x1b[C",
      "\x1b[D",
      "\x1b[H",
      "\x1b[F",
      "\x1b[3~",
      "\x1b[6~",
      "\x1b[I",
      "\x1b[O",
      "\x1b[1;2C",
      "\x1b",
    ])
      expect(isUnpromptedTerminalReply(key), `key ${JSON.stringify(key)}`).toBe(false);
    expect(isUnpromptedTerminalReply("\x7f")).toBe(false); // backspace
    expect(isUnpromptedTerminalReply("\r")).toBe(false);
    expect(isUnpromptedTerminalReply("the deploy is green")).toBe(false);
    expect(isUnpromptedTerminalReply("cursor came back as \x1b[?59;3R — ignore it")).toBe(false);
    expect(isUnpromptedTerminalReply("\x1b[?59;3R done")).toBe(false);
    expect(isUnpromptedTerminalReply("done \x1b[?59;3R")).toBe(false);
    expect(isUnpromptedTerminalReply("")).toBe(false);
  });
});
