// The debug chat listener's decisions (lab/ui/debug-listen.ts): whose lines it
// acts on, when it stays quiet, what it hands the agent.
import { describe, expect, it } from "vitest";
import { forAgent, inQuietHours, parseChat, shouldAct } from "../../lab/ui/debug-listen.ts";

const line = (o: object) => JSON.stringify({ type: "chat", id: "abcdef0123", text: "hi", ...o });

describe("parseChat", () => {
  it("accepts chat events and drops everything else", () => {
    expect(parseChat(line({ from: "owner" }))?.text).toBe("hi");
    expect(parseChat('{"type":"page-changed"}')).toBeNull();
    expect(parseChat("not json")).toBeNull();
    expect(parseChat(line({ from: "stranger" }))).toBeNull();
  });
});

describe("shouldAct", () => {
  it("acts once per owner line and never on a friend's", () => {
    const seen = new Set<string>();
    const owner = parseChat(line({ from: "owner" }))!;
    expect(shouldAct(owner, seen)).toBe(true);
    expect(shouldAct(owner, seen)).toBe(false);
    expect(shouldAct(parseChat(line({ from: "friend", id: "x" }))!, seen)).toBe(false);
    expect(shouldAct(parseChat(line({ from: "owner", id: "y", text: "  " }))!, seen)).toBe(false);
  });
});

describe("inQuietHours", () => {
  const at = (h: number) => new Date(2026, 0, 1, h);
  it("wraps midnight and is off when unset", () => {
    expect(inQuietHours("22-7", at(23))).toBe(true);
    expect(inQuietHours("22-7", at(3))).toBe(true);
    expect(inQuietHours("22-7", at(12))).toBe(false);
    expect(inQuietHours("1-5", at(2))).toBe(true);
    expect(inQuietHours(undefined, at(3))).toBe(false);
  });
});

describe("forAgent", () => {
  it("carries the reply command and the text", () => {
    const m = forAgent(parseChat(line({ from: "owner" }))!, "https://h/_ay/chat");
    expect(m).toContain("liagent say https://h/_ay/chat");
    expect(m.endsWith("\nhi")).toBe(true);
  });
});
