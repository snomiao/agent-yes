import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gcOldBinaryDirs } from "./rustBinary.ts";
import { _setInstalledPackageForTesting } from "./versionChecker.ts";

// Startup GC for the versioned binary download cache (PERFORMANCE-EVENT
// 2026-08-13): each release pins ~/.cache/agent-yes/bin/<version>/, and
// nothing used to delete the old ones. GC must remove ONLY strict x.y.z dirs
// strictly below the current version, and report the freed byte count.

const root = mkdtempSync(path.join(os.tmpdir(), "ay-gc-"));
const prevCacheDir = process.env.AGENT_YES_CACHE_DIR;

function seed(name: string, bytes: number): string {
  const dir = path.join(root, "agent-yes", "bin", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "agent-yes-darwin-arm64"), "x".repeat(bytes));
  return dir;
}

beforeAll(() => {
  process.env.AGENT_YES_CACHE_DIR = path.join(root, "agent-yes");
  _setInstalledPackageForTesting({ name: "agent-yes", version: "1.272.0" });
});

afterAll(() => {
  if (prevCacheDir === undefined) delete process.env.AGENT_YES_CACHE_DIR;
  else process.env.AGENT_YES_CACHE_DIR = prevCacheDir;
  _setInstalledPackageForTesting(null);
  rmSync(root, { recursive: true, force: true });
});

describe("gcOldBinaryDirs", () => {
  it("removes only strict x.y.z dirs strictly below the current version", () => {
    const oldA = seed("1.271.0", 10);
    const oldB = seed("1.256.1", 20);
    const current = seed("1.272.0", 5);
    const newer = seed("1.273.0", 7);
    const prerelease = seed("1.270.0-beta.0", 9);
    const junk = seed("temp", 3);

    const res = gcOldBinaryDirs();

    expect(res.removed.sort()).toEqual(["1.256.1", "1.271.0"]);
    expect(res.freedBytes).toBe(30);
    expect(existsSync(oldA)).toBe(false);
    expect(existsSync(oldB)).toBe(false);
    for (const keep of [current, newer, prerelease, junk]) {
      expect(existsSync(keep), `should keep ${keep}`).toBe(true);
    }
  });

  it("is idempotent — a second run removes nothing", () => {
    const res = gcOldBinaryDirs();
    expect(res.removed).toEqual([]);
    expect(res.freedBytes).toBe(0);
  });

  it("does nothing when the cache dir does not exist", () => {
    const prev = process.env.AGENT_YES_CACHE_DIR;
    process.env.AGENT_YES_CACHE_DIR = path.join(root, "does-not-exist");
    try {
      expect(gcOldBinaryDirs()).toEqual({ removed: [], freedBytes: 0 });
    } finally {
      process.env.AGENT_YES_CACHE_DIR = prev;
    }
  });

  it("does nothing when the current version is a pre-release", () => {
    _setInstalledPackageForTesting({ name: "agent-yes", version: "1.272.0-beta.0" });
    try {
      const res = gcOldBinaryDirs();
      expect(res.removed).toEqual([]);
      expect(res.freedBytes).toBe(0);
    } finally {
      _setInstalledPackageForTesting({ name: "agent-yes", version: "1.272.0" });
    }
  });
});
