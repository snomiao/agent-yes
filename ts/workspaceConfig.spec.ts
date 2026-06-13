import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import path from "path";
import {
  expandTilde,
  getWorkspaceRoot,
  resolveSpawnCwd,
  setWorkspaceRoot,
} from "./workspaceConfig.ts";

describe("workspaceConfig", () => {
  let original: string | undefined;
  let tmp: string;
  beforeEach(() => {
    original = process.env.AGENT_YES_HOME;
    tmp = mkdtempSync(path.join(tmpdir(), "ay-cfg-"));
    process.env.AGENT_YES_HOME = tmp;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = original;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("defaults the workspace root to the home dir when unset", () => {
    expect(getWorkspaceRoot()).toBe(homedir());
  });

  it("round-trips set/get and resolves to an absolute path", () => {
    const saved = setWorkspaceRoot(path.join(tmp, "ws"));
    expect(saved).toBe(path.join(tmp, "ws"));
    expect(getWorkspaceRoot()).toBe(path.join(tmp, "ws"));
  });

  it("expands a leading ~", () => {
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("~/projects")).toBe(path.join(homedir(), "projects"));
    expect(expandTilde("/abs/path")).toBe("/abs/path");
  });

  it("stores a tilde path as home-based absolute", () => {
    const saved = setWorkspaceRoot("~/myws");
    expect(saved).toBe(path.join(homedir(), "myws"));
  });

  describe("resolveSpawnCwd", () => {
    beforeEach(() => setWorkspaceRoot(path.join(tmp, "ws")));

    it("empty input → workspace root", () => {
      expect(resolveSpawnCwd("")).toBe(path.join(tmp, "ws"));
      expect(resolveSpawnCwd(undefined)).toBe(path.join(tmp, "ws"));
    });

    it("bare name → <workspace>/<name>", () => {
      expect(resolveSpawnCwd("myproject")).toBe(path.join(tmp, "ws", "myproject"));
    });

    it("absolute path → used as-is", () => {
      expect(resolveSpawnCwd("/tmp/elsewhere")).toBe("/tmp/elsewhere");
    });

    it("tilde path → home-based", () => {
      expect(resolveSpawnCwd("~/docs")).toBe(path.join(homedir(), "docs"));
    });

    it("a relative path with a separator is resolved, not joined to the workspace", () => {
      expect(resolveSpawnCwd("a/b")).toBe(path.resolve("a/b"));
    });
  });
});
