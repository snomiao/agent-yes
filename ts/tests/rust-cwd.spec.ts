import { spawn } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { expect, it, describe, beforeEach, afterEach } from "bun:test";
import { findRustBinary } from "../rustBinary";

const TEST_DIR = join(process.cwd(), "tmp-test-rust-cwd");
const AGENT_YES_CLI = join(process.cwd(), "ts/cli.ts");
const hasRustBinary = !!findRustBinary();

describe.skipIf(!hasRustBinary)("Rust binary working directory", () => {
  beforeEach(async () => {
    // Create clean test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup test directory
    if (existsSync(TEST_DIR)) {
      let attempts = 0;
      while (attempts < 3) {
        try {
          rmSync(TEST_DIR, { recursive: true, force: true });
          break;
        } catch {
          attempts++;
          if (attempts < 3) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }
    }
  });

  it("should log the correct working directory in verbose mode", async () => {
    // Create a subdirectory to make the test more specific
    const subdir = join(TEST_DIR, "workspace");
    mkdirSync(subdir, { recursive: true });

    // Run agent-yes with --rust and --verbose from subdirectory
    // Use --version flag to make it exit immediately without waiting for input
    const proc = spawn("bun", [AGENT_YES_CLI, "--rust", "--verbose", "claude", "--version"], {
      cwd: subdir,
      env: {
        ...process.env,
        // Use local Rust binary if available to speed up test
        AGENT_YES_CACHE_DIR: join(TEST_DIR, ".cache"),
      },
    });

    const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        let stdout = "";
        let stderr = "";

        proc.stdout?.on("data", (chunk) => {
          stdout += chunk.toString();
        });

        proc.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        proc.on("exit", (code) => {
          resolve({ code: code || 0, stdout, stderr });
        });

        // Timeout after 15 seconds
        setTimeout(() => {
          proc.kill("SIGTERM");
          resolve({ code: 1, stdout, stderr: stderr || "Timeout" });
        }, 15000);
      },
    );

    // Verify the Rust binary logs show the correct working directory
    // The key check: our fix adds "in {directory}" to the log message
    // Note: Rust logs go to stdout via inherited stdio
    expect(result.stdout).toContain(`Starting claude agent in ${subdir}`);
  }, 20000);
});
