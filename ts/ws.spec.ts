import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { isPathInside, resolveOperand, walkWorkspaces, WS_JSON_SCHEMA } from "./ws.ts";

describe("isPathInside", () => {
  it("contains itself and descendants", () => {
    expect(isPathInside("/a/b", "/a/b")).toBe(true);
    expect(isPathInside("/a/b", "/a/b/c/d")).toBe(true);
  });

  it("rejects siblings sharing a name prefix (segment boundary, not startsWith)", () => {
    expect(isPathInside("/a/repo", "/a/repo-two/x")).toBe(false);
  });

  it("rejects parents and unrelated paths", () => {
    expect(isPathInside("/a/b/c", "/a/b")).toBe(false);
    expect(isPathInside("/a/b", "/z")).toBe(false);
  });

  it("resolves relative segments before comparing", () => {
    expect(isPathInside("/a/b", "/a/b/../b/c")).toBe(true);
    expect(isPathInside("/a/b", "/a/b/../c")).toBe(false);
  });
});

describe("walkWorkspaces", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "ay-ws-test-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const mkCheckout = (rel: string, gitAs: "dir" | "file") => {
    const dir = path.join(root, rel);
    mkdirSync(dir, { recursive: true });
    if (gitAs === "dir") mkdirSync(path.join(dir, ".git"));
    else writeFileSync(path.join(dir, ".git"), "gitdir: /elsewhere\n");
    return dir;
  };

  it("finds clones and linked worktrees, including branches containing '/'", async () => {
    const a = mkCheckout("owner/repo/tree/main", "dir");
    const b = mkCheckout("owner/repo/tree/feat/deep/branch", "file");
    const found = await walkWorkspaces(root);
    expect(found).toEqual([
      { owner: "owner", repo: "repo", branch: "feat/deep/branch", path: b },
      { owner: "owner", repo: "repo", branch: "main", path: a },
    ]);
  });

  it("does not descend into a checkout root looking for nested checkouts", async () => {
    const a = mkCheckout("o/r/tree/main", "dir");
    // a stray nested checkout below an existing root must not double-report
    mkdirSync(path.join(a, "vendor", ".git"), { recursive: true });
    const found = await walkWorkspaces(root);
    expect(found.map((w) => w.branch)).toEqual(["main"]);
  });

  it("skips non-layout dirs, dotdirs, and symlinks", async () => {
    mkCheckout("o/r/tree/main", "dir");
    mkdirSync(path.join(root, "o/r/notes"), { recursive: true }); // no tree/ marker
    mkdirSync(path.join(root, ".hidden/x/tree/y"), { recursive: true });
    mkdirSync(path.join(root, "loop/r/tree"), { recursive: true });
    // symlink cycle under tree/ must not hang or be reported
    symlinkSync(path.join(root, "loop"), path.join(root, "loop/r/tree/self"));
    const found = await walkWorkspaces(root);
    expect(found.map((w) => `${w.owner}/${w.repo}@${w.branch}`)).toEqual(["o/r@main"]);
  });

  it("bounds the branch-depth walk", async () => {
    const deep = "o/r/tree/" + Array.from({ length: 12 }, (_, i) => `d${i}`).join("/");
    mkCheckout(deep, "dir");
    const found = await walkWorkspaces(root);
    expect(found).toEqual([]); // beyond MAX_BRANCH_DEPTH → ignored, not crashed
  });

  it("returns [] for an empty or missing root", async () => {
    expect(await walkWorkspaces(root)).toEqual([]);
    expect(await walkWorkspaces(path.join(root, "nope"))).toEqual([]);
  });
});

describe("resolveOperand", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "ay-ws-op-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const fakeProv = (specDir: string) =>
    ({
      parseSource: (input: string) => {
        const m = input.match(/^([^/]+)\/([^/@]+)@(.+)$/);
        return m ? { owner: m[1]!, repo: m[2]!, branch: m[3]! } : null;
      },
      folderFor: () => specDir,
      resolveWsRoot: (w?: string) => w ?? root,
    }) as any;

  const mkCheckout = (rel: string) => {
    const dir = path.join(root, rel);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    return dir;
  };

  it("an existing local path wins over spec parsing in auto mode", async () => {
    const dir = mkCheckout("o/r/tree/main");
    const res = await resolveOperand(fakeProv("/unused"), dir, "auto", undefined);
    expect(res).toEqual({ dir, spec: null });
  });

  it("falls back to spec parsing when the operand is not a path", async () => {
    const dir = mkCheckout("o/r/tree/main");
    const res = await resolveOperand(fakeProv(dir), "o/r@main", "auto", undefined);
    expect(res.dir).toBe(dir);
    expect(res.spec).toEqual({ owner: "o", repo: "r", branch: "main" });
  });

  it("--path mode rejects a directory that is not a checkout root", async () => {
    const dir = path.join(root, "plain");
    mkdirSync(dir);
    await expect(resolveOperand(fakeProv("/unused"), dir, "path", undefined)).rejects.toThrow(
      /not a git checkout root/,
    );
  });

  it("--spec mode reports an unprovisioned workspace with the fix-it hint", async () => {
    await expect(
      resolveOperand(fakeProv(path.join(root, "missing")), "o/r@main", "spec", undefined),
    ).rejects.toThrow(/not provisioned.*ay ws new/s);
  });

  it("reports a precise parse error for garbage", async () => {
    await expect(resolveOperand(fakeProv("/unused"), "not a spec", "spec", undefined)).rejects.toThrow(
      /cannot parse "not a spec"/,
    );
  });
});

describe("json schema tag", () => {
  it("is versioned", () => {
    expect(WS_JSON_SCHEMA).toBe("ay-ws/v1");
  });
});
