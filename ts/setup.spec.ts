import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
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

  it("--no-share with a --port flag still treats the path as the workspace", async () => {
    const dir = path.join(tmp, "ws");
    const code = await cmdSetup(["--no-share", "--port", "7440", dir]);
    expect(code).toBe(0);
    expect(getWorkspaceRoot()).toBe(path.resolve(dir));
  });
});
