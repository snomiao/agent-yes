#!/usr/bin/env bun
/**
 * Debug script to test stdin Ctrl+C detection
 * Run with: bun run tests/debug-ctrl-c.ts
 * Then press Ctrl+C and see what happens
 */

import { fromReadable } from "from-node-stream";
import sflow from "sflow";

console.log("=== Ctrl+C Debug Test ===");
console.log("Process info:");
console.log("- stdin.isTTY:", process.stdin.isTTY);
console.log("- stdin.isRaw:", (process.stdin as any).isRaw);
console.log("\nTrying to set raw mode...");

try {
  if (process.stdin.setRawMode) {
    process.stdin.setRawMode(true);
    console.log("✓ Raw mode enabled");
    console.log("- stdin.isRaw:", (process.stdin as any).isRaw);
  } else {
    console.log("✗ setRawMode not available");
  }
} catch (err) {
  console.log("✗ Failed to set raw mode:", err);
}

console.log("\nPress Ctrl+C now...");
console.log("(or type some text and press Enter)\n");

let ready = false;
setTimeout(() => {
  console.log("\n[After 2s] Setting ready = true");
  ready = true;
}, 2000);

await sflow(fromReadable<Buffer>(process.stdin))
  .map((buffer) => buffer.toString())
  .map((chunk: string) => {
    const CTRL_C = "\u0003";

    // Log every chunk we receive
    console.log("\n[STDIN] Received chunk:");
    console.log("- Length:", chunk.length);
    console.log("- Bytes:", Buffer.from(chunk).toString("hex"));
    console.log("- Printable:", JSON.stringify(chunk));
    console.log("- Contains \\u0003?:", chunk.includes(CTRL_C));
    console.log("- Equals \\u0003?:", chunk === CTRL_C);
    console.log("- ready:", ready);

    // Check for Ctrl+C when not ready
    if (!ready && chunk === CTRL_C) {
      console.log("\n✓ Ctrl+C DETECTED! (stdin not ready)");
      process.exit(130);
    }

    if (!ready && chunk.includes(CTRL_C)) {
      console.log("\n✓ Ctrl+C found in chunk! (but chunk !== \\u0003)");
      console.log("  This might be the issue - chunk contains other data");
      process.exit(130);
    }

    return chunk;
  })
  .forEach(() => {})
  .run();
