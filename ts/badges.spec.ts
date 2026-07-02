import { describe, expect, it } from "vitest";
import { badgeDef, BADGE_DEFS, matchBadges, type BadgeDef } from "./badges.ts";

describe("matchBadges", () => {
  it("matches goal-active when the /goal status line is on screen", () => {
    const lines = ["some output", "/goal active (42s)", "more output"];
    expect(matchBadges(lines)).toEqual(["goal-active"]);
  });

  it("is case-insensitive", () => {
    expect(matchBadges(["/GOAL ACTIVE (1s)"])).toEqual(["goal-active"]);
  });

  it("returns empty when nothing matches", () => {
    expect(matchBadges(["just some regular CLI output", "nothing special here"])).toEqual([]);
  });

  it("returns empty for an empty screen", () => {
    expect(matchBadges([])).toEqual([]);
  });

  it("matches across a join boundary between lines (pattern spans the joined text)", () => {
    // Sanity: matchBadges joins lines with \n before testing, so a pattern that
    // doesn't care about line boundaries still finds a hit split across two lines.
    const defs: BadgeDef[] = [{ id: "spans", label: "x", title: "t", pattern: /foo\nbar/ }];
    expect(matchBadges(["foo", "bar"], defs)).toEqual(["spans"]);
  });

  it("supports custom def sets independent of the built-in BADGE_DEFS", () => {
    const defs: BadgeDef[] = [
      { id: "custom-error", label: "err", title: "custom error banner", pattern: /FATAL: boom/ },
    ];
    expect(matchBadges(["FATAL: boom"], defs)).toEqual(["custom-error"]);
    expect(matchBadges(["FATAL: boom"])).toEqual([]); // not in the default set
  });

  it("can match multiple badges at once, in def order", () => {
    const defs: BadgeDef[] = [
      { id: "a", label: "a", title: "a", pattern: /alpha/ },
      { id: "b", label: "b", title: "b", pattern: /beta/ },
    ];
    expect(matchBadges(["alpha and beta both here"], defs)).toEqual(["a", "b"]);
  });
});

describe("badgeDef", () => {
  it("looks up a built-in definition by id", () => {
    expect(badgeDef("goal-active")).toBe(BADGE_DEFS[0]);
  });

  it("returns undefined for an unknown id", () => {
    expect(badgeDef("does-not-exist")).toBeUndefined();
  });
});
