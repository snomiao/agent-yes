import { describe, expect, it } from "vitest";
import { buildSpawnTutorial, shouldForkNested } from "./forkNested";

describe("shouldForkNested", () => {
  it("forks when nested (AGENT_YES_PID set) and stdout is not a TTY", () => {
    expect(shouldForkNested({ isTTY: false, ayPid: "1234", attach: false })).toBe(true);
  });

  it("does NOT fork on an interactive TTY (a human running it directly)", () => {
    expect(shouldForkNested({ isTTY: true, ayPid: "1234", attach: false })).toBe(false);
  });

  it("does NOT fork when not nested — a human piping output has no AGENT_YES_PID", () => {
    expect(shouldForkNested({ isTTY: false, ayPid: undefined, attach: false })).toBe(false);
    expect(shouldForkNested({ isTTY: false, ayPid: "", attach: false })).toBe(false);
    expect(shouldForkNested({ isTTY: false, ayPid: "   ", attach: false })).toBe(false);
  });

  it("does NOT fork when attach opts out, regardless of context", () => {
    expect(shouldForkNested({ isTTY: false, ayPid: "1234", attach: true })).toBe(false);
  });
});

describe("buildSpawnTutorial", () => {
  it("names the cli + pid and lists the drive commands with that pid", () => {
    const out = buildSpawnTutorial("claude", 4242);
    expect(out).toContain("Spawned claude agent as pid 4242");
    expect(out).toContain("ay tail 4242");
    expect(out).toContain("ay send 4242");
    expect(out).toContain("ay ls");
    expect(out).toContain("ay result get 4242");
    expect(out).toContain("ay exit 4242");
  });
});
