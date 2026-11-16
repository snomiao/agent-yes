import { expect, it } from "vitest";
import { isClaudeStream, nativeFlagValue, withStreamFlags } from "./launch.ts";

it("detects native Claude stream flags without modifying ordinary launches", () => {
  expect(isClaudeStream("claude", ["task"])).toBe(false);
  expect(isClaudeStream("claude", ["-p", "--output-format", "stream-json"])).toBe(true);
  expect(isClaudeStream("claude", ["--output-format=stream-json"])).toBe(true);
  expect(isClaudeStream("other", ["--output-format=stream-json"])).toBe(false);
  expect(isClaudeStream("claude", ["--", "--output-format=stream-json"])).toBe(false);
  expect(
    nativeFlagValue(["--output-format=json", "--output-format", "stream-json"], "--output-format"),
  ).toBe("stream-json");
  expect(withStreamFlags(["--model", "haiku"])).toContain("--replay-user-messages");
});
