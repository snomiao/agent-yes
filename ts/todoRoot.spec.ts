import { describe, expect, it, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, realpath } from "fs/promises";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import path from "path";
import { resolveTodoRoot, type GitRunner } from "./todoRoot.ts";

/** Stands in for a repo whose common dir is `<repo>/.git`, whatever cwd we ask from. */
const gitAt =
  (commonDir: string): GitRunner =>
  async () =>
    `${commonDir}\n`;
const notARepo: GitRunner = async () => null;

describe("resolveTodoRoot", () => {
  it("honors an explicit --root above everything else", async () => {
    const got = await resolveTodoRoot(
      "/explicit",
      "/cwd",
      { AGENT_YES_TODO_ROOT: "/pinned" },
      gitAt("/repo/.git"),
    );
    expect(got).toBe(path.resolve("/explicit"));
  });

  it("resolves a relative --root against cwd, so `--root .` means here", async () => {
    expect(await resolveTodoRoot("sub", "/cwd", {}, notARepo)).toBe(path.resolve("/cwd/sub"));
    expect(await resolveTodoRoot(".", "/cwd", {}, notARepo)).toBe(path.resolve("/cwd"));
  });

  it("falls back to $AGENT_YES_TODO_ROOT before consulting git", async () => {
    const got = await resolveTodoRoot(
      undefined,
      "/cwd",
      { AGENT_YES_TODO_ROOT: "/pinned" },
      gitAt("/repo/.git"),
    );
    expect(got).toBe(path.resolve("/pinned"));
  });

  // The whole reason this module exists: two agents in two worktrees of one
  // repo must land on the SAME store, which is what makes `--owner me`,
  // `claim`, and orphan-reconcile mean anything across agents.
  it("resolves worktrees of one repo to a single shared root", async () => {
    const git = gitAt("/repo/.git");
    const a = await resolveTodoRoot(undefined, "/repo/.claude/worktrees/lane-a", {}, git);
    const b = await resolveTodoRoot(undefined, "/repo/.claude/worktrees/lane-b", {}, git);
    expect(a).toBe(path.resolve("/repo"));
    expect(b).toBe(a);
  });

  it("handles git's relative output (`.git`) by resolving it against cwd", async () => {
    const got = await resolveTodoRoot(undefined, "/repo", {}, async () => ".git\n");
    expect(got).toBe(path.resolve("/repo"));
  });

  it("falls back to cwd when this is not a git repo at all", async () => {
    expect(await resolveTodoRoot(undefined, "/tmp/scratch", {}, notARepo)).toBe(
      path.resolve("/tmp/scratch"),
    );
  });

  // The tests above inject a fake git so the resolution RULES are pinned
  // exactly. This one runs the real default runner against a real repo,
  // because the rules are only worth anything if the actual `git rev-parse
  // --git-common-dir` call — the piece a stub can't check — agrees with them.
  describe("against a real git repo (default runner)", () => {
    const dirs: string[] = [];
    afterAll(async () => {
      for (const d of dirs) await rm(d, { recursive: true, force: true });
    });

    it("resolves a nested subdir AND a linked worktree to the same repo root", async () => {
      // realpath: on macOS tmpdir is a /var -> /private/var symlink, and git
      // reports the resolved path, so comparing against the raw mkdtemp path
      // would fail for a reason that has nothing to do with this module.
      const base = await realpath(await mkdtemp(path.join(tmpdir(), "todoroot-")));
      dirs.push(base);
      const repo = path.join(base, "repo");
      await mkdir(path.join(repo, "deep", "nested"), { recursive: true });

      // -c user.*: CI runners have no global git identity, so a bare `git
      // commit` exits 128 there while passing locally.
      const git = (args: string[], cwd: string) =>
        execFileSync(
          "git",
          ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args],
          { cwd, stdio: "ignore" },
        );
      git(["init", "-q", "."], repo);
      git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
      git(["worktree", "add", "-q", path.join(base, "wt"), "-b", "lane"], repo);

      expect(await resolveTodoRoot(undefined, path.join(repo, "deep", "nested"), {})).toBe(repo);
      expect(await resolveTodoRoot(undefined, path.join(base, "wt"), {})).toBe(repo);
    });

    it("falls back to cwd outside any repo", async () => {
      const outside = await realpath(await mkdtemp(path.join(tmpdir(), "todoroot-bare-")));
      dirs.push(outside);
      // A temp dir can still sit inside an enclosing repo on some machines;
      // the only claim being made is that resolution never throws and returns
      // a real directory path.
      const got = await resolveTodoRoot(undefined, outside, {});
      expect(path.isAbsolute(got)).toBe(true);
    });
  });

  it("treats an empty git result as 'not a repo' rather than resolving to the filesystem root", async () => {
    // A blank line back from git used to be indistinguishable from a real
    // answer: `path.dirname(path.resolve("/cwd", ""))` is "/", which would
    // silently point every agent's store at the root of the disk.
    expect(await resolveTodoRoot(undefined, "/cwd", {}, async () => "\n")).toBe(
      path.resolve("/cwd"),
    );
  });
});
