import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSpawnTutorial,
  confirmAgentStarted,
  predictedLogPath,
  shouldForkNested,
  waitForRegistration,
} from "./forkNested";

describe("shouldForkNested", () => {
  it("forks when nested (AGENT_YES_PID set) and stdout is not a TTY", () => {
    expect(shouldForkNested({ isTTY: false, ayPid: "1234", attach: false })).toBe(true);
  });

  it("does NOT fork on an interactive TTY (a human running it directly)", () => {
    expect(shouldForkNested({ isTTY: true, ayPid: "1234", attach: false })).toBe(false);
  });

  it("does NOT fork when not nested — a human piping output has no AGENT_YES_PID", () => {
    expect(shouldForkNested({ isTTY: false, ayPid: undefined, attach: false })).toBe(false);
    expect(shouldForkNested({ isTTY: false, ayPid: "", attach: false })).toBe(false);
    expect(shouldForkNested({ isTTY: false, ayPid: "   ", attach: false })).toBe(false);
  });

  it("does NOT fork when attach opts out, regardless of context", () => {
    expect(shouldForkNested({ isTTY: false, ayPid: "1234", attach: true })).toBe(false);
  });
});

describe("waitForRegistration", () => {
  let home: string;
  let prevHome: string | undefined;

  const appendPid = (record: Record<string, unknown>) =>
    appendFileSync(path.join(home, "pids.jsonl"), JSON.stringify(record) + "\n");

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "ay-forknested-"));
    prevHome = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("resolves true once the pid registry has a live record for this pid", async () => {
    // Register the pid a poll-tick after the wait starts, like a real spawn.
    setTimeout(
      () =>
        appendPid({
          pid: 111,
          cli: "claude",
          prompt: null,
          cwd: "/tmp",
          log_file: null,
          status: "active",
          exit_code: null,
          exit_reason: null,
          started_at: Date.now(),
        }),
      60,
    );
    await expect(waitForRegistration(111, 2000)).resolves.toBe(true);
  });

  it("times out false when the agent never registers", async () => {
    await expect(waitForRegistration(222, 120)).resolves.toBe(false);
  });

  it("does NOT count a record whose status is already exited", async () => {
    appendPid({
      pid: 333,
      cli: "claude",
      prompt: null,
      cwd: "/tmp",
      log_file: null,
      status: "exited",
      exit_code: 1,
      exit_reason: "crash",
      started_at: Date.now(),
    });
    await expect(waitForRegistration(333, 120)).resolves.toBe(false);
  });

  it("fails fast when aborted() reports the child already died", async () => {
    const start = Date.now();
    await expect(waitForRegistration(444, 5000, () => true)).resolves.toBe(false);
    expect(Date.now() - start).toBeLessThan(1000); // no full-timeout wait
  });
});

describe("confirmAgentStarted", () => {
  let home: string;
  let proj: string;
  let prevHome: string | undefined;

  const appendPid = (record: Record<string, unknown>) =>
    appendFileSync(path.join(home, "pids.jsonl"), JSON.stringify(record) + "\n");

  const live = (pid: number, over: Record<string, unknown> = {}) => ({
    pid,
    cli: "claude",
    prompt: null,
    cwd: proj,
    log_file: null,
    status: "active",
    exit_code: null,
    exit_reason: null,
    started_at: Date.now(),
    ...over,
  });

  /** Write the raw log the wrapper produces once the CLI is really up. */
  const writeRawLog = (pid: number, body = "\x1b[?25l hello") => {
    mkdirSync(path.join(proj, ".agent-yes"), { recursive: true });
    writeFileSync(predictedLogPath(proj, pid), body);
  };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "ay-confirm-home-"));
    proj = mkdtempSync(path.join(tmpdir(), "ay-confirm-proj-"));
    prevHome = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  it("fails when the agent flips to exited inside the grace window — the #387 race", async () => {
    appendPid(live(501));
    setTimeout(
      () => appendPid(live(501, { status: "exited", exit_code: 1, exit_reason: "fatal" })),
      60,
    );
    const res = await confirmAgentStarted(501, 2000);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("exited during startup");
      expect(res.reason).toContain("fatal");
      expect(res.reason).toContain("ay tail 501");
    }
  });

  it("puts the agent's own error output in the failure message", async () => {
    const errLog = path.join(proj, "boom.log");
    writeFileSync(errLog, "error: unknown option '--cwd'\n");
    appendPid(
      live(502, { status: "exited", exit_code: 1, exit_reason: "fatal", log_file: errLog }),
    );
    const res = await confirmAgentStarted(502, 300);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("error: unknown option '--cwd'");
  });

  it("reports death even when the agent produced output before dying", async () => {
    writeRawLog(503);
    appendPid(live(503, { status: "exited", exit_code: 1, exit_reason: "fatal" }));
    // Liveness must never outrank the failure check within a tick.
    await expect(confirmAgentStarted(503, 300)).resolves.toMatchObject({ ok: false });
  });

  it("returns early once the raw log proves the CLI is up", async () => {
    appendPid(live(504));
    writeRawLog(504);
    const start = Date.now();
    await expect(confirmAgentStarted(504, 5000)).resolves.toEqual({ ok: true });
    expect(Date.now() - start).toBeLessThan(1000); // did not pay the whole grace
  });

  it("succeeds at the deadline when the agent is alive but quiet", async () => {
    appendPid(live(505));
    await expect(confirmAgentStarted(505, 250)).resolves.toEqual({ ok: true });
  });

  it("fails when aborted() reports the wrapper already died", async () => {
    appendPid(live(506));
    const res = await confirmAgentStarted(506, 5000, () => true);
    expect(res.ok).toBe(false);
  });

  it("fails when the record vanished — compaction drops dead+exited agents", async () => {
    const res = await confirmAgentStarted(507, 300);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("disappeared from the registry");
  });
});

describe("predictedLogPath", () => {
  it("matches the Rust wrapper's <cwd>/.agent-yes/<pid>.raw.log convention", () => {
    expect(predictedLogPath("/home/u/proj", 4242)).toBe(
      path.join("/home/u/proj", ".agent-yes", "4242.raw.log"),
    );
  });
});

describe("buildSpawnTutorial", () => {
  it("names the cli + pid and lists the drive commands with that pid", () => {
    const out = buildSpawnTutorial("claude", 4242);
    expect(out).toContain("Spawned claude agent as pid 4242");
    expect(out).toContain("ay tail 4242");
    expect(out).toContain("ay send 4242");
    expect(out).toContain("ay ls");
    expect(out).toContain("ay result get 4242");
    expect(out).toContain("ay exit 4242");
  });
});
