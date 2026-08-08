import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { formatIdentity, localHost, localUser, readGitBranch, tildify } from "./identity.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ay-ident-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => null);
});

async function gitFixture(rel: string, head: string): Promise<string> {
  const repo = path.join(root, rel);
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await writeFile(path.join(repo, ".git", "HEAD"), head);
  return repo;
}

describe("readGitBranch", () => {
  it("reads the branch from a normal checkout", async () => {
    const repo = await gitFixture("repo", "ref: refs/heads/main\n");
    expect(readGitBranch(repo)).toBe("main");
  });

  it("walks up from a subdirectory", async () => {
    const repo = await gitFixture("repo2", "ref: refs/heads/feat/x-1.2\n");
    const sub = path.join(repo, "a", "b");
    await mkdir(sub, { recursive: true });
    expect(readGitBranch(sub)).toBe("feat/x-1.2");
  });

  it("follows a worktree's gitdir indirection file", async () => {
    const gitdir = path.join(root, "main-repo", ".git", "worktrees", "wt1");
    await mkdir(gitdir, { recursive: true });
    await writeFile(path.join(gitdir, "HEAD"), "ref: refs/heads/crm-yamamoto-wifi\n");
    const wt = path.join(root, "wt-checkout");
    await mkdir(wt, { recursive: true });
    await writeFile(path.join(wt, ".git"), `gitdir: ${gitdir}\n`);
    expect(readGitBranch(wt)).toBe("crm-yamamoto-wifi");
  });

  it("resolves a RELATIVE gitdir against the checkout", async () => {
    const gitdir = path.join(root, "gd");
    await mkdir(gitdir, { recursive: true });
    await writeFile(path.join(gitdir, "HEAD"), "ref: refs/heads/rel\n");
    const wt = path.join(root, "rel-checkout");
    await mkdir(wt, { recursive: true });
    await writeFile(path.join(wt, ".git"), "gitdir: ../gd\n");
    expect(readGitBranch(wt)).toBe("rel");
  });

  it("returns a short commit id for a detached HEAD", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const repo = await gitFixture("det", sha + "\n");
    expect(readGitBranch(repo)).toBe(sha.slice(0, 12));
  });

  it("returns null outside any git checkout", async () => {
    const plain = path.join(root, "plain");
    await mkdir(plain, { recursive: true });
    expect(readGitBranch(plain)).toBeNull();
  });

  it("returns null on an unreadable/garbled HEAD", async () => {
    const repo = await gitFixture("bad", "something else entirely\n");
    expect(readGitBranch(repo)).toBeNull();
  });
});

describe("formatIdentity", () => {
  it("renders user@host:path:branch#pid", async () => {
    const repo = await gitFixture("fmt", "ref: refs/heads/main\n");
    const id = formatIdentity({ user: "sno", host: "Mac", cwd: repo, pid: 30402 });
    expect(id).toBe(`sno@Mac:${repo}:main#30402`);
  });

  it("omits the branch segment outside a repo", async () => {
    const plain = path.join(root, "nofmt");
    await mkdir(plain, { recursive: true });
    const id = formatIdentity({ user: "sno", host: "Mac", cwd: plain, pid: 7 });
    expect(id).toBe(`sno@Mac:${plain}#7`);
  });

  it("accepts an explicit branch (and null to suppress detection)", () => {
    expect(formatIdentity({ user: "u", host: "h", cwd: "/x", branch: "b", pid: 1 })).toBe(
      "u@h:/x:b#1",
    );
    expect(formatIdentity({ user: "u", host: "h", cwd: "/x", branch: null, pid: 1 })).toBe(
      "u@h:/x#1",
    );
  });

  it("defaults user/host to header-safe local values", () => {
    const id = formatIdentity({ cwd: "/x", branch: null, pid: 1 });
    expect(id).toMatch(/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:\/x#1$/);
    expect(id).toContain(`${localUser()}@${localHost()}`);
  });

  it("tildifies the home directory like ay ls does", () => {
    expect(tildify(path.join(require("os").homedir(), "ws"))).toBe("~/ws");
    expect(tildify("/opt/x")).toBe("/opt/x");
  });
});
