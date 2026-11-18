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

it("plans native flags on either side of the wrapper separator and preserves the exact task", async () => {
  const { parseCliArgs } = await import("../parseCliArgs.ts");
  const { planClaudeStream } = await import("./launch.ts");
  for (const tokens of [
    [
      "claude",
      "--",
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "example",
      "Exact task",
    ],
    [
      "claude",
      "-p",
      "--input-format=stream-json",
      "--output-format=stream-json",
      "--verbose",
      "Exact task",
    ],
    [
      "claude",
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--",
      "Exact task",
    ],
  ]) {
    const config = parseCliArgs(["bun", "agent-yes", ...tokens]);
    const plan = planClaudeStream(config.cli, config.nativeArgs, config.explicitPrompt);
    expect(plan?.prompt).toBe("Exact task");
    expect(plan?.args).not.toContain("Exact task");
    expect(plan?.args).not.toContain("--");
  }
  expect(planClaudeStream("claude", ["ordinary task"])).toBeNull();
  expect(planClaudeStream("claude", ["--", "task with --output-format stream-json"])).toBeNull();
  expect(planClaudeStream("claude", ["--", "Exact task"], undefined, true)?.prompt).toBe(
    "Exact task",
  );
});
