import { expect, test } from "vitest";
import { compileUntil, firstMatch, linesAfterAnchor, untilExitCode } from "./untilMatch.ts";

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

test("firstMatch returns the matching line, or null", () => {
  const lines = ["building…", "3 passed, 0 failed", "done"];
  expect(firstMatch(lines, lit("passed"))).toBe("3 passed, 0 failed");
  expect(firstMatch(lines, lit("crashed"))).toBe(null);
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

test("exit codes follow the --wait family (0 match / 1 exited / 2 no match)", () => {
  expect(untilExitCode("match")).toBe(0);
  expect(untilExitCode("exited")).toBe(1);
  expect(untilExitCode("timeout")).toBe(2);
  // Being signalled away must not read as a match.
  expect(untilExitCode("stopped")).toBe(2);
});
