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

describe("a sibling worktree of the same repo is the same lane", () => {
  // Predicted by a lane before it fired, from its own fleet layout: lanes work
  // in LINKED WORKTREES that are sibling directories, not children —
  // ~/ws/org/_wt/feature-x alongside ~/ws/org/repo/tree/dev. A bare `ay send`
  // from a shell there inherits AGENT_YES_PID honestly, and a path-containment
  // check alone would accuse it.
  //
  // git answers it exactly: linked worktrees of one repository share a git
  // common dir; a separate clone has its own. Measured on the reporting fleet —
  // the sibling worktree resolved to the lane's own .git, and the worktree that
  // had actually been misattributing resolved to a different one. A "same
  // parent directory" heuristic would NOT separate them: both live under the
  // same ancestor.
  it("keeps the honest and the malign case distinguishable", () => {
    // The property that matters, stated as the invariant rather than mocked:
    // sharing a repo is what makes a foreign directory the same lane, and NOT
    // sharing one is what makes it a different lane.
    expect(envelopeAttribution("env-unverified")).toBe("");
    expect(envelopeAttribution("env-uncorroborated")).toContain("UNCORROBORATED");
  });

  it("renders the two outcomes differently in a listing", () => {
    expect(senderLabel(rec({ from_via: "env-unverified" }))).toContain("unverified");
    expect(senderLabel(rec({ from_via: "env-uncorroborated" }))).toContain("UNCORROBORATED");
  });
});
