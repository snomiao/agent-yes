import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _setPlatformPackageFromForTesting,
  chmodExtractedBinaries,
  devBuildInfo,
  ensureExecutable,
  findInPlatformPackage,
  findRustBinary,
  gcOldBinaryDirs,
  getBinaryName,
  getBinDir,
  getPlatformPackageBinDir,
  hasValidMacSignature,
  NATIVE_RUNNER,
  platformKey,
} from "./rustBinary.ts";
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

// The dev-build auto-rebuild used a `/`-only path match, so on Windows (where
// path.resolve yields backslashes) it never recognised target/release and a
// stale exe kept shipping bugs already fixed on main. Both separators must work.
describe("devBuildInfo", () => {
  it("recognises a POSIX dev build path", () => {
    expect(devBuildInfo("/repo/alpha/rs/target/release/agent-yes")).toEqual({
      rsDir: "/repo/alpha/rs",
      isRelease: true,
    });
    expect(devBuildInfo("/repo/alpha/rs/target/debug/agent-yes")).toEqual({
      rsDir: "/repo/alpha/rs",
      isRelease: false,
    });
  });

  it("recognises a Windows dev build path with backslashes and .exe", () => {
    expect(devBuildInfo(String.raw`C:\x\alpha\rs\target\release\agent-yes.exe`)).toEqual({
      rsDir: String.raw`C:\x\alpha\rs`,
      isRelease: true,
    });
    expect(devBuildInfo(String.raw`C:\x\alpha\rs\target\debug\agent-yes.exe`)).toEqual({
      rsDir: String.raw`C:\x\alpha\rs`,
      isRelease: false,
    });
  });

  it("returns undefined for a downloaded/cached binary", () => {
    expect(
      devBuildInfo("/home/alice/.cache/agent-yes/bin/1.2.3/agent-yes-linux-x64"),
    ).toBeUndefined();
    expect(
      devBuildInfo(String.raw`C:\x\.cache\agent-yes\bin\1.2.3\agent-yes-win32-x64.exe`),
    ).toBeUndefined();
  });
});

// A cached download that lost its code signature is SIGKILLed by macOS at exec
// (silent exit 137), so getRustBinary() must spot it and re-download.
describe("hasValidMacSignature", () => {
  it.skipIf(process.platform !== "darwin")("accepts a signed system binary", () => {
    const signed = path.join(root, "signed-ls");
    copyFileSync("/bin/ls", signed);
    expect(hasValidMacSignature(signed)).toBe(true);
  });

  it.skipIf(process.platform !== "darwin")("rejects an unsigned file", () => {
    const unsigned = path.join(root, "agent-yes-darwin-arm64-unsigned");
    writeFileSync(unsigned, "not a mach-o");
    expect(hasValidMacSignature(unsigned)).toBe(false);
  });

  it.skipIf(process.platform === "darwin")("always reports valid off macOS", () => {
    expect(hasValidMacSignature(path.join(root, "does-not-exist"))).toBe(true);
  });
});

// A release bundle arrives with whatever modes the packaging pipeline kept —
// in practice none. Only the main binary used to be chmod'ed, so ayrs was left
// non-executable and the daemon died with EACCES on every supervisor restart.
describe("chmodExtractedBinaries", () => {
  it("marks every extracted regular file executable and skips archives and dirs", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ay-bin-"));
    try {
      writeFileSync(path.join(dir, "agent-yes-linux-x64"), "#!/bin/sh\n", { mode: 0o644 });
      writeFileSync(path.join(dir, "ayrs"), "#!/bin/sh\n", { mode: 0o644 });
      writeFileSync(path.join(dir, "temp.tar.gz"), "x");
      mkdirSync(path.join(dir, "sub"));
      const fixed = await chmodExtractedBinaries(dir);
      expect(fixed.sort()).toEqual(["agent-yes-linux-x64", "ayrs"]);
      if (process.platform !== "win32") {
        expect(statSync(path.join(dir, "ayrs")).mode & 0o111).toBe(0o111);
        expect(statSync(path.join(dir, "temp.tar.gz")).mode & 0o111).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureExecutable", () => {
  it("repairs a present-but-not-executable binary and returns its path", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ay-bin-"));
    try {
      const p = path.join(dir, "ayrs");
      writeFileSync(p, "#!/bin/sh\n", { mode: 0o644 });
      expect(ensureExecutable(p)).toBe(p);
      if (process.platform !== "win32") expect(statSync(p).mode & 0o111).toBe(0o111);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A release can ship this version's binaries as npm platform packages
// (agent-yes@<version>-<platform>, installed as the optional dependency
// agent-yes-<platform>). The launcher must take them from there before it
// considers the download cache, and only when the version matches exactly.
describe("npm platform package", () => {
  const ext = process.platform === "win32" ? ".exe" : "";
  const key = platformKey();
  const pkgName = `agent-yes-${key}`;
  const devBuildPresent = ["release", "debug"].some((p) =>
    existsSync(path.resolve(import.meta.dirname, `../rs/target/${p}/agent-yes${ext}`)),
  );
  // getBinDir() is the checkout's own bin/ when that exists (it holds real
  // downloaded binaries there); the test below writes a stand-in into
  // getBinDir(), so it only runs when that is the temp cache set up above.
  const repoBinDirPresent = existsSync(path.resolve(import.meta.dirname, "../bin"));
  const supported = (() => {
    try {
      getBinaryName();
      return true;
    } catch {
      return false;
    }
  })();

  let base: string;
  // An installed agent-yes's dist/ dir, with the platform package at `layout`.
  function install(layout: "nested" | "hoisted", version: string, bins: string[]): string {
    const prefix = path.join(base, layout, "node_modules");
    const main = path.join(prefix, "agent-yes");
    mkdirSync(path.join(main, "dist"), { recursive: true });
    const platformDir =
      layout === "nested" ? path.join(main, "node_modules", pkgName) : path.join(prefix, pkgName);
    mkdirSync(path.join(platformDir, "bin"), { recursive: true });
    writeFileSync(
      path.join(platformDir, "package.json"),
      JSON.stringify({ name: "agent-yes", version }),
    );
    for (const b of bins)
      writeFileSync(path.join(platformDir, "bin", b + ext), "bin", { mode: 0o755 });
    return path.join(main, "dist");
  }

  beforeAll(() => {
    base = mkdtempSync(path.join(os.tmpdir(), "ay-platform-"));
  });
  afterAll(() => {
    _setPlatformPackageFromForTesting(null);
    rmSync(base, { recursive: true, force: true });
  });

  it("names the platform the way the packages do", () => {
    expect(key).toMatch(/^(linux|darwin|win32|freebsd|openbsd|sunos|aix)-[a-z0-9]+$/);
  });

  it("finds a nested platform package of this version", () => {
    const dist = install("nested", `1.272.0-${key}`, [NATIVE_RUNNER, "ayrs"]);
    _setPlatformPackageFromForTesting(dist);
    expect(getPlatformPackageBinDir()).toBe(
      path.join(path.dirname(dist), "node_modules", pkgName, "bin"),
    );
    expect(findInPlatformPackage("ayrs")).toBe(
      path.join(path.dirname(dist), "node_modules", pkgName, "bin", "ayrs" + ext),
    );
    expect(findInPlatformPackage("ay-spawn-hidden")).toBeUndefined();
  });

  it("finds a hoisted platform package of this version", () => {
    const dist = install("hoisted", `1.272.0-${key}`, [NATIVE_RUNNER]);
    _setPlatformPackageFromForTesting(dist);
    expect(getPlatformPackageBinDir()).toBe(
      path.join(path.dirname(path.dirname(dist)), pkgName, "bin"),
    );
  });

  it("ignores a platform package of another version", () => {
    const dist = install("nested", `1.271.0-${key}`, [NATIVE_RUNNER, "ayrs"]);
    _setPlatformPackageFromForTesting(dist);
    expect(getPlatformPackageBinDir()).toBeUndefined();
    expect(findInPlatformPackage("ayrs")).toBeUndefined();
  });

  it("finds nothing when no platform package is installed", () => {
    const dist = path.join(base, "bare", "node_modules", "agent-yes", "dist");
    mkdirSync(dist, { recursive: true });
    _setPlatformPackageFromForTesting(dist);
    expect(getPlatformPackageBinDir()).toBeUndefined();
  });

  it.skipIf(!supported || devBuildPresent || repoBinDirPresent)(
    "findRustBinary takes the runner from the platform package before the download cache",
    () => {
      const dist = install("nested", `1.272.0-${key}`, [NATIVE_RUNNER]);
      _setPlatformPackageFromForTesting(dist);
      const cached = path.join(getBinDir(), getBinaryName());
      expect(cached.startsWith(root)).toBe(true);
      mkdirSync(path.dirname(cached), { recursive: true });
      writeFileSync(cached, "bin");
      try {
        expect(findRustBinary()).toBe(
          path.join(path.dirname(dist), "node_modules", pkgName, "bin", NATIVE_RUNNER + ext),
        );
        // Without the platform package, the lookup is what it was before.
        _setPlatformPackageFromForTesting(
          path.join(base, "bare", "node_modules", "agent-yes", "dist"),
        );
        expect(findRustBinary()).toBe(cached);
      } finally {
        rmSync(cached, { force: true });
      }
    },
  );
});
