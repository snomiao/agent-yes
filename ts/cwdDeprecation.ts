/**
 * `--cwd <dir>` on an agent run is NOT an agent-yes flag.
 *
 * It once selected the directory the agent runs in. It no longer does: agent-yes
 * forwards it to the target CLI like any other unknown option, so the agent runs
 * wherever `ay` was invoked and the CLI decides what `--cwd` means (usually:
 * rejects it). Because agent-yes never handles a cwd but its own process cwd, the
 * wrapper cwd / agent cwd / recorded cwd cannot drift apart.
 *
 * The shell does this job better anyway: `cd <dir> && <same command>` puts the
 * agent AND every relative path in the command in the same place, with no
 * agent-yes-specific flag to remember. This module detects the flag on a raw argv
 * and builds the copy-pasteable hint we print before continuing.
 *
 * Scope: the agent-run path only (ts/cli.ts), and only tokens BEFORE `--` —
 * past the separator the token belongs to the CLI or the prompt. Management
 * subcommands that take a `--cwd` FILTER (`ay ls/status/spawn/schedule …`) are a
 * different flag and are unaffected — they never reach this code because
 * subcommands are dispatched earlier. The Rust runner mirrors this hint in
 * rs/src/main.rs for direct `agent-yes` invocations that bypass this launcher.
 */

/** Env var the JS launcher sets on the spawned Rust child so the hint, once
 * printed here, is not printed a second time by the Rust runner. Mirrored in
 * rs/src/main.rs. */
export const SUPPRESS_CWD_WARN_ENV = "AGENT_YES_SUPPRESS_CWD_WARN";

export interface CwdPassthroughHint {
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
 * Detect a `--cwd <dir>` / `--cwd=<dir>` token on a full process.argv
 * (`[exec, script, ...userArgs]`). Returns the hint, or null when no `--cwd`
 * appears before the `--` separator.
 */
export function detectCwdDeprecation(argv: string[]): CwdPassthroughHint | null {
  const prog = programName(argv[1]);
  const userArgs = argv.slice(2);
  // Past `--` the token is the CLI's or the prompt's — forwarded verbatim either
  // way, so there is nothing to suggest and nothing to strip.
  const sepIndex = userArgs.indexOf("--");
  const optionEnd = sepIndex === -1 ? userArgs.length : sepIndex;

  let sawCwd = false;
  let dir: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < userArgs.length; i++) {
    const arg = userArgs[i]!;
    if (i < optionEnd && arg === "--cwd") {
      sawCwd = true;
      const next = userArgs[i + 1];
      // `--cwd DIR` — consume the value; a following flag means the value is missing.
      if (next !== undefined && !next.startsWith("-")) {
        dir = next;
        i++;
      }
      continue;
    }
    if (i < optionEnd && arg.startsWith("--cwd=")) {
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
    `\x1b[33m⚠ --cwd is not an agent-yes flag\x1b[0m — it is passed straight through to the CLI. ` +
    `To run the agent somewhere else:\n\n` +
    `    ${suggestion}`;
  return { dir, suggestion, message };
}
