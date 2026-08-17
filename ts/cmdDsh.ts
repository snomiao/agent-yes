/**
 * `ay dsh-legacy` subcommand — launch the DeepSeek Harness terminal client
 * (dsh-tui), acting like `bunx dsh-tui` (or bare `dsh-tui` when already
 * installed). This is a thin exec of the upstream TUI: agent-yes does not wrap
 * or capture it, it just hands the terminal over, so `ay dsh-legacy <alpha>`
 * runs dsh-tui verbatim.
 *
 * NOTE: `dsh-legacy` as a SUBCOMMAND shadows the DeepSeek *agent* CLI name in
 * the manager entry. The canonical `dsh` agent CLI is now the minimal config
 * entry (see default.config.yaml); to spawn the legacy DeepSeek agent CLI, use
 * `ay --cli dsh-legacy`.
 */

/** The upstream terminal client npm package/bin name. */
const DSH_TUI_BIN = "dsh-tui";

/**
 * Resolve the argv prefix that launches dsh-tui: the bare bin when it is
 * already on PATH (fast, deterministic), else `bunx` (which fetches/uses the
 * cached package — the exact behavior of `bunx dsh-tui`).
 */
async function dshTuiPrefix(): Promise<[string, ...string[]]> {
  // Prefer a real install — no network, no bunx resolution quirks.
  try {
    const probe = Bun.spawn([DSH_TUI_BIN, "--version"], {
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
export async function cmdDsh(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    // Show dsh-tui's own help verbatim by exec'ing it rather than re-documenting.
  }
  const prefix = await dshTuiPrefix();
  const proc = Bun.spawn([...prefix, ...rest], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await proc.exited) ?? 0;
}
