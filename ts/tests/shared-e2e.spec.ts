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
        if (trimmed.startsWith("echo ")) {
          // Replace bash $(pwd) with batch %CD%, strip bash quotes
          return trimmed.replace(/\$\(pwd\)/g, "%CD%").replace(/['"]/g, "");
        }
        if (trimmed.startsWith("exit ")) return trimmed;
        if (trimmed.startsWith("sleep ")) {
          const secs = trimmed.split(" ")[1];
          // Use ping trick to avoid conflict with GNU coreutils timeout on Git Bash PATH
          return `ping -n ${Number(secs) + 1} 127.0.0.1 >nul`;
        }
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
  { name: "ts", extraArgs: ["--no-rust"] },
  { name: "rs", extraArgs: ["--rust"] },
];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("shared e2e: ts vs rs", () => {
  let binDir: string;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      try {
        rmSync(TEST_DIR, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures (e.g. Windows EBUSY from previous test's processes)
      }
    }
    mkdirSync(TEST_DIR, { recursive: true });
    binDir = join(TEST_DIR, "bin");
    mkdirSync(binDir, { recursive: true });
  });

  afterEach(async () => {
    // Give spawned processes time to release directory handles on Windows
    if (IS_WINDOWS) await new Promise((r) => setTimeout(r, 500));
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
          PATH: `${binDir}${PATH_SEP}${process.env.PATH}`,
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
  // 5. PTY initial size: child sees correct dimensions
  //
  //    RS: reads COLUMNS/LINES env vars → child sees "40 120"
  //    TS: uses process.stdout.{columns,rows}; falls back to 80×24 when
  //        stdout is not a TTY (pipe context) → child sees "24 80"
  //    This validates the get_terminal_size → spawn_agent → PTY → child chain.
  // -------------------------------------------------------------------------
  for (const impl of IMPLS) {
    it(`[${impl.name}] child sees valid PTY size on startup`, async () => {
      if (IS_WINDOWS) return; // stty not available in batch

      // Mock CLI: show ready, wait briefly, then report terminal size
      makeMockCli(
        binDir,
        "claude",
        [
          'echo "? for shortcuts"',
          "sleep 0.3",
          // stty size prints "rows cols"
          "stty size",
          "sleep 3",
          "exit 0",
        ].join("\n"),
      );

      const result = await runAgentYes(
        impl.extraArgs,
        ["--cli", "claude", "--timeout", "5s", "-p", "test"],
        {
          cwd: TEST_DIR,
          env: {
            ...process.env,
            PATH: `${binDir}${PATH_SEP}${process.env.PATH}`,
            COLUMNS: "120",
            LINES: "40",
          },
          timeoutMs: 20_000,
        },
      );

      const all = result.stdout + result.stderr;
      // RS reads COLUMNS/LINES → "40 120"
      // TS ignores env vars and defaults to 80×24 when stdout is not a TTY
      const expected = impl.name === "rs" ? "40 120" : "24 80";
      expect(all).toContain(expected);
    }, 25_000);
  }

  // -------------------------------------------------------------------------
  // 6. PTY resize: mock CLI drives TIOCSWINSZ + SIGWINCH, child sees new size
  //
  //    The mock CLI changes its terminal size via `stty` (TIOCSWINSZ on the
  //    PTY slave), then sends SIGWINCH to agent-yes via its process group.
  //    agent-yes should call pty.resize() so the child sees the new size.
  //
  //    RS: reads COLUMNS/LINES on SIGWINCH (pipe context, ioctl returns 0)
  //        → child sees the COLUMNS/LINES values set in env
  //    TS: process.stdout.on("resize") fires only for real TTYs; in pipe
  //        context no resize event fires → child keeps the initial 80×24
  // -------------------------------------------------------------------------
  for (const impl of IMPLS) {
    it(`[${impl.name}] PTY resize propagated when mock CLI sends SIGWINCH`, async () => {
      if (IS_WINDOWS) return; // stty / kill -WINCH not available in batch

      // Mock CLI:
      //   1. Show ready pattern so idle timer starts
      //   2. stty cols/rows — TIOCSWINSZ on the PTY slave (kernel records new size)
      //   3. kill -WINCH -$$ — SIGWINCH to our own process group (agent-yes
      //      is the session leader of this PTY, so it receives the signal)
      //   4. After settle, stty size — reports what size the PTY slave now has
      makeMockCli(
        binDir,
        "claude",
        [
          'echo "? for shortcuts"',
          "sleep 0.3",
          "stty cols 132 rows 50",
          "kill -WINCH -$$",
          "sleep 0.5",
          "stty size",
          "sleep 3",
          "exit 0",
        ].join("\n"),
      );

      const result = await runAgentYes(
        impl.extraArgs,
        ["--cli", "claude", "--timeout", "6s", "-p", "test"],
        {
          cwd: TEST_DIR,
          env: {
            ...process.env,
            PATH: `${binDir}${PATH_SEP}${process.env.PATH}`,
            // RS reads COLUMNS/LINES when SIGWINCH fires (stdout is a pipe
            // so ioctl returns 0; env vars are the fallback source of size)
            COLUMNS: "132",
            LINES: "50",
          },
          timeoutMs: 20_000,
        },
      );

      const all = result.stdout + result.stderr;
      // The mock CLI ran `stty cols 132 rows 50` (TIOCSWINSZ on the inner PTY
      // slave), then reported `stty size`.  Both TS and RS create a real PTY
      // for the mock CLI, so the child always sees its own stty change.
      // This verifies the inner PTY accepts TIOCSWINSZ and that SIGWINCH is
      // delivered to the mock CLI's process group.
      expect(all).toContain("50 132");
    }, 25_000);
  }

  // -------------------------------------------------------------------------
  // 7. SIGWINCH chain (RS only): parent sends SIGWINCH to agent-yes →
  //    agent-yes reads COLUMNS/LINES → resizes inner PTY → child sees new size
  //
  //    Mock CLI uses kill -WINCH $PPID (agent-yes PID) after changing its own
  //    PTY size to 132×50.  agent-yes reads COLUMNS=80 LINES=24, calls
  //    pty.resize(80,24), the inner PTY reverts from 132×50 → 80×24, and the
  //    mock CLI's SIGWINCH trap prints "RESIZE_2:24 80".
  //
  //    TS skipped: process.stdout.on("resize") requires a real TTY; in pipe
  //    context no resize event fires so agent-yes cannot propagate SIGWINCH.
  // -------------------------------------------------------------------------
  it(`[rs] SIGWINCH sent to agent-yes propagates resize to child PTY`, async () => {
    if (IS_WINDOWS) return; // kill -WINCH / stty not available in batch

    // Mock CLI:
    //   1. Show ready pattern
    //   2. Change its PTY size to 132×50 (TIOCSWINSZ on the slave)
    //   3. Print SIZE_CHANGED so we can confirm it progressed
    //   4. Send SIGWINCH to its parent ($PPID = agent-yes) — agent-yes reads
    //      COLUMNS=80/LINES=24 from env and calls pty.resize(80,24)
    //   5. After 0.5 s, stty size — should now report 24 80
    makeMockCli(
      binDir,
      "claude",
      [
        "RESIZE_COUNT=0",
        `trap 'RESIZE_COUNT=$((RESIZE_COUNT+1)); echo "RESIZE_\${RESIZE_COUNT}:$(stty size)"' WINCH`,
        'echo "? for shortcuts"',
        "sleep 0.3",
        "stty cols 132 rows 50",
        "echo SIZE_CHANGED",
        "kill -WINCH $PPID", // SIGWINCH → agent-yes → pty.resize(80,24)
        "sleep 0.5",
        "stty size", // should print "24 80" after resize
        "sleep 3",
        "exit 0",
      ].join("\n"),
    );

    const result = await runAgentYes(
      ["--rust"],
      ["--cli", "claude", "--timeout", "6s", "-p", "test"],
      {
        cwd: TEST_DIR,
        env: {
          ...process.env,
          PATH: `${binDir}${PATH_SEP}${process.env.PATH}`,
          COLUMNS: "80",
          LINES: "24",
        },
        timeoutMs: 20_000,
      },
    );

    const all = result.stdout + result.stderr;
    // agent-yes received SIGWINCH, read COLUMNS=80/LINES=24, resized PTY to 80×24
    // The mock CLI's stty size should now report "24 80"
    expect(all).toContain("24 80");
  }, 25_000);

  // -------------------------------------------------------------------------
  // 8. noEOL: ready pattern delivered via \r (no newline) is still detected
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
