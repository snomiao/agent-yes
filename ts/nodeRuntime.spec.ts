import { mkdtemp, readFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureNodeRuntime, liveEnv } from "./nodeRuntime.ts";

// process.platform is stubbed per test (instead of skipIf) so every branch of
// ensureNodeRuntime is exercised on every CI OS — the win32 early-return on
// POSIX runners and the POSIX shim path on Windows runners (mkdir/writeFile/
// chmod all work there; the shim just isn't consulted by real spawns).
const realPlatform = process.platform;
function setPlatform(p: string) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

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
    setPlatform("linux");
  });

  afterEach(async () => {
    setPlatform(realPlatform);
    process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = savedHome;
    await rm(home, { recursive: true, force: true });
  });

  const noNode = (cmd: string) => (cmd === "bun" ? "/fake/bin/bun" : null);

  it("writes an executable node→bun shim and prepends it to PATH when node is absent", async () => {
    const shim = await ensureNodeRuntime(noNode);
    expect(shim).toBe(path.join(home, "bin", "node"));
    const body = await readFile(shim!, "utf-8");
    expect(body).toBe("#!/bin/sh\nexec '/fake/bin/bun' \"$@\"\n");
    if (realPlatform !== "win32") {
      expect((await stat(shim!)).mode & 0o111).not.toBe(0); // executable
    }
    expect(process.env.PATH!.split(path.delimiter)[0]).toBe(path.join(home, "bin"));
  });

  it("does not duplicate the PATH entry", async () => {
    await ensureNodeRuntime(noNode);
    await ensureNodeRuntime(noNode);
    const binDir = path.join(home, "bin");
    const hits = process.env.PATH!.split(path.delimiter).filter((p) => p === binDir);
    expect(hits).toHaveLength(1);
  });

  it("leaves an up-to-date shim untouched on repeat calls (read-only paths stay read-only)", async () => {
    const shim = (await ensureNodeRuntime(noNode))!;
    const before = await stat(shim);
    await new Promise((r) => setTimeout(r, 20));
    await ensureNodeRuntime(noNode);
    const after = await stat(shim);
    expect(after.mtimeMs).toBe(before.mtimeMs); // not rewritten
  });

  it("single-quotes a bun path containing sh-special characters", async () => {
    const shim = await ensureNodeRuntime((cmd) => (cmd === "bun" ? "/opt/we$ird `dir'/bun" : null));
    const body = await readFile(shim!, "utf-8");
    expect(body).toBe("#!/bin/sh\nexec '/opt/we$ird `dir'\\''/bun' \"$@\"\n");
  });

  it("is a no-op when a real node exists", async () => {
    expect(await ensureNodeRuntime(() => "/usr/bin/whatever")).toBeNull();
  });

  it("is a no-op when bun is missing too (nothing to shim to)", async () => {
    expect(await ensureNodeRuntime(() => null)).toBeNull();
  });

  it("is a no-op on Windows (npm .cmd shims invoke node.exe directly)", async () => {
    setPlatform("win32");
    expect(await ensureNodeRuntime(noNode)).toBeNull();
  });
});

describe("liveEnv", () => {
  it("carries post-startup process.env mutations (unlike Bun.spawn's implicit env)", () => {
    process.env.AY_LIVE_ENV_TEST = "set-after-start";
    try {
      expect(liveEnv().AY_LIVE_ENV_TEST).toBe("set-after-start");
    } finally {
      delete process.env.AY_LIVE_ENV_TEST;
    }
  });
});
