import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProgram } from "./resolveBinary.ts";

// Issue #138: a cwd entry named like the agent CLI used to shadow the real
// binary inside portable-pty (reached via bun-pty), killing the forked child
// with "fatal runtime error: assertion failed: output.write(&bytes).is_ok()".
// resolveProgram must consult PATH only, and only accept executable files.
describe.skipIf(process.platform === "win32")("resolveProgram", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ay-resolve-"));
  const binDir = path.join(root, "bin");
  const cwdDir = path.join(root, "cwd");
  mkdirSync(binDir);
  mkdirSync(cwdDir);

  // The real, executable binary — only reachable via PATH.
  const real = path.join(binDir, "ayfake");
  writeFileSync(real, "#!/bin/sh\n");
  chmodSync(real, 0o755);

  it("returns the PATH executable, not a same-named cwd entry", () => {
    expect(resolveProgram("ayfake", binDir)).toBe(real);
  });

  it("skips a directory named like the CLI", () => {
    mkdirSync(path.join(cwdDir, "ayfake"));
    expect(() => resolveProgram("ayfake", cwdDir)).toThrow(/command not found/);
  });

  it("skips a symlink pointing at a directory", () => {
    const linkDir = path.join(root, "link");
    mkdirSync(linkDir);
    symlinkSync(cwdDir, path.join(linkDir, "aylink"));
    expect(() => resolveProgram("aylink", linkDir)).toThrow(/command not found/);
  });

  it("skips a non-executable file", () => {
    const dudDir = path.join(root, "dud");
    mkdirSync(dudDir);
    const dud = path.join(dudDir, "aydud");
    writeFileSync(dud, "not executable");
    chmodSync(dud, 0o644);
    expect(() => resolveProgram("aydud", dudDir)).toThrow(/command not found/);
  });

  it("does not treat an empty PATH entry as the cwd", () => {
    expect(resolveProgram("ayfake", `${path.delimiter}${binDir}`)).toBe(real);
  });

  it("passes through a name that already contains a separator", () => {
    expect(resolveProgram("./ayfake", binDir)).toBe("./ayfake");
    expect(resolveProgram("/usr/bin/env", binDir)).toBe("/usr/bin/env");
  });

  it("throws a command-not-found error the auto-install path recognises", () => {
    // ts/core/spawner.ts isCommandNotFoundError() keys off these substrings.
    expect(() => resolveProgram("ay-does-not-exist", binDir)).toThrow(/ENOENT/);
    expect(() => resolveProgram("ay-does-not-exist", binDir)).toThrow(/command not found/);
  });
});
