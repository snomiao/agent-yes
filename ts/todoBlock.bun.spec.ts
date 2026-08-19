import { describe, expect, it } from "bun:test";
import { blockedOnAgent, describeBlock, monitorHint, type TodoBlock } from "./todoBlock";

describe("todoBlock", () => {
  it("blocked-by-human needs no monitor — a human's reply always self-delivers", () => {
    expect(monitorHint({ type: "blocked-by-human", who: "someone" })).toBe("none");
  });
  it("blocked-by-task needs no monitor — clears itself via pure data (unblockedTasks)", () => {
    expect(monitorHint({ type: "blocked-by-task", taskId: "T1" })).toBe("none");
  });
  it("waiting-on-agent needs a notify-agent monitor", () => {
    expect(monitorHint({ type: "waiting-on-agent", agentId: "abc123" })).toBe("notify-agent");
  });
  it("blocked-by-external needs a poll-external monitor", () => {
    expect(monitorHint({ type: "blocked-by-external", signal: "ci-run" })).toBe("poll-external");
  });

  it("describeBlock renders each shape distinctly and legibly", () => {
    const cases: TodoBlock[] = [
      { type: "blocked-by-task", taskId: "T9" },
      { type: "blocked-by-human", who: "alex", question: "canary or beta?" },
      { type: "blocked-by-external", signal: "release-pipeline" },
      { type: "waiting-on-agent", agentId: "xyz789" },
    ];
    const rendered = cases.map(describeBlock);
    expect(rendered[0]).toContain("T9");
    expect(rendered[1]).toContain("alex");
    expect(rendered[1]).toContain("canary or beta?");
    expect(rendered[2]).toContain("release-pipeline");
    expect(rendered[3]).toContain("xyz789");
    expect(new Set(rendered).size).toBe(4); // all distinct
  });

  it("describeBlock includes the actionLink when a blocked-by-human ask is action-shaped (A7)", () => {
    const rendered = describeBlock({
      type: "blocked-by-human",
      who: "alice",
      actionLink: "https://example/oauth",
    });
    expect(rendered).toContain("alice");
    expect(rendered).toContain("https://example/oauth");
  });
});

describe("blockedOnAgent", () => {
  it("names the agent for both agent-shaped blocks", () => {
    expect(blockedOnAgent({ type: "waiting-on-agent", agentId: "lane-b" })).toBe("lane-b");
    expect(blockedOnAgent({ type: "waiting-on-answer", agentId: "lane-c" })).toBe("lane-c");
  });

  it("returns null for block shapes that name no agent, and for no block at all", () => {
    expect(blockedOnAgent({ type: "blocked-by-task", taskId: "T1" })).toBeNull();
    expect(blockedOnAgent({ type: "blocked-by-human", who: "alice" })).toBeNull();
    expect(blockedOnAgent({ type: "blocked-by-external", signal: "ci" })).toBeNull();
    expect(blockedOnAgent(null)).toBeNull();
    expect(blockedOnAgent(undefined)).toBeNull();
  });
});

describe("waiting-on-answer", () => {
  it("describes who owes the answer, and the question when one was recorded", () => {
    expect(describeBlock({ type: "waiting-on-answer", agentId: "lane-b" })).toBe(
      "waiting for an answer from lane-b",
    );
    expect(
      describeBlock({ type: "waiting-on-answer", agentId: "lane-b", question: "build red?" }),
    ).toBe("waiting for an answer from lane-b: build red?");
  });

  it("is watched via the answering agent's lifecycle, since it can die owing the answer", () => {
    expect(monitorHint({ type: "waiting-on-answer", agentId: "lane-b" })).toBe("notify-agent");
  });
});
