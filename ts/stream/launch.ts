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
