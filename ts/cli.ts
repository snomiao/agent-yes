#!/usr/bin/env bun
import { argv } from "process";
import cliYesConfig from "../agent-yes.config.ts";
import { parseCliArgs } from "./parseCliArgs.ts";
import { logger } from "./logger.ts";
import { PidStore } from "./pidStore.ts";

// Import the CLI module

// Check for MCP server subcommand
const rawArgs = process.argv.slice(2);
if (rawArgs[0] === 'mcp' && rawArgs[1] === 'serve') {
  try {
    // Verify MCP SDK is available before attempting to start server
    await import('@modelcontextprotocol/sdk/server');
    const { startMcpServer } = await import('./mcp-server.ts');
    await startMcpServer();
    process.exit(0);
  } catch (error: any) {
    if (error?.code === 'MODULE_NOT_FOUND' || error?.message?.includes('@modelcontextprotocol/sdk')) {
      console.error('\n❌ MCP Server Error: @modelcontextprotocol/sdk is not installed.\n');
      console.error('This is likely because:');
      console.error('  1. The package was installed globally without dependencies');
      console.error('  2. A corrupt or incomplete installation\n');
      console.error('To fix this, try:');
      console.error('  npm install -g agent-yes --force');
      console.error('  OR');
      console.error('  npm install -g @modelcontextprotocol/sdk\n');
      process.exit(1);
    }
    // Re-throw if it's a different error
    throw error;
  }
}

// Parse CLI arguments
const config = parseCliArgs(process.argv);

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
const { exitCode } = await cliYes(config);
console.log("exiting process");
process.exit(exitCode ?? 1);
