import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { rm, mkdir } from "fs/promises";
import path from "path";
import { withIpcLock, ipcLockTarget } from "./ipcLock.ts";

const isWindows = process.platform === "win32";
const HOME = isWindows
  ? path.join(process.env.TEMP || "C:\\Temp", "ipclock-test-" + process.pid)
  : "/tmp/ipclock-test-" + process.pid;

let prevHome: string | undefined;

beforeEach(async () => {
  prevHome = process.env.AGENT_YES_HOME;
  process.env.AGENT_YES_HOME = HOME;
  await rm(HOME, { recursive: true, force: true });
  await mkdir(HOME, { recursive: true });
});
afterEach(async () => {
  await rm(HOME, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.AGENT_YES_HOME;
  else process.env.AGENT_YES_HOME = prevHome;
});

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withIpcLock", () => {
  it("serialises transactions for the same agent — no interleaving", async () => {
    const order: string[] = [];
    // Each "transaction" is multi-step with a gap in the middle, mirroring
    // `ay send` (body → 200ms settle → Enter). Without the lock the two
    // interleave as A-start, B-start, A-end, B-end.
    const txn = (name: string) =>
      withIpcLock(1234, async () => {
        order.push(`${name}-start`);
        await tick(20);
        order.push(`${name}-end`);
      });

    await Promise.all([txn("A"), txn("B")]);

    expect(order).toHaveLength(4);
    // Whichever ran first, its two halves are adjacent.
    expect(order[0]!.replace("-start", "")).toBe(order[1]!.replace("-end", ""));
    expect(order[2]!.replace("-start", "")).toBe(order[3]!.replace("-end", ""));
  });

  it("does not serialise across DIFFERENT agents — one busy agent must not stall another", async () => {
    const running: number[] = [];
    let maxConcurrent = 0;
    const txn = (pid: number) =>
      withIpcLock(pid, async () => {
        running.push(pid);
        maxConcurrent = Math.max(maxConcurrent, running.length);
        await tick(20);
        running.pop();
      });
    await Promise.all([txn(1), txn(2), txn(3)]);
    expect(maxConcurrent).toBe(3);
  });

  it("is reentrant within one process — a nested acquire must not deadlock the agent's input", async () => {
    // proper-lockfile is not reentrant; without the guard this would block for
    // the full acquire budget and then fail open, i.e. 12s of no input.
    const result = await withIpcLock(1234, async () => withIpcLock(1234, async () => "inner ran"));
    expect(result).toBe("inner ran");
  });

  it("releases on failure, so one throwing transaction does not wedge the agent", async () => {
    await expect(
      withIpcLock(1234, async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    // Still acquirable immediately afterwards.
    await expect(withIpcLock(1234, async () => "ok")).resolves.toBe("ok");
  });

  it("propagates the transaction's return value", async () => {
    await expect(withIpcLock(7, async () => 42)).resolves.toBe(42);
  });

  it("keys the lock under AGENT_YES_HOME, not beside the FIFO (a Windows named pipe has no sibling path)", () => {
    expect(ipcLockTarget(99)).toBe(path.join(HOME, "locks", "ipc-99"));
  });

  it("FAILS OPEN: if the lock cannot be taken, the write still happens and the caller is told", async () => {
    // Point AGENT_YES_HOME at a path that cannot hold a lockfile, so acquiring
    // genuinely fails rather than being simulated.
    process.env.AGENT_YES_HOME = path.join(HOME, "not-a-dir");
    await rm(path.join(HOME, "not-a-dir"), { recursive: true, force: true });
    const { writeFile } = await import("fs/promises");
    await writeFile(path.join(HOME, "not-a-dir"), "i am a file, not a directory");

    let reason: string | null = null;
    // The point of failing open: input delivery must never become MORE fragile
    // than it was before the lock existed.
    await expect(
      withIpcLock(
        1234,
        async () => "delivered anyway",
        (r) => (reason = r),
      ),
    ).resolves.toBe("delivered anyway");
    expect(reason).not.toBeNull();
  });
});
