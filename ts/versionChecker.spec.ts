import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  _setInstalledPackageForTesting,
  checkAndAutoUpdate,
  compareVersions,
  fetchLatestVersion,
  displayVersion,
  detectInstallMethod,
  getInstalledPackage,
  versionString,
} from "./versionChecker.ts";

vi.mock("execa", () => ({ execaCommand: vi.fn().mockResolvedValue({}) }));
vi.mock("fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    // Return false for .git / package.json lookups so neither the dev-checkout
    // guard nor getInstalledPackage's disk read fires during the auto-update tests.
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => {
      throw new Error("readFileSync not stubbed");
    }),
    lstatSync: actual.lstatSync,
    readlinkSync: actual.readlinkSync,
  };
});
vi.mock("child_process", () => ({
  execFileSync: vi.fn(() => {
    // Simulate successful re-exec by throwing an exit-like error
    const err = new Error("re-exec") as any;
    err.status = 0;
    throw err;
  }),
}));

describe("versionChecker", () => {
  describe("compareVersions", () => {
    it("should return 0 for equal versions", () => {
      expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
      expect(compareVersions("2.3.4", "2.3.4")).toBe(0);
    });

    it("should return 1 when v1 > v2", () => {
      expect(compareVersions("2.0.0", "1.0.0")).toBe(1);
      expect(compareVersions("1.1.0", "1.0.0")).toBe(1);
      expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
    });

    it("should return -1 when v1 < v2", () => {
      expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
      expect(compareVersions("1.0.0", "1.1.0")).toBe(-1);
      expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    });

    it("should handle versions with different segment counts", () => {
      expect(compareVersions("1.0", "1.0.0")).toBe(0);
      expect(compareVersions("1.0.0", "1.0")).toBe(0);
      expect(compareVersions("1.0.1", "1.0")).toBe(1);
      expect(compareVersions("1.0", "1.0.1")).toBe(-1);
    });
  });

  describe("fetchLatestVersion", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should return version from npm registry", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ version: "1.2.3" }),
      } as Response);

      const version = await fetchLatestVersion();
      expect(version).toBe("1.2.3");
    });

    it("should return null on non-ok response", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
      } as Response);

      const version = await fetchLatestVersion();
      expect(version).toBeNull();
    });

    it("should return null on network error", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("network error"));

      const version = await fetchLatestVersion();
      expect(version).toBeNull();
    });
  });

  describe("checkAndAutoUpdate", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      _setInstalledPackageForTesting(null);
      vi.stubGlobal("fetch", vi.fn());
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      // Use a mock for process.exit to prevent actual exit in tests
      vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      delete process.env.AGENT_YES_NO_UPDATE;
      delete process.env.AGENT_YES_UPDATED;
      delete process.env.BUN_INSTALL;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should skip when AGENT_YES_NO_UPDATE is set", async () => {
      process.env.AGENT_YES_NO_UPDATE = "1";
      await checkAndAutoUpdate();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("should skip when running from a git dev checkout", async () => {
      const fs = await import("fs");
      // Make the .git check return true so the dev-checkout guard triggers
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      await checkAndAutoUpdate();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("should skip when AGENT_YES_UPDATED matches current version", async () => {
      const pkg = await import("../package.json");
      process.env.AGENT_YES_UPDATED = pkg.default.version;
      await checkAndAutoUpdate();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("should use cached result within TTL and not install when up-to-date", async () => {
      const { readFile } = await import("fs/promises");
      vi.mocked(readFile).mockResolvedValueOnce(
        JSON.stringify({ checkedAt: Date.now(), latestVersion: "0.0.1" }) as any,
      );
      await checkAndAutoUpdate();
      expect(fetch).not.toHaveBeenCalled();
      expect(process.stderr.write).not.toHaveBeenCalled();
    });

    it("should install and re-exec from cache when cached version is newer and within TTL", async () => {
      const { readFile } = await import("fs/promises");
      const { execaCommand } = await import("execa");
      const { execFileSync } = await import("child_process");
      vi.mocked(readFile).mockResolvedValueOnce(
        JSON.stringify({ checkedAt: Date.now(), latestVersion: "999.0.0" }) as any,
      );
      await checkAndAutoUpdate();
      expect(execaCommand).toHaveBeenCalled();
      expect(execFileSync).toHaveBeenCalled();
      expect(process.exit).toHaveBeenCalled();
    });

    it("should fetch and write cache when stale, install and re-exec if behind", async () => {
      const { readFile, writeFile } = await import("fs/promises");
      const { execaCommand } = await import("execa");
      const { execFileSync } = await import("child_process");
      vi.mocked(readFile).mockRejectedValueOnce(new Error("no cache"));
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ version: "999.0.0" }),
      } as Response);
      await checkAndAutoUpdate();
      expect(writeFile).toHaveBeenCalled();
      expect(execaCommand).toHaveBeenCalled();
      expect(execFileSync).toHaveBeenCalled();
    });

    it("should fetch and write cache but not install if up-to-date", async () => {
      const { readFile, writeFile } = await import("fs/promises");
      const { execaCommand } = await import("execa");
      vi.mocked(readFile).mockRejectedValueOnce(new Error("no cache"));
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.0.1" }),
      } as Response);
      await checkAndAutoUpdate();
      expect(writeFile).toHaveBeenCalled();
      expect(execaCommand).not.toHaveBeenCalled();
    });

    it("should silently handle fetch failure", async () => {
      const { readFile } = await import("fs/promises");
      vi.mocked(readFile).mockRejectedValueOnce(new Error("no cache"));
      vi.mocked(fetch).mockRejectedValue(new Error("network error"));
      await expect(checkAndAutoUpdate()).resolves.toBeUndefined();
    });

    it("should use bun when BUN_INSTALL is set", async () => {
      process.env.BUN_INSTALL = "/home/user/.bun";
      const { readFile } = await import("fs/promises");
      const { execaCommand } = await import("execa");
      vi.mocked(readFile).mockRejectedValueOnce(new Error("no cache"));
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ version: "999.0.0" }),
      } as Response);
      await checkAndAutoUpdate();
      expect(vi.mocked(execaCommand).mock.calls[0]?.[0]).toContain("bun");
    });

    it("should print error and not throw when install fails", async () => {
      const { readFile } = await import("fs/promises");
      const { execaCommand } = await import("execa");
      vi.mocked(readFile).mockRejectedValueOnce(new Error("no cache"));
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ version: "999.0.0" }),
      } as Response);
      vi.mocked(execaCommand).mockRejectedValueOnce(new Error("install failed"));
      await expect(checkAndAutoUpdate()).resolves.toBeUndefined();
      expect(process.stderr.write).toHaveBeenCalledWith(
        expect.stringContaining("Auto-update failed"),
      );
    });
  });

  describe("displayVersion", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
      vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should log update available when behind", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ version: "999.0.0" }),
      } as Response);

      await displayVersion();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("update available"));
    });

    it("should log latest when versions match", async () => {
      const pkg = await import("../package.json");
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ version: pkg.default.version }),
      } as Response);

      await displayVersion();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("latest"));
    });

    it("should log latest published when ahead", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.0.1" }),
      } as Response);

      await displayVersion();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("latest published"));
    });

    it("should handle fetch failure gracefully", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("fail"));

      await displayVersion();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("unable to check"));
    });
  });

  describe("detectInstallMethod", () => {
    it("should return a string", () => {
      const method = detectInstallMethod();
      expect(typeof method).toBe("string");
      expect(method.length).toBeGreaterThan(0);
    });

    it("should return 'git' when .git exists in parent of script dir", async () => {
      const fs = await import("fs");
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      expect(detectInstallMethod()).toBe("git");
    });

    it("should return 'source' when not in node_modules and no .git", async () => {
      const fs = await import("fs");
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);
      expect(detectInstallMethod()).toBe("source");
    });
  });

  describe("versionString", () => {
    it("should include version and install method", () => {
      const str = versionString();
      expect(str).toContain("agent-yes v");
      expect(str).toMatch(/agent-yes v\d+\.\d+\.\d+ \(.+\)/);
    });
  });

  // Regression test for https://github.com/snomiao/agent-yes/issues/39:
  // a stale bundled version string must not pin the auto-update comparison
  // when a fresh package.json is on disk next to the running module.
  describe("getInstalledPackage (issue #39)", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      _setInstalledPackageForTesting(null);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      _setInstalledPackageForTesting(null);
    });

    it("prefers the on-disk package.json over the bundled (potentially stale) import", async () => {
      const fs = await import("fs");
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      vi.mocked(fs.readFileSync).mockReturnValueOnce(
        JSON.stringify({ name: "agent-yes", version: "999.0.0" }) as any,
      );

      const resolved = getInstalledPackage();
      expect(resolved.version).toBe("999.0.0");
      expect(resolved.name).toBe("agent-yes");
    });

    it("continues walking parents when a candidate package.json is unreadable", async () => {
      // Per-candidate try/catch: an unreadable/unparsable manifest at one
      // level must not abort the upward walk and silently fall back to the
      // bundled (stale) manifest. The walk must keep going until it finds
      // a matching package.json or exhausts parents.
      const fs = await import("fs");
      let call = 0;
      vi.mocked(fs.existsSync).mockImplementation(() => true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        call += 1;
        if (call === 1) throw new Error("EACCES");
        if (call === 2) return "{not json" as any;
        return JSON.stringify({ name: "agent-yes", version: "999.0.0" }) as any;
      });

      const resolved = getInstalledPackage();
      expect(resolved.version).toBe("999.0.0");
      expect(call).toBeGreaterThanOrEqual(3);
    });

    it("does not trigger an auto-update when on-disk version already matches the registry", async () => {
      // Simulate the post-fix scenario: the bundled `pkg.version` (frozen at
      // build time) is older than the registry, but the runtime resolver
      // surfaces the correct on-disk version and the comparison short-circuits.
      // Pre-fix behavior was install + reExec on every invocation → infinite loop.
      _setInstalledPackageForTesting({ name: "agent-yes", version: "999.0.0" });

      const { readFile } = await import("fs/promises");
      const { execaCommand } = await import("execa");
      vi.mocked(readFile).mockRejectedValueOnce(new Error("no cache"));
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ version: "999.0.0" }),
        } as Response),
      );
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      delete process.env.AGENT_YES_NO_UPDATE;
      delete process.env.AGENT_YES_UPDATED;

      await checkAndAutoUpdate();
      expect(execaCommand).not.toHaveBeenCalled();
    });
  });
});
