import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, symlinkSync, rmSync } from "fs";
import os from "os";
import path from "path";
import {
  cmdWs,
  collectWorkspaces,
  isPathInside,
  resolveOperand,
  walkWorkspaces,
  workspaceStatus,
  WS_JSON_SCHEMA,
} from "./ws.ts";

// Mutable fake for codehost/provision — each test overrides what it needs.
// ws.ts imports the module lazily; vitest's registry mock intercepts that too.
const prov = vi.hoisted(() => ({
  wsRoot: "",
  parseSource: (input: string): { owner: string; repo: string; branch: string } | null => {
    const m = input.match(/^([^/]+)\/([^/@]+)(?:@(.+))?$/);
    return m ? { owner: m[1]!, repo: m[2]!, branch: m[3] ?? "main" } : null;
  },
  readStatus: vi.fn(),
  provision: vi.fn(),
  createBranch: vi.fn(),
  forkWorktree: vi.fn(),
}));

vi.mock("codehost/provision", () => ({
  resolveWsRoot: (w?: string) => w ?? prov.wsRoot,
  folderFor: (spec: { owner: string; repo: string; branch: string }, wsRoot?: string) =>
    path.join(wsRoot ?? prov.wsRoot, spec.owner, spec.repo, "tree", spec.branch),
  parseSource: (input: string) => prov.parseSource(input),
  readStatus: (dir: string) => prov.readStatus(dir),
  provision: (spec: unknown, opts?: unknown) => prov.provision(spec, opts),
  createBranch: (spec: unknown, opts?: unknown) => prov.createBranch(spec, opts),
  forkWorktree: (opts: unknown) => prov.forkWorktree(opts),
}));

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
    await expect(
      resolveOperand(fakeProv("/unused"), "not a spec", "spec", undefined),
    ).rejects.toThrow(/cannot parse "not a spec"/);
  });
});

describe("json schema tag", () => {
  it("is versioned", () => {
    expect(WS_JSON_SCHEMA).toBe("ay-ws/v1");
  });
});

describe("cmdWs (mocked provision)", () => {
  let root: string;
  let out: string[];
  let err: string[];
  let homeBackup: string | undefined;

  const CLEAN = {
    branch: "main",
    head: "abc123",
    ahead: 0,
    behind: 0,
    dirty: false,
    hasUpstream: true,
  };

  beforeEach(() => {
    // realpath: os.tmpdir() is a symlink on macOS (/var → /private/var), and
    // process.chdir + cwd-derived paths come back resolved.
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ay-ws-cmd-")));
    prov.wsRoot = root;
    prov.readStatus.mockReset().mockResolvedValue(CLEAN);
    prov.provision.mockReset();
    prov.createBranch.mockReset();
    prov.forkWorktree.mockReset();
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => (out.push(String(s)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((s: any) => (err.push(String(s)), true));
    // Isolate the agent registry so live-agent counts are deterministic (0).
    homeBackup = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = path.join(root, ".ay-home");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (homeBackup === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = homeBackup;
    rmSync(root, { recursive: true, force: true });
  });

  const mkCheckout = (rel: string) => {
    const dir = path.join(root, rel);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    return dir;
  };

  it("no args / unknown sub → help (0) and error (1)", async () => {
    expect(await cmdWs([])).toBe(0);
    expect(out.join("")).toContain("ay ws ls");
    expect(await cmdWs(["nope"])).toBe(1);
    expect(err.join("")).toContain('unknown subcommand "nope"');
  });

  it("ls: empty root note, then table with agent hint column", async () => {
    expect(await cmdWs(["ls"])).toBe(0);
    expect(err.join("")).toContain("no workspaces under");
    mkCheckout("o/r/tree/main");
    expect(await cmdWs(["ls"])).toBe(0);
    const table = out.join("");
    expect(table).toContain("WORKSPACE");
    expect(table).toContain("o/r@main");
  });

  it("ls --json: versioned schema envelope", async () => {
    const dir = mkCheckout("o/r/tree/feat/x");
    expect(await cmdWs(["ls", "--json"])).toBe(0);
    const doc = JSON.parse(out.join(""));
    expect(doc.schema).toBe(WS_JSON_SCHEMA);
    expect(doc.wsRoot).toBe(root);
    expect(doc.workspaces).toEqual([
      { owner: "o", repo: "r", branch: "feat/x", path: dir, agents: { live: 0 } },
    ]);
  });

  it("ls --status: git summaries and the per-entry error fallback", async () => {
    mkCheckout("o/r/tree/clean");
    mkCheckout("o/r/tree/messy");
    mkCheckout("o/r/tree/broken");
    prov.readStatus.mockImplementation(async (dir: string) => {
      if (dir.endsWith("broken")) throw new Error("boom");
      if (dir.endsWith("messy"))
        return { branch: "messy", head: "h", ahead: 2, behind: 1, dirty: true, hasUpstream: false };
      return CLEAN;
    });
    expect(await cmdWs(["ls", "--status"])).toBe(0);
    const table = out.join("");
    expect(table).toContain("clean");
    expect(table).toContain("dirty, ahead 2, behind 1, no-upstream");
    expect(table).toContain("error: boom");
  });

  it("ls rejects positional args and unknown flags", async () => {
    await expect(cmdWs(["ls", "stray"])).rejects.toThrow(/no positional/);
    await expect(cmdWs(["ls", "--nope"])).rejects.toThrow(/unknown flag --nope/);
    await expect(cmdWs(["ls", "--json=1"])).rejects.toThrow(/takes no value/);
  });

  it("status: layout spec + state text for a path target, --json shape", async () => {
    const dir = mkCheckout("o/r/tree/feat/y");
    expect(await cmdWs(["status", dir])).toBe(0);
    const text = out.join("");
    expect(text).toContain("spec:     o/r@feat/y");
    expect(text).toContain("state:    clean");
    out.length = 0;
    expect(await cmdWs(["status", dir, "--json"])).toBe(0);
    const doc = JSON.parse(out.join(""));
    expect(doc.schema).toBe(WS_JSON_SCHEMA);
    expect(doc.workspace.branch).toBe("feat/y");
    expect(doc.workspace.git).toEqual(CLEAN);
  });

  it("status: a checkout outside the layout omits the spec line", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "ay-ws-out-"));
    try {
      mkdirSync(path.join(outside, ".git"));
      expect(await cmdWs(["status", outside])).toBe(0);
      expect(out.join("")).not.toContain("spec:");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("status: --path and --spec are mutually exclusive; one target max", async () => {
    await expect(cmdWs(["status", "--path", "--spec"])).rejects.toThrow(/mutually exclusive/);
    await expect(cmdWs(["status", "a", "b"])).rejects.toThrow(/at most one/);
  });

  it("new: provisions and prints the action + folder", async () => {
    prov.provision.mockResolvedValue({ ok: true, action: "cloned", folder: "/x" });
    expect(await cmdWs(["new", "o/r@dev"])).toBe(0);
    expect(prov.provision).toHaveBeenCalledWith(
      { owner: "o", repo: "r", branch: "dev" },
      { wsRoot: undefined },
    );
    expect(out.join("")).toContain("cloned  /x");
  });

  it("new: branch-not-found hints at --create, and --create falls back to createBranch", async () => {
    prov.provision.mockResolvedValue({
      ok: false,
      action: "error",
      reason: "branch-not-found",
      error: "nope",
    });
    expect(await cmdWs(["new", "o/r@dev"])).toBe(1);
    expect(err.join("")).toContain("--create");
    expect(prov.createBranch).not.toHaveBeenCalled();

    prov.createBranch.mockResolvedValue({ ok: true, action: "created", folder: "/y" });
    expect(await cmdWs(["new", "o/r@dev", "--create"])).toBe(0);
    expect(out.join("")).toContain("created  /y");
  });

  it("new: usage and parse errors", async () => {
    await expect(cmdWs(["new"])).rejects.toThrow(/usage: ay ws new/);
    await expect(cmdWs(["new", "///"])).rejects.toThrow(/cannot parse/);
  });

  it("fork: --from is resolved and passed through with --wip", async () => {
    prov.forkWorktree.mockResolvedValue({ ok: true, action: "forked", folder: "/f" });
    expect(await cmdWs(["fork", "nb", "--from", root, "--wip"])).toBe(0);
    expect(prov.forkWorktree).toHaveBeenCalledWith({
      fromCwd: path.resolve(root),
      branch: "nb",
      wsRoot: undefined,
      wip: true,
    });
    expect(out.join("")).toContain("forked  /f");
  });

  it("help aliases and the list alias dispatch", async () => {
    for (const h of ["help", "--help", "-h"]) {
      out.length = 0;
      expect(await cmdWs([h])).toBe(0);
      expect(out.join("")).toContain("ay ws ls");
    }
    mkCheckout("o/r/tree/main");
    out.length = 0;
    expect(await cmdWs(["list"])).toBe(0);
    expect(out.join("")).toContain("o/r@main");
  });

  it("ls/status: live agents from the registry produce counts and the ay-ls hint", async () => {
    const dir = mkCheckout("o/r/tree/main");
    const home = process.env.AGENT_YES_HOME!;
    mkdirSync(home, { recursive: true });
    writeFileSync(
      path.join(home, "pids.jsonl"),
      JSON.stringify({
        pid: process.pid,
        cli: "claude",
        prompt: null,
        cwd: path.join(dir, "sub"),
        log_file: null,
        status: "active",
        exit_code: null,
        exit_reason: null,
        started_at: 1,
      }) + "\n",
    );
    expect(await cmdWs(["ls"])).toBe(0);
    expect(err.join("")).toContain("ay ls --cwd");
    out.length = 0;
    err.length = 0;
    expect(await cmdWs(["status", dir])).toBe(0);
    expect(out.join("")).toContain("agents:   1 live");
    expect(err.join("")).toContain(`ay ls --cwd ${dir}`);
  });

  it("status: defaults to cwd, and honors --path / --spec modes", async () => {
    const dir = mkCheckout("o/r/tree/main");
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await cmdWs(["status"])).toBe(0);
      expect(out.join("")).toContain("spec:     o/r@main");
    } finally {
      process.chdir(prevCwd);
    }
    out.length = 0;
    expect(await cmdWs(["status", dir, "--path"])).toBe(0);
    expect(out.join("")).toContain("branch:   main");
    out.length = 0;
    expect(await cmdWs(["status", "o/r@main", "--spec", "--json"])).toBe(0);
    expect(JSON.parse(out.join("")).workspace.path).toBe(dir);
  });

  it("new: a non-branch failure reports without the --create hint", async () => {
    prov.provision.mockResolvedValue({
      ok: false,
      action: "error",
      reason: "repo-not-found",
      error: "gone",
    });
    expect(await cmdWs(["new", "o/r"])).toBe(1);
    const msg = err.join("");
    expect(msg).toContain("repo-not-found");
    expect(msg).not.toContain("--create");
  });

  it("fork: --from=<eq-form> and a stale AGENT_YES_PID both resolve", async () => {
    prov.forkWorktree.mockResolvedValue({ ok: true, action: "forked", folder: "/f" });
    expect(await cmdWs(["fork", "nb", `--from=${root}`])).toBe(0);
    expect(prov.forkWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ fromCwd: path.resolve(root) }),
    );
    // An AGENT_YES_PID with no matching registry record falls back to cwd.
    const envBackup = process.env.AGENT_YES_PID;
    process.env.AGENT_YES_PID = "999999999";
    try {
      expect(await cmdWs(["fork", "nb2"])).toBe(0);
      expect(prov.forkWorktree).toHaveBeenLastCalledWith(
        expect.objectContaining({ fromCwd: path.resolve(process.cwd()) }),
      );
    } finally {
      if (envBackup === undefined) delete process.env.AGENT_YES_PID;
      else process.env.AGENT_YES_PID = envBackup;
    }
  });

  it("fork: defaults --from to cwd (no agent env), surfaces failure", async () => {
    const envBackup = process.env.AGENT_YES_PID;
    delete process.env.AGENT_YES_PID;
    try {
      prov.forkWorktree.mockResolvedValue({ ok: false, error: "no origin" });
      expect(await cmdWs(["fork", "nb"])).toBe(1);
      expect(prov.forkWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ fromCwd: path.resolve(process.cwd()), wip: false }),
      );
      expect(err.join("")).toContain("fork failed: no origin");
      await expect(cmdWs(["fork"])).rejects.toThrow(/usage: ay ws fork/);
      await expect(cmdWs(["fork", "nb", "--from"])).rejects.toThrow(/requires a value/);
    } finally {
      if (envBackup !== undefined) process.env.AGENT_YES_PID = envBackup;
    }
  });
});

// Data API consumed by serve's GET /api/ws and /api/ws/status (the console's
// ⌘K /ws browser) — same mocked provision, no stdout involved.
describe("collectWorkspaces / workspaceStatus (mocked provision)", () => {
  let root: string;
  let homeBackup: string | undefined;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ay-ws-api-")));
    prov.wsRoot = root;
    prov.readStatus.mockReset().mockResolvedValue({
      branch: "main",
      head: "abc123",
      ahead: 1,
      behind: 0,
      dirty: true,
      hasUpstream: true,
    });
    homeBackup = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = path.join(root, ".ay-home");
  });
  afterEach(() => {
    if (homeBackup === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = homeBackup;
    rmSync(root, { recursive: true, force: true });
  });

  const mkCheckout = (rel: string) => {
    const dir = path.join(root, rel);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    return dir;
  };

  it("collectWorkspaces: entries without git by default, joined when status:true", async () => {
    const dir = mkCheckout("o/r/tree/main");
    const bare = await collectWorkspaces();
    expect(bare.wsRoot).toBe(root);
    expect(bare.workspaces).toEqual([
      { owner: "o", repo: "r", branch: "main", path: dir, agents: { live: 0 } },
    ]);
    expect(prov.readStatus).not.toHaveBeenCalled();

    const withStatus = await collectWorkspaces({ status: true });
    expect(withStatus.workspaces[0]!.git).toMatchObject({ dirty: true, ahead: 1 });
  });

  it("workspaceStatus: back-derives the layout spec (slash branch) and counts agents", async () => {
    const dir = mkCheckout("o/r/tree/feat/x");
    const entry = await workspaceStatus(dir);
    expect(entry).toMatchObject({
      owner: "o",
      repo: "r",
      branch: "feat/x",
      path: dir,
      agents: { live: 0 },
    });
    expect(entry.git).toMatchObject({ dirty: true });
  });

  it("workspaceStatus: a dir outside the layout keeps git's branch, no spec", async () => {
    const dir = path.join(root, "elsewhere");
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    prov.wsRoot = path.join(root, "not-here");
    const entry = await workspaceStatus(dir);
    expect(entry.owner).toBe("");
    expect(entry.branch).toBe("main"); // from readStatus, not the layout
  });
});
