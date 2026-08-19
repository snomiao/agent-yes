import { readFile } from "fs/promises";
import { describe, expect, it } from "vitest";
import {
  installerArgv,
  isNoNodeExecError,
  oxmgrVersionHasWindowsFix,
  portlessConsoleUrl,
} from "./serve.ts";

describe("portlessConsoleUrl", () => {
  it("uses the stable local HTTPS hostname and keeps auth in the fragment", () => {
    expect(portlessConsoleUrl()).toBe("https://agent-yes.localhost/");
    expect(portlessConsoleUrl("a b")).toBe("https://agent-yes.localhost/#k=a%20b");
  });
});

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
    expect(isNoNodeExecError("'node' is not recognized as an internal or external command")).toBe(
      true,
    );
  });

  it("matches localized-then-normalized output (probe pins LC_ALL=C)", () => {
    // managerProbe spawns with LC_ALL=C precisely so this English form is what
    // we always see; this test documents the coupling.
    expect(isNoNodeExecError("env: node: No such file or directory")).toBe(true);
  });

  it("does not match a real native/glibc failure", () => {
    expect(
      isNoNodeExecError("oxmgr: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found"),
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
      /Bun\.spawn\((?:\[[^\]]*\bm(?:gr)?\.bin[^\]]*\]|startArgv|installer),[\s\S]*?\}\)/g,
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

// Guards the oxmgr bootstrap: bun blocks untrusted postinstalls, and oxmgr's
// native binary only arrives via its postinstall — without --trust the install
// "succeeds" but leaves a launcher that dies with "oxmgr binary is missing"
// (the real reason bootstrap used to fall back to pm2 on fresh boxes).
describe("installerArgv", () => {
  it("trusts oxmgr's postinstall under bun", () => {
    expect(installerArgv("oxmgr", "/x/bun", null)).toEqual([
      "/x/bun",
      "add",
      "-g",
      "--trust",
      "oxmgr",
    ]);
  });

  it("keeps pm2 untrusted under bun (pure JS, no required scripts)", () => {
    expect(installerArgv("pm2", "/x/bun", "/x/npm")).toEqual(["/x/bun", "add", "-g", "pm2"]);
  });

  it("falls back to npm without a trust flag (npm runs scripts by default)", () => {
    expect(installerArgv("oxmgr", null, "/x/npm")).toEqual(["/x/npm", "install", "-g", "oxmgr"]);
  });

  it("returns null with neither installer", () => {
    expect(installerArgv("pm2", null, null)).toBeNull();
  });
});
