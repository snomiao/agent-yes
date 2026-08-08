import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bunBinDir, linkBunBinsToSystemPath } from "./systemPathLink.ts";

// linkBunBinsToSystemPath is POSIX-only (win32 returns null by design), so the
// behavioural suite only runs where the function actually works.
describe.skipIf(process.platform === "win32")("systemPathLink.linkBunBinsToSystemPath", () => {
  let root: string;
  let bunDir: string;
  let target: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "ay-pathlink-"));
    bunDir = path.join(root, "bun", "bin");
    target = path.join(root, "usr-local-bin");
    mkdirSync(bunDir, { recursive: true });
    for (const name of ["ay", "cy", "qq"]) writeFileSync(path.join(bunDir, name), "#!/bin/sh\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("symlinks every bun bin into the target dir", () => {
    const r = linkBunBinsToSystemPath({ bunDir, target })!;
    expect(r.linked.sort()).toEqual(["ay", "cy", "qq"]);
    for (const name of ["ay", "cy", "qq"]) {
      const dest = path.join(target, name);
      expect(lstatSync(dest).isSymbolicLink()).toBe(true);
      expect(path.resolve(target, readlinkSync(dest))).toBe(path.join(bunDir, name));
    }
  });

  it("never clobbers a foreign (real) binary already in the target", () => {
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "cy"), "#!/bin/sh\n# a different real cy\n");
    const r = linkBunBinsToSystemPath({ bunDir, target })!;
    expect(r.linked.sort()).toEqual(["ay", "qq"]); // cy left alone
    expect(r.skipped).toContain("cy");
    expect(lstatSync(path.join(target, "cy")).isSymbolicLink()).toBe(false); // still the real file
  });

  it("is idempotent — re-running skips links it already owns", () => {
    linkBunBinsToSystemPath({ bunDir, target });
    const r2 = linkBunBinsToSystemPath({ bunDir, target })!;
    expect(r2.linked).toEqual([]);
    expect(r2.skipped.sort()).toEqual(["ay", "cy", "qq"]);
  });

  it("refreshes a dangling symlink it owns (name points into bunDir but target gone)", () => {
    mkdirSync(target, { recursive: true });
    // a stale link named "ay" pointing at a now-missing path INSIDE bunDir
    symlinkSync(path.join(bunDir, "ay-old-removed"), path.join(target, "ay"));
    const r = linkBunBinsToSystemPath({ bunDir, target })!;
    expect(r.refreshed).toContain("ay");
    expect(path.resolve(target, readlinkSync(path.join(target, "ay")))).toBe(path.join(bunDir, "ay"));
  });

  it("returns null when the bun dir is absent", () => {
    expect(linkBunBinsToSystemPath({ bunDir: path.join(root, "nope"), target })).toBeNull();
  });

  it("returns null when the target dir cannot be created", () => {
    // a FILE where the target dir should go → mkdirSync throws → best-effort null
    const blocked = path.join(root, "blocked");
    writeFileSync(blocked, "");
    expect(linkBunBinsToSystemPath({ bunDir, target: path.join(blocked, "bin") })).toBeNull();
  });

  it("leaves a foreign dangling symlink alone (dangles OUTSIDE bunDir)", () => {
    mkdirSync(target, { recursive: true });
    symlinkSync(path.join(root, "elsewhere", "ay"), path.join(target, "ay"));
    const r = linkBunBinsToSystemPath({ bunDir, target })!;
    expect(r.skipped).toContain("ay");
    expect(r.refreshed).toEqual([]);
    // still points at the foreign location
    expect(readlinkSync(path.join(target, "ay"))).toBe(path.join(root, "elsewhere", "ay"));
  });

  it("skips (not refreshes) a live symlink pointing elsewhere", () => {
    mkdirSync(target, { recursive: true });
    const other = path.join(root, "other-ay");
    writeFileSync(other, "#!/bin/sh\n");
    symlinkSync(other, path.join(target, "ay"));
    const r = linkBunBinsToSystemPath({ bunDir, target })!;
    expect(r.skipped).toContain("ay");
    expect(readlinkSync(path.join(target, "ay"))).toBe(other);
  });
});

describe("systemPathLink.bunBinDir", () => {
  it("resolves BUN_INSTALL/bin when it exists, null otherwise", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ay-bunbin-"));
    try {
      expect(bunBinDir({ BUN_INSTALL: root } as NodeJS.ProcessEnv)).toBeNull(); // no bin/ yet
      mkdirSync(path.join(root, "bin"));
      expect(bunBinDir({ BUN_INSTALL: root } as NodeJS.ProcessEnv)).toBe(path.join(root, "bin"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
