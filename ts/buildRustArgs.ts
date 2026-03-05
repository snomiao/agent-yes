/**
 * Build arguments for the Rust binary from process.argv.
 *
 * IMPORTANT: The CLI name (e.g. "claude") must be appended at the END of the
 * arg list, not prepended. The Rust binary uses clap with `trailing_var_arg`,
 * which means once a positional arg is encountered, all subsequent args are
 * treated as positional — so any flags (like --timeout) after the CLI name
 * would be silently swallowed.
 */
export function buildRustArgs(
  argv: string[],
  cliFromScript: string | undefined,
  supportedClis: readonly string[],
): string[] {
  // Filter out --rust flag (already handled by TS layer)
  const rawRustArgs = argv
    .slice(2)
    .filter((arg) => arg !== "--rust" && !arg.startsWith("--rust="));

  // Check if swarm mode is requested (don't append CLI name for swarm mode)
  const hasSwarmArg = rawRustArgs.some(
    (arg) => arg === "--swarm" || arg.startsWith("--swarm="),
  );

  // Check if CLI is already specified in args
  const hasCliArg =
    rawRustArgs.some(
      (arg) => arg.startsWith("--cli=") || arg === "--cli",
    ) || rawRustArgs.some((arg) => supportedClis.includes(arg));

  // Append CLI name at the end so it doesn't trigger trailing_var_arg in clap,
  // which would cause all subsequent args (like --timeout) to be treated as positional
  if (cliFromScript && !hasCliArg && !hasSwarmArg) {
    return [...rawRustArgs, cliFromScript];
  }

  return rawRustArgs;
}
