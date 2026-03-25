#!/usr/bin/env bun
import { argv } from "process";
import { spawn } from "child_process";
import { parseCliArgs } from "./parseCliArgs.ts";
import { SUPPORTED_CLIS } from "./SUPPORTED_CLIS.ts";
import { logger } from "./logger.ts";
import { PidStore } from "./pidStore.ts";
import { checkAndAutoUpdate, displayVersion } from "./versionChecker.ts";
import { getRustBinary } from "./rustBinary.ts";
import { buildRustArgs } from "./buildRustArgs.ts";

// Check for updates before starting — installs & re-execs if a newer version exists.
// Fast path: cached result (no network), so this adds near-zero latency most of the time.
await checkAndAutoUpdate();

// Parse CLI arguments
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
    const rustArgs = buildRustArgs(process.argv, config.cli, SUPPORTED_CLIS);

    if (config.verbose) {
      console.log(`[rust] Using binary: ${rustBinary}`);
      console.log(`[rust] Args: ${rustArgs.join(" ")}`);
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

// Handle --version: display version and exit
if (config.showVersion) {
  await displayVersion();
  process.exit(0);
}

// Handle --append-prompt: write to active IPC (FIFO/Named Pipe) and exit
if (config.appendPrompt) {
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
  // logger.error(process.argv);
  config.cli = "claude"; // default to claude, for smooth UX
  logger.warn("Warning: No CLI name provided. Using default 'claude'.");
  // throw new Error(
  //   `missing cli def, available clis: ${Object.keys((await cliYesConfig).clis).join(", ")}`,
  // );
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
