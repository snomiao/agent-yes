import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { linkBunBinsToSystemPath } from "./systemPathLink.ts";

// The linker is POSIX-only by design (it targets /usr/local/bin; win32 returns
// null immediately), so the filesystem suite only runs on POSIX.
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
});

describe.skipIf(process.platform !== "win32")("systemPathLink on Windows", () => {
  it("is a no-op (returns null) — Windows uses a different PATH model", () => {
    expect(linkBunBinsToSystemPath()).toBeNull();
  });
});
