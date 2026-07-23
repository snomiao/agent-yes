import { describe, expect, it } from "vitest";
import { agentNiceValue } from "./agentNice.ts";

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
