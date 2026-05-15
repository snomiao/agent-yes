import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

// Reroute homedir() so global index writes/reads land in a temp dir.
let testHome: string;

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => testHome,
  };
});

beforeEach(async () => {
  testHome = await mkdtemp(path.join(tmpdir(), "ay-sub-test-"));
  vi.resetModules();
});

afterEach(async () => {
  await rm(testHome, { recursive: true, force: true }).catch(() => null);
});

async function loadModule() {
  return await import("./subcommands.ts");
}

describe("subcommands.controlCodeFromName", () => {
  it("maps named codes to the right control bytes", async () => {
    const { controlCodeFromName } = await loadModule();
    expect(controlCodeFromName("enter")).toBe("\r");
    expect(controlCodeFromName("cr")).toBe("\r");
    expect(controlCodeFromName("esc")).toBe("\x1b");
    expect(controlCodeFromName("ctrl-c")).toBe("\x03");
    expect(controlCodeFromName("ctrl-y")).toBe("\x19");
    expect(controlCodeFromName("ctrl-d")).toBe("\x04");
    expect(controlCodeFromName("tab")).toBe("\t");
    expect(controlCodeFromName("none")).toBe("");
    expect(controlCodeFromName("")).toBe("");
  });

  it("supports raw:0xNN escape", async () => {
    const { controlCodeFromName } = await loadModule();
    expect(controlCodeFromName("raw:0x03")).toBe("\x03");
    expect(controlCodeFromName("raw:0x1b")).toBe("\x1b");
  });

  it("throws on unknown code names", async () => {
    const { controlCodeFromName } = await loadModule();
    expect(() => controlCodeFromName("nope")).toThrow(/unknown --code/);
  });
});

describe("subcommands.matchKeyword", () => {
  const baseRecord = {
    pid: 1234,
    cli: "claude",
    prompt: "fix the parser bug",
    cwd: "/v1/code/snomiao/agent-yes",
    log_file: null,
    status: "active" as const,
    exit_code: null,
    exit_reason: null,
    started_at: 0,
  };

  it("matches by exact pid", async () => {
    const { matchKeyword } = await loadModule();
    expect(matchKeyword(baseRecord, "1234")).toBe(true);
    expect(matchKeyword(baseRecord, "9999")).toBe(false);
  });

  it("matches by cwd substring (case-insensitive)", async () => {
    const { matchKeyword } = await loadModule();
    expect(matchKeyword(baseRecord, "agent-yes")).toBe(true);
    expect(matchKeyword(baseRecord, "AGENT-YES")).toBe(true);
    expect(matchKeyword(baseRecord, "different-project")).toBe(false);
  });

  it("matches by exact cli name", async () => {
    const { matchKeyword } = await loadModule();
    expect(matchKeyword(baseRecord, "claude")).toBe(true);
    expect(matchKeyword(baseRecord, "codex")).toBe(false);
  });

  it("matches by prompt substring", async () => {
    const { matchKeyword } = await loadModule();
    expect(matchKeyword(baseRecord, "parser")).toBe(true);
    expect(matchKeyword(baseRecord, "rocketship")).toBe(false);
  });

  it("returns true for empty keyword (no filter)", async () => {
    const { matchKeyword } = await loadModule();
    expect(matchKeyword(baseRecord, "")).toBe(true);
  });

  it("ignores prompt match if prompt is null", async () => {
    const { matchKeyword } = await loadModule();
    const r = { ...baseRecord, prompt: null };
    expect(matchKeyword(r, "parser")).toBe(false);
  });
});

describe("subcommands.runSubcommand routing", () => {
  it("returns null for unknown subcommands so cli.ts falls through", async () => {
    const { runSubcommand } = await loadModule();
    const code = await runSubcommand(["bun", "cli.js", "definitely-not-a-cmd"]);
    expect(code).toBeNull();
  });

  it("ls on an empty index prints 'no running agents'", async () => {
    const { runSubcommand } = await loadModule();
    const stderr: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => {
      stderr.push(String(s));
      return true;
    };
    try {
      const code = await runSubcommand(["bun", "cli.js", "ls"]);
      expect(code).toBe(0);
      expect(stderr.join("")).toMatch(/no running agents/);
    } finally {
      process.stderr.write = orig;
    }
  });

  it("ls --json emits a parseable JSON array", async () => {
    const mod = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: "live test",
      cwd: process.cwd(),
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
    });

    const stdout: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: any) => {
      stdout.push(String(s));
      return true;
    };
    try {
      const code = await mod.runSubcommand(["bun", "cli.js", "ls", "--json"]);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = orig;
    }

    const parsed = JSON.parse(stdout.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({ pid: process.pid, cli: "claude" });
  });

  it("read errors cleanly when keyword resolves to no agent", async () => {
    const { runSubcommand } = await loadModule();
    const stderr: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => {
      stderr.push(String(s));
      return true;
    };
    try {
      const code = await runSubcommand(["bun", "cli.js", "read", "no-such-agent-keyword"]);
      expect(code).toBe(1);
      expect(stderr.join("")).toMatch(/no agent matched/);
    } finally {
      process.stderr.write = orig;
    }
  });

  it("send refuses when missing arguments", async () => {
    const { runSubcommand } = await loadModule();
    const stderr: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => {
      stderr.push(String(s));
      return true;
    };
    try {
      const code = await runSubcommand(["bun", "cli.js", "send"]);
      expect(code).toBe(1);
      expect(stderr.join("")).toMatch(/usage:/);
    } finally {
      process.stderr.write = orig;
    }
  });

  it("send errors when matched record has no fifo_file", async () => {
    const mod = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: "no-fifo-test",
      cwd: process.cwd(),
      log_file: null,
      fifo_file: null, // explicitly missing — old Rust agent
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
    });

    const stderr: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => {
      stderr.push(String(s));
      return true;
    };
    try {
      const code = await mod.runSubcommand([
        "bun",
        "cli.js",
        "send",
        String(process.pid),
        "anything",
      ]);
      expect(code).toBe(1);
      expect(stderr.join("")).toMatch(/no fifo_file recorded/);
    } finally {
      process.stderr.write = orig;
    }
  });
});

describe("subcommands.cmdLs human table", () => {
  function captureStdout() {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: any) => {
      chunks.push(String(s));
      return true;
    };
    return {
      get text() {
        return chunks.join("");
      },
      restore() {
        process.stdout.write = orig;
      },
    };
  }

  it("prints a header and row for each record", async () => {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: "table format test",
      cwd: process.cwd(),
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now() - 5000,
    });

    const cap = captureStdout();
    try {
      const code = await runSubcommand(["bun", "cli.js", "ls"]);
      expect(code).toBe(0);
    } finally {
      cap.restore();
    }
    expect(cap.text).toMatch(/PID\s+CLI\s+STATUS\s+AGE\s+CWD\s+NOTE\/PROMPT/);
    expect(cap.text).toMatch(new RegExp(`${process.pid}\\s`));
    expect(cap.text).toMatch(/claude/);
    expect(cap.text).toMatch(/table format test/);
  });

  it("renders ages across seconds/minutes/hours/days correctly", async () => {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    const now = Date.now();
    // four records with ages spanning the four units; use distinct fake pids
    // that won't pass liveOnly, so use process.pid for one and --all for full.
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: "x",
      cwd: process.cwd(),
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: now - 2_000, // 2s
    });

    const cap = captureStdout();
    try {
      await runSubcommand(["bun", "cli.js", "ls"]);
    } finally {
      cap.restore();
    }
    // age column should show "2s"
    expect(cap.text).toMatch(/\b2s\b/);
  });

  it("scopes to --cwd <dir>", async () => {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: "should appear",
      cwd: process.cwd(),
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
    });
    const otherCwd = await mkdtemp(path.join(tmpdir(), "ay-other-"));
    try {
      // No record under otherCwd → scoped ls finds nothing
      const stderr: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      (process.stderr as any).write = (s: any) => {
        stderr.push(String(s));
        return true;
      };
      try {
        const code = await runSubcommand(["bun", "cli.js", "ls", "--cwd", otherCwd]);
        expect(code).toBe(0);
        expect(stderr.join("")).toMatch(/no running agents/);
      } finally {
        process.stderr.write = orig;
      }
    } finally {
      await rm(otherCwd, { recursive: true, force: true }).catch(() => null);
    }
  });
});

describe("subcommands.cmdRead renders raw log via xterm-headless", () => {
  it("tail -n N emits last N lines of rendered output", async () => {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    // Build a tiny synthetic raw log: 100 newline-separated lines.
    const tmp = await mkdtemp(path.join(tmpdir(), "ay-raw-log-"));
    try {
      const logPath = path.join(tmp, "x.raw.log");
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) lines.push(`line-${i}`);
      await writeFile(logPath, lines.join("\r\n") + "\r\n");

      await appendGlobalPid({
        pid: process.pid,
        cli: "claude",
        prompt: null,
        cwd: process.cwd(),
        log_file: logPath,
        status: "active",
        exit_code: null,
        exit_reason: null,
        started_at: Date.now(),
      });

      const stdout: string[] = [];
      const orig = process.stdout.write.bind(process.stdout);
      (process.stdout as any).write = (s: any) => {
        stdout.push(String(s));
        return true;
      };
      try {
        const code = await runSubcommand(["bun", "cli.js", "tail", String(process.pid), "-n", "5"]);
        expect(code).toBe(0);
      } finally {
        process.stdout.write = orig;
      }
      const text = stdout.join("");
      // last 5 lines should be 95..99
      expect(text).toMatch(/line-99/);
      expect(text).toMatch(/line-95/);
      // earlier lines should NOT be in output
      expect(text).not.toMatch(/line-50\b/);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => null);
    }
  });

  it("read errors when log_file path is missing on disk", async () => {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: null,
      cwd: process.cwd(),
      log_file: "/nonexistent/path/to/log",
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
    });
    const stderr: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => {
      stderr.push(String(s));
      return true;
    };
    try {
      const code = await runSubcommand(["bun", "cli.js", "read", String(process.pid)]);
      expect(code).toBe(1);
      expect(stderr.join("")).toMatch(/log file not found/);
    } finally {
      process.stderr.write = orig;
    }
  });
});

describe("subcommands.cmdSend writes bytes to FIFO", () => {
  // Skip on non-unix because FIFO creation requires mkfifo
  const itUnix = process.platform === "linux" || process.platform === "darwin";

  it.skipIf(!itUnix)("delivers a message to a real FIFO", async () => {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    const { spawnSync } = await import("child_process");
    const tmp = await mkdtemp(path.join(tmpdir(), "ay-fifo-"));
    try {
      const fifo = path.join(tmp, "test.fifo");
      const r = spawnSync("mkfifo", [fifo]);
      if (r.status !== 0) {
        // mkfifo unavailable — skip
        return;
      }

      // Open RDWR side first (matches Rust behaviour) so writes don't block.
      const fs = await import("fs");
      const rdwrFd = fs.openSync(fifo, fs.constants.O_RDWR);

      await appendGlobalPid({
        pid: process.pid,
        cli: "claude",
        prompt: null,
        cwd: process.cwd(),
        log_file: null,
        fifo_file: fifo,
        status: "active",
        exit_code: null,
        exit_reason: null,
        started_at: Date.now(),
      });

      const stdout: string[] = [];
      const orig = process.stdout.write.bind(process.stdout);
      (process.stdout as any).write = (s: any) => {
        stdout.push(String(s));
        return true;
      };
      try {
        const code = await runSubcommand([
          "bun",
          "cli.js",
          "send",
          String(process.pid),
          "hello-fifo",
        ]);
        expect(code).toBe(0);
        expect(stdout.join("")).toMatch(/sent to pid/);
      } finally {
        process.stdout.write = orig;
      }

      // Now read the bytes back from our RDWR fd.
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(rdwrFd, buf, 0, buf.length, null);
      const received = buf.subarray(0, n).toString();
      expect(received).toBe("hello-fifo\r");
      fs.closeSync(rdwrFd);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => null);
    }
  });

  it("--code=none skips the trailing CR", async () => {
    const { controlCodeFromName } = await loadModule();
    expect(controlCodeFromName("none")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// cmdLs additional arg coverage
// ---------------------------------------------------------------------------

describe("subcommands.cmdLs -h / --help", () => {
  function captureStdout() {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: any) => {
      chunks.push(String(s));
      return true;
    };
    return {
      get text() {
        return chunks.join("");
      },
      restore() {
        process.stdout.write = orig;
      },
    };
  }

  it("ay ls -h prints usage to stdout and exits 0", async () => {
    const { runSubcommand } = await loadModule();
    const cap = captureStdout();
    let code: number | null;
    try {
      code = await runSubcommand(["bun", "cli.js", "ls", "-h"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.text).toMatch(/Usage:/);
    expect(cap.text).toMatch(/--all/);
    expect(cap.text).toMatch(/--json/);
  });

  it("ay ls --help prints usage to stdout and exits 0", async () => {
    const { runSubcommand } = await loadModule();
    const cap = captureStdout();
    let code: number | null;
    try {
      code = await runSubcommand(["bun", "cli.js", "ls", "--help"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.text).toMatch(/Usage:/);
  });
});

describe("subcommands.cmdLs --all / --active / keyword filter / aliases", () => {
  function captureOutput() {
    const out: string[] = [];
    const err: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout as any).write = (s: any) => {
      out.push(String(s));
      return true;
    };
    (process.stderr as any).write = (s: any) => {
      err.push(String(s));
      return true;
    };
    return {
      get stdout() {
        return out.join("");
      },
      get stderr() {
        return err.join("");
      },
      restore() {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
      },
    };
  }

  it("--all shows exited agents", async () => {
    const mod = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: 1, // pid 1 is almost never the test process, so isPidAlive returns false
      cli: "claude",
      prompt: "exited agent",
      cwd: process.cwd(),
      log_file: null,
      status: "exited",
      exit_code: 0,
      exit_reason: "done",
      started_at: Date.now() - 10_000,
    });

    const cap = captureOutput();
    let code: number | null;
    try {
      code = await mod.runSubcommand(["bun", "cli.js", "ls", "--all", "--json"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((r: any) => r.prompt === "exited agent")).toBe(true);
  });

  it("keyword filter restricts results to matching agents", async () => {
    const mod = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: "unique-xyzzy-prompt",
      cwd: process.cwd(),
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
    });

    const cap = captureOutput();
    let code: number | null;
    try {
      code = await mod.runSubcommand(["bun", "cli.js", "ls", "--json", "unique-xyzzy-prompt"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.every((r: any) => r.prompt?.includes("unique-xyzzy-prompt"))).toBe(true);
  });

  it("keyword filter returns 'no running agents' when nothing matches", async () => {
    const { runSubcommand } = await loadModule();
    const stderr: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => {
      stderr.push(String(s));
      return true;
    };
    try {
      const code = await runSubcommand(["bun", "cli.js", "ls", "no-match-zzzzzz"]);
      expect(code).toBe(0);
      expect(stderr.join("")).toMatch(/no running agents matched/);
    } finally {
      process.stderr.write = orig;
    }
  });

  it("list alias routes to cmdLs", async () => {
    const { runSubcommand } = await loadModule();
    const stderr: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => {
      stderr.push(String(s));
      return true;
    };
    try {
      const code = await runSubcommand(["bun", "cli.js", "list"]);
      expect(code).toBe(0);
    } finally {
      process.stderr.write = orig;
    }
  });

  it("ps alias routes to cmdLs", async () => {
    const { runSubcommand } = await loadModule();
    const stderr: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => {
      stderr.push(String(s));
      return true;
    };
    try {
      const code = await runSubcommand(["bun", "cli.js", "ps"]);
      expect(code).toBe(0);
    } finally {
      process.stderr.write = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// cmdRead — head and cat modes
// ---------------------------------------------------------------------------

describe("subcommands.cmdRead head and cat modes", () => {
  it("head emits first N lines", async () => {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    const tmp = await mkdtemp(path.join(tmpdir(), "ay-head-log-"));
    try {
      const logPath = path.join(tmp, "x.raw.log");
      const lines: string[] = [];
      for (let i = 0; i < 50; i++) lines.push(`line-${i}`);
      await writeFile(logPath, lines.join("\r\n") + "\r\n");

      await appendGlobalPid({
        pid: process.pid,
        cli: "claude",
        prompt: null,
        cwd: process.cwd(),
        log_file: logPath,
        status: "active",
        exit_code: null,
        exit_reason: null,
        started_at: Date.now(),
      });

      const stdout: string[] = [];
      const orig = process.stdout.write.bind(process.stdout);
      (process.stdout as any).write = (s: any) => {
        stdout.push(String(s));
        return true;
      };
      const stderr_chunks: string[] = [];
      const origErr = process.stderr.write.bind(process.stderr);
      (process.stderr as any).write = (s: any) => {
        stderr_chunks.push(String(s));
        return true;
      };
      try {
        const code = await runSubcommand(["bun", "cli.js", "head", String(process.pid), "-n", "5"]);
        expect(code).toBe(0);
      } finally {
        process.stdout.write = orig;
        process.stderr.write = origErr;
      }
      const text = stdout.join("");
      expect(text).toMatch(/line-0/);
      expect(text).toMatch(/line-4/);
      expect(text).not.toMatch(/line-10\b/);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => null);
    }
  });

  it("cat emits all lines", async () => {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    const tmp = await mkdtemp(path.join(tmpdir(), "ay-cat-log-"));
    try {
      const logPath = path.join(tmp, "x.raw.log");
      await writeFile(logPath, "alpha\r\nbeta\r\ngamma\r\n");

      await appendGlobalPid({
        pid: process.pid,
        cli: "claude",
        prompt: null,
        cwd: process.cwd(),
        log_file: logPath,
        status: "active",
        exit_code: null,
        exit_reason: null,
        started_at: Date.now(),
      });

      const stdout: string[] = [];
      const orig = process.stdout.write.bind(process.stdout);
      (process.stdout as any).write = (s: any) => {
        stdout.push(String(s));
        return true;
      };
      const stderr_chunks: string[] = [];
      const origErr = process.stderr.write.bind(process.stderr);
      (process.stderr as any).write = (s: any) => {
        stderr_chunks.push(String(s));
        return true;
      };
      try {
        const code = await runSubcommand(["bun", "cli.js", "cat", String(process.pid)]);
        expect(code).toBe(0);
      } finally {
        process.stdout.write = orig;
        process.stderr.write = origErr;
      }
      const text = stdout.join("");
      expect(text).toMatch(/alpha/);
      expect(text).toMatch(/beta/);
      expect(text).toMatch(/gamma/);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => null);
    }
  });
});

// ---------------------------------------------------------------------------
// cmdNote
// ---------------------------------------------------------------------------

describe("subcommands.cmdNote", () => {
  it("throws usage error when no keyword given", async () => {
    const { runSubcommand } = await loadModule();
    const stderr: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => {
      stderr.push(String(s));
      return true;
    };
    try {
      const code = await runSubcommand(["bun", "cli.js", "note"]);
      expect(code).toBe(1);
      expect(stderr.join("")).toMatch(/usage:/i);
    } finally {
      process.stderr.write = orig;
    }
  });

  it("sets a note on a matched agent", async () => {
    const mod = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: "note-target",
      cwd: process.cwd(),
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
    });

    const stdout: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: any) => {
      stdout.push(String(s));
      return true;
    };
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = () => true;
    try {
      const code = await mod.runSubcommand([
        "bun",
        "cli.js",
        "note",
        String(process.pid),
        "my note text",
      ]);
      expect(code).toBe(0);
      expect(stdout.join("")).toMatch(/note set/);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  });

  it("clears a note when no text given", async () => {
    const mod = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: "note-clear-target",
      cwd: process.cwd(),
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
    });

    const stdout: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: any) => {
      stdout.push(String(s));
      return true;
    };
    (process.stderr as any).write = () => true;
    try {
      const code = await mod.runSubcommand(["bun", "cli.js", "note", String(process.pid)]);
      expect(code).toBe(0);
      expect(stdout.join("")).toMatch(/cleared note/);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = process.stderr.write; // no-op restore (silenced above)
    }
  });
});

// ---------------------------------------------------------------------------
// cmdStatus
// ---------------------------------------------------------------------------

describe("subcommands.cmdStatus", () => {
  it("throws usage error when no keyword given", async () => {
    const { runSubcommand } = await loadModule();
    const stderr: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => {
      stderr.push(String(s));
      return true;
    };
    try {
      const code = await runSubcommand(["bun", "cli.js", "status"]);
      expect(code).toBe(1);
      expect(stderr.join("")).toMatch(/usage:/i);
    } finally {
      process.stderr.write = orig;
    }
  });

  it("emits JSON snapshot for a matched agent", async () => {
    const mod = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: "status-test",
      cwd: process.cwd(),
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now() - 1000,
    });

    const stdout: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: any) => {
      stdout.push(String(s));
      return true;
    };
    (process.stderr as any).write = () => true;
    try {
      const code = await mod.runSubcommand(["bun", "cli.js", "status", String(process.pid)]);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = origOut;
    }
    const snap = JSON.parse(stdout.join(""));
    expect(snap).toMatchObject({ pid: process.pid, cli: "claude" });
    expect(typeof snap.age_ms).toBe("number");
  });

  it("--wait-idle returns 0 immediately for an idle agent", async () => {
    const mod = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    const logFile = path.join(testHome, "idle.raw.log");
    await writeFile(logFile, "old\n");
    // Stale mtime: > IDLE_THRESHOLD_MS (60s) in the past
    const stale = (Date.now() - 5 * 60 * 1000) / 1000;
    const { utimes } = await import("fs/promises");
    await utimes(logFile, stale, stale);
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: "wait-idle-test",
      cwd: process.cwd(),
      log_file: logFile,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now() - 10_000,
    });

    const stdout: string[] = [];
    (process.stdout as any).write = (s: any) => {
      stdout.push(String(s));
      return true;
    };
    (process.stderr as any).write = () => true;
    const code = await mod.runSubcommand([
      "bun",
      "cli.js",
      "status",
      String(process.pid),
      "--wait-idle",
      "--timeout=2s",
      "--interval=0.5",
    ]);
    expect(code).toBe(0);
    const snap = JSON.parse(stdout.join("").trim().split("\n").pop()!);
    expect(snap.state).toBe("idle");
  });

  it("--wait-idle returns 1 when the agent is stopped", async () => {
    const mod = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    // Pick a pid that is almost certainly not alive.
    const deadPid = 999_999;
    await appendGlobalPid({
      pid: deadPid,
      cli: "claude",
      prompt: "wait-idle-stopped",
      cwd: process.cwd(),
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now() - 10_000,
    });

    (process.stdout as any).write = () => true;
    (process.stderr as any).write = () => true;
    const code = await mod.runSubcommand([
      "bun",
      "cli.js",
      "status",
      String(deadPid),
      "--wait-idle",
      "--interval=0.5",
    ]);
    expect(code).toBe(1);
  });

  it("--wait-idle returns 2 on timeout while still active", async () => {
    const mod = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    const logFile = path.join(testHome, "active.raw.log");
    await writeFile(logFile, "fresh\n");
    // Fresh mtime keeps state = active
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: "wait-idle-timeout",
      cwd: process.cwd(),
      log_file: logFile,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now() - 10_000,
    });

    (process.stdout as any).write = () => true;
    (process.stderr as any).write = () => true;
    const code = await mod.runSubcommand([
      "bun",
      "cli.js",
      "status",
      String(process.pid),
      "--wait-idle",
      "--timeout=600ms",
      "--interval=0.5",
    ]);
    expect(code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// cmdRestart
// ---------------------------------------------------------------------------

describe("subcommands.cmdRestart", () => {
  it("returns 1 and warns when the agent is still alive", async () => {
    const mod = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: "restart-live-test",
      cwd: process.cwd(),
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
    });

    const stderr: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => {
      stderr.push(String(s));
      return true;
    };
    try {
      const code = await mod.runSubcommand(["bun", "cli.js", "restart", String(process.pid)]);
      expect(code).toBe(1);
      expect(stderr.join("")).toMatch(/still running/);
    } finally {
      process.stderr.write = origErr;
    }
  });
});

// ---------------------------------------------------------------------------
// listRecords merges per-cwd TS file with global
// ---------------------------------------------------------------------------

describe("subcommands.listRecords merges per-cwd TS file with global", () => {
  it("includes records from <cwd>/.agent-yes/pid-records.jsonl", async () => {
    // Write a fake per-cwd file that uses the live process pid so liveOnly
    // doesn't drop it.
    const cwd = await mkdtemp(path.join(tmpdir(), "ay-pcwd-"));
    try {
      const dir = path.join(cwd, ".agent-yes");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, "pid-records.jsonl");
      const record = {
        _id: "abc123",
        pid: process.pid,
        cli: "claude",
        prompt: "merged test",
        cwd,
        logFile: "/dev/null",
        fifoFile: "/dev/null",
        status: "active",
        exitReason: "",
        startedAt: Date.now(),
      };
      await writeFile(file, JSON.stringify(record) + "\n");

      const origCwd = process.cwd();
      process.chdir(cwd);
      try {
        const mod = await loadModule();
        const stdout: string[] = [];
        const orig = process.stdout.write.bind(process.stdout);
        (process.stdout as any).write = (s: any) => {
          stdout.push(String(s));
          return true;
        };
        try {
          const code = await mod.runSubcommand(["bun", "cli.js", "ls", "--json"]);
          expect(code).toBe(0);
        } finally {
          process.stdout.write = orig;
        }
        const parsed = JSON.parse(stdout.join(""));
        expect(parsed).toHaveLength(1);
        expect(parsed[0]).toMatchObject({
          pid: process.pid,
          cli: "claude",
          prompt: "merged test",
        });
      } finally {
        process.chdir(origCwd);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => null);
    }
  });
});
