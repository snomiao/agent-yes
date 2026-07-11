import { describe, expect, it } from "vitest";
import { badgeDef, BADGE_DEFS, matchBadges, TYPING_BADGE, type BadgeDef } from "./badges.ts";

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

  it("matches session-limit when claude's usage-limit banner is on screen", () => {
    expect(matchBadges(["You've hit your session limit · resets 9:50pm (Asia/Tokyo)"])).toEqual([
      "session-limit",
    ]);
  });

  it("matches with or without the apostrophe (straight ', curly ’, or none)", () => {
    expect(matchBadges(["You've hit your session limit"])).toEqual(["session-limit"]);
    expect(matchBadges(["Youve hit your session limit"])).toEqual(["session-limit"]);
  });

  it("does not match an unrelated 'limit' mention", () => {
    expect(matchBadges(["rate limit exceeded, please slow down"])).toEqual([]);
  });

  it("matches retrying on claude's self-retry backoff banner", () => {
    expect(
      matchBadges(["✻ Waiting for API response · will retry in 2m 17s · check your network"]),
    ).toEqual(["retrying"]);
  });

  it("matches retrying across a line-wrapped banner (joined text)", () => {
    expect(
      matchBadges(["✻ Waiting for API response ·", "will retry in 45s · check your network"]),
    ).toEqual(["retrying"]);
  });

  it("does not light retrying for a normal in-flight wait (no 'will retry')", () => {
    expect(matchBadges(["✻ Waiting for API response… (esc to interrupt)"])).toEqual([]);
  });

  it("does not light retrying for an agent merely discussing retries (anchored to the banner)", () => {
    expect(matchBadges(["the client will retry in 5 seconds with backoff"])).toEqual([]);
  });
});

describe("badgeDef", () => {
  it("looks up a built-in definition by id", () => {
    expect(badgeDef("goal-active")).toBe(BADGE_DEFS[0]);
  });

  it("returns undefined for an unknown id", () => {
    expect(badgeDef("does-not-exist")).toBeUndefined();
  });

  it("resolves the time-derived typing badge even though it isn't in BADGE_DEFS", () => {
    expect(badgeDef("typing")).toBe(TYPING_BADGE);
    expect(BADGE_DEFS).not.toContain(TYPING_BADGE);
  });
});

describe("TYPING_BADGE", () => {
  it("is never produced by screen matching (its pattern can't match)", () => {
    // Presence is derived from the stdin-activity marker, not the rendered
    // screen — matchBadges must never surface it, even against text mentioning
    // typing. A screen can't cause a false 'user is typing' chip.
    expect(matchBadges(["the user is typing a lot right now", "typing typing typing"])).toEqual([]);
    expect(TYPING_BADGE.pattern.test("typing")).toBe(false);
  });
});
