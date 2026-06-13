// Unit tests for the agent-yes console's pure logic (lab/ui/console-logic.js).
// These cover the behaviour the left panel relies on: default-CLI omission,
// repo/branch identity (incl. the 3-char compact cap), key:value + bare-token
// filtering, age formatting, and the Alt+PageUp/PageDown selection clamp.
import { describe, it, expect } from "vitest";
import {
  cliLabel,
  repoBranch,
  ident,
  tagsFor,
  age,
  matches,
  nextIndex,
} from "../../lab/ui/console-logic.js";

const agent = (over = {}) => ({
  cli: "claude",
  cwd: "/home/u/ws/snomiao/agent-yes/tree/main",
  title: "",
  prompt: "",
  status: "active",
  pid: 1,
  ...over,
});

describe("cliLabel", () => {
  it("omits the default claude CLI", () => {
    expect(cliLabel(agent({ cli: "claude" }))).toBe("");
  });
  it("shows non-default CLIs", () => {
    expect(cliLabel(agent({ cli: "codex" }))).toBe("codex");
    expect(cliLabel(agent({ cli: "gemini" }))).toBe("gemini");
  });
  it("treats a missing cli as empty", () => {
    expect(cliLabel(agent({ cli: undefined }))).toBe("");
  });
});

describe("repoBranch", () => {
  it("parses owner/repo/branch from a .../tree/<branch> cwd", () => {
    expect(repoBranch(agent())).toEqual({
      owner: "snomiao",
      repo: "agent-yes",
      branch: "main",
    });
  });
  it("returns null when the cwd doesn't match the layout", () => {
    expect(repoBranch(agent({ cwd: "/tmp/scratch" }))).toBeNull();
    expect(repoBranch(agent({ cwd: "" }))).toBeNull();
  });
});

describe("ident", () => {
  it("renders repo/branch in full when uncapped", () => {
    expect(ident(agent())).toBe("agent-yes/main");
  });
  it("caps repo and branch to 3 chars in compact mode", () => {
    expect(ident(agent(), true)).toBe("age/mai");
  });
  it("does not pad short names when capping", () => {
    expect(ident(agent({ cwd: "/x/me/ab/tree/cd" }), true)).toBe("ab/cd");
  });
  it("is empty when there's no repo/branch", () => {
    expect(ident(agent({ cwd: "/tmp" }), true)).toBe("");
  });
});

describe("tagsFor", () => {
  it("derives repo + wt tags, and omits the cli tag for default claude", () => {
    const tags = tagsFor(agent());
    expect(tags).toContainEqual(["repo", "snomiao/agent-yes"]);
    expect(tags).toContainEqual(["wt", "main"]);
    expect(tags.find(([k]) => k === "cli")).toBeUndefined();
  });
  it("adds a cli tag only for non-default CLIs, and a host tag for rooms", () => {
    const tags = tagsFor(agent({ cli: "codex", _host: "laptop" }));
    expect(tags).toContainEqual(["cli", "codex"]);
    expect(tags).toContainEqual(["host", "laptop"]);
  });
});

describe("age", () => {
  const now = 1_000_000_000_000;
  it("returns empty without a start time", () => {
    expect(age(agent({ started_at: 0 }), now)).toBe("");
  });
  it("formats seconds, minutes, and hours", () => {
    expect(age(agent({ started_at: now - 5_000 }), now)).toBe("5s");
    expect(age(agent({ started_at: now - 5 * 60_000 }), now)).toBe("5m");
    expect(age(agent({ started_at: now - 3 * 3_600_000 }), now)).toBe("3h");
  });
  it("clamps a future start time to 0s instead of going negative", () => {
    expect(age(agent({ started_at: now + 10_000 }), now)).toBe("0s");
  });
});

describe("matches", () => {
  it("matches a bare token as a case-insensitive substring", () => {
    expect(matches(agent({ title: "Fix the parser" }), ["parser"])).toBe(true);
    expect(matches(agent({ title: "Fix the parser" }), ["PARSER"])).toBe(true);
    expect(matches(agent(), ["nope"])).toBe(false);
  });
  it("ANDs every token", () => {
    const a = agent({ title: "fix parser bug" });
    expect(matches(a, ["fix", "bug"])).toBe(true);
    expect(matches(a, ["fix", "missing"])).toBe(false);
  });
  it("matches key:value tokens against the mnemonic tags", () => {
    expect(matches(agent(), ["repo:agent-yes"])).toBe(true);
    expect(matches(agent(), ["wt:main"])).toBe(true);
    expect(matches(agent({ cli: "codex" }), ["cli:codex"])).toBe(true);
    expect(matches(agent(), ["repo:nope"])).toBe(false);
    // default claude has no cli tag, so a cli: filter must not match it
    expect(matches(agent({ cli: "claude" }), ["cli:claude"])).toBe(false);
  });
});

describe("nextIndex", () => {
  it("returns -1 for an empty list", () => {
    expect(nextIndex(0, -1, 1)).toBe(-1);
  });
  it("lands on the first row going down / last going up when nothing is selected", () => {
    expect(nextIndex(5, -1, 1)).toBe(0);
    expect(nextIndex(5, -1, -1)).toBe(4);
  });
  it("steps and clamps at both ends", () => {
    expect(nextIndex(5, 2, 1)).toBe(3);
    expect(nextIndex(5, 2, -1)).toBe(1);
    expect(nextIndex(5, 4, 1)).toBe(4); // clamp at bottom, no wrap
    expect(nextIndex(5, 0, -1)).toBe(0); // clamp at top, no wrap
  });
});
