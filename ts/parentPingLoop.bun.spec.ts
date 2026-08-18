import { describe, expect, it } from "bun:test";
import { classifySelfState, startParentPingLoop } from "./parentPingLoop.ts";

// Mirrors the claude config (rs/default.config.yaml): a numbered menu cursor is
// a pending question, a spinner marker means work is happening, `❯ ` alone is
// the idle prompt.
const CONF = {
  needsInput: [/❯ ?\d+\./m],
  working: [/esc to interrupt/],
  ready: [/^\s*❯\s*$/m],
};

describe("classifySelfState", () => {
  it("a working spinner beats everything — a long silent tool call is not done", () => {
    expect(classifySelfState(["❯ 1. yes", "esc to interrupt"], CONF)).toBe("active");
    expect(classifySelfState(["❯", "esc to interrupt"], CONF)).toBe("active");
  });

  it("a pending menu is needs_input", () => {
    expect(classifySelfState(["Do you want to proceed?", "❯ 1. Yes", "  2. No"], CONF)).toBe(
      "needs_input",
    );
  });

  it("a bare prompt is idle", () => {
    expect(classifySelfState(["all done", "❯"], CONF)).toBe("idle");
  });

  it("falls back to active on an unrecognised screen — a false 'idle' is the costly error", () => {
    expect(classifySelfState(["...something..."], CONF)).toBe("active");
    expect(classifySelfState([], CONF)).toBe("active");
    expect(classifySelfState(["❯"], {})).toBe("active");
  });
});

describe("startParentPingLoop", () => {
  const self = { cli: "claude", pid: 1, cwd: "/repo" };
  const base = {
    selfWrapperPid: 2,
    self,
    patterns: CONF,
    screen: () => ["❯"],
  };

  it("never starts a timer for a top-level agent (no parent)", async () => {
    const loop = startParentPingLoop({ ...base, parentPid: undefined });
    await expect(loop.ready).resolves.toBe(false);
    loop.stop();
  });

  it("treats an unresolvable parent as no parent — a route that goes nowhere is worse than none", async () => {
    const loop = startParentPingLoop({ ...base, parentPid: 2 ** 30 });
    await expect(loop.ready).resolves.toBe(false);
    loop.stop();
  });

  it("pingExit is a safe no-op when there is nobody to report to", async () => {
    const loop = startParentPingLoop({ ...base, parentPid: undefined });
    await expect(loop.pingExit(0)).resolves.toBeUndefined();
  });

  it("survives a screen() that throws (a render hiccup is not a signal)", async () => {
    const loop = startParentPingLoop({
      ...base,
      parentPid: undefined,
      screen: () => {
        throw new Error("render race");
      },
    });
    await expect(loop.ready).resolves.toBe(false);
    await expect(loop.pingExit(1)).resolves.toBeUndefined();
  });

  it("stop() before the spawner lookup settles never arms a timer", async () => {
    const loop = startParentPingLoop({ ...base, parentPid: process.pid });
    loop.stop();
    await expect(loop.ready).resolves.toBe(false);
  });
});
