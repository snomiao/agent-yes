import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { expect, it, describe, beforeEach, afterEach } from "bun:test";

const TEST_DIR = join(process.cwd(), "tmp-test-fifo");
const MOCK_CLI_PATH = join(process.cwd(), "ts/tests/mock-claude-cli.ts");
const AGENT_YES_CLI = join(process.cwd(), "ts/cli.ts");

describe("IPC cross-platform functionality", () => {
  beforeEach(async () => {
    // Create clean test directory with retry for Windows file locking issues
    if (existsSync(TEST_DIR)) {
      let attempts = 0;
      while (attempts < 3) {
        try {
          rmSync(TEST_DIR, { recursive: true, force: true });
          break;
        } catch (error) {
          attempts++;
          if (attempts < 3) {
            // Wait before retry to allow file handles to close
            await new Promise(resolve => setTimeout(resolve, 1000));
          } else {
            console.warn(`Failed to cleanup test directory after ${attempts} attempts:`, error);
          }
        }
      }
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup test directory with retry for Windows file locking issues
    if (existsSync(TEST_DIR)) {
      let attempts = 0;
      while (attempts < 3) {
        try {
          rmSync(TEST_DIR, { recursive: true, force: true });
          break;
        } catch (error) {
          attempts++;
          if (attempts < 3) {
            // Wait before retry to allow file handles to close
            await new Promise(resolve => setTimeout(resolve, 1000));
          } else {
            console.warn(`Failed to cleanup test directory after ${attempts} attempts:`, error);
          }
        }
      }
    }
  });

  it("should verify --stdpush flag parsing and platform-specific paths", async () => {
    const { parseCliArgs } = await import("../parseCliArgs");

    // Test that --stdpush flag is correctly parsed
    const config1 = parseCliArgs(["node", "agent-yes", "--stdpush", "claude"]);
    expect(config1.useFifo).toBe(true);

    // Test backward compatibility with --fifo and --ipc
    const config2 = parseCliArgs(["node", "agent-yes", "--fifo", "claude"]);
    expect(config2.useFifo).toBe(true);

    const config3 = parseCliArgs(["node", "agent-yes", "--ipc", "claude"]);
    expect(config3.useFifo).toBe(true);

    // Test that platform detection works
    const originalPlatform = process.platform;

    try {
      // Mock Windows
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const { PidStore } = await import("../pidStore");
      const winStore = new PidStore("/test");
      expect(await winStore.getFifoPath(123)).toMatch(/\\\\\.\\pipe\\agent-yes-123/);

      // Mock Linux
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const linStore = new PidStore("/test");
      expect(await linStore.getFifoPath(123)).toContain("123.stdin");
    } finally {
      // Restore original platform
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it("should fail gracefully when no active IPC agent exists", async () => {
    // Try to append prompt when no agent is running
    const appendProc = spawn("bun", [AGENT_YES_CLI, "--append-prompt", "test prompt"], {
      cwd: TEST_DIR,
    });

    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      let stdout = "";
      let stderr = "";

      appendProc.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      appendProc.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      appendProc.on("exit", (code) => {
        resolve({ code: code || 0, stdout, stderr });
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        appendProc.kill();
        resolve({ code: 1, stdout, stderr: stderr || "Timeout" });
      }, 5000);
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No active agent with IPC found");
  });
});