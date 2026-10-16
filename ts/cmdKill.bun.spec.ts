import { spawn } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { cmdKill, killRefusal, reusedWrapperPid } from "./cmdKill.ts";
import { appendGlobalPid, readGlobalPids } from "./globalPidIndex.ts";
import { register } from "./reaper.ts";

describe("killRefusal", () => {
  const chain = [3000, 2000];
  it("allows an unrelated agent", () => {
    expect(killRefusal({ pid: 1112, wrapper_pid: 1111 }, { pgid: 1112 }, chain, 2000)).toBe(null);
  });
  it("refuses when the agent or its wrapper is the caller or an ancestor", () => {
    expect(killRefusal({ pid: 3000 }, { pgid: null }, chain, 2000)).toMatch(/ancestors/);
    expect(killRefusal({ pid: 1112, wrapper_pid: 2000 }, { pgid: null }, chain, 2000)).toMatch(
      /wrapper pid 2000/,
    );
  });
  it("refuses when the recorded group is the caller's own group", () => {
    expect(killRefusal({ pid: 1112 }, { pgid: 2000 }, chain, 2000)).toMatch(/own group/);
  });
});

describe("reusedWrapperPid", () => {
  const NOW = 1_000_000_000_000;
  const record = { pid: 1112, wrapper_pid: 1111, started_at: NOW - 3_600_000 }; // 1 h ago
  it("flags a wrapper pid now held by a process younger than the registration", () => {
    const t = new Map([
      [1112, { ageSecs: 3_700 }],
      [1111, { ageSecs: 5 }],
    ]);
    expect(reusedWrapperPid(record, t, NOW)).toBe(1111);
  });
  it("keeps a wrapper that predates the registration, or that is unknown", () => {
    expect(reusedWrapperPid(record, new Map([[1111, { ageSecs: 3_700 }]]), NOW)).toBe(null);
    expect(reusedWrapperPid(record, new Map(), NOW)).toBe(null);
    expect(reusedWrapperPid({ ...record, wrapper_pid: 1112 }, new Map(), NOW)).toBe(null);
  });
});

describe.skipIf(process.platform === "win32")("ay kill <pid>", () => {
  let home: string;
  let prevHome: string | undefined;
  let out: string;
  let err: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "ay-kill-"));
    prevHome = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = home;
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c: any) => ((out += String(c)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((c: any) => ((err += String(c)), true));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  const row = (pid: number) => ({
    pid,
    cli: "claude",
    prompt: null,
    cwd: "/repo/alpha",
    log_file: null,
    status: "active" as const,
    exit_code: null,
    exit_reason: null,
    started_at: Date.now() - 5_000,
    wrapper_pid: pid,
  });
  const fakeAgent = async () => {
    // detached → its own process group, like a real agent's pty session.
    const child = spawn("sh", ["-c", "sleep 300 & wait"], { detached: true, stdio: "ignore" });
    child.unref();
    await new Promise((r) => setTimeout(r, 300)); // let the grandchild start
    await appendGlobalPid(row(child.pid!));
    await register(child.pid!, child.pid!);
    return child.pid!;
  };
  const groupAlive = (g: number) => {
    try {
      process.kill(-g, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("SIGKILLs the agent's whole process group and marks the row exited", async () => {
    const pid = await fakeAgent();
    expect(await cmdKill([String(pid)])).toBe(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(groupAlive(pid)).toBe(false); // the grandchild sleep is gone too
    expect(out).toMatch(new RegExp(`killed pid ${pid} .*group ${pid}`));
    expect((await readGlobalPids()).find((r) => r.pid === pid)?.status).toBe("exited");
  });

  it("--dry-run signals nothing", async () => {
    const pid = await fakeAgent();
    try {
      expect(await cmdKill([String(pid), "--dry-run"])).toBe(0);
      expect(out).toMatch(new RegExp(`would SIGKILL group ${pid}`));
      expect(groupAlive(pid)).toBe(true);
    } finally {
      process.kill(-pid, "SIGKILL");
    }
  });

  it("accepts only one exact pid: no keywords, ids, remotes or number coercion", async () => {
    for (const args of [[], ["alpha"], ["abcdef012345"], ["12e3"], ["box:1111"], ["1", "2"]]) {
      err = "";
      expect(await cmdKill(args)).toBe(1);
      expect(err).toMatch(/expected exactly one pid/);
    }
  });

  it("refuses a row already marked exited (its pid may have been reused)", async () => {
    await appendGlobalPid({ ...row(4242), status: "exited" });
    expect(await cmdKill(["4242"])).toBe(1);
    expect(err).toMatch(/registered as exited/);
  });

  it("a signal that fails (EPERM) is reported, and the row is not marked exited", async () => {
    const pid = await fakeAgent();
    const real = process.kill.bind(process);
    const spy = vi.spyOn(process, "kill").mockImplementation(((p: number, sig?: any) => {
      if (sig === "SIGKILL") throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return real(p, sig);
    }) as typeof process.kill);
    try {
      expect(await cmdKill([String(pid)])).toBe(1);
      expect(err).toMatch(/could not signal group \d+ \(EPERM\)/);
      expect((await readGlobalPids()).find((r) => r.pid === pid)?.status).toBe("active");
    } finally {
      spy.mockRestore();
      process.kill(-pid, "SIGKILL");
    }
  });

  it("refuses an unregistered pid", async () => {
    expect(await cmdKill(["99999999"])).toBe(1);
    expect(err).toMatch(/no registered agent has pid 99999999/);
  });

  it("refuses to kill the calling process itself", async () => {
    await appendGlobalPid(row(process.pid));
    expect(await cmdKill([String(process.pid)])).toBe(1);
    expect(err).toMatch(/this shell or one of its ancestors/);
  });
});
