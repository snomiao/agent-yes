import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// trayApp.ts talks to the filesystem (hidden marker), the Rust tray launcher,
// and spawns processes via the Bun global. Mock all three so the tests are
// hermetic and run identically under both the bun and node test runtimes (the
// node job has no `Bun` global at all — we stub it in).

const mockFs = vi.hoisted(() => ({ existsSync: vi.fn().mockReturnValue(false) }));
const mockFsPromises = vi.hoisted(() => ({
  unlink: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));
const mockRustBinary = vi.hoisted(() => ({ findTrayLauncher: vi.fn().mockReturnValue(undefined) }));
const mockHome = vi.hoisted(() => ({ agentYesHome: vi.fn().mockReturnValue("/tmp/ay-home") }));

vi.mock("node:fs", () => ({ existsSync: mockFs.existsSync }));
vi.mock("node:fs/promises", () => ({
  unlink: mockFsPromises.unlink,
  writeFile: mockFsPromises.writeFile,
}));
vi.mock("./rustBinary.ts", () => ({ findTrayLauncher: mockRustBinary.findTrayLauncher }));
vi.mock("./agentYesHome.ts", () => ({ agentYesHome: mockHome.agentYesHome }));

const originalPlatform = process.platform;
function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

// Stub the Bun global's spawn so launchTray/stopTray never spawn real processes.
const spawnMock = vi.fn();
let originalBun: unknown;
function goodChild() {
  return { unref: vi.fn(), exited: Promise.resolve(0) };
}

async function loadTrayApp() {
  return await import("./trayApp.ts");
}

describe("trayApp", () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(false);
    mockFsPromises.unlink.mockResolvedValue(undefined);
    mockFsPromises.writeFile.mockResolvedValue(undefined);
    mockRustBinary.findTrayLauncher.mockReturnValue(undefined);
    mockHome.agentYesHome.mockReturnValue("/tmp/ay-home");
    spawnMock.mockReturnValue(goodChild());
    originalBun = (globalThis as { Bun?: unknown }).Bun;
    (globalThis as { Bun?: unknown }).Bun = { spawn: spawnMock };
    stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    (globalThis as { Bun?: unknown }).Bun = originalBun;
    setPlatform(originalPlatform);
    stdout.mockRestore();
    stderr.mockRestore();
  });

  describe("trayHiddenMarker / isTrayHidden", () => {
    it("marker sits under agentYesHome()", async () => {
      const { trayHiddenMarker } = await loadTrayApp();
      expect(trayHiddenMarker().replace(/\\/g, "/")).toBe("/tmp/ay-home/tray.hidden");
    });

    it("isTrayHidden reflects marker presence", async () => {
      const { isTrayHidden } = await loadTrayApp();
      mockFs.existsSync.mockReturnValue(true);
      expect(isTrayHidden()).toBe(true);
      mockFs.existsSync.mockReturnValue(false);
      expect(isTrayHidden()).toBe(false);
    });
  });

  describe("hasDesktop", () => {
    it("true on win32 and darwin", async () => {
      const { hasDesktop } = await loadTrayApp();
      setPlatform("win32");
      expect(hasDesktop()).toBe(true);
      setPlatform("darwin");
      expect(hasDesktop()).toBe(true);
    });

    it("linux depends on DISPLAY/WAYLAND_DISPLAY", async () => {
      const { hasDesktop } = await loadTrayApp();
      setPlatform("linux");
      const prevD = process.env.DISPLAY;
      const prevW = process.env.WAYLAND_DISPLAY;
      delete process.env.DISPLAY;
      delete process.env.WAYLAND_DISPLAY;
      expect(hasDesktop()).toBe(false);
      process.env.DISPLAY = ":0";
      expect(hasDesktop()).toBe(true);
      if (prevD === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = prevD;
      if (prevW === undefined) delete process.env.WAYLAND_DISPLAY;
      else process.env.WAYLAND_DISPLAY = prevW;
    });
  });

  describe("launchTray", () => {
    it("no-op (false) on a headless session", async () => {
      const { launchTray } = await loadTrayApp();
      setPlatform("linux");
      const prev = process.env.DISPLAY;
      delete process.env.DISPLAY;
      expect(launchTray()).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
      if (prev === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = prev;
    });

    it("no-op (false) when the user hid the tray", async () => {
      const { launchTray } = await loadTrayApp();
      setPlatform("darwin");
      mockFs.existsSync.mockReturnValue(true); // hidden marker present
      expect(launchTray()).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("no-op (false) when the tray binary is missing", async () => {
      const { launchTray } = await loadTrayApp();
      setPlatform("darwin");
      mockRustBinary.findTrayLauncher.mockReturnValue(undefined);
      expect(launchTray()).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("spawns detached and returns true when everything lines up", async () => {
      const { launchTray } = await loadTrayApp();
      setPlatform("darwin");
      mockRustBinary.findTrayLauncher.mockReturnValue("/opt/agent-yes-tray");
      const child = goodChild();
      spawnMock.mockReturnValue(child);
      expect(launchTray()).toBe(true);
      expect(spawnMock).toHaveBeenCalledWith(
        ["/opt/agent-yes-tray"],
        expect.objectContaining({ detached: true }),
      );
      expect(child.unref).toHaveBeenCalled();
    });

    it("returns false when the spawn throws", async () => {
      const { launchTray } = await loadTrayApp();
      setPlatform("darwin");
      mockRustBinary.findTrayLauncher.mockReturnValue("/opt/agent-yes-tray");
      spawnMock.mockImplementation(() => {
        throw new Error("spawn failed");
      });
      expect(launchTray()).toBe(false);
    });
  });

  describe("cmdTray", () => {
    it("status (default subcommand) prints state and returns 0", async () => {
      const { cmdTray } = await loadTrayApp();
      setPlatform("darwin");
      mockFs.existsSync.mockReturnValue(false);
      mockRustBinary.findTrayLauncher.mockReturnValue("/opt/agent-yes-tray");
      const code = await cmdTray([]);
      expect(code).toBe(0);
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("hidden:");
      expect(out).toContain("desktop:");
      expect(out).toContain("/opt/agent-yes-tray");
    });

    it("status shows hidden + headless + not-found variants", async () => {
      const { cmdTray } = await loadTrayApp();
      setPlatform("linux");
      const prev = process.env.DISPLAY;
      delete process.env.DISPLAY;
      mockFs.existsSync.mockReturnValue(true);
      mockRustBinary.findTrayLauncher.mockReturnValue(undefined);
      expect(await cmdTray(["status"])).toBe(0);
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("yes (run");
      expect(out).toContain("headless");
      expect(out).toContain("not found");
      if (prev === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = prev;
    });

    it("show on a headless session errors with code 1", async () => {
      const { cmdTray } = await loadTrayApp();
      setPlatform("linux");
      const prev = process.env.DISPLAY;
      delete process.env.DISPLAY;
      const code = await cmdTray(["show"]);
      expect(code).toBe(1);
      expect(mockFsPromises.unlink).toHaveBeenCalled(); // clears the marker first
      expect(String(stderr.mock.calls[0][0])).toContain("no desktop session");
      if (prev === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = prev;
    });

    it("show with no tray binary errors with code 1", async () => {
      const { cmdTray } = await loadTrayApp();
      setPlatform("darwin");
      mockRustBinary.findTrayLauncher.mockReturnValue(undefined);
      const code = await cmdTray(["show"]);
      expect(code).toBe(1);
      expect(String(stderr.mock.calls[0][0])).toContain("tray binary not found");
    });

    it("show launches the tray and returns 0", async () => {
      const { cmdTray } = await loadTrayApp();
      setPlatform("darwin");
      mockFs.existsSync.mockReturnValue(false);
      mockRustBinary.findTrayLauncher.mockReturnValue("/opt/agent-yes-tray");
      spawnMock.mockReturnValue(goodChild());
      const code = await cmdTray(["show"]);
      expect(code).toBe(0);
      expect(stdout.mock.calls.map((c) => String(c[0])).join("")).toContain("tray shown");
    });

    it("show reports 'not launched' when the spawn fails but still returns 0", async () => {
      const { cmdTray } = await loadTrayApp();
      setPlatform("darwin");
      mockRustBinary.findTrayLauncher.mockReturnValue("/opt/agent-yes-tray");
      spawnMock.mockImplementation(() => {
        throw new Error("nope");
      });
      const code = await cmdTray(["show"]);
      expect(code).toBe(0);
      expect(stdout.mock.calls.map((c) => String(c[0])).join("")).toContain("not launched");
    });

    it("hide writes the marker, kills the tray (win32 taskkill) and returns 0", async () => {
      const { cmdTray } = await loadTrayApp();
      setPlatform("win32");
      const code = await cmdTray(["hide"]);
      expect(code).toBe(0);
      expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("tray.hidden"),
        expect.any(String),
      );
      expect(spawnMock).toHaveBeenCalledWith(
        expect.arrayContaining(["taskkill", "/IM", "agent-yes-tray.exe", "/F"]),
        expect.anything(),
      );
    });

    it("hide uses pkill off-Windows and tolerates a spawn failure", async () => {
      const { cmdTray } = await loadTrayApp();
      setPlatform("linux");
      spawnMock.mockImplementation(() => {
        throw new Error("nothing to kill");
      });
      const code = await cmdTray(["hide"]);
      expect(code).toBe(0); // stopTray swallows the failure
    });

    it("show tolerates the marker unlink rejecting", async () => {
      const { cmdTray } = await loadTrayApp();
      setPlatform("darwin");
      mockFsPromises.unlink.mockRejectedValueOnce(new Error("ENOENT"));
      mockRustBinary.findTrayLauncher.mockReturnValue("/opt/agent-yes-tray");
      spawnMock.mockReturnValue(goodChild());
      expect(await cmdTray(["show"])).toBe(0);
    });

    it("hide tolerates the marker writeFile rejecting", async () => {
      const { cmdTray } = await loadTrayApp();
      setPlatform("linux");
      mockFsPromises.writeFile.mockRejectedValueOnce(new Error("EACCES"));
      expect(await cmdTray(["hide"])).toBe(0);
    });

    it("unknown subcommand errors with code 1", async () => {
      const { cmdTray } = await loadTrayApp();
      const code = await cmdTray(["wat"]);
      expect(code).toBe(1);
      expect(String(stderr.mock.calls[0][0])).toContain("unknown subcommand");
    });
  });
});
