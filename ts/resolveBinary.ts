import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/**
 * Decide whether a PATH candidate is a runnable program.
 *
 * Two checks, both load-bearing:
 * - `isFile()` rejects directories and symlinks-to-directories (statSync FOLLOWS
 *   symlinks), which is the case that used to abort the whole process — see
 *   {@link resolveProgram}.
 * - `access(X_OK)` rejects non-executables. Preferred over testing the raw mode
 *   bits because it accounts for the caller's uid/gid, and because Windows has
 *   no exec bit (there it succeeds for any existing file, which is correct —
 *   Windows executability is decided by PATHEXT, not by permissions).
 *
 * The Rust runtime's `resolve_program` makes the equivalent pair of checks with
 * `metadata().is_file()` + mode & 0o111 (it only ever runs on unix).
 */
export function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk `rawPath` and return the first entry that names a runnable `bin`.
 *
 * Split out from {@link resolveProgram} (and taking an injectable `isExec`) so
 * the resolution logic itself is exercised on every platform, including the
 * Windows CI leg where {@link resolveProgram} short-circuits.
 *
 * @throws Error mentioning ENOENT / "command not found" when unresolvable, so
 *   `isCommandNotFoundError` in ts/core/spawner.ts still routes it to the
 *   auto-install path
 */
export function resolveOnPath(
  bin: string,
  rawPath: string,
  isExec: (candidate: string) => boolean = isExecutableFile,
): string {
  // A name that already carries a separator is a path, not a PATH lookup —
  // `./claude` must keep meaning the one in this directory.
  if (bin.includes("/") || bin.includes(path.sep)) return bin;

  for (const dir of rawPath.split(path.delimiter)) {
    // Empty PATH entries mean "the cwd" under a legacy POSIX allowance.
    // Honouring that would reintroduce exactly the shadowing described in
    // resolveProgram, so skip them.
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (isExec(candidate)) return candidate;
  }

  throw new Error(
    `spawn ${bin} ENOENT: command not found in PATH (install it, or point \`binary:\` at a full path)`,
  );
}

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
 * correct semantics.
 *
 * Mirrors `resolve_program` in rs/src/pty_spawner.rs — keep the two in sync.
 *
 * @param bin - Program name as configured (`cliConf.binary` or the CLI name)
 * @param pathEnv - PATH the child will see; defaults to this process's PATH
 * @returns Absolute path to the executable
 */
export function resolveProgram(bin: string, pathEnv?: string): string {
  // Windows spawns through cmd.exe / ConPTY, which apply their own PATH+PATHEXT
  // resolution — the cwd-shadowing bug is unix-specific, so pass through.
  if (process.platform === "win32") return bin;
  return resolveOnPath(bin, pathEnv ?? process.env.PATH ?? "");
}
