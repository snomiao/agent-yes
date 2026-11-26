import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _setPlatformPackageFromForTesting,
  chmodExtractedBinaries,
  ensureExecutable,
  extractZipWindows,
  findInPlatformPackage,
  gcOldBinaryDirs,
  getPlatformPackageBinDir,
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

// Windows release bundles are .zip. Run from a PowerShell 7 session, the
// inherited PSModulePath made powershell.exe 5.1 load PS7's Archive module,
// whose Expand-Archive threw and extracted nothing while exiting 0 — so the
// download "succeeded" and the spawn then died with "Rust binary not found".
describe.skipIf(process.platform !== "win32")("extractZipWindows", () => {
  const sysRoot = process.env.SystemRoot || String.raw`C:\Windows`;
  const tarExe = path.join(sysRoot, "System32", "tar.exe");

  function makeZip(dir: string): string {
    const src = path.join(dir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(path.join(src, "agent-yes-win32-x64.exe"), "bin");
    writeFileSync(path.join(src, "ayrs.exe"), "ayrs");
    const zip = path.join(dir, "bundle.zip");
    const r = Bun.spawnSync([tarExe, "-a", "-cf", zip, "-C", src, "."]);
    expect(r.exitCode).toBe(0);
    return zip;
  }

  const poisonedModulePath = [
    String.raw`C:\Program Files\PowerShell\7\Modules`,
    String.raw`C:\Windows\system32\WindowsPowerShell\v1.0\Modules`,
  ].join(";");

  for (const via of ["tar", "Expand-Archive fallback"] as const) {
    it(`extracts every file via ${via} despite a PS7 PSModulePath`, async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "ay-zip-"));
      const prev = process.env.PSModulePath;
      try {
        const zip = makeZip(dir);
        const out = path.join(dir, "out");
        mkdirSync(out);
        process.env.PSModulePath = poisonedModulePath;
        // A tar.exe that doesn't exist forces the Expand-Archive fallback.
        await extractZipWindows(zip, out, via === "tar" ? undefined : path.join(dir, "no-tar.exe"));
        expect(existsSync(path.join(out, "agent-yes-win32-x64.exe"))).toBe(true);
        expect(existsSync(path.join(out, "ayrs.exe"))).toBe(true);
      } finally {
        if (prev === undefined) delete process.env.PSModulePath;
        else process.env.PSModulePath = prev;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("throws instead of returning silently on a corrupt zip", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ay-zip-"));
    try {
      const zip = path.join(dir, "bad.zip");
      writeFileSync(zip, "not a zip");
      await expect(extractZipWindows(zip, dir)).rejects.toThrow(/Failed to extract/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// bun:test port of the npm platform package cases in rustBinary.spec.ts: the
// launcher runs under bun, so the lookup is checked under bun as well.
describe("npm platform package", () => {
  const ext = process.platform === "win32" ? ".exe" : "";
  const key = platformKey();
  const pkgName = `agent-yes-${key}`;
  let base: string;
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

  it("finds a nested platform package of this version", () => {
    const dist = install("nested", `1.272.0-${key}`, [NATIVE_RUNNER, "ayrs"]);
    _setPlatformPackageFromForTesting(dist);
    const bin = path.join(path.dirname(dist), "node_modules", pkgName, "bin");
    expect(getPlatformPackageBinDir()).toBe(bin);
    expect(findInPlatformPackage("ayrs")).toBe(path.join(bin, "ayrs" + ext));
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
});
