import { statSync } from "node:fs";
import path from "node:path";

/**
 * Resolve a bare program name to an absolute path using POSIX PATH semantics.
 *
 * `portable-pty`'s `CommandBuilder` — reached from the TS runtime through
 * `bun-pty`'s `librust_pty` — resolves a RELATIVE program name against the cwd
 * FIRST and accepts the result if it merely `exists()`, with no regular-file or
 * executable check (portable-pty 0.8.1, `cmdbuilder.rs::search_path`). So a cwd
 * that happens to hold an entry named like the agent CLI — a `claude/` directory,
 * a symlink to one, or a non-executable `claude` file — shadows the real binary.
 * exec then fails inside the forked child, and portable-pty's `close_random_fds()`
 * `pre_exec` hook has already closed every fd >= 3, including std's CLOEXEC
 * error-report pipe. The child therefore can't hand the errno back to the parent
 * and dies on std's `rtassert!(output.write(&bytes).is_ok())` with
 * `fatal runtime error: assertion failed: output.write(&bytes).is_ok(), aborting`
 * instead of surfacing a normal "not found / not executable" spawn error.
 * See issue #138.
 *
 * POSIX is unambiguous that a command name containing no slash is looked up in
 * PATH *only*, never in the cwd, so pre-resolving here is both the fix and the
 * correct semantics. Names that already contain a separator are passed through
 * untouched, so `./claude` still means "the one in this directory".
 *
 * Empty PATH entries are skipped rather than treated as the cwd (a legacy POSIX
 * allowance) — honouring them would reintroduce exactly the shadowing above.
 *
 * Mirrors `resolve_program` in rs/src/pty_spawner.rs — keep the two in sync.
 *
 * @param bin - Program name as configured (`cliConf.binary` or the CLI name)
 * @param pathEnv - PATH the child will see; defaults to this process's PATH
 * @returns Absolute path to the executable
 * @throws Error mentioning ENOENT / "command not found" when unresolvable, so
 *   {@link isCommandNotFoundError} still routes it to the auto-install path
 */
export function resolveProgram(bin: string, pathEnv?: string): string {
  // Windows spawns through cmd.exe / ConPTY, which apply their own PATH+PATHEXT
  // resolution — the cwd-shadowing bug is unix-specific, so pass through.
  if (process.platform === "win32") return bin;
  if (bin.includes("/")) return bin;

  const raw = pathEnv ?? process.env.PATH ?? "";
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    let st;
    try {
      // statSync FOLLOWS symlinks, so a symlink pointing at a directory is
      // correctly rejected by the isFile() check below.
      st = statSync(candidate);
    } catch {
      continue;
    }
    if (st.isFile() && (st.mode & 0o111) !== 0) return candidate;
  }

  throw new Error(
    `spawn ${bin} ENOENT: command not found in PATH (install it, or point \`binary:\` at a full path)`,
  );
}
