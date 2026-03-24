import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock systray2 before imports
const mockSysTray = vi.hoisted(() => {
  const instance = {
    ready: vi.fn().mockResolvedValue(undefined),
    onClick: vi.fn(),
    sendAction: vi.fn(),
    kill: vi.fn(),
  };
  const MockClass = vi.fn().mockImplementation(function (this: any, opts: any) {
    Object.assign(this, instance);
    (MockClass as any).__lastOpts = opts;
    return this;
  }) as any;
  MockClass.__lastOpts = null;
  return {
    instance,
    MockClass,
  };
});

vi.mock("systray2", () => ({
  default: mockSysTray.MockClass,
}));

// Mock runningLock
const mockGetRunningAgentCount = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ count: 0, tasks: [] }),
);

vi.mock("./runningLock.ts", () => ({
  getRunningAgentCount: mockGetRunningAgentCount,
}));

describe("tray", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRunningAgentCount.mockResolvedValue({ count: 0, tasks: [] });
  });

  describe("startTray", () => {
    it("should create a systray instance on macOS", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });

      const { startTray } = await import("./tray.ts");
      await startTray();

      expect(mockSysTray.MockClass).toHaveBeenCalledWith(
        expect.objectContaining({
          menu: expect.objectContaining({
            title: "AY: 0",
            tooltip: "agent-yes: 0 running",
          }),
        }),
      );
      expect(mockSysTray.instance.ready).toHaveBeenCalled();
      expect(mockSysTray.instance.onClick).toHaveBeenCalled();

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("should show running agent count and task details", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });

      mockGetRunningAgentCount.mockResolvedValue({
        count: 2,
        tasks: [
          {
            pid: 1234,
            cwd: "/home/user/project-a",
            task: "fix bugs",
            status: "running",
            startedAt: Date.now(),
            lockedAt: Date.now(),
          },
          {
            pid: 5678,
            cwd: "/home/user/project-b",
            task: "add tests",
            status: "running",
            startedAt: Date.now(),
            lockedAt: Date.now(),
          },
        ],
      });

      const { startTray } = await import("./tray.ts");
      await startTray();

      const menuArg = mockSysTray.MockClass.mock.calls[0][0];
      expect(menuArg.menu.title).toBe("AY: 2");
      expect(menuArg.menu.tooltip).toBe("agent-yes: 2 running");

      // Should have: header, separator, 2 agent items, separator, quit
      const items = menuArg.menu.items;
      expect(items[0].title).toBe("Running agents: 2");
      expect(items[2].title).toContain("[1234]");
      expect(items[2].title).toContain("project-a");
      expect(items[3].title).toContain("[5678]");
      expect(items[3].title).toContain("project-b");

      // Last item should be "Quit Tray"
      expect(items[items.length - 1].title).toBe("Quit Tray");

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("should handle quit menu click", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });

      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      const { startTray } = await import("./tray.ts");
      await startTray();

      // Get the onClick callback
      const onClickCb = mockSysTray.instance.onClick.mock.calls[0][0];

      // Simulate "Quit Tray" click
      onClickCb({ item: { title: "Quit Tray" } });

      expect(mockSysTray.instance.kill).toHaveBeenCalledWith(false);
      expect(mockExit).toHaveBeenCalledWith(0);

      mockExit.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("should update tray when agent count changes", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });

      vi.useFakeTimers();

      const { startTray } = await import("./tray.ts");
      await startTray();

      // Now simulate agent count change on next poll
      mockGetRunningAgentCount.mockResolvedValue({
        count: 3,
        tasks: [
          {
            pid: 111,
            cwd: "/a",
            task: "t1",
            status: "running" as const,
            startedAt: 0,
            lockedAt: 0,
          },
          {
            pid: 222,
            cwd: "/b",
            task: "t2",
            status: "running" as const,
            startedAt: 0,
            lockedAt: 0,
          },
          {
            pid: 333,
            cwd: "/c",
            task: "t3",
            status: "running" as const,
            startedAt: 0,
            lockedAt: 0,
          },
        ],
      });

      // Advance timer past poll interval
      await vi.advanceTimersByTimeAsync(2100);

      expect(mockSysTray.instance.sendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "update-menu",
          menu: expect.objectContaining({
            title: "AY: 3",
          }),
        }),
      );

      vi.useRealTimers();
      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("should not update tray when agent count stays the same", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });

      vi.useFakeTimers();

      const { startTray } = await import("./tray.ts");
      await startTray();

      // Same count on next poll
      mockGetRunningAgentCount.mockResolvedValue({ count: 0, tasks: [] });

      await vi.advanceTimersByTimeAsync(2100);

      expect(mockSysTray.instance.sendAction).not.toHaveBeenCalled();

      vi.useRealTimers();
      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("should work on Windows", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });

      const { startTray } = await import("./tray.ts");
      await startTray();

      expect(mockSysTray.MockClass).toHaveBeenCalled();

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("should skip on Linux", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux" });

      const { startTray } = await import("./tray.ts");
      await startTray();

      expect(mockSysTray.MockClass).not.toHaveBeenCalled();

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });
  });
});
