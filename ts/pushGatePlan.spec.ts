import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

// The pre-push hook decides from the pushed refs whether a push can skip the
// test gate. These cases pin the two ways that decision must NOT be lenient:
// a SKILL.md anywhere in the tree is runtime input (ts/index.ts reads every one
// from cwd up to the repo root), and a ref with no comparison base says nothing
// about the code under its tip, so it gets the full gate.
const SCRIPT = path.resolve(__dirname, "..", ".husky", "push-gate-plan.sh");
const ZERO = "0".repeat(40);

// A scratch repo must not inherit GIT_DIR & co from a hook or a worktree, or
// `git init` here would point at the real repository.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
) as NodeJS.ProcessEnv;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=alice", "-c", "user.email=alice@example.invalid", ...args],
    { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

async function commit(
  cwd: string,
  files: Record<string, string>,
  message: string,
): Promise<string> {
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await writeFile(path.join(cwd, file), body);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function plan(cwd: string, refLines: string): { mode: string; files: string[] } {
  const out = spawnSync("sh", [SCRIPT], { cwd, env, input: refLines, encoding: "utf8" });
  expect(out.status, out.stderr).toBe(0);
  const [mode = "", ...files] = out.stdout.split("\n").filter(Boolean);
  return { mode, files };
}

describe.skipIf(process.platform === "win32")("pre-push gate plan", () => {
  let repo: string;
  let main: string;

  beforeAll(async () => {
    repo = await realpath(await mkdtemp(path.join(tmpdir(), "ay-push-gate-")));
    git(repo, "init", "-q", "-b", "main");
    main = await commit(
      repo,
      { "README.md": "# alpha\n", "ts/runtime.ts": "export const v = 1;\n" },
      "init",
    );
    // What the hook compares a new branch against.
    git(repo, "update-ref", "refs/remotes/origin/main", main);
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("runs the full gate with no ref information", () => {
    expect(plan(repo, "").mode).toBe("full");
  });

  it("skips a deletion-only push", () => {
    expect(plan(repo, `(delete) ${ZERO} refs/heads/old ${main}\n`).mode).toBe("deletion");
  });

  it("skips a prose-only push and lists its files", async () => {
    git(repo, "checkout", "-q", "-b", "docs-only", main);
    const tip = await commit(repo, { "docs/guide.md": "words\n", "README.md": "# beta\n" }, "docs");
    const got = plan(repo, `refs/heads/docs-only ${tip} refs/heads/docs-only ${ZERO}\n`);
    expect(got.mode).toBe("prose");
    expect(got.files.sort()).toEqual(["README.md", "docs/guide.md"]);
  });

  it("treats a code change as full, against the remote sha when it is known", async () => {
    git(repo, "checkout", "-q", "-b", "code", main);
    const tip = await commit(repo, { "ts/runtime.ts": "export const v = 2;\n" }, "code");
    expect(plan(repo, `refs/heads/code ${tip} refs/heads/code ${main}\n`)).toEqual({
      mode: "full",
      files: ["ts/runtime.ts"],
    });
  });

  // ts/index.ts reads every SKILL.md between cwd and the repo root, so a nested
  // one is runtime input, not prose — the root file was the only exemption before.
  it.each(["SKILL.md", "feature/SKILL.md", "docs/SKILL.md"])(
    "treats %s as code, not prose",
    async (file) => {
      git(repo, "checkout", "-q", "-b", `skill-${file.replace(/\W/g, "-")}`, main);
      const tip = await commit(repo, { [file]: "# skill\n" }, "skill");
      const got = plan(repo, `refs/heads/x ${tip} refs/heads/x ${ZERO}\n`);
      expect(got.mode).toBe("full");
      expect(got.files).toEqual([file]);
    },
  );

  it("still skips a prose push that merely sits next to an unchanged SKILL.md", async () => {
    git(repo, "checkout", "-q", "-b", "near-skill", main);
    await commit(repo, { "feature/SKILL.md": "# skill\n" }, "skill");
    const base = git(repo, "rev-parse", "HEAD");
    const tip = await commit(repo, { "feature/notes.md": "notes\n" }, "notes");
    expect(plan(repo, `refs/heads/near-skill ${tip} refs/heads/near-skill ${base}\n`).mode).toBe(
      "prose",
    );
  });

  // A branch with no common ancestor: its tip is README-only, but the commit
  // under it ships code. Inspecting the tip alone would skip the gate.
  it("runs the full gate when a new branch has no merge base with origin/main", async () => {
    git(repo, "checkout", "-q", "--orphan", "unrelated");
    git(repo, "rm", "-rfq", "--cached", ".");
    await commit(repo, { "ts/runtime.ts": "export const v = 3;\n" }, "code first");
    const tip = await commit(repo, { "README.md": "# unrelated\n" }, "readme tip");
    expect(plan(repo, `refs/heads/unrelated ${tip} refs/heads/unrelated ${ZERO}\n`)).toEqual({
      mode: "full",
      files: [],
    });
  });

  it("runs the full gate when the remote sha is unknown and there is no merge base", async () => {
    const tip = git(repo, "rev-parse", "unrelated");
    const unknownRemote = "1".repeat(40);
    expect(
      plan(repo, `refs/heads/unrelated ${tip} refs/heads/unrelated ${unknownRemote}\n`).mode,
    ).toBe("full");
  });

  it("needs every ref to have a base before it will skip", async () => {
    const docs = git(repo, "rev-parse", "docs-only");
    const unrelated = git(repo, "rev-parse", "unrelated");
    const lines =
      `refs/heads/docs-only ${docs} refs/heads/docs-only ${ZERO}\n` +
      `refs/heads/unrelated ${unrelated} refs/heads/unrelated ${ZERO}\n`;
    expect(plan(repo, lines).mode).toBe("full");
  });
});
