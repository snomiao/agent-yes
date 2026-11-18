/** Read the last native flag value, including --flag=value spelling. */
export function nativeFlagValue(args: readonly string[], flag: string): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") break;
    if (args[i] === flag) value = args[++i];
    else if (args[i]?.startsWith(flag + "=")) value = args[i]!.slice(flag.length + 1);
  }
  return value;
}

export function isClaudeStream(cli: string, args: readonly string[]): boolean {
  return cli === "claude" && nativeFlagValue(args, "--output-format") === "stream-json";
}

/** --stream is only sugar for explicitly requesting Claude's native protocol. */
export function withStreamFlags(args: readonly string[]): string[] {
  return [
    ...args,
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--permission-prompt-tool",
    "stdio",
  ];
}

/** Split native Claude arguments from its task, without treating boolean flags as values. */
export function planClaudeStream(
  cli: string,
  nativeArgs: readonly string[],
  explicitPrompt?: string,
  sugar = false,
): { args: string[]; prompt?: string } | null {
  const separator = nativeArgs.indexOf("--");
  const end = separator === -1 ? nativeArgs.length : separator;
  const candidate = sugar
    ? [...withStreamFlags(nativeArgs.slice(0, end)), ...nativeArgs.slice(end)]
    : [...nativeArgs];
  if (!isClaudeStream(cli, candidate)) return null;
  const args: string[] = [];
  const words: string[] = [];
  const booleans = new Set([
    "-p",
    "--print",
    "--verbose",
    "--replay-user-messages",
    "--continue",
    "-c",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--include-partial-messages",
    "--include-hook-events",
  ]);
  for (let i = 0; i < candidate.length; i++) {
    const arg = candidate[i]!;
    if (arg === "--") {
      words.push(...candidate.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      words.push(arg);
      continue;
    }
    args.push(arg);
    if (
      !arg.includes("=") &&
      !booleans.has(arg) &&
      candidate[i + 1] &&
      !candidate[i + 1]!.startsWith("-")
    )
      args.push(candidate[++i]!);
  }
  return { args, prompt: [explicitPrompt, ...words].filter(Boolean).join(" ") || undefined };
}
