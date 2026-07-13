import { describe, expect, it } from "vitest";
import {
  badgeDef,
  badgeLabel,
  BADGE_DEFS,
  matchBadges,
  TYPING_BADGE,
  type BadgeDef,
} from "./badges.ts";

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

describe("dynamic footer counters", () => {
  // Real footer lines captured from live agents (`ay tail`), singular and plural.
  it("matches the shell counter and carries the footer text on the wire", () => {
    expect(
      matchBadges([
        "  ⏸ manual mode on · 1 shell · ctrl+t to hide tasks · ← for agents · ↓ to manage",
      ]),
    ).toEqual(["shells:1 shell"]);
    expect(matchBadges(["  ⏸ manual mode on · 4 shells · ↓ to manage"])).toEqual([
      "shells:4 shells",
    ]);
  });

  it("matches the monitor counter", () => {
    expect(
      matchBadges(["  ⏸ manual mode on · 3 monitors · esc to interrupt · ↓ to manage"]),
    ).toEqual(["monitors:3 monitors"]);
    expect(matchBadges(["  ⏸ manual mode on · 1 monitor · ↓ to manage"])).toEqual([
      "monitors:1 monitor",
    ]);
  });

  it("matches the background-agents counter (← N agents) at end of line", () => {
    expect(matchBadges(["  ⏸ manual mode on · ? for shortcuts · ← 3 agents"])).toEqual([
      "bg-agents:3 agents",
    ]);
  });

  it("does not light bg-agents on the plain '← for agents' hint (no count)", () => {
    expect(matchBadges(["  ⏸ manual mode on · ctrl+t to hide tasks · ← for agents"])).toEqual([]);
  });

  it("matches the PR chip", () => {
    expect(matchBadges(["  ⏸ manual mode on · PR #310"])).toEqual(["pr:PR #310"]);
    expect(matchBadges(["  ⏸ manual mode on · PR #229 · esc to interrupt"])).toEqual([
      "pr:PR #229",
    ]);
  });

  it("is anchored to footer chrome — prose mentions don't match", () => {
    expect(
      matchBadges([
        "I opened 4 shells and 2 monitors while checking PR #310 today",
        "there are 3 agents running",
      ]),
    ).toEqual([]);
  });

  it("can light several counters on one footer line", () => {
    expect(
      matchBadges(["  ⏸ manual mode on · 2 shells · 3 monitors · PR #12 · ← 5 agents"]),
    ).toEqual(["shells:2 shells", "monitors:3 monitors", "bg-agents:5 agents", "pr:PR #12"]);
  });
});

describe("badgeDef", () => {
  it("looks up a built-in definition by id", () => {
    expect(badgeDef("goal-active")).toBe(BADGE_DEFS[0]);
  });

  it("returns undefined for an unknown id", () => {
    expect(badgeDef("does-not-exist")).toBeUndefined();
  });

  it("resolves a dynamic id by the part before the ':'", () => {
    expect(badgeDef("shells:4 shells")?.id).toBe("shells");
  });

  it("resolves the time-derived typing badge even though it isn't in BADGE_DEFS", () => {
    expect(badgeDef("typing")).toBe(TYPING_BADGE);
    expect(BADGE_DEFS).not.toContain(TYPING_BADGE);
  });
});

describe("badgeLabel", () => {
  it("returns the static label for a plain id", () => {
    expect(badgeLabel("goal-active")).toBe("goal");
    expect(badgeLabel("typing")).toBe("typing");
  });

  it("substitutes the captured footer text into a dynamic label", () => {
    expect(badgeLabel("shells:1 shell")).toBe("1 shell");
    expect(badgeLabel("shells:4 shells")).toBe("4 shells");
    expect(badgeLabel("pr:PR #310")).toBe("PR #310");
  });

  it("falls back to the raw id for an unknown badge", () => {
    expect(badgeLabel("some-future-flag")).toBe("some-future-flag");
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
