import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sleepms } from "../ts/utils";
import path from "path";
import { writeFileSync, rmSync, existsSync } from "fs";
import pty from "../ts/pty";

/**
 * Ctrl+C abort tests
 *
 * These tests verify that sending Ctrl+C (SIGINT) during CLI loading
 * results in a graceful exit with "User aborted: SIGINT" message.
 *
 * Note: These tests use pty.spawn to create a proper pseudo-terminal,
 * which allows Ctrl+C handling to work correctly (unlike piped stdin).
 */
describe("Ctrl+C abort tests", () => {
  const mockClaudePath = path.resolve(__dirname, "claude");

  beforeAll(() => {
    // Create a mock claude script that simulates claude but NEVER shows the ready pattern
    // This keeps stdin in "not ready" state so Ctrl+C triggers the abort handler
    const mockScript = `#!/usr/bin/env bash
# Mock Claude CLI for testing - keeps loading forever without showing ready pattern
echo "Starting Claude..."
echo "Loading..."
# Sleep forever to simulate a loading agent (never becomes ready)
sleep 10000
`;
    writeFileSync(mockClaudePath, mockScript, { mode: 0o755 });
  });

  afterAll(() => {
    // Cleanup mock claude script
    try {
      if (existsSync(mockClaudePath)) {
        rmSync(mockClaudePath, { force: true });
      }
    } catch (err) {
      console.warn("Cleanup failed:", err);
    }
  });

  it("should exit with 'User aborted: SIGINT' message when Ctrl+C is sent after 0.2s", async () => {
    const cliPath = path.resolve(__dirname, "../ts/cli.ts");
    const testDir = path.resolve(__dirname);

    // Use pty.spawn to create a proper pseudo-terminal (not a pipe)
    // This allows raw mode and proper Ctrl+C handling
    // Note: We spawn bun directly (not "bun run") and disable robust mode
    const proc = pty.spawn("bun", [cliPath, "--verbose", "--no-robust", "claude", "--", "hello"], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: testDir,
      env: {
        ...process.env,
        PATH: `${testDir}:${process.env.PATH}`, // Prepend test dir so our mock 'claude' is found
        VERBOSE: "1",
      },
    });

    let allOutput = "";

    // Collect all output using PTY's onData handler
    proc.onData((data) => {
      allOutput += data;
    });

    // Wait for CLI to initialize and spawn the mock claude agent
    // We need to wait long enough for:
    // 1. CLI to load config and initialize
    // 2. CLI to spawn the mock claude subprocess
    // 3. stdin stream handlers to be set up
    // The mock claude will never show the ready pattern, so stdin stays "not ready"
    // Wait for the "Starting Claude..." message to appear
    await new Promise<void>((resolve) => {
      const checkOutput = () => {
        if (allOutput.includes("Starting Claude")) {
          resolve();
        }
      };
      const interval = setInterval(checkOutput, 100);
      setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 3000);
    });

    // Wait a bit more to ensure stdin stream is fully set up
    await sleepms(200);

    // Write Ctrl+C to the PTY
    console.log("\n[TEST] Sending Ctrl+C to PTY...");
    console.log("[TEST] stdin ready?", allOutput.includes("ready"));
    proc.write("\u0003");
    console.log("[TEST] Ctrl+C sent, waiting for exit...");

    // Wait for process to exit
    const exitCode = await new Promise<number | null>((resolve) => {
      let resolved = false;

      proc.onExit(({ exitCode }) => {
        if (!resolved) {
          resolved = true;
          resolve(exitCode);
        }
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        if (!resolved) {
          proc.kill("SIGKILL");
          resolved = true;
          resolve(null);
        }
      }, 5000);
    });

    // Log output for debugging if test fails
    if (!allOutput.includes("User aborted")) {
      console.log("\n=== Test failed - Debug output ===");
      console.log("Exit code:", exitCode);
      console.log("Output length:", allOutput.length);
      console.log("Output (first 1000 chars):");
      console.log(allOutput.substring(0, 1000));
      console.log("==================================\n");
    }

    // Check that "User aborted: SIGINT" appears in output
    expect(allOutput).toContain("User aborted: SIGINT");

    // Check exit code is 130 (SIGINT exit code)
    expect(exitCode).toBe(130);
  }, 15000); // Increased timeout to 15 seconds
});
