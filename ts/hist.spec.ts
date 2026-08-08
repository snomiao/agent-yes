import { describe, expect, it } from "vitest";
import { renderRecord, snippet } from "./hist.ts";
import type { HistRecord } from "./histStore.ts";

const rec: HistRecord = {
  ts: "2026-08-06T09:29:37.533Z",
  role: "user",
  text: "hello there",
  source: "claude",
  sessionId: "ff1f38ee-78aa-48a6",
  file: "/tmp/x.jsonl",
  offset: 0,
};

describe("snippet", () => {
  it("leaves short text alone", () => {
    expect(snippet("short", 100)).toBe("short");
  });

  it("truncates and reports what was withheld", () => {
    const out = snippet("a".repeat(50) + "\n" + "b".repeat(50), 10);
    expect(out.startsWith("a".repeat(10))).toBe(true);
    expect(out).toContain("+91 chars");
    expect(out).toContain("2 more lines");
  });

  it("treats max 0 as unlimited, for --full", () => {
    const long = "x".repeat(5000);
    expect(snippet(long, 0)).toBe(long);
  });
});

describe("renderRecord", () => {
  it("labels the human as user and the agent by its source", () => {
    expect(renderRecord(rec, { color: false, max: 0 })).toContain("user");
    expect(
      renderRecord({ ...rec, role: "assistant" }, { color: false, max: 0 }),
    ).toContain("claude");
    expect(
      renderRecord({ ...rec, role: "assistant", source: "codex" }, { color: false, max: 0 }),
    ).toContain("codex");
  });

  it("emits no ANSI when color is off, so pipes stay clean", () => {
    const out = renderRecord(rec, { color: false, max: 0 });
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(false);
  });

  it("indents the body and shows a short session id", () => {
    const out = renderRecord(rec, { color: false, max: 0 });
    expect(out).toContain("\n  hello there");
    expect(out).toContain("ff1f38ee");
    expect(out).not.toContain("ff1f38ee-78aa");
  });

  it("survives a missing timestamp", () => {
    expect(renderRecord({ ...rec, ts: null }, { color: false, max: 0 })).toContain("??:??");
  });
});
