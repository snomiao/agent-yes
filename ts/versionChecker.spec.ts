import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  checkAndAutoUpdate,
  compareVersions,
  fetchLatestVersion,
  displayVersion,
} from "./versionChecker";

vi.mock("execa", () => ({ execaCommand: vi.fn().mockResolvedValue({}) }));
vi.mock("fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
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
      vi.stubGlobal("fetch", vi.fn());
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      delete process.env.AGENT_YES_NO_UPDATE;
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

    it("should use cached result within TTL and not install when up-to-date", async () => {
      const { readFile } = await import("fs/promises");
      vi.mocked(readFile).mockResolvedValueOnce(
        JSON.stringify({ checkedAt: Date.now(), latestVersion: "0.0.1" }) as any,
      );
      await checkAndAutoUpdate();
      expect(fetch).not.toHaveBeenCalled();
      expect(process.stderr.write).not.toHaveBeenCalled();
    });

    it("should install from cache when cached version is newer and within TTL", async () => {
      const { readFile } = await import("fs/promises");
      const { execaCommand } = await import("execa");
      vi.mocked(readFile).mockResolvedValueOnce(
        JSON.stringify({ checkedAt: Date.now(), latestVersion: "999.0.0" }) as any,
      );
      await checkAndAutoUpdate();
      expect(execaCommand).toHaveBeenCalled();
    });

    it("should fetch and write cache when stale, install if behind", async () => {
      const { readFile, writeFile } = await import("fs/promises");
      const { execaCommand } = await import("execa");
      vi.mocked(readFile).mockRejectedValueOnce(new Error("no cache"));
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ version: "999.0.0" }),
      } as Response);
      await checkAndAutoUpdate();
      expect(writeFile).toHaveBeenCalled();
      expect(execaCommand).toHaveBeenCalled();
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
});
