import { describe, it, expect } from "vitest";
import { sleepms } from "../ts/utils";
import path from "path";
import pty from "../ts/pty";

/**
 * Test if direct stdin event listeners receive Ctrl+C
 * This bypasses fromReadable/sflow to isolate the issue
 */
describe("Direct stdin Ctrl+C test", () => {
  it("should detect Ctrl+C using direct event listeners", async () => {
    const scriptPath = path.resolve(__dirname, "debug-stdin-direct.ts");
    const testDir = path.resolve(__dirname);

    // Spawn the debug script with PTY
    const proc = pty.spawn("bun", [scriptPath], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: testDir,
      env: {
        ...process.env,
      },
    });

    let allOutput = "";

    proc.onData((data) => {
      allOutput += data;
      console.log("[OUTPUT]", data);
    });

    // Wait for initialization
    await sleepms(500);

    console.log("\n[TEST] Sending Ctrl+C to PTY...");
    proc.write("\u0003");
    console.log("[TEST] Ctrl+C sent");

    // Wait for exit
    const exitCode = await new Promise<number | null>((resolve) => {
      let resolved = false;

      proc.onExit(({ exitCode }) => {
        if (!resolved) {
          resolved = true;
          console.log("[TEST] Process exited with code:", exitCode);
          resolve(exitCode);
        }
      });

      setTimeout(() => {
        if (!resolved) {
          console.log("[TEST] Timeout - killing process");
          proc.kill("SIGKILL");
          resolved = true;
          resolve(null);
        }
      }, 5000);
    });

    console.log("\n=== Final Output ===");
    console.log(allOutput);
    console.log("===================\n");

    // Check if Ctrl+C was detected
    expect(allOutput).toContain("Ctrl+C DETECTED");
    expect(exitCode).toBe(130);
  }, 10000);
});
