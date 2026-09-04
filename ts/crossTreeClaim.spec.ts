import { describe, expect, it } from "vitest";
import { envelopeAttribution } from "./subcommands.ts";
import { senderLabel, type MessageRecord } from "./messageLog.ts";

const rec = (over: Partial<MessageRecord>): MessageRecord => ({
  at: 1,
  from: { pid: 20298, cli: "claude", cwd: "/x/acme/tree/dev", agent_id: "lane-dev" },
  to: { pid: 2, cli: "claude", cwd: "/x/acme/tree/qa", agent_id: "lane-qa" },
  body: "hi",
  wrapped: true,
  ...over,
});

describe("a different tree claiming a lane is the contradiction", () => {
  // Measured on real traffic before this change: the rule keyed on "is some
  // OTHER registered lane my ancestor", and it ran inverted — LOUD on a lane's
  // own nested processes (same tree, benign) and SILENT while another worktree
  // sent two documents under this lane's name. The working directory is what
  // actually separates them.
  it("is LOUD in the envelope, because the receiving model reads only that", () => {
    expect(envelopeAttribution("env-uncorroborated")).toContain("UNCORROBORATED");
  });

  it("stays quiet for a lane's own detached process in its own tree", () => {
    expect(envelopeAttribution("env-unverified")).toBe("");
  });

  it("keeps the honest path silent", () => {
    expect(envelopeAttribution("env")).toBe("");
  });

  it("renders the distinction in a listing, where a human reads deliberately", () => {
    expect(senderLabel(rec({ from_via: "env-uncorroborated" }))).toContain("UNCORROBORATED");
    expect(senderLabel(rec({ from_via: "env-unverified" }))).toContain("unverified");
    expect(senderLabel(rec({ from_via: "env" }))).toBe("claude #20298");
  });

  it("still records what was measured about the real sender", () => {
    // The audit that found the misattribution used exactly this: `from` said
    // tree/dev, `sender_observed` said a process in tree/billings. Without the
    // observation there is nothing to compare the claim against.
    const r = rec({
      from_via: "env-uncorroborated",
      sender_observed: { user: "alice", host: "box", cwd: "/x/acme/tree/billings", pid: 47240 },
    });
    expect(r.sender_observed!.cwd).not.toBe(r.from!.cwd);
    expect(senderLabel(r)).toContain("UNCORROBORATED");
  });
});
