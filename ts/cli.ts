#!/usr/bin/env bun
import { argv } from "process";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import cliYesConfig from "../agent-yes.config.ts";
import { parseCliArgs } from "./parseCliArgs.ts";
import { SUPPORTED_CLIS } from "./SUPPORTED_CLIS.ts";
import { logger } from "./logger.ts";
import { PidStore } from "./pidStore.ts";
import { displayVersion } from "./versionChecker.ts";
import { getRustBinary } from "./rustBinary.ts";

// Parse CLI arguments
const config = parseCliArgs(process.argv);

// Handle --rust: spawn the Rust binary instead
if (config.useRust) {
  let rustBinary: string;

  try {
    // Get or download the Rust binary for the current platform
    rustBinary = await getRustBinary({ verbose: config.verbose });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Build args for Rust binary (filter out --rust flag)
  const rawRustArgs = process.argv.slice(2).filter((arg) => arg !== "--rust" && !arg.startsWith("--rust="));

  // Check if swarm mode is requested (don't prepend CLI name for swarm mode)
  const hasSwarmArg = rawRustArgs.some(arg => arg === '--swarm' || arg.startsWith('--swarm='));

  // Prepend CLI name if detected from script name but not already in args
  // This ensures codex-yes --rust passes "codex" to the Rust binary
  // Skip prepending for swarm mode since it doesn't spawn a CLI
  const cliFromScript = config.cli;
  const hasCliArg = rawRustArgs.some(arg => arg.startsWith('--cli=') || arg === '--cli') ||
                    rawRustArgs.some(arg => SUPPORTED_CLIS.includes(arg));
  const rustArgs = cliFromScript && !hasCliArg && !hasSwarmArg
    ? [cliFromScript, ...rawRustArgs]
    : rawRustArgs;

  if (config.verbose) {
    console.log(`[rust] Using binary: ${rustBinary}`);
    console.log(`[rust] Args: ${rustArgs.join(" ")}`);
  }

  // Spawn the Rust process with stdio inheritance
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

  // Forward signals to child
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  // Keep the process alive while child is running
  await new Promise(() => {}); // Never resolves, exits via child.on("exit")
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
