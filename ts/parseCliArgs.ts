import ms from "ms";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { SUPPORTED_CLIS } from "./SUPPORTED_CLIS.ts";
import pkg from "../package.json" with { type: "json" };

// const pkg = await JSON.parse(await readFile(path.resolve((import.meta.dir) + "/../package.json"), 'utf8'))
/**
 * Parse CLI arguments the same way cli.ts does
 * This is a test helper that mirrors the parsing logic in cli.ts
 */
export function parseCliArgs(argv: string[]) {
  // Detect cli name from script name (same logic as cli.ts:10-14)
  const scriptBaseName =
    argv[1]
      ?.split(/[/\\]/)
      .at(-1)
      ?.replace(/(\.[jt]s)?$/, "") || "";

  const cliName =
    scriptBaseName
      .replace(/^(cli|agent)(-yes)?$/, "")
      .replace(/^ay$/, "") // treat standalone "ay" same as "agent-yes"
      .replace(/-yes$/, "") || undefined;

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
    .option("timeout", {
      type: "string",
      description: 'Exit after a period of inactivity, e.g., "5s" or "1m"',
      alias: "t",
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
      description: 'Idle action to perform when idle time is reached, e.g., "/exit" or "check TODO.md"',
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
      description: "Enable external input stream to push additional data to stdin",
      default: false,
      alias: ["ipc", "fifo"], // backward compatibility
    })
    .option("auto", {
      type: "string",
      description: "Control auto-yes mode: 'yes' to auto-approve prompts (default), 'no' to start in manual mode. Press Ctrl+Y during the session to toggle at any time.",
      choices: ["yes", "no"] as const,
      default: "yes",
    })
    .positional("cli", {
      describe: "The AI CLI to run, e.g., claude, codex, copilot, cursor, gemini",
      type: "string",
      choices: SUPPORTED_CLIS,
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
      if (key === "continue") yargsConsumed.add("-c");
    }
  });

  const cliArgsForSpawn = (() => {
    if (parsedArgv._[0] && !cliName) {
      // Explicit CLI name provided as positional arg
      return rawArgs.slice((cliArgIndex ?? 0) + 1, dashIndex ?? undefined);
    } else if (cliName) {
      // CLI name from script, filter out only what yargs consumed
      const result: string[] = [];
      const argsToCheck = rawArgs.slice(0, dashIndex ?? undefined);

      for (let i = 0; i < argsToCheck.length; i++) {
        const arg = argsToCheck[i];
        if (!arg) continue;

        const [flag] = arg.split("=");

        if (flag && yargsConsumed.has(flag)) {
          // Skip consumed flag and its value if separate
          if (!arg.includes("=") && i + 1 < argsToCheck.length) {
            const nextArg = argsToCheck[i + 1];
            if (nextArg && !nextArg.startsWith("-")) {
              i++; // Skip value
            }
          }
        } else {
          result.push(arg);
        }
      }
      return result;
    }
    return [];
  })();
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
        : undefined)) as (typeof SUPPORTED_CLIS)[number],
    cliArgs: cliArgsForSpawn,
    prompt: [parsedArgv.prompt, dashPrompt].filter(Boolean).join(" ") || undefined,
    install: parsedArgv.install,
    exitOnIdle: Number(
      (parsedArgv.timeout || parsedArgv.idle || parsedArgv.exitOnIdle)?.replace(/.*/, (e) =>
        String(ms(e as ms.StringValue)),
      ) || 0,
    ),
    queue: parsedArgv.queue,
    robust: parsedArgv.robust,
    logFile: parsedArgv.logFile,
    verbose: parsedArgv.verbose,
    resume: parsedArgv.continue, // Note: intentional use resume here to avoid preserved keyword (continue)
    useSkills: parsedArgv.useSkills,
    appendPrompt: parsedArgv.appendPrompt,
    useStdinAppend: Boolean(parsedArgv.stdpush || parsedArgv.ipc || parsedArgv.fifo), // Support --stdpush, --ipc, and --fifo (backward compatibility)
    showVersion: parsedArgv.version,
    autoYes: parsedArgv.auto !== "no", // auto-yes enabled by default, disabled with --auto=no
  };
}
