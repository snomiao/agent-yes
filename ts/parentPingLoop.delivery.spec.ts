/**
 * The half of startParentPingLoop that only runs once a spawner actually
 * resolves: the poll timer firing a ping, the suppression check, and pingExit.
 *
 * Split out from parentPingLoop.spec.ts rather than merged into it because
 * covering this half means mocking `resolveSpawner`, and those tests are
 * specifically about what the REAL resolver does with an absent/dead parent —
 * mocking it there would leave that rule untested.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Resolved per-test: the loop only arms its timer when this yields a spawner.
let spawner: { cli: string; pid: number; agentId: string | null; cwd: string } | null = null;
let resolveErr: Error | null = null;

vi.mock("./parentLink.ts", () => ({
  resolveSpawner: async () => {
    if (resolveErr) throw resolveErr;
    return spawner;
  },
}));

// deliverPing spawns a real `ay send` child process; stub the delivery but keep
// buildPingBody real so the body the parent would receive is still exercised.
const delivered: { target: string; body: string; selfWrapperPid: number }[] = [];
let deliverOk = true;

vi.mock("./parentPingSend.ts", async () => {
  const actual = await vi.importActual<typeof import("./parentPingSend.ts")>("./parentPingSend.ts");
  return {
    ...actual,
    deliverPing: async (opts: { target: string; body: string; selfWrapperPid: number }) => {
      delivered.push(opts);
      return deliverOk;
    },
  };
});

const CONF = {
  needsInput: [/❯ ?\d+\./m],
  working: [/esc to interrupt/],
  ready: [/^\s*❯\s*$/m],
};

const self = { cli: "claude", pid: 1, cwd: "/repo" };

async function loadLoop() {
  return (await import("./parentPingLoop.ts")).startParentPingLoop;
}

/** Let the `inFlight` promise chain inside send() drain. */
async function drain() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  delivered.length = 0;
  deliverOk = true;
  resolveErr = null;
  spawner = { cli: "claude", pid: 42, agentId: "agt_parent", cwd: "/parent" };
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startParentPingLoop delivery", () => {
  const base = {
    parentPid: 7,
    selfWrapperPid: 2,
    self: { ...self },
    patterns: CONF,
  };

  it("a pending menu on the first poll reports `stuck` to the parent's agent_id", async () => {
    vi.useFakeTimers();
    const startParentPingLoop = await loadLoop();
    const loop = startParentPingLoop({
      ...base,
      screen: () => ["Do you want to proceed?", "❯ 1. Yes", "  2. No"],
      pollMs: 1_000,
      mode: "always",
      now: () => 1_000,
    });

    await expect(loop.ready).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await drain();

    expect(delivered).toHaveLength(1);
    // Routed to the stable agent_id, never the parent's pid.
    expect(delivered[0].target).toBe("agt_parent");
    expect(delivered[0].selfWrapperPid).toBe(2);
    expect(delivered[0].body).toContain("is STUCK");
    // The tail the parent gets is the screen that justified the report.
    expect(delivered[0].body).toContain("Do you want to proceed?");
    loop.stop();
  });

  it("`never` suppresses the report but still consumes the episode", async () => {
    vi.useFakeTimers();
    const startParentPingLoop = await loadLoop();
    const loop = startParentPingLoop({
      ...base,
      screen: () => ["Do you want to proceed?", "❯ 1. Yes"],
      pollMs: 1_000,
      mode: "never",
      now: () => 1_000,
    });

    await expect(loop.ready).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await drain();

    expect(delivered).toHaveLength(0);
    loop.stop();
  });

  it("pingExit reports the exit code and stops the timer", async () => {
    const startParentPingLoop = await loadLoop();
    const loop = startParentPingLoop({
      ...base,
      screen: () => ["❯"],
      pollMs: 60_000,
      mode: "always",
      now: () => 1_000,
    });

    await expect(loop.ready).resolves.toBe(true);
    await loop.pingExit(3);

    expect(delivered).toHaveLength(1);
    expect(delivered[0].target).toBe("agt_parent");
    expect(delivered[0].body).toContain("has EXITED");
    expect(delivered[0].body).toContain("Exit code: 3");
  });

  it("pingExit still reports when the screen render throws", async () => {
    const startParentPingLoop = await loadLoop();
    const loop = startParentPingLoop({
      ...base,
      screen: () => {
        throw new Error("render race");
      },
      pollMs: 60_000,
      mode: "always",
      now: () => 1_000,
    });

    await expect(loop.ready).resolves.toBe(true);
    await loop.pingExit(null);

    expect(delivered).toHaveLength(1);
    expect(delivered[0].body).toContain("has EXITED");
    // No tail to attach, and a null exit code stays off the report entirely.
    expect(delivered[0].body).not.toContain("Last output:");
    expect(delivered[0].body).not.toContain("Exit code:");
  });

  it("an exit that fails to deliver is not thrown at the wrapper's exit path", async () => {
    deliverOk = false;
    const startParentPingLoop = await loadLoop();
    const loop = startParentPingLoop({
      ...base,
      screen: () => ["❯"],
      pollMs: 60_000,
      mode: "always",
      now: () => 1_000,
    });

    await expect(loop.ready).resolves.toBe(true);
    await expect(loop.pingExit(1)).resolves.toBeUndefined();
    expect(delivered).toHaveLength(1);
  });

  it("reports exactly once — the exit episode is terminal", async () => {
    const startParentPingLoop = await loadLoop();
    const loop = startParentPingLoop({
      ...base,
      screen: () => ["❯"],
      pollMs: 60_000,
      mode: "always",
      now: () => 1_000,
    });

    await loop.ready;
    await loop.pingExit(0);
    await loop.pingExit(0);

    expect(delivered).toHaveLength(1);
  });

  it("a spawner lookup that throws is treated as no parent, not a crash", async () => {
    resolveErr = new Error("registry exploded");
    const startParentPingLoop = await loadLoop();
    const loop = startParentPingLoop({
      ...base,
      screen: () => ["❯"],
      mode: "always",
    });

    await expect(loop.ready).resolves.toBe(false);
    await expect(loop.pingExit(0)).resolves.toBeUndefined();
    expect(delivered).toHaveLength(0);
  });

  it("a screen() hiccup mid-poll skips the tick instead of reporting a false state", async () => {
    vi.useFakeTimers();
    let throwNow = true;
    const startParentPingLoop = await loadLoop();
    const loop = startParentPingLoop({
      ...base,
      screen: () => {
        if (throwNow) throw new Error("render race");
        return ["Do you want to proceed?", "❯ 1. Yes"];
      },
      pollMs: 1_000,
      mode: "always",
      now: () => 1_000,
    });

    await expect(loop.ready).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await drain();
    expect(delivered).toHaveLength(0); // the throwing tick reported nothing

    throwNow = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await drain();
    expect(delivered).toHaveLength(1); // the next good tick still does

    loop.stop();
  });
});
