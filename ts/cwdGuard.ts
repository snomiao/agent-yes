/**
 * Startup guard for a working directory that no longer exists.
 *
 * A shell can sit in a directory that gets deleted and recreated under it —
 * routine here, since `ay ws new` re-clones `<ws>/tree/<branch>` and worktrees
 * get removed and re-added while a terminal is parked inside one. The path
 * still resolves, but the inode the shell holds is gone, so `process.cwd()`
 * throws ENOENT/uv_cwd.
 *
 * Nothing used to catch that. The first thing to call `process.cwd()` was the
 * eager config load (ts/index.ts top-level-awaits agent-yes.config.ts, whose
 * body awaits loadCascadingConfig → process.cwd()), and later execa and
 * bun-pty, so `cy` died with a raw Bun stack trace — three of them — before any
 * of our own error handling existed. No pid record, no log, nothing to read
 * back; see the no-trace symptom in the report that prompted this.
 *
 * So this runs FIRST, before anything else can touch the cwd: recover when the
 * shell's `$PWD` still names a real directory (the recreated workspace — which
 * is where the user meant to be), and otherwise fail with one actionable line
 * instead of a stack trace.
 *
 * Imported for its side effect as the first import of ts/cli.ts: an ES module's
 * imports are evaluated before the importing module's body, so an inline check
 * in cli.ts would already be too late if any import touched the cwd.
 * cwdGuard.spec.ts pins that import position.
 */

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

export type CwdCheck =
  | { state: "ok" }
  | { state: "recovered"; dir: string }
  | { state: "stale"; message: string };

/** Injectable for tests — the real thing mutates the process and must not run in-suite. */
export interface CwdDeps {
  cwd?: () => string;
  chdir?: (dir: string) => void;
  pwd?: string | undefined;
  isDir?: (dir: string) => boolean;
}

function staleMessage(pwd: string | undefined): string {
  const where = pwd ? ` ('${pwd}')` : "";
  return (
    `agent-yes: this shell's working directory${where} no longer exists.\n` +
    `  It was deleted or replaced while the shell stayed in it, so process.cwd()\n` +
    `  fails (ENOENT/uv_cwd) and no agent can be started here.\n` +
    `  Re-enter it, then retry:\n` +
    `    cd "$PWD"        # if the path was recreated\n` +
    `    cd <some-dir>    # otherwise, go somewhere that exists\n`
  );
}

/**
 * Is the cwd usable, and can it be recovered when not? Pure given `deps`; the
 * process-mutating `chdir` only runs on the recovery path.
 */
export function checkCwd(deps: CwdDeps = {}): CwdCheck {
  const cwd = deps.cwd ?? (() => process.cwd());
  const chdir = deps.chdir ?? ((dir: string) => process.chdir(dir));
  const pwd = "pwd" in deps ? deps.pwd : process.env.PWD;
  const isDir =
    deps.isDir ??
    ((dir: string) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });

  try {
    cwd();
    return { state: "ok" };
  } catch {
    // cwd is gone — fall through to recovery.
  }

  // `$PWD` is the shell's idea of where the user is. When the path was recreated
  // (the `ay ws new` case) that directory exists again and is exactly where they
  // typed the command, so moving there beats refusing to run. Absolute only: a
  // relative `$PWD` can't be resolved without the cwd we just lost.
  if (pwd && isAbsolute(pwd) && isDir(pwd)) {
    try {
      chdir(pwd);
      return { state: "recovered", dir: pwd };
    } catch {
      // chdir can still fail (permissions, a race with another delete) — report.
    }
  }
  return { state: "stale", message: staleMessage(pwd) };
}

/** Apply the verdict: notify on recovery, exit 1 with one readable line otherwise. */
export function applyCwdGuard(
  deps: CwdDeps = {},
  io: { warn?: (s: string) => void; fail?: (s: string) => never } = {},
): CwdCheck {
  const warn = io.warn ?? ((s: string) => void process.stderr.write(s));
  const fail =
    io.fail ??
    ((s: string) => {
      process.stderr.write(s);
      process.exit(1);
    });
  const verdict = checkCwd(deps);
  if (verdict.state === "recovered")
    warn(
      `agent-yes: the working directory was replaced while this shell sat in it; ` +
        `continuing in ${verdict.dir}\n`,
    );
  else if (verdict.state === "stale") fail(verdict.message);
  return verdict;
}

applyCwdGuard();
