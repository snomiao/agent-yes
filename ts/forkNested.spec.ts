import { appendFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSpawnTutorial,
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

describe("buildSpawnTutorial — the parent's half of the contract", () => {
  it("offers the monitor route first, for a harness that has one", () => {
    const out = buildSpawnTutorial("claude", 4242);
    expect(out).toContain("ay ls --watch --json");
    expect(out).toContain("ay status 4242");
    expect(out).toContain("--wait-idle");
  });

  it("tells the parent the push is a fallback that yields to a watcher", () => {
    const out = buildSpawnTutorial("claude", 4242);
    expect(out).toContain("<ay-report");
    expect(out).toMatch(/finishes, gets stuck, or exits/);
    expect(out).toContain("stays quiet while you are actively watching");
  });

  it("still lists the drive commands (a parent may want to intervene early)", () => {
    const out = buildSpawnTutorial("codex", 7);
    expect(out).toContain("ay tail 7");
    expect(out).toContain(`ay send 7 "..."`);
  });
});
