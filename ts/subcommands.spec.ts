import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "fs/promises";
import { appendFileSync } from "fs";
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
    expect(controlCodeFromName("ctrl-\\")).toBe("\x1c");
    expect(controlCodeFromName("ctrl-backslash")).toBe("\x1c");
    expect(controlCodeFromName("tab")).toBe("\t");
    expect(controlCodeFromName("none")).toBe("");
    expect(controlCodeFromName("")).toBe("");
  });

  it("maps navigation keys to their ANSI sequences (for ay key / ay select)", async () => {
    const { controlCodeFromName } = await loadModule();
    expect(controlCodeFromName("up")).toBe("\x1b[A");
    expect(controlCodeFromName("down")).toBe("\x1b[B");
    expect(controlCodeFromName("right")).toBe("\x1b[C");
    expect(controlCodeFromName("left")).toBe("\x1b[D");
    expect(controlCodeFromName("space")).toBe(" ");
    expect(controlCodeFromName("backspace")).toBe("\x7f");
    expect(controlCodeFromName("pageup")).toBe("\x1b[5~");
    expect(controlCodeFromName("pagedown")).toBe("\x1b[6~");
  });

  it("supports raw:0xNN escape", async () => {
    const { controlCodeFromName } = await loadModule();
    expect(controlCodeFromName("raw:0x03")).toBe("\x03");
    expect(controlCodeFromName("raw:0x1b")).toBe("\x1b");
  });

  it("throws on unknown code names", async () => {
    const { controlCodeFromName } = await loadModule();
    expect(() => controlCodeFromName("nope")).toThrow(/unknown key\/code/);
  });
});

describe("subcommands.menuSelectKeys (ay select cursor arithmetic)", () => {
  it("sends Downs + Enter to reach an option below the cursor", async () => {
    const { menuSelectKeys } = await loadModule();
    expect(menuSelectKeys(1, 3)).toEqual(["down", "down", "enter"]);
  });
  it("sends Ups + Enter to reach an option above the cursor", async () => {
    const { menuSelectKeys } = await loadModule();
    expect(menuSelectKeys(3, 1)).toEqual(["up", "up", "enter"]);
  });
  it("sends only Enter when the cursor already sits on the target", async () => {
    const { menuSelectKeys } = await loadModule();
    expect(menuSelectKeys(2, 2)).toEqual(["enter"]);
  });
  it("encodes to the exact ANSI byte stream via controlCodeFromName", async () => {
    const { menuSelectKeys, controlCodeFromName } = await loadModule();
    const bytes = menuSelectKeys(2, 4).map((k) => controlCodeFromName(k));
    expect(bytes.join("")).toBe("\x1b[B\x1b[B\r"); // down, down, enter
  });
});

describe("subcommands.isSubcommand", () => {
  it("recognises attach and stop alongside the existing subcommands", async () => {
    const { isSubcommand } = await loadModule();
    expect(isSubcommand("attach")).toBe(true);
    expect(isSubcommand("stop")).toBe(true);
    expect(isSubcommand("tail")).toBe(true);
    expect(isSubcommand("send")).toBe(true);
    expect(isSubcommand("not-a-command")).toBe(false);
    expect(isSubcommand(undefined)).toBe(false);
  });

  it("gates manager-only `setup` on the generic manager, not cli-bound aliases", async () => {
    const { isSubcommand } = await loadModule();
    // `ay setup` (managerCommands defaults to true) → a subcommand.
    expect(isSubcommand("setup")).toBe(true);
    expect(isSubcommand("setup", true)).toBe(true);
    // `cy setup` (cli-bound alias) → NOT a subcommand, so it falls through to
    // running claude with that text.
    expect(isSubcommand("setup", false)).toBe(false);
    // Inspection subcommands stay universal — `cy ls` / `cy send` still work.
    expect(isSubcommand("ls", false)).toBe(true);
    expect(isSubcommand("send", false)).toBe(true);
  });
});

describe("subcommands.cmdHelp", () => {
  const capture = async (managerCommands?: boolean) => {
    const { cmdHelp } = await loadModule();
    let out = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
      out += String(s);
      return true;
    });
    try {
      await cmdHelp(managerCommands);
    } finally {
      spy.mockRestore();
    }
    return out;
  };

  it("hides the manager-only `setup` line for cli-bound aliases", async () => {
    expect(await capture(true)).toContain("ay setup"); // manager
    expect(await capture()).toContain("ay setup"); // default = manager
    expect(await capture(false)).not.toContain("ay setup"); // cli-bound alias (cy)
    expect(await capture(false)).toContain("ay ls"); // universal commands still shown
  });

  it("stays plain for a human shell (no AGENT_YES_PID)", async () => {
    const out = await capture();
    expect(out).not.toContain("You are running inside an agent");
  });

  it("prints self + parent identity and sub-agent guidance when nested in an agent", async () => {
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    const parentWrapperPid = 555001;
    const selfWrapperPid = 555002;
    await appendGlobalPid({
      pid: 900001,
      cli: "codex",
      prompt: "orchestrate the migration",
      cwd: "/work/parent",
      log_file: null,
      fifo_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
      wrapper_pid: parentWrapperPid,
    });
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: "fix the failing test",
      cwd: "/work/parent/child",
      log_file: null,
      fifo_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
      wrapper_pid: selfWrapperPid,
      parent_pid: parentWrapperPid,
    });
    const saved = process.env.AGENT_YES_PID;
    process.env.AGENT_YES_PID = String(selfWrapperPid);
    try {
      const out = await capture();
      expect(out).toContain("You are running inside an agent");
      expect(out).toContain(`You are agent pid ${process.pid} (claude)`);
      expect(out).toContain(`Spawned by agent pid 900001 (codex)`);
      expect(out).toContain("Spawn a sub-agent");
      expect(out).toContain(`ay ls --cwd /work/parent/child`);
      expect(out).toContain(`ay ls --watch --cwd /work/parent/child`);
    } finally {
      if (saved === undefined) delete process.env.AGENT_YES_PID;
      else process.env.AGENT_YES_PID = saved;
    }
  });

  it("reports a nested-but-unresolved parent distinctly from top-level", async () => {
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    const selfWrapperPid = 555004;
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: null,
      cwd: process.cwd(),
      log_file: null,
      fifo_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
      wrapper_pid: selfWrapperPid,
      parent_pid: 999999999, // no record ever registered for this wrapper pid
    });
    const saved = process.env.AGENT_YES_PID;
    process.env.AGENT_YES_PID = String(selfWrapperPid);
    try {
      const out = await capture();
      expect(out).not.toContain("Top-level agent");
      expect(out).toContain("Nested under a parent (wrapper pid 999999999)");
    } finally {
      if (saved === undefined) delete process.env.AGENT_YES_PID;
      else process.env.AGENT_YES_PID = saved;
    }
  });

  it("reports top-level (no parent) when parent_pid is absent", async () => {
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    const selfWrapperPid = 555003;
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: null,
      cwd: process.cwd(),
      log_file: null,
      fifo_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
      wrapper_pid: selfWrapperPid,
    });
    const saved = process.env.AGENT_YES_PID;
    process.env.AGENT_YES_PID = String(selfWrapperPid);
    try {
      const out = await capture();
      expect(out).toContain("Top-level agent");
    } finally {
      if (saved === undefined) delete process.env.AGENT_YES_PID;
      else process.env.AGENT_YES_PID = saved;
    }
  });
});

describe("subcommands.stopTipForCli", () => {
  it("returns a hint for CLIs that ignore single Ctrl+C", async () => {
    const { stopTipForCli } = await loadModule();
    expect(stopTipForCli("claude", 1234)).toMatch(/ay stop 1234/);
    expect(stopTipForCli("claude", 1234)).toMatch(/\/exit/);
    expect(stopTipForCli("codex", 99)).toMatch(/ay stop 99/);
    expect(stopTipForCli("gemini", 7)).toMatch(/\/quit/);
  });

  it("returns null for CLIs without a known graceful command", async () => {
    const { stopTipForCli } = await loadModule();
    expect(stopTipForCli("qwen", 1)).toBeNull();
    expect(stopTipForCli("copilot", 1)).toBeNull();
  });
});

describe("subcommands.GRACEFUL_EXIT_COMMANDS", () => {
  it("maps the three known CLIs to their /exit-style commands", async () => {
    const { GRACEFUL_EXIT_COMMANDS } = await loadModule();
    expect(GRACEFUL_EXIT_COMMANDS["claude"]).toBe("/exit");
    expect(GRACEFUL_EXIT_COMMANDS["codex"]).toBe("/exit");
    expect(GRACEFUL_EXIT_COMMANDS["gemini"]).toBe("/quit");
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

  it("treats a numeric keyword as an identity selector (pid or agent_id prefix, no cwd/prompt match)", async () => {
    const { matchKeyword } = await loadModule();
    // pid mentioned inside another agent's prompt/cwd must NOT match by number.
    const r = {
      ...baseRecord,
      pid: 5678,
      prompt: "investigating crash in pid 1234",
      cwd: "/v1/code/proj-1234",
    };
    expect(matchKeyword(r, "1234")).toBe(false); // not this agent's pid, despite cwd/prompt mentions
    expect(matchKeyword(r, "5678")).toBe(true); // its actual pid
    // an all-digit agent_id prefix still resolves (ids are random hex).
    const idr = { ...baseRecord, pid: 5678, agent_id: "206812abcdef" };
    expect(matchKeyword(idr, "206812")).toBe(true); // agent_id prefix
    expect(matchKeyword(idr, "5678")).toBe(true); // pid still wins too
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

  it("matches by agent_id prefix", async () => {
    const { matchKeyword } = await loadModule();
    const r = { ...baseRecord, agent_id: "a1b2c3d4e5f6" };
    expect(matchKeyword(r, "a1b2c3d4e5f6")).toBe(true); // full id
    expect(matchKeyword(r, "a1b2c3")).toBe(true); // prefix
    expect(matchKeyword(r, "A1B2C3")).toBe(true); // case-insensitive
    expect(matchKeyword(r, "b2c3")).toBe(false); // not a prefix (mid-string)
    expect(matchKeyword({ ...baseRecord, agent_id: null }, "a1b2")).toBe(false);
  });
});

describe("subcommands.resolveOne exact-identity precedence", () => {
  const opts = { all: false, active: false, json: true, latest: true, cwdScope: null };

  // Regression for the `/w/#room:206812` deep link rendering a sibling's terminal:
  // sharing the URL pastes the pid into other agents' prompts, so a bare pid
  // lookup fuzzily matched them too and the newest-first tiebreak won. Exact pid
  // must beat prompt-substring collisions.
  it("returns the agent whose pid IS the keyword over newer prompt-substring matches", async () => {
    const { resolveOne } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    const now = Date.now();
    const base = {
      cwd: process.cwd(),
      log_file: null,
      status: "active" as const,
      exit_code: null,
      exit_reason: null,
    };
    // The real target — oldest.
    await appendGlobalPid({
      ...base,
      pid: 206812,
      cli: "codex",
      prompt: "do the thing",
      started_at: now - 60_000,
    });
    // Two newer claudes whose prompt embeds the share URL containing "206812".
    await appendGlobalPid({
      ...base,
      pid: 265959,
      cli: "claude",
      prompt: "https://agent-yes.com/w/#r2d058f:206812 is codex agent but renders claude",
      started_at: now - 2_000,
    });
    await appendGlobalPid({
      ...base,
      pid: 239973,
      cli: "claude",
      prompt: "look at https://agent-yes.com/w/#r2d058f:206812",
      started_at: now - 6_000,
    });

    const record = await resolveOne("206812", opts);
    expect(record.pid).toBe(206812);
    expect(record.cli).toBe("codex");
  });

  it("returns the agent whose agent_id IS the keyword over prompt-substring matches", async () => {
    const { resolveOne } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    const now = Date.now();
    const base = {
      cwd: process.cwd(),
      log_file: null,
      status: "active" as const,
      exit_code: null,
      exit_reason: null,
    };
    await appendGlobalPid({
      ...base,
      pid: 111,
      cli: "codex",
      prompt: "target",
      agent_id: "a1b2c3d4e5f6",
      started_at: now - 60_000,
    });
    await appendGlobalPid({
      ...base,
      pid: 222,
      cli: "claude",
      prompt: "mentions a1b2c3d4e5f6 in passing",
      started_at: now - 1_000,
    });

    const record = await resolveOne("a1b2c3d4e5f6", opts);
    expect(record.pid).toBe(111);
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

  it("--local forces the rich local-only table (AGE column, no HOST column)", async () => {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: "local only please",
      cwd: process.cwd(),
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now() - 5000,
    });
    const cap = captureStdout();
    try {
      const code = await runSubcommand(["bun", "cli.js", "ls", "--local"]);
      expect(code).toBe(0);
    } finally {
      cap.restore();
    }
    // The local table has an AGE column under NOTE/PROMPT; the aggregated remote
    // table has a HOST column and no AGE. --local must pick the former.
    expect(cap.text).toMatch(/PID\s+CLI\s+STATUS\s+AGE\s+CWD\s+NOTE\/PROMPT/);
    expect(cap.text).not.toMatch(/^HOST\s/m);
    expect(cap.text).toMatch(new RegExp(`${process.pid}\\s`));
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

// The plain (pipe/script) follow mode emits a line only once the cursor has
// moved off it, so in-place redraws (spinners, progress bars, TUI repaints) stay
// out of the stream. finalizedLines() is that rule; drive it with a real
// @xterm/headless terminal so the assertions reflect actual PTY semantics.
describe("subcommands.finalizedLines (plain follow line discipline)", () => {
  async function newTerm() {
    const { Terminal } = await import("@xterm/headless");
    return new Terminal({ cols: 80, rows: 10, scrollback: 1000, allowProposedApi: true });
  }
  const feed = (term: any, s: string) =>
    new Promise<void>((r) => term.write(new TextEncoder().encode(s), () => r()));

  it("emits newline-finalized lines and suppresses in-place redraws", async () => {
    const { finalizedLines, cursorAbs } = await loadModule();
    const term = await newTerm();

    await feed(term, "line A\r\nline B\r\n");
    // Cursor is now on the empty row 2; rows 0–1 are finalized.
    expect(finalizedLines(term as any, 0)).toEqual(["line A", "line B"]);

    // A spinner rewrites the current row in place (CR, no newline) — not finalized.
    let mark = cursorAbs(term as any);
    await feed(term, "\x1b[33mWorking |\x1b[0m");
    expect(finalizedLines(term as any, mark)).toEqual([]);
    await feed(term, "\rWorking /"); // redraw same row
    expect(finalizedLines(term as any, mark)).toEqual([]);

    // Once the line is overwritten with real content AND terminated, it commits.
    await feed(term, "\rdownload complete\r\n");
    expect(finalizedLines(term as any, mark)).toEqual(["download complete"]);

    // Advancing the high-water mark, nothing new is finalized until more arrives.
    mark = cursorAbs(term as any);
    expect(finalizedLines(term as any, mark)).toEqual([]);
    await feed(term, "next line\r\n");
    expect(finalizedLines(term as any, mark)).toEqual(["next line"]);
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
      // Isolate from the send-safety guard: if the suite itself runs inside an
      // ay-managed agent, AGENT_YES_PID would make cmdSend treat this as an agent
      // sender (adding a "from …" prefix / blocking). Force-send to test pure
      // byte delivery. --force keeps the agent prefix off only when no agent
      // context resolves, so also clear AGENT_YES_PID for determinism.
      const savedAyPid = process.env.AGENT_YES_PID;
      delete process.env.AGENT_YES_PID;
      try {
        const code = await runSubcommand([
          "bun",
          "cli.js",
          "send",
          String(process.pid),
          "hello-fifo",
          "--force",
        ]);
        expect(code).toBe(0);
        expect(stdout.join("")).toMatch(/sent to pid/);
      } finally {
        process.stdout.write = orig;
        if (savedAyPid !== undefined) process.env.AGENT_YES_PID = savedAyPid;
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

  it.skipIf(!itUnix)(
    "routes a bare 'exit' to the graceful /exit, not the literal word",
    async () => {
      const { runSubcommand } = await loadModule();
      const { appendGlobalPid } = await import("./globalPidIndex.ts");
      const { spawnSync } = await import("child_process");
      const tmp = await mkdtemp(path.join(tmpdir(), "ay-fifo-"));
      try {
        const fifo = path.join(tmp, "exit.fifo");
        if (spawnSync("mkfifo", [fifo]).status !== 0) return;
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
        (process.stdout as any).write = (s: any) => (stdout.push(String(s)), true);
        const savedAyPid = process.env.AGENT_YES_PID;
        delete process.env.AGENT_YES_PID;
        try {
          const code = await runSubcommand([
            "bun",
            "cli.js",
            "send",
            String(process.pid),
            "exit",
            "--force",
          ]);
          expect(code).toBe(0);
          expect(stdout.join("")).toMatch(/exit requested/);
        } finally {
          process.stdout.write = orig;
          if (savedAyPid !== undefined) process.env.AGENT_YES_PID = savedAyPid;
        }
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(rdwrFd, buf, 0, buf.length, null);
        // The real `/exit` command + Enter — NOT the literal "exit\r" that claude ignores.
        expect(buf.subarray(0, n).toString()).toBe("/exit\r");
        fs.closeSync(rdwrFd);
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => null);
      }
    },
  );
});

describe("subcommands.isExitRequest", () => {
  it("matches the bare exit word and the literal /exit (any case, trimmed)", async () => {
    const { isExitRequest } = await loadModule();
    for (const s of ["exit", "/exit", "  exit ", "EXIT", "/Exit", "\nexit\n"]) {
      expect(isExitRequest(s)).toBe(true);
    }
  });
  it("does NOT match a sentence that merely contains 'exit'", async () => {
    const { isExitRequest } = await loadModule();
    for (const s of [
      "please exit now",
      "exit the loop after step 3",
      "do not exit",
      "exiting",
      "",
    ]) {
      expect(isExitRequest(s)).toBe(false);
    }
  });
});

describe("subcommands.isSlashCommand", () => {
  it("matches a body that starts with a slash command (so it is sent unprefixed)", async () => {
    const { isSlashCommand } = await loadModule();
    for (const s of ["/compact", "/clear", "/model sonnet", "/resume\nmore text"]) {
      expect(isSlashCommand(s)).toBe(true);
    }
  });
  it("does NOT match plain prose, or a slash not at column 0", async () => {
    const { isSlashCommand } = await loadModule();
    for (const s of [
      "please run /compact",
      " /compact", // leading space — the CLI won't parse it as a command either
      "//two slashes... wait, no letter after first slash",
      "/ ",
      "hello",
      "",
    ]) {
      expect(isSlashCommand(s)).toBe(false);
    }
  });
});

describe("subcommands.waitForLogQuiet", () => {
  it("resolves once writes to the file stop for quietMs, with the final size", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ay-quiet-"));
    try {
      const log = path.join(dir, "a.log");
      await writeFile(log, "hello");
      const { waitForLogQuiet } = await loadModule();
      const size = await waitForLogQuiet(log, 50, 500);
      expect(size).toBe(5);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  });

  it("returns the last observed size when maxWaitMs elapses without ever going quiet", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ay-quiet-"));
    try {
      const log = path.join(dir, "a.log");
      await writeFile(log, "x");
      const timer = setInterval(() => {
        appendFileSync(log, "x");
      }, 20);
      try {
        const { waitForLogQuiet } = await loadModule();
        const start = Date.now();
        const size = await waitForLogQuiet(log, 50, 200);
        expect(Date.now() - start).toBeGreaterThanOrEqual(190); // hit the cap, not the quiet window
        expect(size).toBeGreaterThan(0);
      } finally {
        clearInterval(timer);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  });

  it("returns null when the file can't be stat'd", async () => {
    const { waitForLogQuiet } = await loadModule();
    expect(await waitForLogQuiet("/no/such/file/here", 50, 200)).toBeNull();
  });
});

describe("subcommands.submitAndConfirm (ay send swallowed-Enter fix)", () => {
  const itUnix = process.platform === "linux" || process.platform === "darwin";
  // claude's shipped `working` busy marker — matches cliDefaults()["claude"].working.
  const BUSY = "⏺ Cogitating…\r\nesc to interrupt · ← for agents\r\n";
  const IDLE = "❯ some leftover unsent text\r\n"; // no busy marker, never changes

  const rec = (over: any) => ({
    pid: process.pid,
    cli: "claude",
    prompt: null,
    cwd: "/tmp",
    log_file: null,
    fifo_file: null,
    status: "active",
    exit_code: null,
    exit_reason: null,
    started_at: 0,
    ...over,
  });

  async function withFifo(fn: (fifo: string) => Promise<void>) {
    const { spawnSync } = await import("child_process");
    const dir = await mkdtemp(path.join(tmpdir(), "ay-confirm-"));
    const fifo = path.join(dir, "test.fifo");
    try {
      const r = spawnSync("mkfifo", [fifo]);
      if (r.status !== 0) return; // mkfifo unavailable — skip
      const fs = await import("fs");
      const rdwrFd = fs.openSync(fifo, fs.constants.O_RDWR); // keeps writes from blocking
      try {
        await fn(fifo);
      } finally {
        fs.closeSync(rdwrFd);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  }

  it.skipIf(!itUnix)(
    "confirms on the first attempt when the busy marker newly appears after sending",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "ay-confirm-log-"));
      try {
        const log = path.join(dir, "a.log");
        await writeFile(log, "❯ \r\n"); // idle — no busy marker yet
        const { submitAndConfirm } = await loadModule();
        await withFifo(async (fifo) => {
          // The Enter kicks off work: the busy marker appears shortly after,
          // well within the confirm window — a genuine idle→busy transition.
          setTimeout(() => appendFileSync(log, BUSY), 100);
          const { confirmed, screen } = await submitAndConfirm(rec({ log_file: log }), fifo, "\r");
          expect(confirmed).toBe(true);
          expect(screen.join("\n")).toContain("esc to interrupt");
        });
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
  );

  it.skipIf(!itUnix)(
    "does NOT confirm from a busy marker that was already on screen before sending (false-positive guard)",
    async () => {
      // A screen already showing "esc to interrupt" (busy from whatever the agent
      // was already doing) proves nothing about whether THIS Enter landed — e.g.
      // it could be sitting queued, unsubmitted, behind an unrelated in-flight
      // turn. Static and unchanging (no growth either), so this must NOT confirm.
      const dir = await mkdtemp(path.join(tmpdir(), "ay-confirm-log-"));
      try {
        const log = path.join(dir, "a.log");
        await writeFile(log, BUSY);
        const { submitAndConfirm } = await loadModule();
        await withFifo(async (fifo) => {
          const { confirmed } = await submitAndConfirm(rec({ log_file: log }), fifo, "\r");
          expect(confirmed).toBe(false);
        });
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
    10_000,
  );

  it.skipIf(!itUnix)("confirms via log growth even without a recognized busy marker", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ay-confirm-log-"));
    try {
      const log = path.join(dir, "a.log");
      await writeFile(log, "❯ \r\n");
      const { submitAndConfirm } = await loadModule();
      await withFifo(async (fifo) => {
        // Simulate the CLI starting to respond shortly after Enter lands — well
        // within the first attempt's confirm window.
        setTimeout(() => appendFileSync(log, "some real response text appears here\r\n"), 100);
        const { confirmed } = await submitAndConfirm(rec({ log_file: log }), fifo, "\r");
        expect(confirmed).toBe(true);
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  });

  it.skipIf(!itUnix)(
    "gives up after exhausting retries when the Enter is swallowed (screen never changes)",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "ay-confirm-log-"));
      try {
        const log = path.join(dir, "a.log");
        await writeFile(log, IDLE); // never touched again — nothing to confirm
        const { submitAndConfirm } = await loadModule();
        await withFifo(async (fifo) => {
          const { confirmed, screen } = await submitAndConfirm(rec({ log_file: log }), fifo, "\r");
          expect(confirmed).toBe(false);
          expect(screen.join("\n")).toContain("leftover unsent text");
        });
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
    10_000,
  );
});

describe("subcommands.cmdSend end-to-end submit-confirm wiring", () => {
  const itUnix = process.platform === "linux" || process.platform === "darwin";
  const BUSY = "⏺ Cogitating…\r\nesc to interrupt · ← for agents\r\n";

  // A background drain so cmdSend's writes to the FIFO never block, mirroring
  // the "delivers a message to a real FIFO" setup above.
  async function withDrainedFifo(fn: (fifo: string) => Promise<void>) {
    const { spawnSync } = await import("child_process");
    const dir = await mkdtemp(path.join(tmpdir(), "ay-send-e2e-"));
    const fifo = path.join(dir, "test.fifo");
    try {
      if (spawnSync("mkfifo", [fifo]).status !== 0) return; // mkfifo unavailable — skip
      const fs = await import("fs");
      const rdwrFd = fs.openSync(fifo, fs.constants.O_RDWR);
      const drain = setInterval(() => {
        try {
          fs.readSync(rdwrFd, Buffer.alloc(4096), 0, 4096, null);
        } catch {
          /* EAGAIN or similar — nothing pending, ignore */
        }
      }, 20);
      try {
        await fn(fifo);
      } finally {
        clearInterval(drain);
        fs.closeSync(rdwrFd);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  }

  async function send(fifo: string, log: string, body: string, extraArgs: string[] = []) {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: null,
      cwd: process.cwd(),
      log_file: log,
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
    const savedAyPid = process.env.AGENT_YES_PID;
    delete process.env.AGENT_YES_PID; // isolate from the send-safety guard, as above
    try {
      const code = await runSubcommand([
        "bun",
        "cli.js",
        "send",
        String(process.pid),
        body,
        "--force",
        ...extraArgs,
      ]);
      return { code, stdout: stdout.join("") };
    } finally {
      process.stdout.write = orig;
      if (savedAyPid !== undefined) process.env.AGENT_YES_PID = savedAyPid;
    }
  }

  it.skipIf(!itUnix)(
    "exits 0 and reports 'sent' when the busy marker confirms submission",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "ay-send-e2e-log-"));
      try {
        const log = path.join(dir, "a.log");
        await writeFile(log, BUSY); // already showing "working" — settles + confirms immediately
        await withDrainedFifo(async (fifo) => {
          const { code, stdout } = await send(fifo, log, "hello");
          expect(code).toBe(0);
          expect(stdout).toMatch(/^sent to pid/);
          expect(stdout).not.toMatch(/NOT confirmed/);
        });
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
  );

  it.skipIf(!itUnix)(
    "exits non-zero and reports the leftover screen when submission can't be confirmed",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "ay-send-e2e-log-"));
      try {
        const log = path.join(dir, "a.log");
        await writeFile(log, "❯ \r\n"); // stays this way — nothing ever confirms
        await withDrainedFifo(async (fifo) => {
          const { code, stdout } = await send(fifo, log, "hello");
          expect(code).toBe(1);
          expect(stdout).toMatch(/NOT confirmed/);
        });
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
    10_000,
  );

  it.skipIf(!itUnix)(
    "applies submit-confirm for --code=cr too, not just the default --code=enter",
    async () => {
      // canConfirm gates on the resolved trailing byte, not the code NAME, so
      // every alias that resolves to Enter must go through the same confirm
      // path — regression test for that alias-vs-byte gap.
      const dir = await mkdtemp(path.join(tmpdir(), "ay-send-e2e-log-"));
      try {
        const log = path.join(dir, "a.log");
        await writeFile(log, "❯ \r\n"); // never confirms — nothing ever changes
        await withDrainedFifo(async (fifo) => {
          const { code, stdout } = await send(fifo, log, "hello", ["--code=cr"]);
          expect(code).toBe(1);
          expect(stdout).toMatch(/NOT confirmed/);
        });
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
    10_000,
  );

  it.skipIf(!itUnix)("--no-wait skips confirmation entirely and always exits 0", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ay-send-e2e-log-"));
    try {
      const log = path.join(dir, "a.log");
      await writeFile(log, "❯ \r\n"); // would fail to confirm if checked — but we opt out
      await withDrainedFifo(async (fifo) => {
        const start = Date.now();
        const { code, stdout } = await send(fifo, log, "hello", ["--no-wait"]);
        expect(code).toBe(0);
        expect(stdout).not.toMatch(/NOT confirmed/);
        expect(Date.now() - start).toBeLessThan(1000); // fast — no settle/confirm polling
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  });
});

describe("subcommands.writeToIpc reliable delivery", () => {
  const itUnix = process.platform === "linux" || process.platform === "darwin";

  it.skipIf(!itUnix)(
    "delivers a payload larger than the FIFO buffer to a slow reader",
    async () => {
      const { writeToIpc } = await loadModule();
      const { spawnSync } = await import("child_process");
      const fs = await import("fs");
      const tmp = await mkdtemp(path.join(tmpdir(), "ay-ipc-"));
      try {
        const fifo = path.join(tmp, "big.fifo");
        if (spawnSync("mkfifo", [fifo]).status !== 0) return;
        // Reader present (so open() doesn't ENXIO) but draining slowly, in small
        // chunks on a timer — this backs the ~8KB kernel buffer up and makes the
        // old single non-blocking writeFileSync EAGAIN/truncate.
        const rfd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        const chunks: Buffer[] = [];
        const drain = setInterval(() => {
          const b = Buffer.alloc(1000);
          try {
            const n = fs.readSync(rfd, b, 0, b.length, null);
            if (n > 0) chunks.push(Buffer.from(b.subarray(0, n)));
          } catch {
            /* EAGAIN when momentarily empty */
          }
        }, 5);
        try {
          // 50KB >> the FIFO buffer: forces many partial writes + EAGAIN retries.
          const payload = "abcdefghij".repeat(5000);
          await writeToIpc(fifo, payload);
          // Let the drainer flush whatever is still buffered.
          const deadline = Date.now() + 3000;
          while (Buffer.concat(chunks).length < payload.length && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
          }
          expect(Buffer.concat(chunks).toString("utf8")).toBe(payload);
        } finally {
          clearInterval(drain);
          fs.closeSync(rfd);
        }
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => null);
      }
    },
  );
});

describe("subcommands.cmdSend safety guards", () => {
  it("maps AGENT_YES_PID→wrapper_pid and blocks an agent from sending to itself", async () => {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    // We register an agent whose wrapper_pid is a known value, then run `ay send`
    // with AGENT_YES_PID set to that wrapper — so resolveSender maps it back to
    // this same agent, and sending to its own pid trips the self-send guard.
    const wrapperPid = 424242;
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: null,
      cwd: process.cwd(),
      log_file: null,
      fifo_file: "/tmp/ay-guard-test.fifo",
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
      wrapper_pid: wrapperPid,
    });
    const stderr: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => {
      stderr.push(String(s));
      return true;
    };
    const savedAyPid = process.env.AGENT_YES_PID;
    process.env.AGENT_YES_PID = String(wrapperPid);
    try {
      const code = await runSubcommand(["bun", "cli.js", "send", String(process.pid), "loop?"]);
      expect(code).toBe(1);
      expect(stderr.join("")).toMatch(/refusing to send to yourself/);
    } finally {
      process.stderr.write = orig;
      if (savedAyPid === undefined) delete process.env.AGENT_YES_PID;
      else process.env.AGENT_YES_PID = savedAyPid;
    }
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

  it("--json surfaces the Rust unresponsive flag as state 'stuck'", async () => {
    const mod = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: process.pid, // alive → not "stopped"
      cli: "claude",
      prompt: "wedged-agent-probe",
      cwd: process.cwd(),
      log_file: null,
      status: "active",
      unresponsive: true,
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
    });
    const cap = captureOutput();
    let code: number | null;
    try {
      code = await mod.runSubcommand(["bun", "cli.js", "ls", "--json"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const row = JSON.parse(cap.stdout).find((r: any) => r.prompt === "wedged-agent-probe");
    expect(row?.state).toBe("stuck");
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
  // A live agent is now stopped-then-resumed. With no fifo_file the graceful
  // stop can't be sent, so it errors out *before* any kill — which also proves
  // the live test process (used as the fake pid) is never signalled.
  it("returns 1 when a live agent can't be gracefully stopped (no fifo_file)", async () => {
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
      expect(stderr.join("")).toMatch(/no fifo_file/);
    } finally {
      process.stderr.write = origErr;
    }
    // The live process must still be alive — restart must not have killed it.
    // (signal 0 throws only if the pid is gone / not signalable.)
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  // The post-restart hint must NOT print a pid (the resumed agent's pid races and
  // resolves to "no agent matched" — the reported "restart not working"). It must
  // instead key `ay tail` on the cwd, which is the one stable handle at this point.
  it("restartHintLines keys the watch hint on cwd, never a pid", async () => {
    const mod = await loadModule();
    const cwd = "/Users/x/ws/proj/tree/docs";
    const { out, err } = mod.restartHintLines("claude", cwd, "restoreArgs (--continue)");
    expect(out).toMatch(/restarted claude in/);
    expect(out).not.toMatch(/new pid/); // the old, broken phrasing
    // `ay tail -f <cwd>` — a substring of the agent's absolute cwd, so it resolves
    // regardless of which pid the resume settles on.
    expect(err).toMatch(/ay tail -f \/Users\/x\/ws\/proj\/tree\/docs/);
    expect(err).toMatch(/ay ls/);
    // No bare numeric pid anywhere in the hint.
    expect(`${out}${err}`).not.toMatch(/\bpid \d+/);
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

describe("subcommands.resolveReadWindow", () => {
  const total = 100;

  it("defaults: tail = last 96, head = first 96, cat = all", async () => {
    const { resolveReadWindow } = await loadModule();
    expect(resolveReadWindow({ total: 200, mode: "tail" })).toEqual({ start: 104, end: 200 });
    expect(resolveReadWindow({ total: 200, mode: "head" })).toEqual({ start: 0, end: 96 });
    expect(resolveReadWindow({ total: 200, mode: "cat" })).toEqual({ start: 0, end: 200 });
  });

  it("respects -n for tail/head; cat ignores -n (stays whole)", async () => {
    const { resolveReadWindow } = await loadModule();
    expect(resolveReadWindow({ total, mode: "tail", n: 10 })).toEqual({ start: 90, end: 100 });
    expect(resolveReadWindow({ total, mode: "head", n: 10 })).toEqual({ start: 0, end: 10 });
    expect(resolveReadWindow({ total, mode: "cat", n: 10 })).toEqual({ start: 0, end: 100 });
  });

  it("--last / --head override the mode", async () => {
    const { resolveReadWindow } = await loadModule();
    expect(resolveReadWindow({ total, mode: "cat", last: 5 })).toEqual({ start: 95, end: 100 });
    expect(resolveReadWindow({ total, mode: "tail", head: 5 })).toEqual({ start: 0, end: 5 });
  });

  it("--range A:B is 1-indexed inclusive and order-insensitive", async () => {
    const { resolveReadWindow } = await loadModule();
    expect(resolveReadWindow({ total, mode: "cat", range: "10:20" })).toEqual({
      start: 9,
      end: 20,
    });
    expect(resolveReadWindow({ total, mode: "cat", range: "20:10" })).toEqual({
      start: 9,
      end: 20,
    });
  });

  it("--before-line L shows the page of `limit` lines ending just above L", async () => {
    const { resolveReadWindow } = await loadModule();
    // page-up cursor: lines strictly before line 51, limit 10 -> [41..50] (0-idx 40..50)
    expect(resolveReadWindow({ total, mode: "cat", beforeLine: 51, limit: 10 })).toEqual({
      start: 40,
      end: 50,
    });
    // round-trip: first-visible of the above is line 41; paging up again from 41
    expect(resolveReadWindow({ total, mode: "cat", beforeLine: 41, limit: 10 })).toEqual({
      start: 30,
      end: 40,
    });
  });

  it("clamps out-of-range indices", async () => {
    const { resolveReadWindow } = await loadModule();
    expect(resolveReadWindow({ total: 5, mode: "tail", n: 999 })).toEqual({ start: 0, end: 5 });
    expect(resolveReadWindow({ total: 5, mode: "cat", range: "3:999" })).toEqual({
      start: 2,
      end: 5,
    });
    expect(resolveReadWindow({ total: 5, mode: "cat", beforeLine: 2, limit: 999 })).toEqual({
      start: 0,
      end: 1,
    });
  });

  it("ignores a malformed --range and falls through to the mode default", async () => {
    const { resolveReadWindow } = await loadModule();
    expect(resolveReadWindow({ total, mode: "head", range: "not-a-range" })).toEqual({
      start: 0,
      end: 96,
    });
  });
});

describe("subcommands.deriveLiveStatus", () => {
  const rec = (over: any) => ({
    pid: process.pid,
    cli: "claude",
    prompt: null,
    cwd: "/tmp",
    log_file: null,
    fifo_file: null,
    status: "active",
    exit_code: null,
    exit_reason: null,
    started_at: 0,
    ...over,
  });

  it("returns 'exited' for a dead pid", async () => {
    const mod = await loadModule();
    expect(await mod.deriveLiveStatus(rec({ pid: 2147483646 }))).toBe("exited");
  });

  it("returns 'exited' when the record is already exited", async () => {
    const mod = await loadModule();
    expect(await mod.deriveLiveStatus(rec({ status: "exited" }))).toBe("exited");
  });

  it("returns 'active' for an alive pid with no log file", async () => {
    const mod = await loadModule();
    expect(await mod.deriveLiveStatus(rec({ log_file: null }))).toBe("active");
  });

  it("returns 'active' for an alive pid with a freshly-written log", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ay-dls-"));
    try {
      const log = path.join(dir, "a.log");
      await writeFile(log, "hi");
      const mod = await loadModule();
      expect(await mod.deriveLiveStatus(rec({ log_file: log }))).toBe("active");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  });

  it("returns 'idle' when the log has been quiet past the threshold", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ay-dls-"));
    try {
      const log = path.join(dir, "a.log");
      await writeFile(log, "hi");
      const old = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago > 60s threshold
      await utimes(log, old, old);
      const mod = await loadModule();
      expect(await mod.deriveLiveStatus(rec({ log_file: log }))).toBe("idle");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  });
});

describe("subcommands.isAgentStuck / stuck state", () => {
  const rec = (over: any) => ({
    pid: process.pid,
    cli: "claude",
    prompt: null,
    cwd: "/tmp",
    log_file: null,
    fifo_file: null,
    status: "active",
    exit_code: null,
    exit_reason: null,
    started_at: 0,
    ...over,
  });
  // A log whose rendered tail shows claude's shipped `working` busy marker.
  const BUSY = "⏺ Cogitating…\r\nesc to interrupt · ← for agents\r\n";
  const tenMinAgo = () => new Date(Date.now() - 10 * 60 * 1000);

  it("isAgentStuck: true when a busy marker is on screen and the log is long-silent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ay-stuck-"));
    try {
      const log = path.join(dir, "a.log");
      await writeFile(log, BUSY);
      await utimes(log, tenMinAgo(), tenMinAgo());
      const mod = await loadModule();
      expect(await mod.isAgentStuck(rec({ log_file: log }))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  });

  it("isAgentStuck: false when the busy log was written recently (still working)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ay-stuck-"));
    try {
      const log = path.join(dir, "a.log");
      await writeFile(log, BUSY); // fresh mtime — under the stuck threshold
      const mod = await loadModule();
      expect(await mod.isAgentStuck(rec({ log_file: log }))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  });

  it("isAgentStuck: false when long-silent but no busy marker on screen (genuinely idle)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ay-stuck-"));
    try {
      const log = path.join(dir, "a.log");
      await writeFile(log, "⏺ Done — all green.\r\n❯\r\n");
      await utimes(log, tenMinAgo(), tenMinAgo());
      const mod = await loadModule();
      expect(await mod.isAgentStuck(rec({ log_file: log }))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  });

  it("snapshotStatus: reports 'stuck' for a long-silent busy agent (not 'idle')", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ay-stuck-"));
    try {
      const log = path.join(dir, "a.log");
      await writeFile(log, BUSY);
      await utimes(log, tenMinAgo(), tenMinAgo());
      const mod = await loadModule();
      const snap = await mod.snapshotStatus(rec({ log_file: log }));
      expect(snap.state).toBe("stuck");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  });

  it("snapshotStatus: reports 'stuck' when the Rust unresponsive flag is set (no log needed)", async () => {
    const mod = await loadModule();
    const snap = await mod.snapshotStatus(rec({ unresponsive: true, log_file: null }));
    expect(snap.state).toBe("stuck");
  });

  it("snapshotStatus: the unresponsive flag overrides a quiet (would-be idle) log", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ay-stuck-"));
    try {
      const log = path.join(dir, "a.log");
      // Long-silent, no busy marker → would read as `idle`; the flag forces `stuck`.
      await writeFile(log, "⏺ Done — all green.\r\n❯\r\n");
      await utimes(log, tenMinAgo(), tenMinAgo());
      const mod = await loadModule();
      expect((await mod.snapshotStatus(rec({ log_file: log }))).state).toBe("idle");
      expect((await mod.snapshotStatus(rec({ log_file: log, unresponsive: true }))).state).toBe(
        "stuck",
      );
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  });
});

// A CLI like Claude Code repaints by moving the cursor UP over the previous
// frame and rewriting it. The up-count is the frame's height AT THE AGENT'S REAL
// WIDTH. Replayed narrower, the body line wraps to an extra row, the up-count
// undershoots, and every old frame strands below as a duplicate — the `ay tail`
// stutter. `bodyLen` chars stay one row at the real width but wrap below it.
function buildRedrawLog(frames: number, bodyLen: number): Buffer {
  const body = "BODY-" + "z".repeat(Math.max(0, bodyLen - 5));
  const frame = (i: number) => `HEADER-${i}\r\n${body}`;
  let bytes = frame(0) + "\r\n";
  for (let i = 1; i < frames; i++) bytes += `\x1b[2A\r` + frame(i) + "\r\n"; // up 2 = header+body at real width
  return Buffer.from(bytes);
}
const countHeaders = (s: string) => (s.match(/^HEADER-\d+/gm) ?? []).length;

describe("renderRawLog honors the agent's recorded PTY geometry", () => {
  it("collapses redraw frames at the recorded width but duplicates at a mismatched width", async () => {
    const { renderRawLog } = await loadModule();
    const buf = buildRedrawLog(6, 220); // one row at >=220 cols, two rows below that

    // Replayed at the real width, each repaint lands on the prior frame: one header.
    const correct = await renderRawLog(buf, { mode: "cat", n: 0, cols: 240, rows: 50 });
    expect(countHeaders(correct)).toBe(1);

    // Replayed narrower (the body wraps), repaints undershoot and pile up.
    const wrong = await renderRawLog(buf, { mode: "cat", n: 0, cols: 120, rows: 50 });
    expect(countHeaders(wrong)).toBeGreaterThan(1);
  });
});

describe("subcommands.cmdRead replays at the ptysize sidecar geometry", () => {
  it("renders at the recorded geometry, not the 200-col fallback", async () => {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    const tmp = await mkdtemp(path.join(tmpdir(), "ay-raw-log-"));
    try {
      const logPath = path.join(tmp, "wide.raw.log");
      // Authored for a 240-col terminal; at the 200-col fallback the body wraps
      // and the redraw duplicates (see buildRedrawLog / renderRawLogLines).
      await writeFile(logPath, buildRedrawLog(6, 220));

      // ptysize sidecar lives under the (mocked) home: ~/.agent-yes/ptysize/<pid>.
      const ptDir = path.join(testHome, ".agent-yes", "ptysize");
      await mkdir(ptDir, { recursive: true });
      await writeFile(path.join(ptDir, String(process.pid)), "240 50\n");

      await appendGlobalPid({
        pid: process.pid,
        cli: "claude",
        prompt: null,
        cwd: process.cwd(),
        log_file: logPath,
        status: "active" as const,
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
        const code = await runSubcommand(["bun", "cli.js", "cat", String(process.pid)]);
        expect(code).toBe(0);
      } finally {
        process.stdout.write = orig;
      }
      // With the sidecar honored, the six repaints collapse to a single frame.
      expect(countHeaders(stdout.join(""))).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => null);
    }
  });
});

describe("subcommands.resolveResumeArgs", () => {
  it("replays the original prompt when --fresh", async () => {
    const { resolveResumeArgs } = await loadModule();
    expect(
      resolveResumeArgs({ restoreArgs: ["--continue"] }, "irrelevant log", {
        fresh: true,
        prompt: "do the thing",
      }),
    ).toEqual({ args: ["do the thing"], strategy: "fresh (replay original prompt)" });
  });

  it("--fresh with no prompt yields no args", async () => {
    const { resolveResumeArgs } = await loadModule();
    expect(resolveResumeArgs(undefined, "", { fresh: true })).toEqual({
      args: [],
      strategy: "fresh (no prompt)",
    });
  });

  it("scrapes a printed resume command (capture group 1, whitespace-split)", async () => {
    const { resolveResumeArgs } = await loadModule();
    const conf = { resumeCommand: /To resume run: agent (.+)/ };
    const log = "...\nTo resume run: agent --resume abc-123\n> ";
    expect(resolveResumeArgs(conf, log, { fresh: false })).toEqual({
      args: ["--resume", "abc-123"],
      strategy: "printed resume command: --resume abc-123",
    });
  });

  it("ignores a stray global flag on resumeCommand and still captures", async () => {
    const { resolveResumeArgs } = await loadModule();
    const conf = { resumeCommand: /resume=(\S+)/g };
    expect(resolveResumeArgs(conf, "session resume=zzz here", { fresh: false }).args).toEqual([
      "zzz",
    ]);
  });

  it("falls back to restoreArgs when resumeCommand is absent or unmatched", async () => {
    const { resolveResumeArgs } = await loadModule();
    expect(
      resolveResumeArgs({ restoreArgs: ["--continue"] }, "no resume hint here", { fresh: false }),
    ).toEqual({ args: ["--continue"], strategy: "restoreArgs (--continue)" });
    // resumeCommand present but no match in the log → still falls back.
    expect(
      resolveResumeArgs(
        { resumeCommand: /resume (\S+)/, restoreArgs: ["resume", "--last"] },
        "nothing matches",
        { fresh: false },
      ).args,
    ).toEqual(["resume", "--last"]);
  });

  it("falls back to --continue when neither resumeCommand nor restoreArgs exist", async () => {
    const { resolveResumeArgs } = await loadModule();
    expect(resolveResumeArgs(undefined, "", { fresh: false })).toEqual({
      args: ["--continue"],
      strategy: "--continue (fallback)",
    });
  });
});
