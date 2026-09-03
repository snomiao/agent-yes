import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PASTE_END, PASTE_START } from "./bracketedPaste.ts";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "fs/promises";
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

// The homedir mock covers the DEFAULT case completely: agentYesHome() falls back
// to homedir() when $AGENT_YES_HOME is unset, so the fallback resolves into the
// mock. It does NOT cover the case where the variable is set, because
// agentYesHome() reads it first — and then the tests below write pids.jsonl rows
// and IPC locks to whatever path it names, the operator's live store included.
// Pin it at the same temp dir so both paths land there.
let savedAyHome: string | undefined;

beforeEach(async () => {
  testHome = await mkdtemp(path.join(tmpdir(), "ay-sub-test-"));
  savedAyHome = process.env.AGENT_YES_HOME;
  process.env.AGENT_YES_HOME = path.join(testHome, ".agent-yes");
  vi.resetModules();
});

afterEach(async () => {
  // Restore the operator's own value rather than deleting it (from #456): a
  // bare delete would leave a machine that HAD it set running the rest of the
  // suite against the default path.
  if (savedAyHome === undefined) delete process.env.AGENT_YES_HOME;
  else process.env.AGENT_YES_HOME = savedAyHome;
  for (const fd of heldFifoFds.splice(0)) {
    try {
      (await import("fs")).closeSync(fd);
    } catch {
      /* already closed */
    }
  }
  await rm(testHome, { recursive: true, force: true }).catch(() => null);
});

async function loadModule() {
  return await import("./subcommands.ts");
}

/** Reader fds held open by `liveFifo`, closed after every test. */
const heldFifoFds: number[] = [];

/**
 * Give a record a stdin FIFO with a reader held open — what a healthy lane
 * looks like to `probeStdinReachable` (both runtimes hold theirs open for the
 * agent's whole lifetime). Fixtures whose subject is some OTHER state (stuck,
 * needs_input, a send guard) need this: without a readable FIFO the row is
 * genuinely undeliverable and now reports `unreachable`, which is correct but
 * is not what those tests measure.
 *
 * With no argument it creates the CONVENTIONAL path for `pid` — the same one
 * `probeStdinReachable` falls back to when `fifo_file` is absent — so a fixture
 * carrying `fifo_file: null` becomes reachable without editing it.
 *
 * Returns the path, or null when `mkfifo` is unavailable (caller should skip).
 */
async function liveFifo(pid: number, at?: string): Promise<string | null> {
  const { spawnSync } = await import("child_process");
  const fs = await import("fs");
  const { agentYesHome } = await import("./agentYesHome.ts");
  const fifo = at ?? path.join(agentYesHome(), "fifo", `${pid}.stdin`);
  await mkdir(path.dirname(fifo), { recursive: true });
  await rm(fifo, { force: true }).catch(() => null);
  if (spawnSync("mkfifo", [fifo]).status !== 0) return null;
  heldFifoFds.push(fs.openSync(fifo, fs.constants.O_RDWR));
  return fifo;
}

describe("subcommands.readLogForRender", () => {
  it("reads a small file whole (byte-identical)", async () => {
    const { readLogForRender } = await loadModule();
    const p = path.join(testHome, "small.log");
    const body = Buffer.from("hello\nworld\n".repeat(100));
    await writeFile(p, body);
    const got = await readLogForRender(p);
    expect(Buffer.from(got)).toEqual(body);
  });

  it("caps an oversized file to its trailing window", async () => {
    const { readLogForRender } = await loadModule();
    const p = path.join(testHome, "big.log");
    // 300 KiB of distinct 16-byte lines; cap the read at 64 KiB.
    const lines: string[] = [];
    for (let i = 0; i < 300 * 64; i++) lines.push(String(i).padStart(15, "0"));
    const body = Buffer.from(lines.join("\n") + "\n");
    await writeFile(p, body);
    const cap = 64 * 1024;
    const got = await readLogForRender(p, cap);
    expect(got.byteLength).toBe(cap);
    // The window is the tail: it ends with the file's final bytes.
    expect(Buffer.from(got).subarray(-16)).toEqual(body.subarray(-16));
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

describe("subcommands ↔ rs/src/cli.rs subcommand mirror", () => {
  // The Rust runner keeps its OWN hardcoded copy of both lists (it must decide
  // whether to re-exec the JS launcher before clap swallows the word as prompt
  // text). Nothing enforced that copy, so it silently drifted: `key`, `select`,
  // `todo`, `tray` existed only on the TS side, and running them on the Rust
  // binary directly launched an agent with the subcommand as its prompt. Parse
  // both sources and require them to stay identical.
  const names = (src: string, re: RegExp): string[] =>
    [...(src.match(re)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();

  it("keeps SUBCOMMANDS and MANAGER_SUBCOMMANDS identical in both runtimes", async () => {
    const ts = await readFile(new URL("./subcommands.ts", import.meta.url), "utf8");
    const rs = await readFile(new URL("../rs/src/cli.rs", import.meta.url), "utf8");
    expect(names(rs, /pub const SUBCOMMANDS: &\[&str\] = &\[([\s\S]*?)\];/)).toEqual(
      names(ts, /const SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\)/),
    );
    expect(names(rs, /pub const MANAGER_SUBCOMMANDS: &\[&str\] = &\[([\s\S]*?)\];/)).toEqual(
      names(ts, /const MANAGER_SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\)/),
    );
  });

  it("actually parsed something (guards against a regex that silently matches nothing)", async () => {
    const rs = await readFile(new URL("../rs/src/cli.rs", import.meta.url), "utf8");
    expect(names(rs, /pub const SUBCOMMANDS: &\[&str\] = &\[([\s\S]*?)\];/).length).toBeGreaterThan(
      20,
    );
  });
});

describe("subcommands.isUnknownManagerToken (footgun guard)", () => {
  const CLIS = ["claude", "codex"];
  it("flags a bare non-cli non-subcommand word on the manager entry", async () => {
    const { isUnknownManagerToken } = await loadModule();
    // `ay frobnicate` / a newer subcommand on an older build — neither a
    // subcommand nor a CLI here → error (rather than spawn it as a prompt).
    expect(isUnknownManagerToken("frobnicate", true, CLIS)).toBe(true);
    expect(isUnknownManagerToken("xyzzy", true, CLIS)).toBe(true);
  });
  it("allows a known CLI, a subcommand, a flag, and empty", async () => {
    const { isUnknownManagerToken } = await loadModule();
    expect(isUnknownManagerToken("claude", true, CLIS)).toBe(false); // `ay claude …`
    expect(isUnknownManagerToken("ls", true, CLIS)).toBe(false); // subcommand
    expect(isUnknownManagerToken("--cli", true, CLIS)).toBe(false); // flag → explicit spawn
    expect(isUnknownManagerToken(undefined, true, CLIS)).toBe(false); // bare `ay`
  });
  it("never fires for a cli-bound alias (first word is the prompt)", async () => {
    const { isUnknownManagerToken } = await loadModule();
    // `cy widget ls` → managerCommands=false → "widget ls" is a prompt to claude.
    expect(isUnknownManagerToken("widget", false, CLIS)).toBe(false);
  });
});

describe("subcommands.isBareManagerInvocation", () => {
  it("fires for a bare manager entry (`ay` with no args) → help, not a spawn", async () => {
    const { isBareManagerInvocation } = await loadModule();
    expect(isBareManagerInvocation(["bun", "/x/dist/agent-yes.js"], true)).toBe(true);
  });
  it("never fires for a cli-bound alias (bare `cy` still spawns claude)", async () => {
    const { isBareManagerInvocation } = await loadModule();
    expect(isBareManagerInvocation(["bun", "/x/dist/cy.js"], false)).toBe(false);
  });
  it("does not fire once any arg is present, including a flags-only run", async () => {
    const { isBareManagerInvocation } = await loadModule();
    // `ay claude`, `ay ls`, `ay --continue` each asked for something specific.
    expect(isBareManagerInvocation(["bun", "/x/agent-yes.js", "claude"], true)).toBe(false);
    expect(isBareManagerInvocation(["bun", "/x/agent-yes.js", "ls"], true)).toBe(false);
    expect(isBareManagerInvocation(["bun", "/x/agent-yes.js", "--continue"], true)).toBe(false);
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
    expect(await capture()).toContain("ay notify watch --unread"); // Management entry
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
      expect(out).toContain("ay notify watch --unread");
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
  });

  it("returns null for CLIs without a known graceful command", async () => {
    const { stopTipForCli } = await loadModule();
    expect(stopTipForCli("qwen", 1)).toBeNull();
    expect(stopTipForCli("copilot", 1)).toBeNull();
  });
});

describe("subcommands.GRACEFUL_EXIT_COMMANDS", () => {
  it("maps the known CLIs to their /exit-style commands", async () => {
    const { GRACEFUL_EXIT_COMMANDS } = await loadModule();
    expect(GRACEFUL_EXIT_COMMANDS["claude"]).toBe("/exit");
    expect(GRACEFUL_EXIT_COMMANDS["codex"]).toBe("/exit");
  });
});

describe("subcommands.readAgentPtysize (writer/reader pid fallback)", () => {
  const rec = (pid: number, wrapper_pid: number | null) =>
    ({
      pid,
      wrapper_pid,
      cli: "claude",
      prompt: null,
      cwd: "/x",
      log_file: null,
      status: "active" as const,
      exit_code: null,
      exit_reason: null,
      started_at: 0,
    }) as any;

  async function writeSidecar(pid: number, cols: number, rows: number) {
    const dir = path.join(testHome, ".agent-yes", "ptysize");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, String(pid)), `${cols} ${rows}\n`);
  }

  it("reads geometry keyed by the agent's own pid (Rust runtime)", async () => {
    const { readAgentPtysize } = await loadModule();
    await writeSidecar(500, 120, 40);
    expect(await readAgentPtysize(rec(500, 499))).toEqual({ cols: 120, rows: 40 });
  });

  it("falls back to wrapper_pid when the child pid has no sidecar (TS runtime)", async () => {
    const { readAgentPtysize } = await loadModule();
    // Only the wrapper pid's sidecar exists — mirrors ts/index.ts writing under process.pid
    await writeSidecar(499, 200, 50);
    expect(await readAgentPtysize(rec(500, 499))).toEqual({ cols: 200, rows: 50 });
  });

  it("returns null when neither pid has a sidecar", async () => {
    const { readAgentPtysize } = await loadModule();
    expect(await readAgentPtysize(rec(500, 499))).toBeNull();
    expect(await readAgentPtysize(rec(500, null))).toBeNull();
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

  it("treats '.' / './' as the current working directory (exact cwd match)", async () => {
    const { matchKeyword } = await loadModule();
    const here = { ...baseRecord, cwd: process.cwd() };
    const elsewhere = { ...baseRecord, cwd: "/some/other/place" };
    // sibling agent in this exact cwd resolves
    expect(matchKeyword(here, ".")).toBe(true);
    expect(matchKeyword(here, "./")).toBe(true);
    // an agent in a different cwd (even a subdir/parent) does not
    expect(matchKeyword(elsewhere, ".")).toBe(false);
    expect(matchKeyword({ ...baseRecord, cwd: process.cwd() + "/sub" }, ".")).toBe(false);
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
      // Was 1. A record with no FIFO is the same fact as a FIFO nobody reads —
      // nothing can be delivered — so it now carries the same distinguishable
      // status. The message is unchanged.
      expect(code).toBe(3);
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
      // Delivered as ONE bracketed paste (the target CLI declares the mode), so
      // the receiving TUI never has to guess the burst's boundaries.
      //
      // The CR after the END marker is the load-bearing half: inside a paste a
      // CR is content, so it would insert a newline and submit nothing, leaving
      // the message unsent in the composer with no error anywhere. This is the
      // guard against a refactor folding `trailing` into the framed string.
      expect(received).toBe(`${PASTE_START}hello-fifo${PASTE_END}\r`);
      fs.closeSync(rdwrFd);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => null);
    }
  });

  // The two ways framing must NOT happen, checked on the wire rather than on the
  // predicate — a wiring mistake here is invisible to a unit test.
  const fifoCase = async (cli: string, body: string) => {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    const { spawnSync } = await import("child_process");
    const tmp = await mkdtemp(path.join(tmpdir(), "ay-fifo-"));
    const fifo = path.join(tmp, "test.fifo");
    if (spawnSync("mkfifo", [fifo]).status !== 0) return null;
    const fs = await import("fs");
    const rdwrFd = fs.openSync(fifo, fs.constants.O_RDWR);
    await appendGlobalPid({
      pid: process.pid,
      cli,
      prompt: null,
      cwd: process.cwd(),
      log_file: null,
      fifo_file: fifo,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
    });
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = () => true;
    const savedAyPid = process.env.AGENT_YES_PID;
    delete process.env.AGENT_YES_PID;
    try {
      await runSubcommand(["bun", "cli.js", "send", String(process.pid), body, "--force"]);
    } finally {
      process.stdout.write = orig;
      if (savedAyPid !== undefined) process.env.AGENT_YES_PID = savedAyPid;
    }
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(rdwrFd, buf, 0, buf.length, null);
    fs.closeSync(rdwrFd);
    await rm(tmp, { recursive: true, force: true }).catch(() => null);
    return buf.subarray(0, n).toString();
  };

  it.skipIf(!itUnix)("never frames a CLI that does not enable the mode", async () => {
    // bash would receive ESC[200~ as literal text on its command line.
    const received = await fifoCase("bash", "echo hi");
    if (received === null) return;
    expect(received).toBe("echo hi\r");
  });

  it.skipIf(!itUnix)("never frames a slash command — pasted text is not typing", async () => {
    // A CLI recognizes /exit only when typed; framing it would deliver the text
    // of a command the sender meant to run.
    const received = await fifoCase("claude", "/model opus");
    if (received === null) return;
    expect(received).toBe("/model opus\r");
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

  /**
   * `fn` gets the fifo path plus `onKeystroke()`, which resolves once
   * submitAndConfirm's trailing code actually lands on the fifo.
   *
   * Tests that need the agent to "react" MUST hang that reaction off
   * `onKeystroke()` rather than a `setTimeout`. submitAndConfirm snapshots the
   * log size and the current working-marker state BEFORE it writes to the fifo,
   * and it only does that after `cliDefaults()` has parsed the config — so a
   * wall-clock timer races that setup. Under load the setup wins, the "reaction"
   * lands in the pre-write snapshot, and the assertion flips: growth gets folded
   * into `sizeBefore`, and a busy marker reads as `wasAlreadyWorking` (which the
   * false-positive guard below deliberately treats as NOT confirmed).
   */
  async function withFifo(
    fn: (fifo: string, onKeystroke: () => Promise<boolean>) => Promise<void>,
  ) {
    const { spawnSync } = await import("child_process");
    const dir = await mkdtemp(path.join(tmpdir(), "ay-confirm-"));
    const fifo = path.join(dir, "test.fifo");
    try {
      const r = spawnSync("mkfifo", [fifo]);
      if (r.status !== 0) return; // mkfifo unavailable — skip
      const fs = await import("fs");
      const rdwrFd = fs.openSync(fifo, fs.constants.O_RDWR); // keeps writes from blocking
      // A SEPARATE non-blocking reader: rdwrFd is never read from, so the
      // keystroke is still here to be observed. O_NONBLOCK is load-bearing —
      // a blocking readSync on an empty fifo wedges the whole vitest worker.
      const readFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      const onKeystroke = async (timeoutMs = 5_000): Promise<boolean> => {
        const buf = Buffer.alloc(64);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          try {
            if (fs.readSync(readFd, buf, 0, buf.length, null) > 0) return true;
          } catch (err: any) {
            if (err?.code !== "EAGAIN") throw err; // EAGAIN = nothing yet
          }
          await new Promise((r) => setTimeout(r, 5));
        }
        return false;
      };
      try {
        await fn(fifo, onKeystroke);
      } finally {
        fs.closeSync(readFd);
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
        await withFifo(async (fifo, onKeystroke) => {
          // The Enter kicks off work: the busy marker appears once the keystroke
          // has actually landed — a genuine idle→busy transition, and one that
          // provably happens AFTER submitAndConfirm's pre-write snapshot.
          const reacted = onKeystroke().then((got) => {
            if (got) appendFileSync(log, BUSY);
            return got;
          });
          const { confirmed, screen } = await submitAndConfirm(rec({ log_file: log }), fifo, "\r");
          expect(await reacted).toBe(true); // the fifo really carried the Enter
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
      await withFifo(async (fifo, onKeystroke) => {
        // The CLI starts responding once the Enter lands. Keyed off the actual
        // keystroke so the growth cannot be folded into `sizeBefore`.
        const reacted = onKeystroke().then((got) => {
          if (got) appendFileSync(log, "some real response text appears here\r\n");
          return got;
        });
        const { confirmed } = await submitAndConfirm(rec({ log_file: log }), fifo, "\r");
        expect(await reacted).toBe(true);
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
      // O_NONBLOCK is REQUIRED here: without it, readSync on an empty FIFO BLOCKS
      // the whole event loop. An O_RDWR fd keeps a writer open, so the read waits
      // for bytes that only arrive once fn() calls writeToIpc — but fn() can't make
      // progress while the loop is blocked in readSync → deadlock. That froze the
      // vitest worker so hard its 30s testTimeout couldn't even fire, wedging the CI
      // job for the full 6h cap. The catch below expects EAGAIN, which only happens
      // with O_NONBLOCK. The sibling drain in "writeToIpc reliable delivery" already
      // opens O_NONBLOCK for exactly this reason.
      const rdwrFd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
      const drain = setInterval(() => {
        try {
          fs.readSync(rdwrFd, Buffer.alloc(4096), 0, 4096, null);
        } catch {
          /* EAGAIN or similar — nothing pending, ignore */
        }
      }, 20);
      // Belt-and-suspenders: never let the drain timer alone keep the worker alive.
      // If a future test's fn() hangs past testTimeout, the finally below won't run
      // (the awaited fn stays pending), but an unref'd timer can't wedge process exit.
      drain.unref();
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
    "exits 0 and reports 'sent' when a working marker appears after the Enter (genuine confirm)",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "ay-send-e2e-log-"));
      // A STATIC pre-existing busy marker cannot confirm — that's the #157
      // wasAlreadyWorking guard (see the "already on screen before sending" test).
      // Confirmation needs a real idle→working transition (or >=8 bytes of growth)
      // AFTER the submit. Model that: the log is idle until we send, then a steady
      // trickle of the working marker lands within submitAndConfirm's window, so it
      // confirms deterministically without fragile single-shot timing.
      const log = path.join(dir, "a.log");
      await writeFile(log, "❯ \r\n"); // idle until the submitted Enter lands
      let working = false;
      const respond = setInterval(() => {
        if (working) appendFileSync(log, BUSY);
      }, 40);
      respond.unref();
      try {
        await withDrainedFifo(async (fifo) => {
          working = true; // the submitted Enter kicks the agent into working
          const { code, stdout } = await send(fifo, log, "hello");
          expect(code).toBe(0);
          expect(stdout).toMatch(/^sent to pid/);
          expect(stdout).not.toMatch(/NOT confirmed/);
        });
      } finally {
        clearInterval(respond);
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

describe("withIpcLock prevents two writers splicing into one FIFO", () => {
  const itUnix = process.platform === "linux" || process.platform === "darwin";

  // The failure this guards against is NOT "messages arrive in a surprising
  // order" — it is one message cut in half by another. writeToIpc loops on
  // EAGAIN/partial writes, and POSIX only promises atomicity up to PIPE_BUF
  // (512 bytes on macOS), so two concurrent writers of a large payload
  // interleave bytes mid-message. This test reproduces that against a real
  // FIFO with a real slow reader, exactly like the delivery test above.
  it.skipIf(!itUnix)("keeps each writer's payload contiguous", async () => {
    const { writeToIpc } = await loadModule();
    const { withIpcLock } = await import("./ipcLock.ts");
    const { spawnSync } = await import("child_process");
    const fs = await import("fs");
    const tmp = await mkdtemp(path.join(tmpdir(), "ay-splice-"));
    try {
      const fifo = path.join(tmp, "splice.fifo");
      if (spawnSync("mkfifo", [fifo]).status !== 0) return;
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
        // Two 20KB payloads of distinct repeated characters, each written as a
        // two-part transaction with a gap — the `ay send` shape (body, settle,
        // Enter). Locked, each must appear as one unbroken run.
        const a = "a".repeat(20_000);
        const b = "b".repeat(20_000);
        const txn = (ch: string, body: string) =>
          withIpcLock(987654, async () => {
            await writeToIpc(fifo, body);
            await new Promise((r) => setTimeout(r, 30));
            await writeToIpc(fifo, ch.toUpperCase());
          });
        await Promise.all([txn("a", a), txn("b", b)]);

        const deadline = Date.now() + 5000;
        const total = a.length + b.length + 2;
        while (Buffer.concat(chunks).length < total && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
        const got = Buffer.concat(chunks).toString("utf8");
        expect(got).toHaveLength(total);
        // Whichever transaction went first, the stream is exactly one complete
        // transaction followed by the other — never a's bytes inside b's run.
        expect(got === a + "A" + b + "B" || got === b + "B" + a + "A").toBe(true);
      } finally {
        clearInterval(drain);
        fs.closeSync(rfd);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => null);
    }
  });
});

describe("subcommands.cmdSend safety guards", () => {
  it("maps AGENT_YES_PID→wrapper_pid and blocks an agent from sending to itself", async () => {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    // We register an agent whose wrapper_pid is a known value, then run `ay send`
    // with AGENT_YES_PID set to that wrapper — so resolveSender maps it back to
    // this same agent, and sending to its own pid trips the self-send guard.
    const wrapperPid = 424242;
    // A live target: every guard below is about the SENDER or the BODY, and
    // `ay send` now refuses an unreachable target before reaching any of them.
    const fifo = await liveFifo(process.pid);
    if (!fifo) return; // no mkfifo on this box
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

  it("refuses an over-cap body and points at a remedy that WORKS (the path, not `-`)", async () => {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    // Register a target agent so resolveOne succeeds and we reach the length gate.
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: null,
      cwd: process.cwd(),
      log_file: null,
      fifo_file: await liveFifo(process.pid),
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
      const long = "x".repeat(1025);
      const code = await runSubcommand(["bun", "cli.js", "send", String(process.pid), long]);
      expect(code).toBe(1);
      expect(stderr.join("")).toMatch(/over the 1024-char limit/);
      // It must point at sending the PATH...
      expect(stderr.join("")).toMatch(/send the PATH/);
      expect(stderr.join("")).toMatch(/\/path\/to\/notes\.md/);
      // ...and must not resurrect `- < file.txt`, which hits this same cap. The
      // previous version of this test asserted that exact string, so the defect
      // was pinned GREEN: an operator followed the hint and was rejected again.
      expect(stderr.join("")).not.toMatch(/- < file\.txt/);
    } finally {
      process.stderr.write = orig;
    }
  });

  it("counts the envelope it adds — a body UNDER the cap that would transmit over it", async () => {
    // The defect: the cap was checked on the body, then ~134 chars of
    // <ay-msg …> envelope were added and the whole thing written. A body of
    // 1000 was accepted and ~1134 went down the pipe. The enforced number was
    // never the transmitted number.
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    const sender = {
      pid: 900001,
      cli: "claude" as const,
      prompt: null,
      cwd: "/repo/beta",
      log_file: null,
      fifo_file: null,
      status: "active" as const,
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
      agent_id: "cccc0000dddd",
      wrapper_pid: 900001,
    };
    await appendGlobalPid(sender);
    await appendGlobalPid({
      pid: process.pid,
      cli: "claude",
      prompt: null,
      cwd: process.cwd(),
      log_file: null,
      // Deliberately a dead path, and it no longer matters: the envelope cap is
      // decided from the SENDER alone, before anything about the target is
      // touched. That is what keeps this test ungated and green on Windows,
      // where liveFifo() cannot create a FIFO at all.
      fifo_file: "/tmp/ay-envelope-cap-test.fifo",
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
    });
    const stderr: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (x: any) => {
      stderr.push(String(x));
      return true;
    };
    const savedAyPid = process.env.AGENT_YES_PID;
    process.env.AGENT_YES_PID = "900001"; // an AGENT sender, so the envelope is added
    try {
      const body = "x".repeat(1000); // comfortably under the 1024 body cap
      const code = await runSubcommand([
        "bun",
        "cli.js",
        "send",
        String(process.pid),
        body,
        "--force",
      ]);
      expect(code).toBe(1);
      const out = stderr.join("");
      expect(out).toMatch(/would transmit/);
      expect(out).toMatch(/1000 of body/);
      expect(out).toMatch(/envelope/);
    } finally {
      process.stderr.write = orig;
      if (savedAyPid === undefined) delete process.env.AGENT_YES_PID;
      else process.env.AGENT_YES_PID = savedAyPid;
    }
  });

  it.skipIf(process.platform === "win32")(
    "applies the same cap to the `-` (stdin) body — the form the old hint recommended",
    async () => {
      const { runSubcommand } = await loadModule();
      const { appendGlobalPid } = await import("./globalPidIndex.ts");
      await appendGlobalPid({
        pid: process.pid,
        cli: "claude",
        prompt: null,
        cwd: process.cwd(),
        log_file: null,
        fifo_file: await liveFifo(process.pid),
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
      const origStdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
      const long = "y".repeat(1780);
      Object.defineProperty(process, "stdin", {
        configurable: true,
        value: (async function* () {
          yield Buffer.from(long, "utf-8");
        })(),
      });
      try {
        const code = await runSubcommand(["bun", "cli.js", "send", String(process.pid), "-"]);
        expect(code).toBe(1);
        // The cap is on the body however it arrives, so `-` buys nothing.
        expect(stderr.join("")).toMatch(/1780 chars, over the 1024-char limit/);
      } finally {
        process.stderr.write = orig;
        Object.defineProperty(process, "stdin", origStdin);
      }
    },
  );
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
      // A wedged agent's wrapper is still alive and still reading its FIFO —
      // `stuck` is what it must report, not `unreachable`.
      fifo_file: await liveFifo(process.pid),
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
  // `ay status` reports the same states as `ay ls`, `unreachable` included. Give
  // the fixtures the reachable stdin FIFO a live agent has, so the wait loops are
  // measured on the state they are about rather than on a dead input channel.
  beforeEach(async () => {
    await liveFifo(process.pid);
  });

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
  // These fixtures are about the LOG-derived state (stuck / needs_input / idle),
  // so give every one of them the reachable stdin FIFO a live agent has —
  // otherwise the row is genuinely undeliverable and correctly reads
  // `unreachable`, which is a different question than the one under test.
  //
  // That dependency makes the suite unix-only: `liveFifo` is a no-op where
  // mkfifo does not exist, so on Windows every row here reads `unreachable` and
  // the assertions invert. Same reason as this file's other FIFO-backed suites.
  const itUnix = process.platform === "linux" || process.platform === "darwin";
  beforeEach(async () => {
    await liveFifo(process.pid);
  });

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

  it.skipIf(!itUnix)(
    "isAgentStuck: true when a busy marker is on screen and the log is long-silent",
    async () => {
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
    },
  );

  it.skipIf(!itUnix)(
    "isAgentStuck: false when the busy log was written recently (still working)",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "ay-stuck-"));
      try {
        const log = path.join(dir, "a.log");
        await writeFile(log, BUSY); // fresh mtime — under the stuck threshold
        const mod = await loadModule();
        expect(await mod.isAgentStuck(rec({ log_file: log }))).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
  );

  it.skipIf(!itUnix)(
    "isAgentStuck: false when long-silent but no busy marker on screen (genuinely idle)",
    async () => {
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
    },
  );

  it.skipIf(!itUnix)(
    "snapshotStatus: reports 'stuck' for a long-silent busy agent (not 'idle')",
    async () => {
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
    },
  );

  it.skipIf(!itUnix)(
    "snapshotStatus: reports 'stuck' when the Rust unresponsive flag is set (no log needed)",
    async () => {
      const mod = await loadModule();
      const snap = await mod.snapshotStatus(rec({ unresponsive: true, log_file: null }));
      expect(snap.state).toBe("stuck");
    },
  );

  it.skipIf(!itUnix)(
    "snapshotStatus: the unresponsive flag overrides a quiet (would-be idle) log",
    async () => {
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
    },
  );
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

describe("subcommands.cmdWhoami", () => {
  const envKey = "AGENT_YES_PID";
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[envKey];
    delete process.env[envKey];
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[envKey];
    else process.env[envKey] = savedEnv;
  });

  it("outside an agent (no AGENT_YES_PID) exits 1 with a human-shell hint", async () => {
    const { runSubcommand } = await loadModule();
    const stderr: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => {
      stderr.push(String(s));
      return true;
    };
    try {
      const code = await runSubcommand(["bun", "cli.js", "whoami"]);
      expect(code).toBe(1);
      expect(stderr.join("")).toMatch(/AGENT_YES_PID is unset/);
    } finally {
      process.stderr.write = orig;
    }
  });

  it("a set-but-unregistered AGENT_YES_PID reports 'unregistered' in --json and exits 1", async () => {
    const { runSubcommand } = await loadModule();
    process.env[envKey] = "999999";
    const stdout: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: any) => {
      stdout.push(String(s));
      return true;
    };
    try {
      const code = await runSubcommand(["bun", "cli.js", "whoami", "--json"]);
      expect(code).toBe(1);
    } finally {
      process.stdout.write = orig;
    }
    expect(JSON.parse(stdout.join(""))).toEqual({ agent: null, reason: "unregistered" });
  });

  it("resolves the caller via wrapper_pid and prints identity + reply address", async () => {
    const mod = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: process.pid, // alive, so live-state derivation doesn't read it as exited
      cli: "claude",
      prompt: "whoami test",
      cwd: "/repo/alpha",
      log_file: null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
      wrapper_pid: 424242,
      parent_pid: null,
      agent_id: "aaaa0000bbbb",
    });
    process.env[envKey] = "424242";

    const stdout: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: any) => {
      stdout.push(String(s));
      return true;
    };
    try {
      const code = await mod.runSubcommand(["bun", "cli.js", "whoami", "--json"]);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed).toMatchObject({
      pid: process.pid,
      cli: "claude",
      cwd: "/repo/alpha",
      agent_id: "aaaa0000bbbb",
      wrapper_pid: 424242,
      reply: "ay send aaaa0000bbbb",
    });
    expect(typeof parsed.state).toBe("string");

    // Human-readable form carries the traceable envelope template.
    const stdout2: string[] = [];
    (process.stdout as any).write = (s: any) => {
      stdout2.push(String(s));
      return true;
    };
    try {
      const code = await mod.runSubcommand(["bun", "cli.js", "whoami"]);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    const text = stdout2.join("");
    expect(text).toMatch(/agent {5}claude #\d+ {2}\(agent_id aaaa0000bbbb\)/);
    expect(text).toMatch(/reply {5}ay send aaaa0000bbbb/);
    expect(text).toMatch(
      /<ay-msg from claude [A-Za-z0-9._-]+@[A-Za-z0-9._-]+:\/repo\/alpha#\d+ — reply: ay send aaaa0000bbbb "\.\.\.">/,
    );
  });
});

describe("subcommands.cmdSend double-envelope warning", () => {
  const itUnix = process.platform === "linux" || process.platform === "darwin";

  it.skipIf(!itUnix)(
    "warns when an agent sender's body is already <ay-msg …>-wrapped (still delivers, still wraps)",
    async () => {
      const { runSubcommand } = await loadModule();
      const { appendGlobalPid } = await import("./globalPidIndex.ts");
      const { spawnSync } = await import("child_process");
      const tmp = await mkdtemp(path.join(tmpdir(), "ay-fifo-"));
      try {
        const fifo = path.join(tmp, "warn.fifo");
        if (spawnSync("mkfifo", [fifo]).status !== 0) return;
        const fs = await import("fs");
        const rdwrFd = fs.openSync(fifo, fs.constants.O_RDWR);
        // Target agent (owns the fifo) …
        await appendGlobalPid({
          pid: process.pid,
          cli: "claude",
          prompt: null,
          cwd: "/repo/alpha",
          log_file: null,
          fifo_file: fifo,
          status: "active",
          exit_code: null,
          exit_reason: null,
          started_at: Date.now(),
        });
        // … and a registered SENDER so cmdSend resolves an agent context and
        // engages the auto-envelope path the warning guards.
        await appendGlobalPid({
          pid: 900001,
          cli: "claude",
          prompt: null,
          cwd: "/repo/beta",
          log_file: null,
          status: "active",
          exit_code: null,
          exit_reason: null,
          started_at: Date.now(),
          wrapper_pid: 424242,
          agent_id: "cccc0000dddd",
        });
        const savedAyPid = process.env.AGENT_YES_PID;
        process.env.AGENT_YES_PID = "424242";
        const stderr: string[] = [];
        const origErr = process.stderr.write.bind(process.stderr);
        (process.stderr as any).write = (s: any) => (stderr.push(String(s)), true);
        const origOut = process.stdout.write.bind(process.stdout);
        (process.stdout as any).write = () => true;
        try {
          const code = await runSubcommand([
            "bun",
            "cli.js",
            "send",
            String(process.pid),
            '<ay-msg deadbeef from claude #900001 @ /repo/beta — reply: ay send 900001 "...">hi</ay-msg deadbeef>',
            "--force",
          ]);
          expect(code).toBe(0);
          expect(stderr.join("")).toMatch(/DOUBLE wrapper/);
        } finally {
          process.stderr.write = origErr;
          process.stdout.write = origOut;
          if (savedAyPid === undefined) delete process.env.AGENT_YES_PID;
          else process.env.AGENT_YES_PID = savedAyPid;
        }
        // Delivered bytes carry BOTH envelopes — transport stamp outermost.
        const buf = Buffer.alloc(8192);
        const n = fs.readSync(rdwrFd, buf, 0, buf.length, null);
        const received = buf.subarray(0, n).toString();
        expect(received.startsWith(PASTE_START)).toBe(true);
        expect(received).toMatch(
          /<ay-msg [0-9a-f]{8} from claude [A-Za-z0-9._-]+@[A-Za-z0-9._-]+:\/repo\/beta#900001 — /,
        );
        expect(received).toContain("<ay-msg deadbeef");
        fs.closeSync(rdwrFd);
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => null);
      }
    },
  );

  it.skipIf(!itUnix)("plain agent-sender bodies do not trigger the warning", async () => {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    const { spawnSync } = await import("child_process");
    const tmp = await mkdtemp(path.join(tmpdir(), "ay-fifo-"));
    try {
      const fifo = path.join(tmp, "plain.fifo");
      if (spawnSync("mkfifo", [fifo]).status !== 0) return;
      const fs = await import("fs");
      const rdwrFd = fs.openSync(fifo, fs.constants.O_RDWR);
      await appendGlobalPid({
        pid: process.pid,
        cli: "claude",
        prompt: null,
        cwd: "/repo/alpha",
        log_file: null,
        fifo_file: fifo,
        status: "active",
        exit_code: null,
        exit_reason: null,
        started_at: Date.now(),
      });
      await appendGlobalPid({
        pid: 900001,
        cli: "claude",
        prompt: null,
        cwd: "/repo/beta",
        log_file: null,
        status: "active",
        exit_code: null,
        exit_reason: null,
        started_at: Date.now(),
        wrapper_pid: 424242,
        agent_id: "cccc0000dddd",
      });
      const savedAyPid = process.env.AGENT_YES_PID;
      process.env.AGENT_YES_PID = "424242";
      const stderr: string[] = [];
      const origErr = process.stderr.write.bind(process.stderr);
      (process.stderr as any).write = (s: any) => (stderr.push(String(s)), true);
      const origOut = process.stdout.write.bind(process.stdout);
      (process.stdout as any).write = () => true;
      try {
        const code = await runSubcommand([
          "bun",
          "cli.js",
          "send",
          String(process.pid),
          "plain body, quoting <ay-msg deadbeef …> mid-text is fine",
          "--force",
        ]);
        expect(code).toBe(0);
        expect(stderr.join("")).not.toMatch(/DOUBLE wrapper/);
      } finally {
        process.stderr.write = origErr;
        process.stdout.write = origOut;
        if (savedAyPid === undefined) delete process.env.AGENT_YES_PID;
        else process.env.AGENT_YES_PID = savedAyPid;
      }
      fs.closeSync(rdwrFd);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => null);
    }
  });

  it.skipIf(!itUnix)("the envelope header carries the standardized identity", async () => {
    const { runSubcommand } = await loadModule();
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    const { spawnSync } = await import("child_process");
    const tmp = await mkdtemp(path.join(tmpdir(), "ay-fifo-"));
    try {
      const fifo = path.join(tmp, "ident.fifo");
      if (spawnSync("mkfifo", [fifo]).status !== 0) return;
      const fs = await import("fs");
      const rdwrFd = fs.openSync(fifo, fs.constants.O_RDWR);
      // Sender cwd IS a git checkout, so the identity carries its branch.
      const senderCwd = path.join(tmp, "sender-repo");
      await mkdir(path.join(senderCwd, ".git"), { recursive: true });
      await writeFile(path.join(senderCwd, ".git", "HEAD"), "ref: refs/heads/crm-lane\n");
      await appendGlobalPid({
        pid: process.pid,
        cli: "claude",
        prompt: null,
        cwd: "/repo/alpha",
        log_file: null,
        fifo_file: fifo,
        status: "active",
        exit_code: null,
        exit_reason: null,
        started_at: Date.now(),
      });
      await appendGlobalPid({
        pid: 900001,
        cli: "claude",
        prompt: null,
        cwd: senderCwd,
        log_file: null,
        status: "active",
        exit_code: null,
        exit_reason: null,
        started_at: Date.now(),
        wrapper_pid: 424242,
        agent_id: "cccc0000dddd",
      });
      const savedAyPid = process.env.AGENT_YES_PID;
      process.env.AGENT_YES_PID = "424242";
      const origOut = process.stdout.write.bind(process.stdout);
      (process.stdout as any).write = () => true;
      try {
        const code = await runSubcommand([
          "bun",
          "cli.js",
          "send",
          String(process.pid),
          "hello from crm",
          "--force",
        ]);
        expect(code).toBe(0);
      } finally {
        process.stdout.write = origOut;
        if (savedAyPid === undefined) delete process.env.AGENT_YES_PID;
        else process.env.AGENT_YES_PID = savedAyPid;
      }
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(rdwrFd, buf, 0, buf.length, null);
      const received = buf.subarray(0, n).toString();
      // <user>@<host>:<path>:<branch>#<pid> — reply targets the agent_id. The
      // envelope now opens just inside the paste marker, so the anchor moves
      // from start-of-payload to start-of-paste.
      expect(received.startsWith(PASTE_START)).toBe(true);
      expect(received).toMatch(
        /<ay-msg [0-9a-f]{8} from claude [A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.+:crm-lane#900001 — reply: ay send cccc0000dddd "\.\.\.">/,
      );
      fs.closeSync(rdwrFd);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => null);
    }
  });
});

// ---------------------------------------------------------------------------
// Reachability: `ay ls` must not report an undeliverable row as `idle`
// ---------------------------------------------------------------------------

describe("subcommands.probeStdinReachable", () => {
  // FIFO-backed, so unix-only — same reason as the other FIFO suites in this
  // file. On Windows `probeStdinReachable` returns "unknown" by design (named
  // pipes need a connect, not an open), so these assertions cannot hold there
  // and skipping is the honest outcome rather than a weaker expectation.
  const itUnix = process.platform === "linux" || process.platform === "darwin";

  /** A real FIFO plus a held O_RDWR fd, which is how both runtimes keep it open. */
  async function withReadFifo(fn: (fifo: string) => Promise<void> | void) {
    const { spawnSync } = await import("child_process");
    const fs = await import("fs");
    const dir = await mkdtemp(path.join(tmpdir(), "ay-reach-"));
    const fifo = path.join(dir, "stdin.fifo");
    try {
      if (spawnSync("mkfifo", [fifo]).status !== 0) return; // no mkfifo — skip
      const fd = fs.openSync(fifo, fs.constants.O_RDWR);
      try {
        await fn(fifo);
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  }

  /** The same FIFO with NOBODY holding it open — the dead-agent shape. */
  async function withReaderlessFifo(fn: (fifo: string) => Promise<void> | void) {
    const { spawnSync } = await import("child_process");
    const dir = await mkdtemp(path.join(tmpdir(), "ay-reach-"));
    const fifo = path.join(dir, "stdin.fifo");
    try {
      if (spawnSync("mkfifo", [fifo]).status !== 0) return;
      await fn(fifo);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  }

  it.skipIf(!itUnix)(
    "is 'ok' while something holds the FIFO open — the positive control",
    async () => {
      const mod = await loadModule();
      await withReadFifo((fifo) => {
        expect(mod.probeStdinReachable({ pid: process.pid, fifo_file: fifo })).toBe("ok");
      });
    },
  );

  it.skipIf(!itUnix)(
    "waits longer for a SEND than for a listing, because the costs differ",
    async () => {
      // A listing that is briefly wrong is cheap; refusing to deliver to an agent
      // that was merely still starting is not. The send window must therefore
      // outlast the display one, and a reader that appears between them must be
      // seen by the send.
      const { spawnSync } = await import("child_process");
      const fs = await import("fs");
      const dir = await mkdtemp(path.join(tmpdir(), "ay-reach-"));
      try {
        const fifo = path.join(dir, "stdin.fifo");
        if (spawnSync("mkfifo", [fifo]).status !== 0) return;
        const mod = await loadModule();
        const rec = { pid: process.pid, fifo_file: fifo };
        // Nothing is reading yet, and nothing will within the display window.
        expect(await mod.confirmStdinUnreachable(rec)).toBe(true);
        const late = setTimeout(() => fs.openSync(fifo, fs.constants.O_RDWR), 400);
        try {
          // …but the send keeps looking, and sees the reader arrive.
          expect(await mod.confirmStdinUnreachable(rec, 3_000)).toBe(false);
        } finally {
          clearTimeout(late);
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
  );

  it.skipIf(!itUnix)(
    "costs ONE window for many dead rows probed together, not one each",
    async () => {
      // The property `ay notifyd` depends on: it derives every child's state in
      // parallel, so a fleet with several broken children costs one confirmation
      // window per tick rather than one per child. Serially this would be 5×.
      const { spawnSync } = await import("child_process");
      const dir = await mkdtemp(path.join(tmpdir(), "ay-reach-"));
      try {
        const fifos: string[] = [];
        for (let i = 0; i < 5; i++) {
          const f = path.join(dir, `stdin-${i}.fifo`);
          if (spawnSync("mkfifo", [f]).status !== 0) return;
          fifos.push(f);
        }
        const mod = await loadModule();
        const started = Date.now();
        const answers = await Promise.all(
          fifos.map((f) => mod.confirmStdinUnreachable({ pid: process.pid, fifo_file: f })),
        );
        const elapsed = Date.now() - started;
        expect(answers).toEqual([true, true, true, true, true]);
        // One window is 150ms; five serial ones would be 750ms. A generous bound,
        // so this fails on the shape (serial) and not on a slow machine.
        expect(elapsed).toBeLessThan(500);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
  );

  it.skipIf(!itUnix)("is 'unreachable' for a FIFO nobody is reading (the ENXIO row)", async () => {
    const mod = await loadModule();
    await withReaderlessFifo((fifo) => {
      expect(mod.probeStdinReachable({ pid: process.pid, fifo_file: fifo })).toBe("unreachable");
    });
  });

  it.skipIf(!itUnix)("is 'unreachable' when the FIFO is gone entirely", async () => {
    const mod = await loadModule();
    expect(
      mod.probeStdinReachable({ pid: process.pid, fifo_file: path.join(testHome, "nope.fifo") }),
    ).toBe("unreachable");
  });

  it.skipIf(!itUnix)(
    "falls back to the conventional path when `fifo_file` was dropped",
    async () => {
      // The decisive test for the fallback, not just "a missing path is
      // unreachable": a LIVE agent whose record lost the optional field (a Rust
      // rewrite of pids.jsonl can drop it) must still read `ok`, because the FIFO
      // is right where both runtimes put it.
      const mod = await loadModule();
      const pid = 4242;
      const fifo = await liveFifo(pid); // creates <agentYesHome()>/fifo/4242.stdin
      if (!fifo) return;
      expect(mod.probeStdinReachable({ pid, fifo_file: null })).toBe("ok");
    },
  );

  it.skipIf(!itUnix)(
    "is 'unreachable' when no FIFO exists at the conventional path either",
    async () => {
      const mod = await loadModule();
      expect(mod.probeStdinReachable({ pid: 4243, fifo_file: null })).toBe("unreachable");
    },
  );

  // Portable: asserts the errno CLASSIFIER, which is a pure predicate — no
  // FIFO and no probe, so it holds on Windows too.
  it("classifies EPIPE as unreachable for a WRITE, though a probe can never see it", async () => {
    // A reader present at open() that vanishes mid-write gives EPIPE. Only the
    // write path produces it, so it belongs in the send's classification and not
    // in the probe — but it must land on the same exit status, because it is the
    // same mechanism noticed a moment later.
    const mod = await loadModule();
    expect(mod.isUnreachableWriteErrno("EPIPE")).toBe(true);
    expect(mod.isUnreachableWriteErrno("ENXIO")).toBe(true);
    expect(mod.isUnreachableWriteErrno("ENOENT")).toBe(true);
    // A full pipe means a reader EXISTS and is slow — that is the retry loop,
    // not a dead row.
    expect(mod.isUnreachableWriteErrno("EAGAIN")).toBe(false);
    expect(mod.isUnreachableWriteErrno("EACCES")).toBe(false);
    expect(mod.isUnreachableWriteErrno(undefined)).toBe(false);
  });

  it.skipIf(!itUnix)(
    "fails OPEN on any other errno rather than calling a live agent dead",
    async () => {
      const mod = await loadModule();
      // A directory: open(O_WRONLY) gives EISDIR, which says nothing about whether
      // an agent is reading. Anything but ENXIO/ENOENT must leave the state alone.
      expect(mod.probeStdinReachable({ pid: process.pid, fifo_file: testHome })).toBe("unknown");
    },
  );
});

describe("subcommands.deriveLiveState reachability", () => {
  // FIFO-backed, so unix-only — same reason as the other FIFO suites in this
  // file. On Windows `probeStdinReachable` returns "unknown" by design (named
  // pipes need a connect, not an open), so these assertions cannot hold there
  // and skipping is the honest outcome rather than a weaker expectation.
  const itUnix = process.platform === "linux" || process.platform === "darwin";

  const rec = (over: any) => ({
    pid: process.pid,
    cli: "codex",
    prompt: null,
    cwd: "/repo/alpha",
    log_file: null,
    fifo_file: null,
    status: "active",
    exit_code: null,
    exit_reason: null,
    started_at: 0,
    ...over,
  });

  /** A log old enough that deriveLiveStatus reads `idle`. */
  async function quietLog(dir: string): Promise<string> {
    const log = path.join(dir, "a.log");
    await writeFile(log, "waiting for work\n");
    const old = new Date(Date.now() - 5 * 60 * 1000);
    await utimes(log, old, old);
    return log;
  }

  it.skipIf(!itUnix)(
    "reports 'unreachable', not 'idle', for an alive pid whose FIFO takes no writer",
    async () => {
      const { spawnSync } = await import("child_process");
      const dir = await mkdtemp(path.join(tmpdir(), "ay-reach-"));
      try {
        const fifo = path.join(dir, "stdin.fifo");
        if (spawnSync("mkfifo", [fifo]).status !== 0) return;
        const log = await quietLog(dir);
        const mod = await loadModule();
        expect(await mod.deriveLiveState(rec({ log_file: log, fifo_file: fifo }))).toEqual({
          state: "unreachable",
          question: null,
        });
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
  );

  // Deliberately passes both before and after this change — that IS its job.
  // The brief's condition is that a genuinely idle, reachable lane keeps reading
  // `idle`; a fix that marked every quiet lane dead would look identical from
  // the outside without it. It guards the fix, it does not prove it.
  it.skipIf(!itUnix)(
    "still reports 'idle' for a quiet lane that IS reachable — the positive control",
    async () => {
      const { spawnSync } = await import("child_process");
      const fs = await import("fs");
      const dir = await mkdtemp(path.join(tmpdir(), "ay-reach-"));
      try {
        const fifo = path.join(dir, "stdin.fifo");
        if (spawnSync("mkfifo", [fifo]).status !== 0) return;
        const held = fs.openSync(fifo, fs.constants.O_RDWR);
        try {
          const log = await quietLog(dir);
          const mod = await loadModule();
          expect(await mod.deriveLiveState(rec({ log_file: log, fifo_file: fifo }))).toEqual({
            state: "idle",
            question: null,
          });
        } finally {
          fs.closeSync(held);
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
  );

  it.skipIf(!itUnix)(
    "does NOT call a freshly spawned agent unreachable — the spawn-race guard",
    async () => {
      // Both runtimes register the record BEFORE the reader opens the FIFO, so a
      // healthy agent has a reader-less FIFO for a moment at spawn. Its log is
      // fresh then, so the row reads `active` and is never probed. If this ever
      // reports `unreachable`, every new agent flashes dead on the way up.
      const { spawnSync } = await import("child_process");
      const dir = await mkdtemp(path.join(tmpdir(), "ay-reach-"));
      try {
        const fifo = path.join(dir, "stdin.fifo");
        if (spawnSync("mkfifo", [fifo]).status !== 0) return;
        const log = path.join(dir, "a.log");
        await writeFile(log, "starting up\n"); // fresh mtime → `active`
        const mod = await loadModule();
        expect(await mod.deriveLiveState(rec({ log_file: log, fifo_file: fifo }))).toEqual({
          state: "active",
          question: null,
        });
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
  );

  it.skipIf(!itUnix)(
    "does NOT probe a young agent that INHERITED a stale log — the recycled-log race",
    async () => {
      // The quiet half of the grace period is not enough on its own. Rust's log
      // writer opens `<pid>.raw.log` in APPEND mode, so a recycled pid can inherit
      // a previous agent's log file and look quiet from its first millisecond —
      // while its reader has not opened the FIFO yet. The AGE half is what covers
      // this: the record was created seconds ago, so nothing is concluded from it.
      const { spawnSync } = await import("child_process");
      const dir = await mkdtemp(path.join(tmpdir(), "ay-reach-"));
      try {
        const fifo = path.join(dir, "stdin.fifo");
        if (spawnSync("mkfifo", [fifo]).status !== 0) return;
        const log = await quietLog(dir); // inherited: mtime 5 minutes old
        const mod = await loadModule();
        const state = await mod.deriveLiveState(
          rec({ log_file: log, fifo_file: fifo, started_at: Date.now() - 1_000 }),
        );
        expect(state.state).not.toBe("unreachable");
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
  );

  // Portable: `fifo_file: null` with no FIFO on disk is ENOENT on every
  // platform, so this needs neither mkfifo nor an ENXIO-capable pipe.
  it("still probes an OLD record that has no log at all", async () => {
    // `log_file: null` reads `active` from the log heuristics because there is
    // nothing to judge by — it must not therefore become unprobeable, or a row
    // with no log could never be reported unreachable at all.
    const mod = await loadModule();
    expect(
      await mod.deriveLiveState(rec({ log_file: null, fifo_file: null, started_at: 0 })),
    ).toEqual({ state: "unreachable", question: null });
  });

  // Also a guard rather than a proof: `stopped` must keep winning, so a dead pid
  // is never reported by the more specific-sounding `unreachable`.
  // Portable: a stored exit short-circuits before any probe runs.
  it("agrees with ay status on an exited record whose pid has been recycled", async () => {
    // `ay ls` has always honoured a stored exit; `ay status` asked the OS alone,
    // so a recycled pid made it call an exited row alive — and, once this change
    // existed, `unreachable` — while `ay ls` said `stopped`. The two must not
    // disagree about whether a row can be given work.
    const mod = await loadModule();
    const exited = rec({ status: "exited", pid: process.pid, fifo_file: null });
    expect((await mod.deriveLiveState(exited)).state).toBe("stopped");
    expect((await mod.snapshotStatus(exited)).state).toBe("stopped");
  });

  it.skipIf(!itUnix)(
    "keeps reporting 'stopped' for a dead pid without probing anything",
    async () => {
      const mod = await loadModule();
      expect(await mod.deriveLiveState(rec({ pid: 2147483646 }))).toEqual({
        state: "stopped",
        question: null,
      });
    },
  );
});

describe("subcommands.cmdStop retiring an unreachable row", () => {
  // FIFO-backed, so unix-only — same reason as the other FIFO suites in this
  // file. On Windows `probeStdinReachable` returns "unknown" by design (named
  // pipes need a connect, not an open), so these assertions cannot hold there
  // and skipping is the honest outcome rather than a weaker expectation.
  const itUnix = process.platform === "linux" || process.platform === "darwin";

  async function registerStopTarget(fifoFile: string | null) {
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: process.pid,
      cli: "codex",
      prompt: "stop-reach-test",
      cwd: process.cwd(),
      log_file: null,
      fifo_file: fifoFile,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now() - 10 * 60 * 1000,
    });
  }

  async function statusOf(pid: number): Promise<string | undefined> {
    const { readGlobalPids } = await import("./globalPidIndex.ts");
    return (await readGlobalPids()).find((r) => r.pid === pid)?.status;
  }

  it.skipIf(!itUnix)("retires it WITHOUT sending any signal, and says why", async () => {
    // The only remedy that works on such a row: registry only. `ay send` points
    // here, so it has to actually work — that was the defect this replaces.
    const { spawnSync } = await import("child_process");
    const dir = await mkdtemp(path.join(tmpdir(), "ay-stop-"));
    try {
      const fifo = path.join(dir, "stdin.fifo");
      if (spawnSync("mkfifo", [fifo]).status !== 0) return;
      const mod = await loadModule();
      await registerStopTarget(fifo);
      const out: string[] = [];
      const origOut = process.stdout.write.bind(process.stdout);
      const origErr = process.stderr.write.bind(process.stderr);
      (process.stdout as any).write = (x: any) => (out.push(String(x)), true);
      (process.stderr as any).write = (x: any) => (out.push(String(x)), true);
      let code: number | null;
      try {
        code = await mod.runSubcommand(["bun", "cli.js", "stop", String(process.pid)]);
      } finally {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
      }
      expect(code).toBe(0);
      expect(out.join("")).toMatch(/unreachable/);
      expect(out.join("")).toMatch(/no shutdown command was sent/);
      expect(out.join("")).toMatch(/ps -p \d+ -o comm=/);
      expect(await statusOf(process.pid)).toBe("exited");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  });

  it.skipIf(!itUnix)(
    "does NOT retire a row that is merely quiet — the control that matters",
    async () => {
      // A reachable agent with nothing to say must survive `ay stop` reaching the
      // new branch: it has to fall through to the real shutdown path, leaving the
      // record active. A stop that retires quiet lanes is worse than the bug.
      const { spawnSync } = await import("child_process");
      const fs = await import("fs");
      const dir = await mkdtemp(path.join(tmpdir(), "ay-stop-"));
      try {
        const fifo = path.join(dir, "stdin.fifo");
        if (spawnSync("mkfifo", [fifo]).status !== 0) return;
        const held = fs.openSync(fifo, fs.constants.O_RDWR); // a live reader
        try {
          const mod = await loadModule();
          await registerStopTarget(fifo);
          const out: string[] = [];
          const origOut = process.stdout.write.bind(process.stdout);
          const origErr = process.stderr.write.bind(process.stderr);
          (process.stdout as any).write = (x: any) => (out.push(String(x)), true);
          (process.stderr as any).write = (x: any) => (out.push(String(x)), true);
          try {
            await mod.runSubcommand(["bun", "cli.js", "stop", String(process.pid)]);
          } finally {
            process.stdout.write = origOut;
            process.stderr.write = origErr;
          }
          expect(out.join("")).not.toMatch(/unreachable/);
          expect(await statusOf(process.pid)).not.toBe("exited");
        } finally {
          fs.closeSync(held);
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
  );
});

describe("subcommands.cmdSend unreachable exit status", () => {
  // FIFO-backed, so unix-only — same reason as the other FIFO suites in this
  // file. On Windows `probeStdinReachable` returns "unknown" by design (named
  // pipes need a connect, not an open), so these assertions cannot hold there
  // and skipping is the honest outcome rather than a weaker expectation.
  const itUnix = process.platform === "linux" || process.platform === "darwin";

  async function registerTarget(fifoFile: string | null) {
    const { appendGlobalPid } = await import("./globalPidIndex.ts");
    await appendGlobalPid({
      pid: process.pid,
      cli: "codex",
      prompt: "reach-test",
      cwd: process.cwd(),
      log_file: null,
      fifo_file: fifoFile,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
    });
  }

  function captureStderr() {
    const out: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => {
      out.push(String(s));
      return true;
    };
    return { out, restore: () => (process.stderr.write = orig) };
  }

  it.skipIf(!itUnix)(
    "exits SEND_EXIT_UNREACHABLE (not 1) for a FIFO nobody is reading",
    async () => {
      const { spawnSync } = await import("child_process");
      const dir = await mkdtemp(path.join(tmpdir(), "ay-reach-"));
      try {
        const fifo = path.join(dir, "stdin.fifo");
        if (spawnSync("mkfifo", [fifo]).status !== 0) return;
        const mod = await loadModule();
        await registerTarget(fifo);
        const cap = captureStderr();
        try {
          const code = await mod.runSubcommand([
            "bun",
            "cli.js",
            "send",
            String(process.pid),
            "hi",
          ]);
          expect(code).toBe(mod.SEND_EXIT_UNREACHABLE);
          expect(code).not.toBe(1);
          expect(cap.out.join("")).toMatch(/UNREACHABLE/);
          // The remedy it names must be one that WORKS on this row. `ay restart`
          // writes the shutdown command to this same FIFO and fails identically —
          // naming it was brief defect #1 reproduced inside its own fix.
          expect(cap.out.join("")).toMatch(/ay stop \d+/);
          expect(cap.out.join("")).toMatch(/Do NOT use ay restart/);
          expect(cap.out.join("")).toMatch(/ps -p \d+ -o comm=/);
        } finally {
          cap.restore();
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
  );

  it.skipIf(!itUnix)("uses the same status when the agent never registered a FIFO", async () => {
    const mod = await loadModule();
    await registerTarget(null);
    const cap = captureStderr();
    try {
      const code = await mod.runSubcommand(["bun", "cli.js", "send", String(process.pid), "hi"]);
      expect(code).toBe(mod.SEND_EXIT_UNREACHABLE);
      expect(cap.out.join("")).toMatch(/no fifo_file recorded/);
    } finally {
      cap.restore();
    }
  });

  // Ungated: it asserts an ordering that happens BEFORE any FIFO is touched, so
  // it needs no pipe and holds on Windows.
  it("reports an over-cap argv body immediately, without probing a dead target", async () => {
    // Load-bearing twice over. The reachability probe can wait up to two
    // seconds; an over-cap argv body is wrong whatever the target's state and
    // costs nothing to detect. Probing first would make a caller wait to be told
    // its own input was malformed, and would answer `unreachable` (3) for a send
    // that was never going to be made — hiding the real, actionable error behind
    // an incidental one.
    const mod = await loadModule();
    await registerTarget(null); // deliberately unreachable
    const cap = captureStderr();
    const started = Date.now();
    let code: number | null;
    try {
      code = await mod.runSubcommand([
        "bun",
        "cli.js",
        "send",
        String(process.pid),
        "x".repeat(5000),
      ]);
    } finally {
      cap.restore();
    }
    const elapsed = Date.now() - started;
    expect(code).toBe(1); // the caller error, NOT SEND_EXIT_UNREACHABLE
    expect(cap.out.join("")).toMatch(/over the \d+-char limit/);
    expect(cap.out.join("")).not.toMatch(/UNREACHABLE/);
    // Well under the 2s confirm window, so it cannot pass by having probed.
    expect(elapsed).toBeLessThan(1_000);
  });

  it.skipIf(!itUnix)("does not consume piped stdin when the target is unreachable", async () => {
    // A send that cannot land must not eat the caller's body: `-` is resolved
    // AFTER the reachability gate, so the text is still theirs to re-send.
    const mod = await loadModule();
    await registerTarget(null);
    const cap = captureStderr();
    let stdinRead = false;
    const orig = Object.getOwnPropertyDescriptor(process, "stdin")!;
    Object.defineProperty(process, "stdin", {
      configurable: true,
      get() {
        stdinRead = true;
        return orig.get ? orig.get.call(process) : orig.value;
      },
    });
    try {
      const code = await mod.runSubcommand(["bun", "cli.js", "send", String(process.pid), "-"]);
      expect(code).toBe(mod.SEND_EXIT_UNREACHABLE);
      expect(stdinRead).toBe(false);
    } finally {
      Object.defineProperty(process, "stdin", orig);
      cap.restore();
    }
  });

  it.skipIf(!itUnix)("exits the same way when the reader dies MID-SEND, end to end", async () => {
    // The window the preflight probe cannot cover, driven through cmdSend rather
    // than asserted on a predicate: reachable when the send starts, gone before
    // it finishes. `writeToIpc` opens per call, so the failure the SECOND write
    // meets here is ENXIO at open — EPIPE needs the reader to vanish inside one
    // write, which the sibling test below produces directly. Both errnos go
    // through the same catch, and this is the half that proves the catch is
    // wired to cmdSend's exit status at all.
    //
    // Hold the FIFO with a read-only fd: an O_RDWR fd would BE a reader forever
    // and the write could never fail.
    const { spawnSync } = await import("child_process");
    const fs = await import("fs");
    const dir = await mkdtemp(path.join(tmpdir(), "ay-epipe-"));
    const savedForce = process.env.AGENT_YES_FORCE_SEND;
    try {
      const fifo = path.join(dir, "stdin.fifo");
      if (spawnSync("mkfifo", [fifo]).status !== 0) return;
      const readFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      let closed = false;

      const mod = await loadModule();
      // No log_file: cmdSend then takes the plain "body, pause, trailing" path,
      // so there is a real gap between the two writes for the reader to vanish in.
      await registerTarget(fifo);
      process.env.AGENT_YES_FORCE_SEND = "1"; // this test is about delivery, not guards

      // Armed only NOW, after module load and registration: a watchdog started
      // before them can burn its deadline on a slow import under load, close the
      // reader before the send begins, and quietly turn this into a test of the
      // preflight probe instead of the mid-send path it is named for.
      const closeOnFirstByte = (async () => {
        const buf = Buffer.alloc(4096);
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          try {
            if (fs.readSync(readFd, buf, 0, buf.length, null) > 0) break;
          } catch (err: any) {
            if (err?.code !== "EAGAIN") break;
          }
          await new Promise((r) => setTimeout(r, 2));
        }
        fs.closeSync(readFd); // every reader gone → the next write fails
        closed = true;
      })();
      const cap = captureStderr();
      let code: number | null;
      try {
        code = await mod.runSubcommand(["bun", "cli.js", "send", String(process.pid), "hello"]);
      } finally {
        cap.restore();
      }
      await closeOnFirstByte;
      expect(closed).toBe(true);
      expect(code).toBe(mod.SEND_EXIT_UNREACHABLE);
      expect(cap.out.join("")).toMatch(/UNREACHABLE mid-send/);
    } finally {
      if (savedForce === undefined) delete process.env.AGENT_YES_FORCE_SEND;
      else process.env.AGENT_YES_FORCE_SEND = savedForce;
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  });

  it.skipIf(!itUnix)(
    "a reader lost INSIDE one write really does raise EPIPE, and it classifies",
    async () => {
      // Produces the errno rather than asserting a string: fill the pipe so
      // `writeToIpc` is looping on EAGAIN, then take the reader away mid-loop.
      // POSIX gives EPIPE for a write to a FIFO with no reader, and that is the
      // one shape a preflight open() can never predict.
      const { spawnSync } = await import("child_process");
      const fs = await import("fs");
      const dir = await mkdtemp(path.join(tmpdir(), "ay-epipe-"));
      try {
        const fifo = path.join(dir, "stdin.fifo");
        if (spawnSync("mkfifo", [fifo]).status !== 0) return;
        const readFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        const mod = await loadModule();
        // Far past any pipe buffer, and never drained, so the write backs up.
        const huge = "z".repeat(1024 * 1024);
        const write = mod.writeToIpc(fifo, huge);
        setTimeout(() => fs.closeSync(readFd), 50); // every reader gone, mid-write
        const err = await write.then(
          () => null,
          (e: NodeJS.ErrnoException) => e,
        );
        expect(err).not.toBeNull();
        expect(err!.code).toBe("EPIPE");
        expect(mod.isUnreachableWriteErrno(err!.code)).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
  );

  // Guard, not proof: pins that exit 1 keeps meaning "your call was wrong",
  // so introducing 3 did not quietly widen into the caller-error cases.
  it.skipIf(!itUnix)("does not refuse a target whose reader opens a moment later", async () => {
    // The send-side half of the sustained reading: a wrapper that is still
    // starting has no reader for a moment, and refusing delivery to it would be
    // the same false positive as listing it dead.
    const { spawnSync } = await import("child_process");
    const fs = await import("fs");
    const dir = await mkdtemp(path.join(tmpdir(), "ay-reach-"));
    try {
      const fifo = path.join(dir, "stdin.fifo");
      if (spawnSync("mkfifo", [fifo]).status !== 0) return;
      const mod = await loadModule();
      // Unreachable right now; a reader appears inside the confirm window.
      const late = setTimeout(() => fs.openSync(fifo, fs.constants.O_RDWR), 100);
      try {
        expect(mod.probeStdinReachable({ pid: process.pid, fifo_file: fifo })).toBe("unreachable");
        expect(await mod.confirmStdinUnreachable({ pid: process.pid, fifo_file: fifo })).toBe(
          false,
        );
      } finally {
        clearTimeout(late);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  });

  // Guard, not proof: pins that exit 1 keeps meaning "your call was wrong",
  // so introducing 3 did not quietly widen into the caller-error cases.
  it.skipIf(!itUnix)(
    "keeps 1 for an over-cap body — that is a caller error, not a dead row",
    async () => {
      const { spawnSync } = await import("child_process");
      const fs = await import("fs");
      const dir = await mkdtemp(path.join(tmpdir(), "ay-reach-"));
      try {
        const fifo = path.join(dir, "stdin.fifo");
        if (spawnSync("mkfifo", [fifo]).status !== 0) return;
        const held = fs.openSync(fifo, fs.constants.O_RDWR);
        try {
          const mod = await loadModule();
          await registerTarget(fifo);
          const cap = captureStderr();
          try {
            const code = await mod.runSubcommand([
              "bun",
              "cli.js",
              "send",
              String(process.pid),
              "x".repeat(5000), // far past any cap this CLI has shipped
            ]);
            expect(code).toBe(1);
            expect(cap.out.join("")).toMatch(/over the \d+-char limit/);
          } finally {
            cap.restore();
          }
        } finally {
          fs.closeSync(held);
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    },
  );
});
