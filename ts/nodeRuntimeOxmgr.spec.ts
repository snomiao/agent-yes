import path from "path";
import { describe, expect, it } from "vitest";
import { daemonEnv, isDaemonEnvName, resolveOxmgrBin } from "./nodeRuntime.ts";

describe("resolveOxmgrBin", () => {
  const launcher = "/g/node_modules/oxmgr/bin/oxmgr.js";
  const vendored = path.normalize("/g/node_modules/oxmgr/vendor/oxmgr");
  const fs = (files: string[]) => ({
    realpath: (p: string) => (p === "/g/bin/oxmgr" ? launcher : p),
    isFile: (p: string) => files.includes(path.normalize(p)),
  });

  it("execs the vendored native binary behind the node launcher", () => {
    expect(resolveOxmgrBin(() => "/g/bin/oxmgr", fs([vendored]), "linux")).toBe(vendored);
  });

  it("keeps the PATH entry when the vendored binary is missing", () => {
    expect(resolveOxmgrBin(() => "/g/bin/oxmgr", fs([]), "linux")).toBe("/g/bin/oxmgr");
  });

  it("keeps a native oxmgr (not a JS launcher) as is", () => {
    const native = "/home/alice/.cargo/bin/oxmgr";
    expect(resolveOxmgrBin(() => native, fs([vendored]), "linux")).toBe(native);
  });

  it("returns null when oxmgr is not on PATH", () => {
    expect(resolveOxmgrBin(() => null, fs([vendored]), "linux")).toBeNull();
  });

  it("falls back to the PATH entry when realpath throws", () => {
    const broken = {
      realpath: () => {
        throw new Error("ENOENT");
      },
      isFile: () => true,
    };
    expect(resolveOxmgrBin(() => "/g/bin/oxmgr", broken, "linux")).toBe("/g/bin/oxmgr");
  });
});

describe("daemonEnv", () => {
  it("forwards host settings and drops unrelated and per-session names", () => {
    expect(
      daemonEnv({
        AGENT_YES_ICE_PUBLIC_IPS: "203.0.113.7",
        AY_NAME: "alpha",
        AGENT_YES_PID: "1111",
        AY_TERM_TOKEN: "t",
        AY_JOIN_SECRET: "s",
        HOME: "/home/alice",
        AGENT_YES_UNSET: undefined,
      }),
    ).toEqual({ AGENT_YES_ICE_PUBLIC_IPS: "203.0.113.7", AY_NAME: "alpha" });
  });

  it("keeps the prior registration's settings, overridden by the current env", () => {
    expect(
      daemonEnv(
        { AGENT_YES_ICE_UDP_PORT: "40000" },
        { AGENT_YES_ICE_UDP_PORT: "1", AGENT_YES_ICE_PUBLIC_IPS: "203.0.113.7", PATH: "/x" },
      ),
    ).toEqual({ AGENT_YES_ICE_PUBLIC_IPS: "203.0.113.7", AGENT_YES_ICE_UDP_PORT: "40000" });
  });

  it("an empty value removes a prior setting", () => {
    expect(daemonEnv({ AGENT_YES_ICE_PUBLIC_IPS: "" }, { AGENT_YES_ICE_PUBLIC_IPS: "x" })).toEqual(
      {},
    );
  });

  it("is sorted, so equal configs stringify equally", () => {
    expect(Object.keys(daemonEnv({ AY_B: "1", AY_A: "2" }))).toEqual(["AY_A", "AY_B"]);
  });

  it("name filter", () => {
    expect(isDaemonEnvName("AGENT_YES_HOME")).toBe(true);
    expect(isDaemonEnvName("AGENT_YES_AGENT_ID")).toBe(false);
    expect(isDaemonEnvName("AYX")).toBe(false);
    expect(isDaemonEnvName("CF_TURN_API_TOKEN")).toBe(true);
    expect(isDaemonEnvName("CF_OTHER")).toBe(false);
  });
});
