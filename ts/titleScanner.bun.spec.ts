import { describe, expect, it } from "bun:test";
import { TitlePublisher, TitleScanner } from "./titleScanner.ts";

describe("TitleScanner", () => {
  it("parses OSC 0 terminated by BEL", () => {
    const s = new TitleScanner();
    expect(s.feed("\x1b]0;✳ fixing tests\x07")).toBe("✳ fixing tests");
  });

  it("parses OSC 2 terminated by ST (ESC \\)", () => {
    const s = new TitleScanner();
    expect(s.feed("\x1b]2;my task\x1b\\")).toBe("my task");
  });

  it("survives a chunk split mid-sequence", () => {
    const s = new TitleScanner();
    expect(s.feed("text \x1b]0;ha")).toBeNull();
    expect(s.feed("lf done\x07 more")).toBe("half done");
  });

  it("returns the last title when a chunk has several", () => {
    const s = new TitleScanner();
    expect(s.feed("\x1b]0;one\x07\x1b]2;two\x07")).toBe("two");
  });

  it("ignores icon-only and unrelated OSC sequences", () => {
    const s = new TitleScanner();
    expect(s.feed("\x1b]1;icon\x07\x1b]52;c;YWJj\x07\x1b]133;A\x07")).toBeNull();
  });

  it("ignores CSI colors and plain text", () => {
    const s = new TitleScanner();
    expect(s.feed("plain \x1b[31mred\x1b[0m text")).toBeNull();
  });

  it("caps runaway titles and resyncs", () => {
    const s = new TitleScanner();
    expect(s.feed(`\x1b]0;${"x".repeat(2000)}\x07`)).toBeNull();
    expect(s.feed("\x1b]0;ok\x07")).toBe("ok");
  });

  it("strips control chars and rejects empty titles", () => {
    const s = new TitleScanner();
    expect(s.feed("\x1b]0;a\tb\x07")).toBe("ab");
    expect(s.feed("\x1b]0;\x07")).toBeNull();
    expect(s.feed("\x1b]0;   \x07")).toBeNull();
  });
});

describe("TitlePublisher", () => {
  it("writes on change, dedupes, and rate-limits within the window", () => {
    const writes: string[] = [];
    const p = new TitlePublisher((t) => writes.push(t), 2000);
    p.observe("a");
    expect(writes).toEqual(["a"]); // first write is immediate
    p.observe("a");
    expect(writes).toEqual(["a"]); // unchanged — no write
    p.observe("b");
    expect(writes).toEqual(["a"]); // changed but throttled
    p.poll(Date.now() + 2500); // window elapsed — pending title lands
    expect(writes).toEqual(["a", "b"]);
    p.poll(Date.now() + 5000);
    expect(writes).toEqual(["a", "b"]); // nothing pending — no write
  });
});
