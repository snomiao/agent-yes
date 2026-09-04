import { describe, expect, it } from "bun:test";
import { detectSnapConfinement, snapConfinementMessage } from "./snapGuard.ts";

const SANDBOX_HOME = "/home/u/snap/bun-js/87";

describe("detectSnapConfinement", () => {
  it("returns null outside a snap", () => {
    expect(detectSnapConfinement({}, "/home/u")).toBeNull();
  });

  it("detects strict confinement when HOME is the snap user-data dir", () => {
    const snap = detectSnapConfinement(
      { SNAP_NAME: "bun-js", SNAP_REVISION: "87", SNAP_USER_DATA: SANDBOX_HOME },
      SANDBOX_HOME,
    );
    expect(snap).toMatchObject({ name: "bun-js", revision: "87" });
  });

  it("ignores classic confinement — SNAP_* is set but HOME is untouched", () => {
    expect(
      detectSnapConfinement(
        { SNAP_NAME: "bun-js", SNAP_USER_DATA: SANDBOX_HOME, SNAP: "/snap/bun-js/87" },
        "/home/u",
      ),
    ).toBeNull();
  });

  it("falls back to the HOME path shape when SNAP_USER_DATA is absent", () => {
    const snap = detectSnapConfinement({ SNAP: "/snap/bun-js/87" }, SANDBOX_HOME);
    expect(snap).toMatchObject({ name: "bun-js", revision: "87" });
  });
});

describe("snapConfinementMessage", () => {
  it("names the snap, the sandbox HOME, and the native install", () => {
    const msg = snapConfinementMessage({ name: "bun-js", revision: "87", home: SANDBOX_HOME });
    expect(msg).toContain("'bun-js' snap sandbox (revision 87)");
    expect(msg).toContain(SANDBOX_HOME);
    expect(msg).toContain("sudo snap remove bun-js");
    expect(msg).toContain("https://bun.sh/install");
  });
});
