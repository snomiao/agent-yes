import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import path from "path";
import {
  expandTilde,
  getProvisionAllowlist,
  getProvisionRoot,
  getWorkspaceRoot,
  isProvisionAllowed,
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
    delete process.env.CODEHOST_WS_ROOT;
    delete process.env.CODEHOST_PROVISION_ALLOWLIST;
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
      // path.resolve keeps a POSIX-absolute path on Unix but anchors it to the
      // current drive on Windows (→ C:\tmp\elsewhere); compare against the same
      // resolution the impl uses so the assertion holds on both (cf. "a/b" below).
      expect(resolveSpawnCwd("/tmp/elsewhere")).toBe(path.resolve("/tmp/elsewhere"));
    });

    it("tilde path → home-based", () => {
      expect(resolveSpawnCwd("~/docs")).toBe(path.join(homedir(), "docs"));
    });

    it("a relative path with a separator is resolved, not joined to the workspace", () => {
      expect(resolveSpawnCwd("a/b")).toBe(path.resolve("a/b"));
    });
  });

  const writeConfig = (c: Record<string, unknown>) =>
    writeFileSync(path.join(tmp, "config.json"), JSON.stringify(c));

  describe("getProvisionRoot", () => {
    it("is undefined when neither env nor config is set", () => {
      expect(getProvisionRoot()).toBeUndefined();
    });

    it("returns the configured provisionRoot, resolved", () => {
      writeConfig({ provisionRoot: "/code" });
      expect(getProvisionRoot()).toBe(path.resolve("/code"));
    });

    it("env CODEHOST_WS_ROOT overrides the config and expands ~", () => {
      writeConfig({ provisionRoot: "/code" });
      process.env.CODEHOST_WS_ROOT = "~/ws";
      expect(getProvisionRoot()).toBe(path.join(homedir(), "ws"));
    });

    it("ignores a blank configured value", () => {
      writeConfig({ provisionRoot: "   " });
      expect(getProvisionRoot()).toBeUndefined();
    });
  });

  describe("getProvisionAllowlist", () => {
    it("is empty when unset", () => {
      expect(getProvisionAllowlist()).toEqual([]);
    });

    it("reads and normalizes the configured list (trim/lowercase/drop empties)", () => {
      writeConfig({ provisionAllowlist: [" Snomiao ", "Acme/Repo", ""] });
      expect(getProvisionAllowlist()).toEqual(["snomiao", "acme/repo"]);
    });

    it("env CODEHOST_PROVISION_ALLOWLIST (comma-separated) overrides config", () => {
      writeConfig({ provisionAllowlist: ["snomiao"] });
      process.env.CODEHOST_PROVISION_ALLOWLIST = "Foo, bar/baz ,";
      expect(getProvisionAllowlist()).toEqual(["foo", "bar/baz"]);
    });
  });

  describe("isProvisionAllowed", () => {
    it("denies everything when the allowlist is empty (secure default)", () => {
      expect(isProvisionAllowed("snomiao", "agent-yes")).toBe(false);
    });

    it("'*' allows any owner/repo", () => {
      writeConfig({ provisionAllowlist: ["*"] });
      expect(isProvisionAllowed("anyone", "anything")).toBe(true);
    });

    it("matches by owner case-insensitively and rejects others", () => {
      writeConfig({ provisionAllowlist: ["snomiao"] });
      expect(isProvisionAllowed("SNOMIAO", "x")).toBe(true);
      expect(isProvisionAllowed("evil", "x")).toBe(false);
    });

    it("matches an exact owner/repo and an owner/* glob", () => {
      writeConfig({ provisionAllowlist: ["acme/widget", "org/*"] });
      expect(isProvisionAllowed("acme", "widget")).toBe(true);
      expect(isProvisionAllowed("acme", "other")).toBe(false);
      expect(isProvisionAllowed("org", "anything")).toBe(true);
    });
  });
});
