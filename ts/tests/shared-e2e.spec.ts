/**
 * Shared e2e tests that run the same behavioral assertions against both the
 * TypeScript and Rust implementations of agent-yes.
 *
 * Each test is parameterized over two "runners":
 *   - ts:  bun ts/cli.ts <args>
 *   - rs:  bun ts/cli.ts --rust <args>
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { expect, it, describe, beforeEach, afterEach } from "bun:test";

const ROOT = process.cwd();
const AGENT_YES_CLI = join(ROOT, "ts/cli.ts");
const TEST_DIR = join(ROOT, "tmp-test-shared-e2e");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RunResult = { code: number; stdout: string; stderr: string };

function runAgentYes(
  implArgs: string[],
  cliAndArgs: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  const { cwd = ROOT, env = process.env, timeoutMs = 15_000 } = opts;
  const args = ["bun", AGENT_YES_CLI, ...implArgs, ...cliAndArgs];

  return new Promise((resolve) => {
    const proc = spawn(args[0]!, args.slice(1), { cwd, env });
    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ code: -1, stdout, stderr: stderr || "Timeout" });
    }, timeoutMs);

    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Create an executable bash script inside dir. */
function makeMockCli(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

// ---------------------------------------------------------------------------
// Parametrize
// ---------------------------------------------------------------------------

const IMPLS: Array<{ name: string; extraArgs: string[] }> = [
  { name: "ts", extraArgs: [] },
  { name: "rs", extraArgs: ["--rust"] },
];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("shared e2e: ts vs rs", () => {
  let binDir: string;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    binDir = join(TEST_DIR, "bin");
    mkdirSync(binDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      try {
        rmSync(TEST_DIR, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
  });

  // -------------------------------------------------------------------------
  // 1. CWD is preserved
  // -------------------------------------------------------------------------
  for (const impl of IMPLS) {
    it(`[${impl.name}] preserves working directory`, async () => {
      const workdir = join(TEST_DIR, "workspace");
      mkdirSync(workdir, { recursive: true });

      // Mock CLI: prints PWD then shows ready pattern and exits
      makeMockCli(
        binDir,
        "claude",
        ['echo "PWD: $(pwd)"', 'echo "? for shortcuts"', "sleep 1", "exit 0"].join("\n"),
      );

      const result = await runAgentYes(
        impl.extraArgs,
        ["--cli", "claude", "--timeout", "5s", "-p", "test"],
        {
          cwd: workdir,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
          },
          timeoutMs: 20_000,
        },
      );

      const all = result.stdout + result.stderr;
      expect(all).toContain(`PWD: ${workdir}`);
    }, 25_000);
  }

  // -------------------------------------------------------------------------
  // 2. Auto-yes: sends Enter when "Press Enter to continue" is shown
  // -------------------------------------------------------------------------
  for (const impl of IMPLS) {
    it(`[${impl.name}] auto-sends Enter on "Press Enter to continue"`, async () => {
      // Mock CLI: blocks on read until Enter is received, then exits
      makeMockCli(
        binDir,
        "claude",
        [
          "echo 'Press Enter to continue'",
          "read -r _line", // blocks until Enter
          "echo 'CONTINUED'",
          "echo '? for shortcuts'",
          "sleep 1",
          "exit 0",
        ].join("\n"),
      );

      const result = await runAgentYes(
        impl.extraArgs,
        ["--cli", "claude", "--timeout", "10s", "-p", "test"],
        {
          cwd: TEST_DIR,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
          },
          timeoutMs: 20_000,
        },
      );

      const all = result.stdout + result.stderr;
      expect(all).toContain("CONTINUED");
    }, 25_000);
  }

  // -------------------------------------------------------------------------
  // 3. Unknown CLI is rejected
  // -------------------------------------------------------------------------
  for (const impl of IMPLS) {
    it(`[${impl.name}] rejects unknown CLI name`, async () => {
      const result = await runAgentYes(impl.extraArgs, ["--cli", "totally_unknown_cli_xyz"], {
        timeoutMs: 10_000,
      });

      expect(result.code).not.toBe(0);
    }, 15_000);
  }

  // -------------------------------------------------------------------------
  // 4. Exits on idle timeout after CLI shows ready then goes silent
  // -------------------------------------------------------------------------
  for (const impl of IMPLS) {
    it(`[${impl.name}] exits when idle timeout is reached`, async () => {
      // Mock CLI: shows ready pattern then sleeps forever → idle timer fires
      makeMockCli(binDir, "claude", ["echo '? for shortcuts'", "sleep 10000"].join("\n"));

      const start = Date.now();
      await runAgentYes(impl.extraArgs, ["--cli", "claude", "--timeout", "3s", "-p", "test"], {
        cwd: TEST_DIR,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
        },
        timeoutMs: 20_000,
      });

      const elapsed = Date.now() - start;
      // Should have exited within a reasonable window around the 3s idle timeout
      expect(elapsed).toBeLessThan(15_000);
    }, 25_000);
  }
});
