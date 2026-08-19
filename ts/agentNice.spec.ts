import { afterEach, describe, expect, it, vi } from "vitest";

// applyAgentNice reaches setPriority through a dynamic `await import("os")`, so
// the module has to be mocked rather than spied — a namespace object's exports
// are frozen and a spy on them never takes effect.
const setPriority = vi.fn();
vi.mock("os", async (importActual) => {
  const actual = await importActual<typeof import("os")>();
  return { ...actual, default: { ...actual, setPriority }, setPriority };
});

import { agentNiceValue, applyAgentNice } from "./agentNice.ts";

describe("agentNice.agentNiceValue", () => {
  it("defaults to 5 when unset or empty", () => {
    expect(agentNiceValue({})).toBe(5);
    expect(agentNiceValue({ AGENT_YES_AGENT_NICE: "" })).toBe(5);
  });

  it("honors a valid positive value", () => {
    expect(agentNiceValue({ AGENT_YES_AGENT_NICE: "10" })).toBe(10);
    expect(agentNiceValue({ AGENT_YES_AGENT_NICE: "0" })).toBe(0); // 0 = disabled
  });

  it("clamps into the 0..19 nice range (never elevates)", () => {
    expect(agentNiceValue({ AGENT_YES_AGENT_NICE: "-5" })).toBe(0); // no negative (needs CAP_SYS_NICE)
    expect(agentNiceValue({ AGENT_YES_AGENT_NICE: "40" })).toBe(19);
  });

  it("falls back to the default on garbage", () => {
    expect(agentNiceValue({ AGENT_YES_AGENT_NICE: "abc" })).toBe(5);
    expect(agentNiceValue({ AGENT_YES_AGENT_NICE: "3.9" })).toBe(3); // truncates
  });
});

describe("agentNice.applyAgentNice", () => {
  afterEach(() => {
    setPriority.mockReset();
  });

  it("deprioritizes the spawned pid to the configured nice", async () => {
    await applyAgentNice(4242, { AGENT_YES_AGENT_NICE: "7" });

    expect(setPriority).toHaveBeenCalledWith(4242, 7);
  });

  it("does nothing when nice is 0 (explicitly disabled)", async () => {
    await applyAgentNice(4242, { AGENT_YES_AGENT_NICE: "0" });

    // 0 means "leave the agent at the default priority" — calling setPriority(0)
    // anyway would be a no-op syscall, but skipping it keeps the disabled path
    // free of a platform call that can throw.
    expect(setPriority).not.toHaveBeenCalled();
  });

  it("swallows a setPriority failure — a scheduling hint must never break a spawn", async () => {
    setPriority.mockImplementation(() => {
      // What an unprivileged container or a pid that already exited looks like.
      throw new Error("EPERM: operation not permitted");
    });

    await expect(applyAgentNice(4242, { AGENT_YES_AGENT_NICE: "5" })).resolves.toBeUndefined();
  });
});
