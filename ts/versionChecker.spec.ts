import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { compareVersions, fetchLatestVersion, displayVersion } from "./versionChecker";

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
