import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock systray2 before imports
const mockSysTray = vi.hoisted(() => {
  const instance = {
    ready: vi.fn().mockResolvedValue(undefined),
    onClick: vi.fn(),
    sendAction: vi.fn(),
    kill: vi.fn(),
  };
  const MockClass = vi.fn().mockImplementation(function (this: any) {
    Object.assign(this, instance);
    return this;
  }) as any;
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

// Mock fs for PID file operations
const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(false),
}));
const mockFsPromises = vi.hoisted(() => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(""),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("fs", () => ({ existsSync: mockFs.existsSync }));
vi.mock("fs/promises", () => mockFsPromises);

// Mock child_process for ensureTray
const mockSpawn = vi.hoisted(() => {
  const child = { unref: vi.fn() };
  return { spawn: vi.fn().mockReturnValue(child), child };
});

vi.mock("child_process", () => ({ spawn: mockSpawn.spawn }));

describe("tray", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRunningAgentCount.mockResolvedValue({ count: 0, tasks: [] });
    mockFs.existsSync.mockReturnValue(false);
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
      // Should write PID file
      expect(mockFsPromises.writeFile).toHaveBeenCalled();

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

      const items = menuArg.menu.items;
      expect(items[0].title).toBe("Running agents: 2");
      expect(items[2].title).toContain("[1234]");
      expect(items[2].title).toContain("project-a");
      expect(items[3].title).toContain("[5678]");
      expect(items[3].title).toContain("project-b");
      expect(items[items.length - 1].title).toBe("Quit Tray");

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("should handle quit menu click", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      const { startTray } = await import("./tray.ts");
      await startTray();

      const onClickCb = mockSysTray.instance.onClick.mock.calls[0][0];
      onClickCb({ item: { title: "Quit Tray" } });

      expect(mockSysTray.instance.kill).toHaveBeenCalledWith(false);
      // removeTrayPid is called (unlink)
      await vi.waitFor(() => expect(mockExit).toHaveBeenCalledWith(0));

      mockExit.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("should update tray when agent count changes", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });
      vi.useFakeTimers();

      const { startTray } = await import("./tray.ts");
      await startTray();

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

      await vi.advanceTimersByTimeAsync(2100);

      expect(mockSysTray.instance.sendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "update-menu",
          menu: expect.objectContaining({ title: "AY: 3" }),
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

    it("should skip if tray already running", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });

      // Simulate existing tray PID file with a live process (our own PID)
      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue(String(process.pid));

      const { startTray } = await import("./tray.ts");
      await startTray();

      // Should NOT create systray because one is already running
      expect(mockSysTray.MockClass).not.toHaveBeenCalled();

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });
  });

  describe("isTrayRunning", () => {
    it("should return false when no PID file exists", async () => {
      mockFs.existsSync.mockReturnValue(false);

      const { isTrayRunning } = await import("./tray.ts");
      expect(await isTrayRunning()).toBe(false);
    });

    it("should return false when PID file has invalid content", async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue("not-a-number");

      const { isTrayRunning } = await import("./tray.ts");
      expect(await isTrayRunning()).toBe(false);
    });

    it("should return true when PID file points to a running process", async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue(String(process.pid));

      const { isTrayRunning } = await import("./tray.ts");
      expect(await isTrayRunning()).toBe(true);
    });

    it("should return false when PID file points to a dead process", async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue("999999999");

      const { isTrayRunning } = await import("./tray.ts");
      expect(await isTrayRunning()).toBe(false);
    });
  });

  describe("ensureTray", () => {
    it("should spawn tray on macOS when not running", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockFs.existsSync.mockReturnValue(false);

      const { ensureTray } = await import("./tray.ts");
      await ensureTray();

      expect(mockSpawn.spawn).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining(["--tray", "--no-rust"]),
        expect.objectContaining({ detached: true, stdio: "ignore" }),
      );
      expect(mockSpawn.child.unref).toHaveBeenCalled();

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("should not spawn on Linux", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux" });

      const { ensureTray } = await import("./tray.ts");
      await ensureTray();

      expect(mockSpawn.spawn).not.toHaveBeenCalled();

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("should not spawn if tray already running", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });

      // Simulate existing tray
      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue(String(process.pid));

      const { ensureTray } = await import("./tray.ts");
      await ensureTray();

      expect(mockSpawn.spawn).not.toHaveBeenCalled();

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });
  });
});
