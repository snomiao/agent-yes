#!/usr/bin/env bun
import { argv } from "process";
import { spawn } from "child_process";
import { parseCliArgs } from "./parseCliArgs.ts";
import { invokedCliName } from "./invokedCli.ts";
import { logger } from "./logger.ts";
import { checkAndAutoUpdate, displayVersion, versionString } from "./versionChecker.ts";
import { getRustBinary } from "./rustBinary.ts";
import { buildRustArgs } from "./buildRustArgs.ts";

// Ultra-fast path: skip heavy init for --version/-v
{
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === "-v" || rawArgs.includes("--version")) {
    console.log(versionString());
    process.exit(0);
  }
}

// Subcommand fast path: `cy ls / read / cat / tail / head / send` bypass the
// agent-spawn machinery (and the --rust dispatch) and operate on the global
// pid index instead. Must run before checkAndAutoUpdate / yargs / Rust spawn.
{
  const rawArg = process.argv[2];
  // Manager-only subcommands (e.g. `setup`) apply only to the generic
  // `ay`/`agent-yes` entry, not to a cli-bound alias like `cy` (= claude-yes):
  // `cy setup …` must run claude with that text, not manage the host.
  const managerCommands = !invokedCliName(process.argv);
  // Intercept bare -h/--help so we show TS subcommands, not just Rust agent-runner options.
  const isHelpFlag = rawArg === "-h" || rawArg === "--help";
  const { isSubcommand, runSubcommand, cmdHelp } = await import("./subcommands.ts");
  if (isHelpFlag && process.argv.length === 3) {
    await cmdHelp(managerCommands);
    process.exit(0);
  }
  if (isSubcommand(rawArg, managerCommands)) {
    const code = await runSubcommand(process.argv);
    process.exit(code ?? 0);
  }
}

// Check for updates before starting — installs & re-execs if a newer version exists.
// Fast path: cached result (no network), so this adds near-zero latency most of the time.
await checkAndAutoUpdate();

logger.info(versionString());

// Parse CLI arguments (no choices validation — SUPPORTED_CLIS loaded lazily below)
const config = parseCliArgs(process.argv);

// Handle --tray: show system tray icon and block
if (config.tray) {
  const { startTray } = await import("./tray.ts");
  await startTray();
  await new Promise(() => {}); // Block forever, exit via tray quit or signal
}

// Auto-spawn tray icon in background on desktop OS (best-effort, silent failure)
// Must run before --rust spawn since that blocks forever
{
  const { ensureTray } = await import("./tray.ts");
  ensureTray(); // fire-and-forget, don't await
}

// Spawn admission control — applies to a REAL agent launch only (subcommands,
// --version, --tray already handled/exited above; --append-prompt / --version
// below are not launches). Sits BEFORE the --rust dispatch so it gates BOTH the
// Rust and the TypeScript runtimes. Blocks with φ-backoff until there's capacity
// (or fails open after a timeout) so a burst of recursive `ay <cli>` spawns gets
// spaced out instead of storming the host into the OOM-killer. No-op (instant)
// unless maxAgents/minFreeMb is configured — see ts/spawnGate.ts.
if (!config.showVersion && !config.appendPrompt && !config.tray) {
  const { waitForSpawnCapacity } = await import("./spawnGate.ts");
  await waitForSpawnCapacity({
    onWait: (reason, waitedMs) => {
      if (config.verbose || waitedMs === 0)
        console.error(`[agent-yes] spawn gate: ${reason} — waiting…`);
    },
    onProceedAnyway: (reason, waitedMs) =>
      console.error(
        `[agent-yes] spawn gate: ${reason} — waited ${Math.round(waitedMs / 1000)}s, proceeding anyway`,
      ),
  });
}

// Handle --rust: spawn the Rust binary instead, fall back to TypeScript if unavailable
if (config.useRust) {
  let rustBinary: string | undefined;

  try {
    rustBinary = await getRustBinary({ verbose: config.verbose });
  } catch (err) {
    // Rust binary unavailable (not yet released for this version, or network issue) — fall back to TypeScript
    if (config.verbose) {
      console.error(`[rust] ${err instanceof Error ? err.message : String(err)}`);
      console.error("[rust] Falling back to TypeScript implementation.");
    }
  }

  if (rustBinary) {
    const { SUPPORTED_CLIS } = await import("./SUPPORTED_CLIS.ts");
    const rustArgs = buildRustArgs(process.argv, config.cli, SUPPORTED_CLIS);

    if (config.verbose) {
      console.log(`[rust] Using binary: ${rustBinary}`);
      console.log(`[rust] Args: ${rustArgs.join(" ")}`);
    }

    // Nested + non-tty (e.g. an agent ran this via its Bash tool): detach the
    // agent so we don't block the parent's tool call for the whole session, then
    // print how to drive it and exit. `--attach`/AGENT_YES_ATTACH=1 opts out.
    const attach = config.attach || process.env.AGENT_YES_ATTACH === "1";
    const { shouldForkNested, buildSpawnTutorial, waitForFifo } = await import("./forkNested.ts");
    if (
      shouldForkNested({
        isTTY: Boolean(process.stdout.isTTY),
        ayPid: process.env.AGENT_YES_PID,
        attach,
      })
    ) {
      const forked = spawn(rustBinary, rustArgs, {
        detached: true,
        stdio: "ignore",
        env: process.env,
        cwd: process.cwd(),
      });
      const forkedPid = forked.pid;
      if (!forkedPid) {
        console.error("Failed to spawn agent: no pid.");
        process.exit(1);
      }
      // Race a fast startup failure against FIFO registration so we never print a
      // success tutorial for a dead pid. The wrapper keeps its own per-pid log, so
      // real output stays reachable via `ay tail` even with stdio ignored. Store a
      // pre-formatted message (not a union) — the callbacks run async, so control-flow
      // analysis can't narrow a union here anyway.
      let deathMsg: string | null = null;
      forked.on("error", (err) => {
        deathMsg ??= `Failed to spawn agent: ${err.message}`;
      });
      forked.on("exit", (code, signal) => {
        deathMsg ??= `Agent exited immediately (${signal ?? `code ${code}`}). See: ay tail ${forkedPid}`;
      });
      const registered = await waitForFifo(forkedPid, 2000, () => deathMsg !== null);
      if (deathMsg) {
        console.error(deathMsg);
        process.exit(1);
      }
      forked.unref();
      console.log(buildSpawnTutorial(config.cli || "agent", forkedPid));
      if (!registered) console.log(`(note: still registering — give ay send/tail a moment)`);
      process.exit(0);
    }

    const child = spawn(rustBinary, rustArgs, {
      stdio: "inherit",
      env: process.env,
      cwd: process.cwd(),
    });

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.error(`Rust binary '${rustBinary}' not found. Try: npx agent-yes --rust --verbose`);
      } else {
        console.error(`Failed to spawn Rust binary: ${err.message}`);
      }
      process.exit(1);
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
      }
      process.exit(code ?? 1);
    });

    process.on("SIGINT", () => child.kill("SIGINT"));
    process.on("SIGTERM", () => child.kill("SIGTERM"));

    await new Promise(() => {}); // Never resolves, exits via child.on("exit")
  }
}

// Handle --version: display version and exit (also reached when --version comes after other flags)
if (config.showVersion) {
  await displayVersion();
  process.exit(0);
}

// Handle --append-prompt: write to active IPC (FIFO/Named Pipe) and exit
if (config.appendPrompt) {
  const { PidStore } = await import("./pidStore.ts");
  const ipcPath = await PidStore.findActiveFifo(process.cwd());
  if (!ipcPath) {
    console.error("No active agent with IPC found in current directory.");
    process.exit(1);
  }

  try {
    if (process.platform === "win32") {
      // Windows named pipe
      const { connect } = await import("net");
      await new Promise<void>((resolve, reject) => {
        const client = connect(ipcPath);
        client.on("connect", () => {
          client.write(config.appendPrompt + "\r");
          client.end();
          console.log(`Sent prompt to Windows named pipe: ${ipcPath}`);
          resolve();
        });
        client.on("error", (error) => {
          console.error(`Failed to connect to named pipe: ${error}`);
          reject(error);
        });
        // Timeout after 5 seconds
        setTimeout(() => {
          client.destroy();
          reject(new Error("Connection timeout"));
        }, 5000);
      });
    } else {
      // Linux FIFO (original implementation)
      const { writeFileSync, openSync, closeSync } = await import("fs");
      const fd = openSync(ipcPath, "w");
      writeFileSync(fd, config.appendPrompt + "\r");
      closeSync(fd);
      console.log(`Sent prompt to FIFO: ${ipcPath}`);
    }
  } catch (error) {
    console.error(`Failed to send prompt: ${error}`);
    process.exit(1);
  }
  process.exit(0);
}

// Validate CLI name
if (!config.cli) {
  config.cli = "claude"; // default to claude, for smooth UX
  logger.warn("Warning: No CLI name provided. Using default 'claude'.");
}

// console.log(`Using CLI: ${config.cli}`);

if (config.verbose) {
  process.env.VERBOSE = "true"; // enable verbose logging in yesLog.ts
  console.log(config);
  console.log(argv);
}

const { default: cliYes } = await import("./index.ts");
const { exitCode } = await cliYes({ ...config, autoYes: config.autoYes });

console.log("exiting process");
process.exit(exitCode ?? 1);
