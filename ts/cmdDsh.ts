/**
 * `ay dsh-legacy` subcommand — launch the DeepSeek Harness terminal client
 * (dsh-tui), acting like `bunx dsh-tui` (or bare `dsh-tui` when already
 * installed). This is a thin exec of the upstream TUI: agent-yes does not wrap
 * or capture it, it just hands the terminal over, so `ay dsh-legacy <alpha>`
 * runs dsh-tui verbatim. Passing `--help`/`-h` is not special-cased on purpose:
 * the args are forwarded and dsh-tui prints its own help, so agent-yes never
 * has a second copy of it to keep in sync.
 *
 * NOTE: `dsh-legacy` as a SUBCOMMAND shadows the DeepSeek *agent* CLI name in
 * the manager entry. The canonical `dsh` agent CLI is now the minimal config
 * entry (see default.config.yaml); to spawn the legacy DeepSeek agent CLI, use
 * `ay --cli dsh-legacy`.
 */

/** The upstream terminal client npm package/bin name. */
const DSH_TUI_BIN = "dsh-tui";

/**
 * The slice of `Bun.spawn` this module uses. Declared as a seam so the launch
 * DECISION (installed bin vs `bunx` fallback) is testable without spawning
 * anything: the real spawns here either probe the host's PATH or hand over the
 * terminal, neither of which a unit test can do. Defaults to `Bun.spawn`, so
 * production callers pass nothing and behavior is unchanged.
 */
export type DshSpawn = (
  cmd: string[],
  opts: { stdin: "ignore" | "inherit"; stdout: "ignore" | "inherit"; stderr: "ignore" | "inherit" },
) => { exited: Promise<number> };

const defaultSpawn: DshSpawn = (cmd, opts) => Bun.spawn(cmd, opts);

/**
 * Resolve the argv prefix that launches dsh-tui: the bare bin when it is
 * already on PATH (fast, deterministic), else `bunx` (which fetches/uses the
 * cached package — the exact behavior of `bunx dsh-tui`).
 */
export async function dshTuiPrefix(spawn: DshSpawn = defaultSpawn): Promise<[string, ...string[]]> {
  // Prefer a real install — no network, no bunx resolution quirks.
  try {
    const probe = spawn([DSH_TUI_BIN, "--version"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await probe.exited) === 0) return [DSH_TUI_BIN];
  } catch {
    /* not found — fall through to bunx */
  }
  return ["bunx", DSH_TUI_BIN];
}

/** Run `dsh-tui` in the foreground with the user's terminal (forward args). */
export async function cmdDsh(rest: string[], spawn: DshSpawn = defaultSpawn): Promise<number> {
  const prefix = await dshTuiPrefix(spawn);
  const proc = spawn([...prefix, ...rest], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await proc.exited) ?? 0;
}
