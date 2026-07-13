import { mkdtemp, readFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureNodeRuntime, isNoNodeExecError, oxmgrVersionHasWindowsFix } from "./serve.ts";

// Guards the Windows daemon-manager selection: on Windows we only PREFER oxmgr
// when the installed build carries the daemon-socket-inheritance fix. Stock
// builds <= 0.4.0 still wedge and must fall back to pm2.
describe("oxmgrVersionHasWindowsFix", () => {
  it("accepts the winfix fork build", () => {
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.4.0+winfix")).toBe(true);
    // Case-insensitive, and works as a prerelease tag too.
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.4.0-WinFix.1")).toBe(true);
  });

  it("rejects stock builds at or below the last wedged release", () => {
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.4.0")).toBe(false);
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.3.9")).toBe(false);
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.1.0")).toBe(false);
    // A plain 0.4.0 prerelease is not the fix.
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.4.0-rc1")).toBe(false);
  });

  it("assumes the fix is upstreamed in any release newer than 0.4.0", () => {
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.4.1")).toBe(true);
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.5.0")).toBe(true);
    expect(oxmgrVersionHasWindowsFix("oxmgr 1.0.0")).toBe(true);
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.5.0-rc1")).toBe(true);
  });

  it("returns false on unparseable output", () => {
    expect(oxmgrVersionHasWindowsFix("")).toBe(false);
    expect(oxmgrVersionHasWindowsFix("oxmgr (unknown)")).toBe(false);
  });
});

// The bun-only-no-node path (sym003): pm2/oxmgr bins are `#!/usr/bin/env node`
// scripts, so with no node on PATH they die at the shebang. ensureNodeRuntime
// must bridge that with a node→bun shim in ay's own bin dir.
describe("ensureNodeRuntime", () => {
  let home: string;
  let savedPath: string | undefined;
  let savedHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "ay-node-shim-"));
    savedPath = process.env.PATH;
    savedHome = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = home;
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = savedHome;
    await rm(home, { recursive: true, force: true });
  });

  const noNode = (cmd: string) => (cmd === "bun" ? "/fake/bin/bun" : null);

  it.skipIf(process.platform === "win32")(
    "writes an executable node→bun shim and prepends it to PATH when node is absent",
    async () => {
      const shim = await ensureNodeRuntime(noNode);
      expect(shim).toBe(path.join(home, "bin", "node"));
      const body = await readFile(shim!, "utf-8");
      expect(body).toBe("#!/bin/sh\nexec '/fake/bin/bun' \"$@\"\n");
      expect((await stat(shim!)).mode & 0o111).not.toBe(0); // executable
      expect(process.env.PATH!.split(path.delimiter)[0]).toBe(path.join(home, "bin"));
    },
  );

  it.skipIf(process.platform === "win32")("does not duplicate the PATH entry", async () => {
    await ensureNodeRuntime(noNode);
    await ensureNodeRuntime(noNode);
    const binDir = path.join(home, "bin");
    const hits = process.env.PATH!.split(path.delimiter).filter((p) => p === binDir);
    expect(hits).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")(
    "leaves an up-to-date shim untouched on repeat calls (read-only paths stay read-only)",
    async () => {
      const shim = (await ensureNodeRuntime(noNode))!;
      const before = await stat(shim);
      await new Promise((r) => setTimeout(r, 20));
      await ensureNodeRuntime(noNode);
      const after = await stat(shim);
      expect(after.mtimeMs).toBe(before.mtimeMs); // not rewritten
    },
  );

  it.skipIf(process.platform === "win32")(
    "single-quotes a bun path containing sh-special characters",
    async () => {
      const shim = await ensureNodeRuntime((cmd) =>
        cmd === "bun" ? "/opt/we$ird `dir'/bun" : null,
      );
      const body = await readFile(shim!, "utf-8");
      expect(body).toBe("#!/bin/sh\nexec '/opt/we$ird `dir'\\''/bun' \"$@\"\n");
    },
  );

  it("is a no-op when a real node exists", async () => {
    expect(await ensureNodeRuntime(() => "/usr/bin/whatever")).toBeNull();
  });

  it("is a no-op when bun is missing too (nothing to shim to)", async () => {
    expect(await ensureNodeRuntime(() => null)).toBeNull();
  });
});

// Guards the serve-install diagnostic: a missing node runtime must be reported
// as such, never as a "glibc mismatch" (glibc doesn't even exist on macOS).
describe("isNoNodeExecError", () => {
  it("matches macOS/BSD env output", () => {
    expect(isNoNodeExecError("env: node: No such file or directory")).toBe(true);
  });

  it("matches GNU coreutils quoted env output", () => {
    expect(isNoNodeExecError("env: 'node': No such file or directory")).toBe(true);
  });

  it("matches Windows cmd output", () => {
    expect(
      isNoNodeExecError("'node' is not recognized as an internal or external command"),
    ).toBe(true);
  });

  it("matches localized-then-normalized output (probe pins LC_ALL=C)", () => {
    // managerProbe spawns with LC_ALL=C precisely so this English form is what
    // we always see; this test documents the coupling.
    expect(isNoNodeExecError("env: node: No such file or directory")).toBe(true);
  });

  it("does not match a real native/glibc failure", () => {
    expect(
      isNoNodeExecError(
        "oxmgr: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found",
      ),
    ).toBe(false);
    expect(isNoNodeExecError("")).toBe(false);
  });
});

// Bun.spawn without an explicit `env` hands the child the environ captured at
// process startup, NOT the live process.env — so ensureNodeRuntime's shim PATH
// prepend never reached children spawned that way (`pm2 start` died with
// `env: node: No such file or directory` right after the probe passed). Guard
// the fix pattern: every spawn of a daemon-manager binary in serve.ts must pass
// an explicit env.
describe("manager spawns pass a live env snapshot", () => {
  it("every Bun.spawn of mgr.bin/startArgv/installer carries an env option", async () => {
    const src = await readFile(new URL("./serve.ts", import.meta.url), "utf-8");
    // Grab each Bun.spawn(...) call whose argv mentions a manager binary.
    // Capture from the call opening through the options object's closing `})`.
    const calls = src.match(
      /Bun\.spawn\((?:\[[^\]]*mgr\.bin[^\]]*\]|startArgv|installer),[\s\S]*?\}\)/g,
    );
    expect(calls?.length).toBeGreaterThanOrEqual(7);
    for (const call of calls!) {
      // Require a real liveEnv() env option, not just the substring "env:"
      // (which a comment inside the options object could satisfy).
      expect(call, `missing explicit env in: ${call.slice(0, 80)}`).toMatch(
        /env: (?:\{\s*(?:\.\.\.)?)?liveEnv\(\)/,
      );
    }
  });
});
