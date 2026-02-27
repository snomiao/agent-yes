#!/usr/bin/env bun
import { argv } from "process";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import cliYesConfig from "../agent-yes.config.ts";
import { parseCliArgs } from "./parseCliArgs.ts";
import { logger } from "./logger.ts";
import { PidStore } from "./pidStore.ts";
import { displayVersion } from "./versionChecker.ts";

// Parse CLI arguments
const config = parseCliArgs(process.argv);

// Handle --rust: spawn the Rust binary instead
if (config.useRust) {
  const rustBinaryName = config.cli ? `${config.cli}-yes` : "agent-yes";
  const rustBinaryPaths = [
    // Check relative to this script (in the repo)
    path.resolve(import.meta.dir, "../rs/target/release/agent-yes"),
    path.resolve(import.meta.dir, "../rs/target/debug/agent-yes"),
    // Check in PATH
    rustBinaryName,
    "agent-yes",
  ];

  let rustBinary: string | undefined;
  for (const p of rustBinaryPaths) {
    if (p.includes("/") && existsSync(p)) {
      rustBinary = p;
      break;
    } else if (!p.includes("/")) {
      // For PATH lookup, just use it directly
      rustBinary = p;
      break;
    }
  }

  if (!rustBinary) {
    console.error("Rust binary not found. Please build with: cd rs && cargo build --release");
    process.exit(1);
  }

  // Build args for Rust binary (filter out --rust flag)
  const rustArgs = process.argv.slice(2).filter((arg) => arg !== "--rust" && !arg.startsWith("--rust="));

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
      console.error(`Rust binary '${rustBinary}' not found in PATH. Please build with: cd rs && cargo build --release`);
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
