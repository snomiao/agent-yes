import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSpawnTutorial, shouldForkNested, waitForFifo } from "./forkNested";

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

describe("waitForFifo", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "ay-forknested-"));
    mkdirSync(path.join(home, "fifo"), { recursive: true });
    prevHome = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("resolves true as soon as the wrapper's stdin FIFO is registered", async () => {
    // Register the endpoint a poll-tick after the wait starts, like a real spawn.
    setTimeout(() => writeFileSync(path.join(home, "fifo", "111.stdin"), ""), 60);
    await expect(waitForFifo(111, 2000)).resolves.toBe(true);
  });

  it("times out false when the child never registers", async () => {
    await expect(waitForFifo(222, 120)).resolves.toBe(false);
  });

  it("fails fast when aborted() reports the child already died", async () => {
    const start = Date.now();
    await expect(waitForFifo(333, 5000, () => true)).resolves.toBe(false);
    expect(Date.now() - start).toBeLessThan(1000); // no full-timeout wait
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
