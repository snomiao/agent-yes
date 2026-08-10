/**
 * Where `ay todo`'s store lives when the caller did not say.
 *
 * The engine is meant to be shared by every agent working on a repo, but the
 * store is a file at `<root>/.agent-yes/todos.jsonl`, so "which root" is what
 * actually decides who can see whom. Defaulting to `process.cwd()` — the
 * original behavior — quietly breaks that the moment agents run in git
 * WORKTREES (this project's own normal mode: `.claude/worktrees/<name>/`, one
 * agent each): every worktree is a different cwd, so every agent gets a
 * PRIVATE todo list, while `reconcileTodos` goes on matching task owners
 * against the GLOBAL cross-runtime agent index. That leaves the two halves of
 * a cross-agent feature disagreeing about what "everyone" means, and it fails
 * silently — an agent sees an empty list, not an error.
 *
 * So the default root is the repo's COMMON root: the main worktree, shared by
 * every linked worktree of the same repo. That is the parent of `git rev-parse
 * --git-common-dir`, NOT `--show-toplevel` — inside a linked worktree
 * `--show-toplevel` returns that worktree's own path (exactly the private
 * answer we are trying to get away from), while `--git-common-dir` is by
 * definition the directory all worktrees of a repo share.
 *
 * Scope deliberately stops at the repo. Going fleet-global (one store for
 * every repo on the machine, the way `ay ls` lists every agent) is a different
 * product decision — unrelated projects' tasks in one list — and is not taken
 * here; a caller who wants that passes an explicit `--root`.
 */

import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type GitRunner = (args: string[], cwd: string) => Promise<string | null>;

/**
 * Minimal `git` runner: stdout on success, `null` if git is missing, this
 * isn't a repo, or it hangs.
 *
 * `child_process` rather than `Bun.spawn` (which sibling modules like
 * `subcommands.ts` use) so this module works under BOTH runtimes. Bun
 * implements `child_process`, while `Bun` is undefined under Node — and the
 * failure mode there is the quiet kind: the catch below would swallow the
 * ReferenceError and every lookup would fall back to cwd, i.e. exactly the
 * per-directory store this module exists to prevent, with no error to notice.
 */
const spawnGit: GitRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 2000 });
    return stdout;
  } catch {
    return null;
  }
};

/**
 * Resolve the todo store root, most explicit source first:
 *
 *   1. `--root <dir>` — the caller said it; never second-guessed.
 *   2. `$AGENT_YES_TODO_ROOT` — pins a root for a whole shell/agent session
 *      (also how tests point at a scratch dir with no git repo involved).
 *   3. the repo's common root — shared across worktrees, see the file header.
 *   4. `cwd` — not a git repo at all.
 *
 * Relative values in (1)/(2) resolve against `cwd`, so `--root .` keeps
 * meaning "here" instead of depending on where the process happened to start.
 */
export async function resolveTodoRoot(
  explicit: string | undefined,
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
  runGit: GitRunner = spawnGit,
): Promise<string> {
  if (explicit) return path.resolve(cwd, explicit);
  const pinned = env.AGENT_YES_TODO_ROOT;
  if (pinned) return path.resolve(cwd, pinned);

  // The output may be relative (a bare `.git` when cwd IS the repo root); git
  // prints it relative to its own process cwd, which is the `cwd` we spawn in,
  // so resolving against `cwd` is correct for both the relative and absolute
  // forms. `--path-format=absolute` would force one shape but needs git >=
  // 2.31 and buys nothing here.
  const common = (await runGit(["rev-parse", "--git-common-dir"], cwd))?.trim();
  if (!common) return cwd;
  return path.dirname(path.resolve(cwd, common));
}
