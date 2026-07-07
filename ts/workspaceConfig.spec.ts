import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import path from "path";
import {
  expandTilde,
  getMaxAgents,
  getMinFreeMb,
  getSpawnWaitMs,
  getProvisionAllowlist,
  getProvisionHook,
  getProvisionRoot,
  getSpawnHook,
  getWorkspaceRoot,
  hasProvisionHook,
  hasSpawnHook,
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
    delete process.env.AGENT_YES_SPAWN_HOOK;
    delete process.env.AGENT_YES_PROVISION_HOOK;
    delete process.env.AGENT_YES_MAX_AGENTS;
    delete process.env.AGENT_YES_MIN_FREE_MB;
    delete process.env.AGENT_YES_SPAWN_WAIT_MS;
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

  describe("getMaxAgents", () => {
    it("is undefined (unlimited) when neither env nor config is set", () => {
      expect(getMaxAgents()).toBeUndefined();
    });

    it("reads a positive integer from config", () => {
      writeConfig({ maxAgents: 8 });
      expect(getMaxAgents()).toBe(8);
    });

    it("env AGENT_YES_MAX_AGENTS overrides config", () => {
      writeConfig({ maxAgents: 8 });
      process.env.AGENT_YES_MAX_AGENTS = "3";
      expect(getMaxAgents()).toBe(3);
    });

    it("floors a fractional value", () => {
      process.env.AGENT_YES_MAX_AGENTS = "4.9";
      expect(getMaxAgents()).toBe(4);
    });

    it("treats 0, negative, and garbage as unlimited (undefined)", () => {
      writeConfig({ maxAgents: 0 });
      expect(getMaxAgents()).toBeUndefined();
      process.env.AGENT_YES_MAX_AGENTS = "-5";
      expect(getMaxAgents()).toBeUndefined();
      process.env.AGENT_YES_MAX_AGENTS = "lots";
      expect(getMaxAgents()).toBeUndefined();
    });

    it("treats a fractional value < 1 as unlimited, not a 0 hard-cap", () => {
      // Regression: 0.5 must NOT floor to 0 (which would reject every spawn).
      process.env.AGENT_YES_MAX_AGENTS = "0.5";
      expect(getMaxAgents()).toBeUndefined();
    });
  });

  describe("getMinFreeMb", () => {
    it("is undefined (no floor) when unset", () => {
      expect(getMinFreeMb()).toBeUndefined();
    });

    it("reads config and lets env override", () => {
      writeConfig({ minFreeMb: 1024 });
      expect(getMinFreeMb()).toBe(1024);
      process.env.AGENT_YES_MIN_FREE_MB = "2048";
      expect(getMinFreeMb()).toBe(2048);
    });

    it("treats non-positive/garbage/sub-1 as no floor", () => {
      process.env.AGENT_YES_MIN_FREE_MB = "0";
      expect(getMinFreeMb()).toBeUndefined();
      process.env.AGENT_YES_MIN_FREE_MB = "nope";
      expect(getMinFreeMb()).toBeUndefined();
      process.env.AGENT_YES_MIN_FREE_MB = "0.5";
      expect(getMinFreeMb()).toBeUndefined();
    });
  });

  describe("getSpawnWaitMs", () => {
    it("defaults to 10 minutes when unset", () => {
      expect(getSpawnWaitMs()).toBe(600_000);
    });

    it("reads config and lets env override; allows 0 (don't wait)", () => {
      writeConfig({ spawnWaitMs: 5000 });
      expect(getSpawnWaitMs()).toBe(5000);
      process.env.AGENT_YES_SPAWN_WAIT_MS = "0";
      expect(getSpawnWaitMs()).toBe(0);
    });

    it("falls back to the default on negative/garbage", () => {
      process.env.AGENT_YES_SPAWN_WAIT_MS = "-1";
      expect(getSpawnWaitMs()).toBe(600_000);
      process.env.AGENT_YES_SPAWN_WAIT_MS = "soon";
      expect(getSpawnWaitMs()).toBe(600_000);
    });
  });

  describe("getSpawnHook / hasSpawnHook", () => {
    const isPosix = process.platform !== "win32";

    it("is null/false when unset", () => {
      expect(getSpawnHook()).toBeNull();
      expect(hasSpawnHook()).toBe(false);
    });

    it("returns the configured hook from a private (0600) config", () => {
      writeConfig({ spawnHook: 'echo hi >&2\nexec "$@"' });
      if (isPosix) chmodSync(path.join(tmp, "config.json"), 0o600);
      expect(getSpawnHook()).toBe('echo hi >&2\nexec "$@"');
      expect(hasSpawnHook()).toBe(true);
    });

    it("ignores a blank hook", () => {
      writeConfig({ spawnHook: "   " });
      expect(getSpawnHook()).toBeNull();
    });

    it("env AGENT_YES_SPAWN_HOOK overrides the config", () => {
      writeConfig({ spawnHook: "from-file" });
      process.env.AGENT_YES_SPAWN_HOOK = "from-env";
      expect(getSpawnHook()).toBe("from-env");
    });

    it.skipIf(!isPosix)(
      "refuses a file-backed hook when the config is group/world-writable (tampering guard)",
      () => {
        writeConfig({ spawnHook: "echo pwned" });
        chmodSync(path.join(tmp, "config.json"), 0o666);
        expect(getSpawnHook()).toBeNull();
        chmodSync(path.join(tmp, "config.json"), 0o600);
        expect(getSpawnHook()).toBe("echo pwned");
      },
    );
  });

  describe("getProvisionHook / hasProvisionHook", () => {
    const isPosix = process.platform !== "win32";

    it("is null/false when unset", () => {
      expect(getProvisionHook()).toBeNull();
      expect(hasProvisionHook()).toBe(false);
    });

    it("returns the configured hook from a private (0600) config", () => {
      writeConfig({ provisionHook: 'gh auth switch --user "$KOHO_OWNER"' });
      if (isPosix) chmodSync(path.join(tmp, "config.json"), 0o600);
      expect(getProvisionHook()).toBe('gh auth switch --user "$KOHO_OWNER"');
      expect(hasProvisionHook()).toBe(true);
    });

    it("ignores a blank hook", () => {
      writeConfig({ provisionHook: "   " });
      expect(getProvisionHook()).toBeNull();
    });

    it("env AGENT_YES_PROVISION_HOOK overrides the config", () => {
      writeConfig({ provisionHook: "from-file" });
      process.env.AGENT_YES_PROVISION_HOOK = "from-env";
      expect(getProvisionHook()).toBe("from-env");
    });

    it("is independent of the spawn hook", () => {
      writeConfig({ spawnHook: "spawn-only" });
      if (isPosix) chmodSync(path.join(tmp, "config.json"), 0o600);
      expect(getSpawnHook()).toBe("spawn-only");
      expect(getProvisionHook()).toBeNull();
    });

    it.skipIf(!isPosix)(
      "refuses a file-backed hook when the config is group/world-writable (tampering guard)",
      () => {
        writeConfig({ provisionHook: "echo pwned" });
        chmodSync(path.join(tmp, "config.json"), 0o666);
        expect(getProvisionHook()).toBeNull();
        chmodSync(path.join(tmp, "config.json"), 0o600);
        expect(getProvisionHook()).toBe("echo pwned");
      },
    );
  });
});
