#!/usr/bin/env bun test
import { describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "./parseCliArgs";

describe("CLI argument parsing", () => {
  it("should parse cli name from first positional argument", () => {
    const result = parseCliArgs(["node", "/path/to/cli", "claude"]);

    expect(result.cli).toBe("claude");
  });

  it("should parse prompt from --prompt flag", () => {
    const result = parseCliArgs(["node", "/path/to/cli", "--prompt", "hello world", "claude"]);

    expect(result.prompt).toBe("hello world");
  });

  it("should parse prompt from -- separator", () => {
    const result = parseCliArgs(["node", "/path/to/cli", "claude", "--", "hello", "world"]);

    expect(result.prompt).toBe("hello world");
  });

  it("should parse prompt from only -- separator with -yes cli", () => {
    const result = parseCliArgs(["node", "/path/to/claude-yes", "--", "hello", "world"]);

    expect(result.prompt).toBe("hello world");
  });

  it("should combine --prompt and -- prompt", () => {
    const result = parseCliArgs([
      "node",
      "/path/to/cli",
      "--prompt",
      "part1",
      "claude",
      "--",
      "part2",
    ]);

    expect(result.prompt).toBe("part1 part2");
  });

  it("should parse --idle flag", () => {
    const result = parseCliArgs(["node", "/path/to/cli", "--idle", "30s", "claude"]);

    expect(result.exitOnIdle).toBe(30000);
  });

  it("should parse --exit-on-idle flag (deprecated)", () => {
    const result = parseCliArgs(["node", "/path/to/cli", "--exit-on-idle", "1m", "claude"]);

    expect(result.exitOnIdle).toBe(60000);
  });

  it("should parse --robust flag", () => {
    const result = parseCliArgs(["node", "/path/to/cli", "--robust", "claude"]);

    expect(result.robust).toBe(true);
  });

  it("should parse --no-robust flag", () => {
    const result = parseCliArgs(["node", "/path/to/cli", "--no-robust", "claude"]);

    expect(result.robust).toBe(false);
  });

  it("should parse --queue flag", () => {
    const result = parseCliArgs(["node", "/path/to/cli", "--queue", "claude"]);

    expect(result.queue).toBe(true);
  });

  it("should parse --no-queue flag", () => {
    const result = parseCliArgs(["node", "/path/to/cli", "--no-queue", "claude"]);

    expect(result.queue).toBe(false);
  });

  it("should parse --logFile flag", () => {
    const result = parseCliArgs(["node", "/path/to/cli", "--logFile", "./output.log", "claude"]);

    expect(result.logFile).toBe("./output.log");
  });

  it("should parse --verbose flag", () => {
    const result = parseCliArgs(["node", "/path/to/cli", "--verbose", "claude"]);

    expect(result.verbose).toBe(true);
  });

  it("should pass through unknown CLI args to cliArgs", () => {
    const result = parseCliArgs(["node", "/path/to/cli", "claude", "--unknown-flag", "value"]);

    expect(result.cliArgs).toContain("--unknown-flag");
    expect(result.cliArgs).toContain("value");
  });

  it("should separate agent-yes args from cli args before --", () => {
    const result = parseCliArgs([
      "node",
      "/path/to/cli",
      "--robust",
      "claude",
      "--claude-arg",
      "--",
      "prompt",
    ]);

    expect(result.cli).toBe("claude");
    expect(result.robust).toBe(true);
    expect(result.cliArgs).toContain("--claude-arg");
    expect(result.prompt).toBe("prompt");
  });

  it("should detect cli name from script name (claude-yes)", () => {
    const result = parseCliArgs(["/usr/bin/node", "/usr/local/bin/claude-yes", "--prompt", "test"]);

    expect(result.cli).toBe("claude");
  });

  it("should detect cli name from script name (codex-yes)", () => {
    const result = parseCliArgs(["/usr/bin/node", "/usr/local/bin/codex-yes", "--prompt", "test"]);

    expect(result.cli).toBe("codex");
  });

  it("should prefer script name over explicit cli argument", () => {
    const result = parseCliArgs([
      "/usr/bin/node",
      "/usr/local/bin/claude-yes",
      "--prompt",
      "test",
      "gemini",
    ]);

    // cliName (from script) takes precedence over positional arg
    expect(result.cli).toBe("claude");
  });

  it("should handle empty cliArgs when no positional cli is provided", () => {
    const result = parseCliArgs([
      "/usr/bin/node",
      "/usr/local/bin/claude-yes",
      "--prompt",
      "prompt",
    ]);

    expect(result.cliArgs).toEqual([]);
    expect(result.prompt).toBe("prompt");
  });

  it("should include all args when no -- separator is present", () => {
    const result = parseCliArgs([
      "node",
      "/path/to/cli",
      "claude",
      "--some-flag",
      "--another-flag",
    ]);

    expect(result.cliArgs).toContain("--some-flag");
    expect(result.cliArgs).toContain("--another-flag");
  });

  it("should parse bunx agent-yes command with verbose and dash prompt", () => {
    const result = parseCliArgs([
      "/tmp/bunx-0-agent-yes@beta/node_modules/bun/bin/bun.exe",
      "/tmp/bunx-0-agent-yes@beta/node_modules/agent-yes/dist/cli.js",
      "--verbose",
      "claude",
      "--",
      "lets",
      "fix",
      "signin",
      "page,",
      "setup",
      "shadcn",
    ]);

    expect(result.cli).toBe("claude");
    expect(result.verbose).toBe(true);
    expect(result.cliArgs).toEqual([]);
    expect(result.prompt).toBe("lets fix signin page, setup shadcn");
  });

  it("should parse bunx agent-yes command with verbose and dash prompt", () => {
    const result = parseCliArgs([
      "/tmp/bunx-0-agent-yes@beta/node_modules/bun/bin/bun.exe",
      "/tmp/bunx-0-agent-yes@beta/node_modules/agent-yes/dist/claude-yes.js",
      "--",
      "lets",
      "fix",
      "signin",
      "page,",
      "setup",
      "shadcn",
    ]);

    expect(result.cli).toBe("claude");
    expect(result.verbose).toBe(false);
    expect(result.cliArgs).toEqual([]);
    expect(result.prompt).toBe("lets fix signin page, setup shadcn");
  });

  it("should pass -h flag to claude CLI args", () => {
    const result = parseCliArgs([
      "/root/.nvm/versions/node/v24.5.0/bin/node",
      "/root/.bun/bin/claude-yes",
      "-h",
    ]);

    expect(result.cli).toBe("claude");
    expect(result.cliArgs).toEqual(["-h"]);
  });

  it("should parse --use-skills flag", () => {
    const result = parseCliArgs([
      "node",
      "/path/to/cli",
      "--use-skills",
      "codex",
      "--",
      "Implement feature",
    ]);

    expect(result.useSkills).toBe(true);
    expect(result.cli).toBe("codex");
    expect(result.prompt).toBe("Implement feature");
  });

  it("should parse ay -- hello command (ay is wrapper, so CLI is undefined)", () => {
    const result = parseCliArgs([
      "node",
      "/path/to/ay",
      "--",
      "hello",
    ]);

    // "ay" is a wrapper script like "agent-yes", so cliName is stripped to undefined
    // cli.ts will default this to "claude" at runtime
    expect(result.cli).toBeUndefined();
    expect(result.cliArgs).toEqual([]);
    expect(result.prompt).toBe("hello");
    expect(result.verbose).toBe(false);
    expect(result.robust).toBe(true);
  });

  it("should parse --timeout flag", () => {
    const result = parseCliArgs(["node", "/path/to/cli", "--timeout", "45s", "claude"]);

    expect(result.exitOnIdle).toBe(45000);
  });

  it("should prioritize --timeout over --exit-on-idle", () => {
    const result = parseCliArgs(["node", "/path/to/cli", "--timeout", "30s", "--exit-on-idle", "1m", "claude"]);

    expect(result.exitOnIdle).toBe(30000);
  });

  it("should prioritize --timeout over --idle", () => {
    const result = parseCliArgs(["node", "/path/to/cli", "--timeout", "15s", "--idle", "1m", "claude"]);

    expect(result.exitOnIdle).toBe(15000);
  });

  it("should show deprecation warning for --exit-on-idle", () => {
    const warnSpy = vi.spyOn(console, "warn");

    parseCliArgs(["node", "/path/to/cli", "--exit-on-idle", "1m", "claude"]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("--exit-on-idle and -e are deprecated")
    );

    warnSpy.mockRestore();
  });

  it("should show deprecation warning for -e flag", () => {
    const warnSpy = vi.spyOn(console, "warn");

    parseCliArgs(["node", "/path/to/cli", "-e", "1m", "claude"]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("--exit-on-idle and -e are deprecated")
    );

    warnSpy.mockRestore();
  });

  it("should not show deprecation warning when using --timeout", () => {
    const warnSpy = vi.spyOn(console, "warn");

    parseCliArgs(["node", "/path/to/cli", "--timeout", "30s", "claude"]);

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
