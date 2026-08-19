import { describe, expect, it } from "bun:test";
import { isParentWatching, parseReportMode, shouldDeliverReport } from "./parentWatching.ts";

describe("parseReportMode", () => {
  it("defaults to auto for unset or unrecognised values", () => {
    expect(parseReportMode(undefined)).toBe("auto");
    expect(parseReportMode("")).toBe("auto");
    expect(parseReportMode("yes")).toBe("auto");
    expect(parseReportMode("auto")).toBe("auto");
  });

  it("accepts always/never, case- and space-insensitively", () => {
    expect(parseReportMode("always")).toBe("always");
    expect(parseReportMode(" ALWAYS ")).toBe("always");
    expect(parseReportMode("Never")).toBe("never");
  });
});

describe("shouldDeliverReport", () => {
  const at = (over: Partial<Parameters<typeof shouldDeliverReport>[0]> = {}) =>
    shouldDeliverReport({
      mode: "auto",
      parentIsWatching: false,
      reason: "finished",
      ...over,
    });

  it("auto sends when nobody is watching — the case this feature exists for", () => {
    expect(at({ reason: "finished" })).toBe(true);
    expect(at({ reason: "stuck" })).toBe(true);
  });

  it("auto stays quiet when the parent is already monitoring", () => {
    expect(at({ parentIsWatching: true, reason: "finished" })).toBe(false);
    expect(at({ parentIsWatching: true, reason: "stuck" })).toBe(false);
  });

  it("auto still sends `exited` to a watching parent — a poll can miss it entirely", () => {
    expect(at({ parentIsWatching: true, reason: "exited" })).toBe(true);
  });

  it("never suppresses everything, including exited", () => {
    for (const reason of ["finished", "stuck", "exited"] as const) {
      expect(at({ mode: "never", reason })).toBe(false);
      expect(at({ mode: "never", reason, parentIsWatching: true })).toBe(false);
    }
  });

  it("always sends even to a watching parent", () => {
    for (const reason of ["finished", "stuck", "exited"] as const) {
      expect(at({ mode: "always", reason, parentIsWatching: true })).toBe(true);
    }
  });
});

describe("isParentWatching", () => {
  it("fails open (false) when there is no watcher and no recent read", async () => {
    // Nothing in this test process has watched or tailed these synthetic pids.
    await expect(isParentWatching(2 ** 30, 2 ** 30 + 1, 2 ** 30 + 2)).resolves.toBe(false);
  });
});
