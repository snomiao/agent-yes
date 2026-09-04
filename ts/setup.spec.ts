import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import path from "path";
import { cmdSetup } from "./setup.ts";
import { getWorkspaceRoot } from "./workspaceConfig.ts";

// Guards against the regression where `ay setup` was registered + documented but
// its module was missing ("Cannot find module './setup.ts'"). Exercises the
// --no-share path only, so no daemon is installed.
describe("cmdSetup", () => {
  let original: string | undefined;
  let tmp: string;
  beforeEach(() => {
    original = process.env.AGENT_YES_HOME;
    tmp = mkdtempSync(path.join(tmpdir(), "ay-setup-"));
    process.env.AGENT_YES_HOME = tmp;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = original;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("--help returns 0 without touching config", async () => {
    expect(await cmdSetup(["--help"])).toBe(0);
  });

  it("--no-share sets the workspace root and skips the daemon", async () => {
    const dir = path.join(tmp, "myspace");
    const code = await cmdSetup(["--no-share", dir]);
    expect(code).toBe(0);
    expect(getWorkspaceRoot()).toBe(path.resolve(dir));
  });

  // Regression: with no --port, `rest.indexOf("--port")` is -1, so the old
  // `i !== portIdx + 1` filter excluded index 0 — the documented
  // `ay setup <workspace-dir>` form silently ignored its argument.
  it("takes the workspace dir as the FIRST argument", async () => {
    const dir = path.join(tmp, "first-arg");
    const code = await cmdSetup([dir, "--no-share"]);
    expect(code).toBe(0);
    expect(getWorkspaceRoot()).toBe(path.resolve(dir));
  });

  // The snap guard: piped (no TTY) it must warn and carry on, never block.
  it("warns but proceeds when running inside a snap sandbox", async () => {
    // Point SNAP_USER_DATA at the real homedir() rather than mutating $HOME:
    // Bun resolves os.homedir() without re-reading the env, so an env-only
    // remap wouldn't be seen. Matching the actual home is what the guard checks.
    const snapEnv = { SNAP_NAME: "bun-js", SNAP_REVISION: "87", SNAP_USER_DATA: homedir() };
    const restore = Object.entries(snapEnv).map(([k, v]) => {
      const prev = process.env[k];
      process.env[k] = v;
      return () => (prev === undefined ? delete process.env[k] : (process.env[k] = prev));
    });
    const write = process.stderr.write.bind(process.stderr);
    let err = "";
    process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
    try {
      expect(await cmdSetup([path.join(tmp, "snap-ws"), "--no-share"])).toBe(0);
      expect(err).toContain("snap sandbox");
      err = "";
      expect(await cmdSetup([path.join(tmp, "snap-ws"), "--no-share", "--allow-snap"])).toBe(0);
      expect(err).not.toContain("snap sandbox");
    } finally {
      process.stderr.write = write;
      for (const undo of restore) undo();
    }
  });

  it("--no-share with a --port flag still treats the path as the workspace", async () => {
    const dir = path.join(tmp, "ws");
    const code = await cmdSetup(["--no-share", "--port", "7440", dir]);
    expect(code).toBe(0);
    expect(getWorkspaceRoot()).toBe(path.resolve(dir));
  });
});
