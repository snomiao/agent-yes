import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isExecutableFile, resolveOnPath, resolveProgram } from "./resolveBinary.ts";

// Issue #138: a cwd entry named like the agent CLI used to shadow the real
// binary inside portable-pty (reached via bun-pty), killing the forked child
// with "fatal runtime error: assertion failed: output.write(&bytes).is_ok()".
// Resolution must consult PATH only, and only accept runnable files.

const isWindows = process.platform === "win32";
const root = mkdtempSync(path.join(os.tmpdir(), "ay-resolve-"));

// resolveOnPath takes an injected probe, so these run on every platform —
// including the Windows CI leg, where resolveProgram itself short-circuits.
describe("resolveOnPath", () => {
  const binDir = path.join(root, "bin");
  const real = path.join(binDir, "ayfake");
  // Only `real` is runnable; anything else the walk considers must be rejected.
  const isExec = (candidate: string) => candidate === real;

  it("returns the PATH entry that is actually runnable", () => {
    expect(resolveOnPath("ayfake", binDir, isExec)).toBe(real);
  });

  it("skips PATH entries that are not runnable and keeps walking", () => {
    const decoys = [path.join(root, "a"), path.join(root, "b")].join(path.delimiter);
    expect(resolveOnPath("ayfake", `${decoys}${path.delimiter}${binDir}`, isExec)).toBe(real);
  });

  it("does not treat an empty PATH entry as the cwd", () => {
    expect(resolveOnPath("ayfake", `${path.delimiter}${binDir}`, isExec)).toBe(real);
  });

  it("passes through a name that already contains a separator", () => {
    expect(resolveOnPath(`.${path.sep}ayfake`, binDir, isExec)).toBe(`.${path.sep}ayfake`);
    expect(resolveOnPath("/usr/bin/env", binDir, isExec)).toBe("/usr/bin/env");
  });

  it("throws a command-not-found error the auto-install path recognises", () => {
    // ts/core/spawner.ts isCommandNotFoundError() keys off these substrings.
    expect(() => resolveOnPath("ay-nope", binDir, isExec)).toThrow(/ENOENT/);
    expect(() => resolveOnPath("ay-nope", binDir, isExec)).toThrow(/command not found/);
  });
});

describe("isExecutableFile", () => {
  const dir = path.join(root, "probe");
  mkdirSync(dir, { recursive: true });

  it("accepts a runnable file", () => {
    // Windows has no exec bit — access(X_OK) succeeds for any existing file
    // there, which is the intended behaviour (PATHEXT decides executability).
    const exe = path.join(dir, "ayexe");
    writeFileSync(exe, "#!/bin/sh\n");
    chmodSync(exe, 0o755);
    expect(isExecutableFile(exe)).toBe(true);
  });

  it("rejects a directory named like the CLI", () => {
    const asDir = path.join(dir, "aydir");
    mkdirSync(asDir, { recursive: true });
    expect(isExecutableFile(asDir)).toBe(false);
  });

  it("rejects a path that does not exist", () => {
    expect(isExecutableFile(path.join(dir, "ay-missing"))).toBe(false);
  });

  // Symlink creation needs elevation on Windows, and there is no exec bit there.
  it.skipIf(isWindows)("rejects a symlink pointing at a directory", () => {
    const target = path.join(dir, "aydir");
    const link = path.join(dir, "aylink");
    symlinkSync(target, link);
    expect(isExecutableFile(link)).toBe(false);
  });

  it.skipIf(isWindows)("rejects a non-executable file", () => {
    const dud = path.join(dir, "aydud");
    writeFileSync(dud, "not executable");
    chmodSync(dud, 0o644);
    expect(isExecutableFile(dud)).toBe(false);
  });
});

describe("resolveProgram", () => {
  // Both platform arms matter on both CI legs, so drive process.platform
  // directly rather than skipping half the behaviour on each OS.
  function withPlatform(value: string, fn: () => void) {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value });
    try {
      fn();
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  }

  it("passes the name through on Windows", () => {
    // cmd.exe / ConPTY do their own PATH+PATHEXT resolution there.
    withPlatform("win32", () => {
      expect(resolveProgram("cmd", `C:${path.sep}nonexistent`)).toBe("cmd");
    });
  });

  it("resolves against the real filesystem via PATH elsewhere", () => {
    const binDir = path.join(root, "realbin");
    mkdirSync(binDir, { recursive: true });
    const exe = path.join(binDir, "ayreal");
    writeFileSync(exe, "#!/bin/sh\n");
    chmodSync(exe, 0o755);
    // A same-named directory next to it must NOT win: only PATH is consulted.
    mkdirSync(path.join(root, "ayreal"), { recursive: true });
    withPlatform("linux", () => {
      expect(resolveProgram("ayreal", binDir)).toBe(exe);
    });
  });

  it("falls back to the process PATH, and to none at all", () => {
    const original = process.env.PATH;
    try {
      withPlatform("linux", () => {
        expect(() => resolveProgram("ay-definitely-missing")).toThrow(/command not found/);
        delete process.env.PATH;
        expect(() => resolveProgram("ay-definitely-missing")).toThrow(/command not found/);
      });
    } finally {
      if (original === undefined) delete process.env.PATH;
      else process.env.PATH = original;
    }
  });
});
