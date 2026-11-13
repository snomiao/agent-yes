import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./globalPidIndex.ts", () => ({ readGlobalPids: io.read }));
import { launchingCli, warnIfCwdOccupied } from "./cwdConflictWarn.ts";

describe("launch conflict warning IO", () => {
  beforeEach(() => {
    vi.stubEnv("AGENT_YES_NO_CWD_WARN", "0");
    io.read.mockReset().mockResolvedValue([]);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  it("handles missing argv, opt-out, empty discovery and discovery errors", async () => {
    expect(launchingCli([])).toBeNull();
    vi.stubEnv("AGENT_YES_NO_CWD_WARN", "1");
    await warnIfCwdOccupied([]);
    expect(io.read).not.toHaveBeenCalled();
    vi.stubEnv("AGENT_YES_NO_CWD_WARN", "0");
    await warnIfCwdOccupied([]);
    expect(process.stderr.write).not.toHaveBeenCalled();
    io.read.mockRejectedValue(new Error("registry unavailable"));
    await expect(warnIfCwdOccupied([])).resolves.toBeUndefined();
  });
  it.each([false, true])(
    "warns only for matching cwd and pauses only on a TTY (%s)",
    async (tty) => {
      vi.useFakeTimers();
      const old = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: tty });
      io.read.mockResolvedValue([
        { pid: 1111, cli: "claude", cwd: process.cwd() },
        { pid: 2222, cli: "codex", cwd: "/unrelated/repo" },
      ]);
      try {
        const pending = warnIfCwdOccupied(["bun", "agent-yes.js", "claude", "two words"]);
        await vi.runAllTimersAsync();
        await pending;
        expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("1111  claude"));
        expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("'two words'"));
      } finally {
        if (old) Object.defineProperty(process.stdout, "isTTY", old);
        else Reflect.deleteProperty(process.stdout, "isTTY");
      }
    },
  );
});
