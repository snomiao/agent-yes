import { describe, expect, it } from "vitest";
import { suggestAgents } from "./subcommands";

const rec = (pid: number, cwd: string, started_at = pid) =>
  ({ pid, cwd, started_at, status: "active", agent_id: `id${pid}` }) as any;

describe("suggestAgents", () => {
  const live = [
    rec(1, "/home/u/ws/symval/symphr/tree/main"),
    rec(2, "/home/u/ws/symval/symphr/tree/bean"),
    rec(3, "/home/u/ws/snomiao/slack-term/tree/main"),
    { ...rec(4, "/home/u/ws/symval/symphr/tree/sf"), status: "exited" },
  ];
  it("suggests by a typo in a path segment", () => {
    expect(suggestAgents(live, "beam").map((r) => r.pid)).toEqual([2]);
  });
  it("suggests by substring", () => {
    expect(suggestAgents(live, "slack").map((r) => r.pid)).toEqual([3]);
  });
  it("skips exited agents and unrelated keywords", () => {
    expect(suggestAgents(live, "sf")).toEqual([]);
    expect(suggestAgents(live, "zzzzzz")).toEqual([]);
  });
  it("never suggests for numeric keywords (identity selectors)", () => {
    expect(suggestAgents(live, "12345")).toEqual([]);
  });
});
