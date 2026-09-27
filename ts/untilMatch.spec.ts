import { expect, test } from "vitest";
import {
  compileUntil,
  linesAfterAnchor,
  makeJudge,
  makeTally,
  untilExitCode,
} from "./untilMatch.ts";

const lit = (pattern: string, ignoreCase = false) =>
  compileUntil({ pattern, regex: false, ignoreCase });
const rx = (pattern: string, ignoreCase = false) =>
  compileUntil({ pattern, regex: true, ignoreCase });

test("literal pattern is a substring match, not a regex", () => {
  const m = lit("cost: $0.02");
  expect(m("  total cost: $0.02 (3 turns)")).toBe(true);
  // `$` would anchor if this leaked into a RegExp; as a literal it must not.
  expect(m("cost: 0.02")).toBe(false);
});

test("literal match is case-sensitive by default, case-folded under -i", () => {
  expect(lit("PASSED")("all tests passed")).toBe(false);
  expect(lit("PASSED", true)("all tests passed")).toBe(true);
});

test("regex mode compiles the pattern", () => {
  const m = rx("^\\s*ERROR\\b");
  expect(m("  ERROR: boom")).toBe(true);
  expect(m("no ERROR here")).toBe(false);
});

test("regex mode honours -i", () => {
  expect(rx("^error")("Error: boom")).toBe(false);
  expect(rx("^error", true)("Error: boom")).toBe(true);
});

test("regex predicate is stateless across lines (no lastIndex carryover)", () => {
  const m = rx("a");
  expect(m("a")).toBe(true);
  expect(m("a")).toBe(true);
  expect(m("a")).toBe(true);
});

test("empty pattern is rejected rather than matching the next line of output", () => {
  expect(() => lit("")).toThrow(/non-empty/);
  expect(() => rx("")).toThrow(/non-empty/);
});

test("invalid regex is rejected at compile time", () => {
  expect(() => rx("[unterminated")).toThrow(/invalid --until regex/);
});

test("a default tally is satisfied by the first matching line", () => {
  const t = makeTally(lit("passed"));
  expect(t.feedAll(["building…", "3 passed, 0 failed", "done"])).toBe(true);
  expect(t.last).toBe("3 passed, 0 failed");
  expect(t.hits).toBe(1);
});

test("a tally left unsatisfied reports its progress", () => {
  const t = makeTally(lit("passed"), 3);
  expect(t.feedAll(["a passed", "b passed"])).toBe(false);
  expect(t.done).toBe(false);
  expect(t.hits).toBe(2);
  expect(t.last).toBe("b passed");
});

test("--count hits accumulate across sources (backlog, then stream)", () => {
  // The same tally is fed by the context window and then the live follow, so
  // `--count 3` means three hits total rather than three from each.
  const t = makeTally(lit("ok"), 3);
  expect(t.feedAll(["ok 1", "ok 2"])).toBe(false);
  expect(t.feed("noise")).toBe(false);
  expect(t.feed("ok 3")).toBe(true);
  expect(t.last).toBe("ok 3");
});

test("a satisfied tally stops counting and keeps its last hit", () => {
  const t = makeTally(lit("ok"), 1);
  expect(t.feed("ok first")).toBe(true);
  t.feed("ok second");
  expect(t.hits).toBe(1);
  expect(t.last).toBe("ok first");
});

test("--count must be a positive integer", () => {
  expect(() => makeTally(lit("x"), 0)).toThrow(/positive integer/);
  expect(() => makeTally(lit("x"), 1.5)).toThrow(/positive integer/);
});

test("linesAfterAnchor returns the tail the follower has not seen", () => {
  const lines = ["$ run tests", "3 passed", "$ echo DONE", "DONE", "exit"];
  expect(linesAfterAnchor(lines, "$ echo DONE")).toEqual(["DONE", "exit"]);
});

test("linesAfterAnchor aligns on the LAST occurrence (repeated shell prompts)", () => {
  const lines = ["$ ", "building…", "$ ", "DONE"];
  expect(linesAfterAnchor(lines, "$ ")).toEqual(["DONE"]);
});

test("linesAfterAnchor skips the drain rather than rescanning history", () => {
  const lines = ["DONE", "more"];
  // No anchor, or an anchor this file doesn't contain: returning [] here would
  // let a "DONE" printed before the wait began be reported as a match.
  expect(linesAfterAnchor(lines, null)).toBe(null);
  expect(linesAfterAnchor(lines, "a line from another log")).toBe(null);
});

test("linesAfterAnchor is empty when the anchor is the last line", () => {
  expect(linesAfterAnchor(["a", "b"], "b")).toEqual([]);
});

test("exit codes follow the --wait family (0 match / 1 exited / 2 no match / 3 fail-on)", () => {
  expect(untilExitCode("match")).toBe(0);
  expect(untilExitCode("exited")).toBe(1);
  expect(untilExitCode("timeout")).toBe(2);
  // Being signalled away must not read as a match.
  expect(untilExitCode("stopped")).toBe(2);
  // --fail-on is its own code: "it went wrong" is not "it never happened".
  expect(untilExitCode("failed")).toBe(3);
});

test("the judge settles on --until when no --fail-on is armed", () => {
  const j = makeJudge(makeTally(lit("PASS")), null);
  expect(j.test("building")).toBe(false);
  expect(j.test("PASS: 12 tests")).toBe(true);
  expect(j.outcome).toBe("match");
  expect(j.matched).toBe("PASS: 12 tests");
});

test("the judge settles on --fail-on before --until on the same line", () => {
  // A line matching both is a failure: a caller branching on exit 0 must not be
  // told "matched" by the very line saying it went wrong.
  const j = makeJudge(makeTally(lit("step")), makeTally(lit("step"), 1));
  expect(j.test("step 3 of 4")).toBe(true);
  expect(j.outcome).toBe("failed");
  expect(j.matched).toBe("step 3 of 4");
});

test("whichever pattern lands first wins across lines", () => {
  const good = () => makeJudge(makeTally(lit("PASS")), makeTally(lit("FAIL"), 1));
  const a = good();
  a.testAll(["PASS now", "FAIL later"]);
  expect(a.outcome).toBe("match");
  const b = good();
  b.testAll(["FAIL now", "PASS later"]);
  expect(b.outcome).toBe("failed");
});

test("--fail-on does not settle a --count wait early on --until hits", () => {
  const j = makeJudge(makeTally(lit("ok"), 2), makeTally(lit("bad"), 1));
  expect(j.test("ok one")).toBe(false);
  expect(j.settled).toBe(false);
  expect(j.test("ok two")).toBe(true);
  expect(j.outcome).toBe("match");
});

test("a settled judge stays settled and ignores later lines", () => {
  const j = makeJudge(makeTally(lit("ok")), makeTally(lit("bad"), 1));
  expect(j.test("ok")).toBe(true);
  expect(j.test("bad")).toBe(true);
  expect(j.outcome).toBe("match");
  expect(j.matched).toBe("ok");
});

test("an unsettled judge reports no outcome", () => {
  const j = makeJudge(makeTally(lit("ok")), null);
  expect(j.testAll(["a", "b"])).toBe(false);
  expect(j.settled).toBe(false);
  expect(j.outcome).toBe(null);
  expect(j.matched).toBe(null);
});
