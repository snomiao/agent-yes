import { describe, expect, it } from "bun:test";
import { cmdDsh, type DshSpawn, dshTuiPrefix } from "./cmdDsh.ts";

/**
 * Records every spawn so the assertions can be about the ARGV that would be
 * executed, which is the whole contract of this module — it never interprets
 * dsh-tui's output, it only decides how to invoke it and forwards the rest.
 */
function recorder(behavior: (cmd: string[]) => number | Error): {
  spawn: DshSpawn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const spawn: DshSpawn = (cmd) => {
    calls.push(cmd);
    const outcome = behavior(cmd);
    if (outcome instanceof Error) throw outcome;
    return { exited: Promise.resolve(outcome) };
  };
  return { spawn, calls };
}

describe("dshTuiPrefix", () => {
  it("uses the bare bin when the probe exits 0 (dsh-tui already installed)", async () => {
    const { spawn, calls } = recorder(() => 0);
    expect(await dshTuiPrefix(spawn)).toEqual(["dsh-tui"]);
    expect(calls).toEqual([["dsh-tui", "--version"]]);
  });

  it("falls back to bunx when the probe exits non-zero", async () => {
    const { spawn } = recorder(() => 1);
    expect(await dshTuiPrefix(spawn)).toEqual(["bunx", "dsh-tui"]);
  });

  it("falls back to bunx when the probe throws (bin not on PATH)", async () => {
    // Bun.spawn raises rather than resolving non-zero when the program is
    // missing entirely, so this is a distinct path from the exit-code one.
    const { spawn } = recorder(() => new Error("ENOENT"));
    expect(await dshTuiPrefix(spawn)).toEqual(["bunx", "dsh-tui"]);
  });
});

describe("cmdDsh", () => {
  it("forwards args verbatim after the resolved prefix", async () => {
    const { spawn, calls } = recorder(() => 0);
    await cmdDsh(["alpha", "--flag", "x"], spawn);
    // [0] is the probe; [1] is the real launch.
    expect(calls[1]).toEqual(["dsh-tui", "alpha", "--flag", "x"]);
  });

  it("prefixes with bunx when dsh-tui is not installed", async () => {
    const { spawn, calls } = recorder((cmd) => (cmd[1] === "--version" ? 1 : 0));
    await cmdDsh(["alpha"], spawn);
    expect(calls[1]).toEqual(["bunx", "dsh-tui", "alpha"]);
  });

  it("does not intercept --help — it is forwarded so dsh-tui prints its own", async () => {
    const { spawn, calls } = recorder(() => 0);
    await cmdDsh(["--help"], spawn);
    expect(calls[1]).toEqual(["dsh-tui", "--help"]);
    const short = recorder(() => 0);
    await cmdDsh(["-h"], short.spawn);
    expect(short.calls[1]).toEqual(["dsh-tui", "-h"]);
  });

  it("runs with no args at all", async () => {
    const { spawn, calls } = recorder(() => 0);
    await cmdDsh([], spawn);
    expect(calls[1]).toEqual(["dsh-tui"]);
  });

  it("propagates the child's exit code", async () => {
    const { spawn } = recorder((cmd) => (cmd[1] === "--version" ? 0 : 42));
    expect(await cmdDsh(["alpha"], spawn)).toBe(42);
  });

  it("reports 0 when the child yields no exit code", async () => {
    // `proc.exited` is typed as possibly-undefined, hence the `?? 0` guard.
    const calls: string[][] = [];
    const spawn: DshSpawn = (cmd) => {
      calls.push(cmd);
      return {
        exited: Promise.resolve(cmd[1] === "--version" ? 0 : (undefined as unknown as number)),
      };
    };
    expect(await cmdDsh(["alpha"], spawn)).toBe(0);
  });
});
