/**
 * `--cwd <dir>` on an agent run is deprecated.
 *
 * It used to pick the directory the agent runs in. The shell already does this
 * better: `cd <dir> && <same command>` puts the agent AND every relative path in
 * the command in the same place, with no agent-yes-specific flag to remember.
 * This module detects the flag on a raw argv and builds the copy-pasteable
 * migration hint we print before continuing (the flag still works for now).
 *
 * Scope: the agent-run path only (ts/cli.ts). Management subcommands that take a
 * `--cwd` FILTER (`ay ls/status/spawn/schedule …`) are a different flag and are
 * not deprecated — they never reach this code because subcommands are dispatched
 * earlier. The Rust runner mirrors this warning in rs/src/main.rs for direct
 * `agent-yes` invocations that bypass this launcher.
 */

/** Env var the JS launcher sets on the spawned Rust child so the warning, once
 * printed here, is not printed a second time by the Rust runner. Mirrored in
 * rs/src/main.rs. */
export const SUPPRESS_CWD_WARN_ENV = "AGENT_YES_SUPPRESS_CWD_WARN";

export interface CwdDeprecation {
  /** The directory value the user passed to --cwd (undefined if the flag had no value). */
  dir: string | undefined;
  /** The suggested replacement command line, e.g. `cd ~/foo && cy claude -- fix`. */
  suggestion: string;
  /** Colorized, multi-line warning ready to write to stderr (no trailing newline). */
  message: string;
}

/**
 * Quote a single argv token for display in a copy-pasteable shell command.
 * Leaves shell-safe tokens (including a leading `~`/`~/path`, so `cd ~/foo`
 * still expands) bare; single-quotes anything else.
 */
function shellDisplayQuote(s: string): string {
  if (s === "") return "''";
  // Safe unquoted: word chars and the handful of path/opt punctuation that carry
  // no shell meaning here. `~` included so a home-relative dir keeps expanding.
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Program name as the user typed it, derived from argv[1] (the launched script). */
function programName(scriptPath: string | undefined): string {
  if (!scriptPath) return "agent-yes";
  const base = scriptPath.split(/[\\/]/).pop() || scriptPath;
  return base.replace(/\.(js|ts|mjs|cjs)$/, "");
}

/**
 * Detect a deprecated `--cwd <dir>` / `--cwd=<dir>` flag on a full process.argv
 * (`[exec, script, ...userArgs]`). Returns the migration hint, or null when no
 * `--cwd` flag is present.
 */
export function detectCwdDeprecation(argv: string[]): CwdDeprecation | null {
  const prog = programName(argv[1]);
  const userArgs = argv.slice(2);

  let sawCwd = false;
  let dir: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < userArgs.length; i++) {
    const arg = userArgs[i]!;
    if (arg === "--cwd") {
      sawCwd = true;
      const next = userArgs[i + 1];
      // `--cwd DIR` — consume the value; a following flag means the value is missing.
      if (next !== undefined && !next.startsWith("-")) {
        dir = next;
        i++;
      }
      continue;
    }
    if (arg.startsWith("--cwd=")) {
      sawCwd = true;
      dir = arg.slice("--cwd=".length);
      continue;
    }
    rest.push(arg);
  }
  if (!sawCwd) return null;

  const cmd = [prog, ...rest].map(shellDisplayQuote).join(" ");
  // `<dir>` is a placeholder shown when the flag had no value — keep it bare.
  const dirDisplay = dir === undefined ? "<dir>" : shellDisplayQuote(dir);
  const suggestion = `cd ${dirDisplay} && ${cmd}`;
  const message =
    `\x1b[33m⚠ --cwd is deprecated.\x1b[0m Run the command in the target directory instead:\n\n` +
    `    ${suggestion}`;
  return { dir, suggestion, message };
}
