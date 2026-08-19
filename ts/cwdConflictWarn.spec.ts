import { describe, expect, it } from "vitest";
import { formatCwdConflictWarning, shQuote } from "./cwdConflictWarn.ts";

describe("cwdConflictWarn.formatCwdConflictWarning", () => {
  const cwd = "/code/proj/tree/main";

  it("returns null when no peers occupy the cwd", () => {
    expect(formatCwdConflictWarning([], cwd, "ay claude")).toBeNull();
  });

  it("warns and suggests a git-worktree command for a single peer", () => {
    const msg = formatCwdConflictWarning([{ pid: 111, cli: "claude" }], cwd, "ay claude -- fix");
    expect(msg).toContain("1 agent is already running in this directory (/code/proj/tree/main)");
    expect(msg).toContain("111  claude");
    // uses `git worktree add` (not `git clone .`) — worktree name = dir + branch
    expect(msg).toContain("git worktree add -b main-work ../main-work && cd ../main-work");
    expect(msg).not.toContain("git clone");
    // original command is appended so the suggestion is copy-pasteable
    expect(msg).toContain("&& ay claude -- fix");
    expect(msg).toContain("AGENT_YES_NO_CWD_WARN=1");
  });

  it("pluralizes and lists at most 3 peers with an overflow count", () => {
    const peers = [1, 2, 3, 4, 5].map((n) => ({ pid: n, cli: "codex" }));
    const msg = formatCwdConflictWarning(peers, cwd, "ay codex")!;
    expect(msg).toContain("5 agents are already running");
    expect(msg).toContain("1  codex");
    expect(msg).toContain("3  codex");
    expect(msg).not.toContain("4  codex"); // capped at 3 listed
    expect(msg).toContain("…and 2 more");
  });

  it("falls back to a placeholder when cwd has no basename or command is empty", () => {
    const msg = formatCwdConflictWarning([{ pid: 9, cli: "gemini" }], "/", "   ")!;
    expect(msg).toContain("../agent-work"); // basename('/') is empty → 'agent'
    expect(msg).toContain("&& ay <cli> …"); // empty origCmd → placeholder
  });
});

describe("cwdConflictWarn.shQuote", () => {
  it("passes safe tokens through unquoted", () => {
    expect(shQuote("ay")).toBe("ay");
    expect(shQuote("claude")).toBe("claude");
    expect(shQuote("--")).toBe("--");
    expect(shQuote("../main-work")).toBe("../main-work");
    expect(shQuote("main-work_2.3")).toBe("main-work_2.3");
  });

  it("single-quotes tokens with spaces or shell metacharacters", () => {
    expect(shQuote("fix the bug")).toBe("'fix the bug'");
    expect(shQuote("a;rm -rf b")).toBe("'a;rm -rf b'");
    expect(shQuote("$HOME")).toBe("'$HOME'");
    expect(shQuote("")).toBe("''");
  });

  it("escapes embedded single quotes safely", () => {
    // POSIX close-quote / escaped-quote / reopen-quote dance
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });
});
