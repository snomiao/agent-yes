// The debug chat listener's decisions (lab/ui/debug-listen.ts): whose lines it
// acts on, when it stays quiet, what it hands the agent.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deliverable, forAgent, parseChat, shouldAct } from "../../lab/ui/debug-listen.ts";

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

describe("seen cap", () => {
  it("forgets the oldest ids past 500", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 600; i++) shouldAct(parseChat(line({ from: "owner", id: `m${i}` }))!, seen);
    expect(seen.size).toBe(500);
    expect(seen.has("m0")).toBe(false);
    expect(seen.has("m599")).toBe(true);
  });
});

describe("deliverable", () => {
  it("inlines a short line and hands a long one over as a private file", () => {
    const dir = mkdtempSync(join(tmpdir(), "t-"));
    const short = parseChat(line({ from: "owner" }))!;
    expect(deliverable(short, "https://h", dir)).toContain("\nhi");
    const long = parseChat(line({ from: "owner", text: "x".repeat(2000) }))!;
    const msg = deliverable(long, "https://h", dir);
    expect(msg.length).toBeLessThan(1000);
    const file = /in (\S+\.txt)/.exec(msg)![1];
    expect(readFileSync(file, "utf8")).toBe("x".repeat(2000));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true });
  });
});

describe("forAgent", () => {
  it("carries the reply command and the text", () => {
    const m = forAgent(parseChat(line({ from: "owner" }))!, "https://h/_ay/chat");
    expect(m).toContain("liagent say https://h/_ay/chat");
    expect(m.endsWith("\nhi")).toBe(true);
  });
});
