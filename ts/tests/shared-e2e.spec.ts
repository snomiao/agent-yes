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
import { expect, it, describe, beforeEach, afterEach } from "vitest";

const IS_WINDOWS = process.platform === "win32";
const PATH_SEP = IS_WINDOWS ? ";" : ":";

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

/**
 * Create an executable mock CLI script inside dir.
 * On Windows: creates a .cmd batch file.
 * On Unix: creates a bash script and marks it executable.
 */
function makeMockCli(dir: string, name: string, body: string): string {
  if (IS_WINDOWS) {
    const p = join(dir, `${name}.cmd`);
    // Convert bash-style body to basic batch: echo statements, exit
    const batchBody = body
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("echo ")) return trimmed;
        if (trimmed.startsWith("exit ")) return trimmed;
        if (trimmed.startsWith("sleep "))
          return `timeout /t ${trimmed.split(" ")[1]} /nobreak >nul`;
        if (trimmed.startsWith("read ")) return "set /p _line=";
        return `rem ${trimmed}`;
      })
      .join("\r\n");
    writeFileSync(p, `@echo off\r\n${batchBody}\r\n`);
    return p;
  }
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
            PATH: `${binDir}${PATH_SEP}${process.env.PATH}`,
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
            PATH: `${binDir}${PATH_SEP}${process.env.PATH}`,
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
      // Should have exited within a reasonable window around the idle timeout.
      // On slow machines, force-ready (10s) + idle timeout (3s) + overhead ≈ 16s.
      expect(elapsed).toBeLessThan(20_000);
    }, 25_000);
  }

  // -------------------------------------------------------------------------
  // 5. noEOL: ready pattern delivered via \r (no newline) is still detected
  //    via the heartbeat's terminalRender.tail() poll
  // -------------------------------------------------------------------------
  for (const impl of IMPLS) {
    it(`[${impl.name}] detects ready pattern written with \\r (noEOL-style)`, async () => {
      if (IS_WINDOWS) return; // \r semantics differ in Windows batch; skip

      // Mock CLI: writes the ready pattern using \r then \n (like a spinner that
      // rewrites a line) so no clean \n-separated line ever appears in the raw
      // chunk stream — only the rendered terminal has the clean text.
      makeMockCli(
        binDir,
        "claude",
        [
          // Overwrite a line: first write noise, then carriage-return and write the
          // actual ready text on the same line.
          `printf 'loading...\\r? for shortcuts\\n'`,
          "sleep 10000",
        ].join("\n"),
      );

      const result = await runAgentYes(
        impl.extraArgs,
        ["--cli", "claude", "--timeout", "3s", "-p", "test"],
        {
          cwd: TEST_DIR,
          env: { ...process.env, PATH: `${binDir}${PATH_SEP}${process.env.PATH}` },
          timeoutMs: 20_000,
        },
      );

      // If the ready pattern was detected the agent starts the idle timer and
      // exits cleanly (code 0 or 1) within the timeout window — not killed by us.
      expect(result.code).not.toBe(-1); // -1 means our outer kill fired
    }, 25_000);
  }
});
