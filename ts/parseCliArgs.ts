import ms from "ms";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { invokedCliName } from "./invokedCli.ts";
/**
 * Parse CLI arguments the same way cli.ts does
 * This is a test helper that mirrors the parsing logic in cli.ts
 */
export function parseCliArgs(argv: string[], supportedClis?: readonly string[]) {
  // The agent CLI implied by the invoked binary name (cy/claude-yes → claude),
  // or undefined for the generic ay/agent-yes manager entry.
  const cliName = invokedCliName(argv);

  // Parse args with yargs (same logic as cli.ts:16-73)
  const parsedArgv = yargs(hideBin(argv))
    .usage("Usage: $0 [cli] [agent-yes args] [agent-cli args] [--] [prompts...]")
    .example(
      "$0 claude --timeout=30s -- solve all todos in my codebase, commit one by one",
      "Run Claude with a 30 seconds idle timeout (will type /exit when timeout), everything after `--` will be treated as the prompt",
    )
    .example(
      "$0 claude --stdpush",
      "Run Claude with external stdin input enabled via --append-prompt",
    )
    // TODO: add a --docker option, will tell cli.ts to start docker process with tty and handles all stdio forwarding

    .option("robust", {
      type: "boolean",
      default: true,
      description: "re-spawn Claude with --continue if it crashes, only works for claude yet",
      alias: "r",
    })
    .option("attach", {
      type: "boolean",
      default: false,
      description:
        "Run the agent in the foreground even when nested inside another agent (disables fork-by-default; also AGENT_YES_ATTACH=1).",
      alias: "foreground",
    })
    .option("logFile", {
      type: "string",
      description: "Rendered log file to write to.",
    })
    .option("prompt", {
      type: "string",
      description: "Prompt to send to Claude (also can be passed after --)",
      alias: "p",
    })
    .option("verbose", {
      type: "boolean",
      description: "Enable verbose logging, will emit ./agent-yes.log",
      default: false,
    })
    .option("use-skills", {
      type: "boolean",
      description:
        "Prepend SKILL.md header from current directory to the prompt (helpful for non-Claude agents)",
      default: false,
    })
    .option("swarm-hint", {
      type: "boolean",
      description:
        "Inject peer discovery hint into agent system prompt when other agents are running (use --no-swarm-hint to opt out)",
      default: true,
    })
    .option("timeout", {
      type: "string",
      description: 'Exit after a period of inactivity, e.g., "5s" or "1m"',
      alias: ["t", "idle-timeout"],
    })
    .option("exit-on-idle", {
      type: "string",
      deprecated: "use --timeout instead",
      alias: "e", // keep for backward compatibility, will be removed in future major versions
    })
    .option("idle", {
      type: "string",
      description: 'short idle time, will perform idle action when reached, e.g., "5s" or "1m"',
      alias: "i", // keep for backward compatibility, will be removed in future major versions
    })
    .option("idle-action", {
      type: "string",
      description:
        'Idle action to perform when idle time is reached, e.g., "/exit" or "check TODO.md"',
      alias: "ia",
    })
    .option("queue", {
      type: "boolean",
      description:
        "Queue Agent Commands when spawning multiple agents in the same directory/repo, can be disabled with --no-queue",
      default: false,
    })
    .option("install", {
      type: "boolean",
      description: "Automatically Install/Update the CLI if not found or outdated",
      default: false,
    })
    .option("continue", {
      type: "boolean",
      description:
        "Resume previous session in current cwd if any, note: will exit if no previous session found",
      default: false,
      alias: "c",
    })
    .option("append-prompt", {
      type: "string",
      description: "Send a prompt to the active agent's stdin in current directory",
    })
    .option("stdpush", {
      type: "boolean",
      description:
        "Enable external input stream to push additional data to stdin (default: true; pass --no-stdpush to disable). Required for `ay send` to deliver messages to this agent.",
      default: true,
      alias: ["ipc", "fifo"], // backward compatibility
    })
    .option("auto", {
      type: "string",
      description:
        "Control auto-yes mode: 'yes' to auto-approve prompts (default), 'no' to start in manual mode. Press Ctrl+Y during the session to toggle at any time.",
      choices: ["yes", "no"] as const,
      default: "yes",
    })
    .option("yes", {
      type: "boolean",
      description:
        "Pass the CLI's 'yolo' flag (claude: --dangerously-skip-permissions; codex: --dangerously-bypass-approvals-and-sandbox)",
      default: false,
      alias: "y",
    })
    .option("tray", {
      type: "boolean",
      description: "Show a system tray icon with running agent count (macOS/Windows only)",
      default: false,
    })
    .option("rust", {
      type: "boolean",
      description: "Use the Rust implementation (enabled by default, use --no-rust for TypeScript)",
      default: true,
    })
    .option("swarm", {
      type: "string",
      description: `Enable swarm mode for multi-agent P2P networking (requires --rust).
        Formats:
          --swarm my-project       Topic name (LAN auto-discovery)
          --swarm ABC-123          Room code (6-char, easy to share)
          --swarm "ay://..."       Swarm URL (for internet)
          --swarm "/ip4/..."       Raw multiaddr (direct connect)`,
    })
    .option("experimental-swarm", {
      type: "boolean",
      description: "Deprecated: use --swarm instead",
      default: false,
      hidden: true,
    })
    .option("swarm-topic", {
      type: "string",
      description: "Deprecated: use --swarm <topic> instead",
      default: "agent-yes-swarm",
      hidden: true,
    })
    .option("swarm-listen", {
      type: "string",
      description: "Deprecated: use ay:// URL with listen param",
      hidden: true,
    })
    .option("swarm-bootstrap", {
      type: "array",
      description: "Deprecated: use --swarm ay://...?peer=... instead",
      default: [] as string[],
      hidden: true,
    })
    .positional("cli", {
      describe: "The AI CLI to run, e.g., claude, codex, copilot, cursor, gemini",
      type: "string",
      choices: supportedClis as string[] | undefined,
      demandOption: false,
      default: cliName,
    })
    .help()
    .version(false) // Disable yargs default version handling
    .option("version", {
      type: "boolean",
      description: "Show version number",
      alias: "v",
    })
    .parserConfiguration({
      "unknown-options-as-args": true,
      "halt-at-non-option": true,
    })
    .parseSync();

  // Extract cli args and dash prompt (same logic as cli.ts:76-91)
  const optionalIndex = (e: number) => (0 <= e ? e : undefined);
  const rawArgs = argv.slice(2);
  const cliArgIndex = optionalIndex(rawArgs.indexOf(String(parsedArgv._[0])));
  const dashIndex = optionalIndex(rawArgs.indexOf("--"));

  // Reconstruct what yargs consumed vs what it didn't
  const yargsConsumed = new Set<string>();

  // Add consumed flags
  Object.keys(parsedArgv).forEach((key) => {
    if (key !== "_" && key !== "$0" && parsedArgv[key as keyof typeof parsedArgv] !== undefined) {
      yargsConsumed.add(`--${key}`);
      // Add short aliases
      if (key === "prompt") yargsConsumed.add("-p");
      if (key === "robust") yargsConsumed.add("-r");
      if (key === "idle") yargsConsumed.add("-i");
      if (key === "exitOnIdle") yargsConsumed.add("-e");
      if (key === "yes") yargsConsumed.add("-y");
      if (key === "continue") yargsConsumed.add("-c");
    }
  });

  // Collect bare positional words as prompt text (e.g., `cy arg1 arg2` → prompt = "arg1 arg2")
  const positionalPromptWords: string[] = [];

  const cliArgsForSpawn = (() => {
    if (parsedArgv._[0] && !cliName) {
      // Explicit CLI name provided as positional arg — separate flags from bare words
      const allAfterCli = rawArgs.slice((cliArgIndex ?? 0) + 1, dashIndex ?? undefined);
      const result: string[] = [];
      for (let i = 0; i < allAfterCli.length; i++) {
        const arg = allAfterCli[i]!;
        if (arg.startsWith("-")) {
          result.push(arg);
          // Consume the next arg as the flag's value if separate (--flag value)
          if (!arg.includes("=") && i + 1 < allAfterCli.length) {
            const nextArg = allAfterCli[i + 1];
            if (nextArg && !nextArg.startsWith("-")) {
              result.push(nextArg);
              i++;
            }
          }
        } else {
          positionalPromptWords.push(arg);
        }
      }
      return result;
    } else if (cliName) {
      // CLI name from script, filter out what yargs consumed; bare words become prompt
      const result: string[] = [];
      const argsToCheck = rawArgs.slice(0, dashIndex ?? undefined);

      for (let i = 0; i < argsToCheck.length; i++) {
        const arg = argsToCheck[i];
        if (!arg) continue;

        const [flag] = arg.split("=");

        // Check both the flag itself and its --no- negation (yargs stores --no-x as key "x")
        const isConsumed =
          (flag && yargsConsumed.has(flag)) ||
          (flag?.startsWith("--no-") && yargsConsumed.has(`--${flag.slice(5)}`));
        if (isConsumed) {
          // Skip consumed flag and its value if separate
          if (!arg.includes("=") && i + 1 < argsToCheck.length) {
            const nextArg = argsToCheck[i + 1];
            if (nextArg && !nextArg.startsWith("-")) {
              i++; // Skip value
            }
          }
        } else if (arg.startsWith("-")) {
          // Non-consumed flag → pass to target CLI
          result.push(arg);
          // Consume the next arg as the flag's value if separate
          if (!arg.includes("=") && i + 1 < argsToCheck.length) {
            const nextArg = argsToCheck[i + 1];
            if (nextArg && !nextArg.startsWith("-")) {
              result.push(nextArg);
              i++;
            }
          }
        } else {
          // Bare word → treat as prompt text
          positionalPromptWords.push(arg);
        }
      }
      return result;
    }
    return [];
  })();
  const positionalPrompt = positionalPromptWords.join(" ") || undefined;
  const dashPrompt: string | undefined =
    dashIndex === undefined ? undefined : rawArgs.slice(dashIndex + 1).join(" ");

  // Show deprecation warning for --exit-on-idle and -e flags
  if (parsedArgv.exitOnIdle !== undefined) {
    console.warn(
      "\x1b[33m⚠ Warning: --exit-on-idle and -e are deprecated. Please use --timeout instead.\x1b[0m",
    );
  }

  // Return the config object that would be passed to cliYes (same logic as cli.ts:99-121)
  return {
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    cli: (cliName ||
      parsedArgv.cli ||
      (dashIndex !== 0
        ? parsedArgv._[0]?.toString()?.replace?.(/-yes$/, "")
        : undefined)) as string,
    cliArgs: cliArgsForSpawn,
    // `-y`/--yes: the actual flag is per-CLI (see each CLI's `yesArgs` in
    // default.config.yaml). agentYes() appends it once the CLI is resolved.
    skipPermissions: parsedArgv.yes,
    prompt:
      [parsedArgv.prompt, positionalPrompt, dashPrompt].filter(Boolean).join(" ") || undefined,
    install: parsedArgv.install,
    exitOnIdle: Number(
      (parsedArgv.timeout || parsedArgv.idle || parsedArgv.exitOnIdle)?.replace(/.*/, (e) =>
        String(ms(e as ms.StringValue)),
      ) || 0,
    ),
    queue: parsedArgv.queue,
    robust: parsedArgv.robust,
    attach: parsedArgv.attach,
    logFile: parsedArgv.logFile,
    verbose: parsedArgv.verbose,
    resume: parsedArgv.continue, // Note: intentional use resume here to avoid preserved keyword (continue)
    useSkills: parsedArgv.useSkills,
    swarmHint: parsedArgv.swarmHint,
    appendPrompt: parsedArgv.appendPrompt,
    useStdinAppend: Boolean(parsedArgv.stdpush), // --ipc and --fifo are yargs aliases of --stdpush; reading the canonical key ensures --no-stdpush wins over alias defaults
    showVersion: parsedArgv.version,
    autoYes: parsedArgv.auto !== "no", // auto-yes enabled by default, disabled with --auto=no
    idleAction: parsedArgv.idleAction as string | undefined,
    tray: parsedArgv.tray,
    useRust: parsedArgv.rust,
    // New unified --swarm flag (takes precedence over deprecated flags)
    swarm: parsedArgv.swarm ?? (parsedArgv.experimentalSwarm ? parsedArgv.swarmTopic : undefined),
    // Deprecated flags (kept for backwards compatibility)
    experimentalSwarm: parsedArgv.experimentalSwarm,
    swarmTopic: parsedArgv.swarmTopic,
    swarmListen: parsedArgv.swarmListen,
    swarmBootstrap: parsedArgv.swarmBootstrap as string[],
  };
}
