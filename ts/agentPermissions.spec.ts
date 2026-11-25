import { afterEach, describe, expect, it } from "vitest";
import { derivePermissions, permissionBadge } from "./agentPermissions.ts";
import { allowsSkipPermissions } from "./workspaceConfig.ts";

// Issue #236. The pid record is the only place the answer to "was this agent
// allowed to act without confirmation?" survives — the global index carries no
// argv, and the wrapper's own flags never reach the CLI's args at all.

describe("derivePermissions", () => {
  const YES = ["--dangerously-skip-permissions"];

  it("detects the configured yolo flag", () => {
    expect(derivePermissions({ cliArgs: ["--print", ...YES], yesArgs: YES }).skip_permissions).toBe(
      true,
    );
  });

  it("detects a dangerous flag the config never declared", () => {
    // A CLI with no yesArgs must still not hide a flag that disables its gate —
    // the check is the union of configured and known-dangerous, not just config.
    expect(derivePermissions({ cliArgs: ["--yolo"] }).skip_permissions).toBe(true);
    expect(
      derivePermissions({ cliArgs: ["--dangerously-bypass-approvals-and-sandbox"] })
        .skip_permissions,
    ).toBe(true);
  });

  it("matches the flag part of an --flag=value form", () => {
    expect(derivePermissions({ cliArgs: ["--full-auto=true"] }).skip_permissions).toBe(true);
  });

  it("does not flag ordinary args", () => {
    expect(
      derivePermissions({ cliArgs: ["--model", "opus", "--continue"], yesArgs: YES })
        .skip_permissions,
    ).toBe(false);
    expect(derivePermissions({ cliArgs: [] }).skip_permissions).toBe(false);
  });

  it("records the wrapper flags independently of the CLI's", () => {
    const p = derivePermissions({ cliArgs: [], robust: true, autoContinue: true });
    expect(p).toEqual({ skip_permissions: false, robust: true, auto_continue: true });
  });

  it("defaults every flag to false rather than undefined", () => {
    // The record is serialized to JSON and read by both runtimes; an absent
    // boolean would read as "unknown" where we mean "no".
    expect(derivePermissions({ cliArgs: [] })).toEqual({
      skip_permissions: false,
      robust: false,
      auto_continue: false,
    });
  });

  it("ignores an empty yesArgs entry rather than matching everything", () => {
    // A config with a stray "" must not make every arg look like a yolo flag.
    expect(derivePermissions({ cliArgs: ["--model"], yesArgs: [""] }).skip_permissions).toBe(false);
  });
});

describe("permissionBadge", () => {
  it("reports skip only when the CLI gate is off", () => {
    expect(permissionBadge({ skip_permissions: true, robust: false, auto_continue: false })).toBe(
      "skip",
    );
    expect(permissionBadge({ skip_permissions: false, robust: false, auto_continue: false })).toBe(
      "prompt",
    );
  });

  it("never lets the wrapper flags soften the label", () => {
    // robust/auto_continue change how the agent RECOVERS, not what it may do.
    expect(permissionBadge({ skip_permissions: true, robust: true, auto_continue: true })).toBe(
      "skip",
    );
  });

  it("has nothing to show for a record with no stamp (pre-#236 agent)", () => {
    expect(permissionBadge(null)).toBeNull();
    expect(permissionBadge(undefined)).toBeNull();
  });
});

describe("allowsSkipPermissions", () => {
  const original = process.env.AGENT_YES_ALLOW_SKIP_PERMISSIONS;
  afterEach(() => {
    if (original === undefined) delete process.env.AGENT_YES_ALLOW_SKIP_PERMISSIONS;
    else process.env.AGENT_YES_ALLOW_SKIP_PERMISSIONS = original;
  });

  it("is permissive by default — restricting is an opt-in", () => {
    delete process.env.AGENT_YES_ALLOW_SKIP_PERMISSIONS;
    expect(allowsSkipPermissions()).toBe(true);
  });

  it("is restricted by an explicit falsy env value", () => {
    for (const v of ["0", "false", "no", "off", "FALSE"]) {
      process.env.AGENT_YES_ALLOW_SKIP_PERMISSIONS = v;
      expect(allowsSkipPermissions()).toBe(false);
    }
  });

  it("stays permissive for any other value, including garbage", () => {
    // Failing closed here would lock spawns out of a host over a typo; the
    // enforcement point is an explicit opt-in, so an unparseable value must not
    // silently become a restriction.
    for (const v of ["1", "true", "yes", "on", "banana"]) {
      process.env.AGENT_YES_ALLOW_SKIP_PERMISSIONS = v;
      expect(allowsSkipPermissions()).toBe(true);
    }
  });

  it("treats an empty env value as unset (falls through to config)", () => {
    process.env.AGENT_YES_ALLOW_SKIP_PERMISSIONS = "   ";
    expect(allowsSkipPermissions()).toBe(true);
  });
});
