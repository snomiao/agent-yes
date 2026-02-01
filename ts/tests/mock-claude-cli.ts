#!/usr/bin/env bun
/**
 * Mock Claude CLI for testing agent-yes FIFO/append-prompt functionality.
 *
 * Simulates the Claude CLI by:
 * 1. Printing the ready pattern ("? for shortcuts") so agent-yes detects readiness
 * 2. Accepting input via stdin (including merged FIFO input)
 * 3. Echoing received prompts to stdout for verification
 * 4. Writing received prompts to a log file (CWD/.agent-yes/mock-received.log)
 * 5. Handling /exit to terminate cleanly
 *
 * Usage:
 *   bun ts/tests/mock-claude-cli.ts [prompt]
 *
 * The mock accepts an optional positional prompt arg (like real claude with promptArg: "last-arg").
 */

import { appendFileSync, mkdirSync } from "fs";
import path from "path";

const receivedLogPath = path.resolve(process.cwd(), ".agent-yes", "mock-received.log");
mkdirSync(path.dirname(receivedLogPath), { recursive: true });

function logReceived(source: string, message: string) {
  const entry = `[${new Date().toISOString()}] ${source}: ${message}\n`;
  appendFileSync(receivedLogPath, entry);
}

// Handle positional prompt arg (mimics claude's promptArg: "last-arg")
const promptArg = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("-"))
  .at(-1);
if (promptArg) {
  logReceived("argv", promptArg);
  process.stdout.write(`Received prompt arg: ${promptArg}\n`);
}

// Simulate startup delay, then print ready pattern
setTimeout(() => {
  process.stdout.write("\n  Claude Code\n\n");
  process.stdout.write("> \n");
  process.stdout.write("  Type ? for shortcuts\n\n");
}, 300);

// Read stdin line by line
let buffer = "";

function handleLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return;

  if (trimmed === "/exit") {
    process.stdout.write("\nExiting mock claude.\n");
    logReceived("exit", "/exit");
    process.exit(0);
  }

  // Echo received input
  process.stdout.write(`\nReceived: ${trimmed}\n> `);
  logReceived("stdin", trimmed);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  // Split on \r or \n (FIFO sends \r, terminal sends \n)
  const parts = buffer.split(/\r|\n/);
  buffer = parts.pop() ?? "";
  for (const part of parts) {
    handleLine(part);
  }
});

// Keep the process alive
process.stdin.resume();

// Handle SIGINT/SIGTERM
process.on("SIGINT", () => {
  logReceived("signal", "SIGINT");
  process.exit(130);
});
process.on("SIGTERM", () => {
  logReceived("signal", "SIGTERM");
  process.exit(143);
});
