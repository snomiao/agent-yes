import { describe, expect, it } from "vitest";
import { oxmgrVersionHasWindowsFix } from "./serve.ts";

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
