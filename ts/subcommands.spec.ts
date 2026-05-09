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

describe("subcommands.parseArgs", () => {
  it("collects positional args and bare flags", async () => {
    const { parseArgs } = await loadModule();
    const out = parseArgs(["foo", "bar", "--all"]);
    expect(out.positional).toEqual(["foo", "bar"]);
    expect(out.flags.all).toBe(true);
  });

  it("parses --key=value form", async () => {
    const { parseArgs } = await loadModule();
    const out = parseArgs(["--code=enter"]);
    expect(out.flags.code).toBe("enter");
  });

  it("parses --key value form for non-boolean keys", async () => {
    const { parseArgs } = await loadModule();
    const out = parseArgs(["--cwd", "/tmp/foo"]);
    expect(out.flags.cwd).toBe("/tmp/foo");
  });

  it("treats well-known boolean flags as boolean even with a following positional", async () => {
    const { parseArgs } = await loadModule();
    const out = parseArgs(["--all", "claude"]);
    expect(out.flags.all).toBe(true);
    expect(out.positional).toEqual(["claude"]);
  });

  it("supports -n N short form", async () => {
    const { parseArgs } = await loadModule();
    const out = parseArgs(["-n", "50", "keyword"]);
    expect(out.flags.n).toBe("50");
    expect(out.positional).toEqual(["keyword"]);
  });
});

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
      expect(stderr.join("")).toMatch(/no running agent matched/);
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
    expect(cap.text).toMatch(/PID\s+CLI\s+STATUS\s+AGE\s+CWD\s+PROMPT/);
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
