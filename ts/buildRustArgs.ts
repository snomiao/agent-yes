/**
 * Build arguments for the Rust binary from process.argv.
 *
 * IMPORTANT: The CLI name (e.g. "claude") must be passed via a leading `--cli=`
 * flag, NOT as a bare positional. The Rust binary uses clap with
 * `trailing_var_arg`, which means once a positional arg is encountered, all
 * subsequent args are treated as positional — so any agent-yes flags (like
 * `--cwd` or `--timeout`) placed AFTER a positional CLI name would be silently
 * swallowed and forwarded to the target CLI (which then errors on the unknown
 * option). The documented `ay <cli> --cwd <dir>` form is exactly this shape, so
 * we rewrite a bare positional CLI name into `--cli=<name>` here.
 */
export function buildRustArgs(
  argv: string[],
  cliFromScript: string | undefined,
  supportedClis: readonly string[],
): string[] {
  // Filter out TS-layer flags the Rust parser doesn't know: --rust (runtime
  // selection) and --detach (the TS layer does the fork). --detach is ours only
  // where parseCliArgs reads it as ours — before the CLI name and before `--`;
  // after the CLI name it belongs to that CLI, after `--` it is prompt text.
  const all = argv.slice(2);
  const dash = all.indexOf("--");
  const end = dash === -1 ? all.length : dash;
  const cliAt = all.findIndex((arg, i) => i < end && supportedClis.includes(arg));
  const oursUntil = cliAt === -1 ? end : cliAt;
  const isDetach = (arg: string) =>
    arg === "--detach" || arg === "--no-detach" || arg.startsWith("--detach=");
  const rawRustArgs = all.filter(
    (arg, i) =>
      !(arg === "--rust" || arg.startsWith("--rust=")) && !(i < oursUntil && isDetach(arg)),
  );

  // Swarm mode runs without a target CLI — leave args untouched.
  const hasSwarmArg = rawRustArgs.some((arg) => arg === "--swarm" || arg.startsWith("--swarm="));
  if (hasSwarmArg) return rawRustArgs;

  // An explicit --cli=/--cli flag already selects the CLI; don't second-guess it.
  const hasCliFlag = rawRustArgs.some((arg) => arg.startsWith("--cli=") || arg === "--cli");
  if (hasCliFlag) return rawRustArgs;

  // A supported-CLI word after `--` is prompt text, not the CLI selector.
  const dashIndex = rawRustArgs.indexOf("--");
  const optionEnd = dashIndex === -1 ? rawRustArgs.length : dashIndex;

  // CLI name given as a bare positional (e.g. `cy claude --cwd X`): hoist it into
  // a leading `--cli=` flag so clap parses the agent-yes flags that follow it
  // instead of swallowing them into trailing_var_arg.
  const cliPositionalIndex = rawRustArgs.findIndex(
    (arg, i) => i < optionEnd && supportedClis.includes(arg),
  );
  if (cliPositionalIndex !== -1) {
    const cli = rawRustArgs[cliPositionalIndex];
    const rest = rawRustArgs.filter((_, i) => i !== cliPositionalIndex);
    return [`--cli=${cli}`, ...rest];
  }

  // No CLI in args — fall back to the script-inferred name (cy → claude).
  if (cliFromScript) {
    return [`--cli=${cliFromScript}`, ...rawRustArgs];
  }

  return rawRustArgs;
}
