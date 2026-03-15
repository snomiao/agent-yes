#!/usr/bin/env bun test
import { describe, expect, it } from "vitest";
import { buildRustArgs } from "./buildRustArgs";

const SUPPORTED_CLIS = [
  "claude",
  "gemini",
  "codex",
  "copilot",
  "cursor",
  "grok",
  "qwen",
  "auggie",
  "amp",
  "opencode",
];

// Helper: simulate argv as [node, script, ...userArgs]
function argv(...userArgs: string[]): string[] {
  return ["node", "/path/to/claude-yes", ...userArgs];
}

describe("buildRustArgs", () => {
  // ─── Core: CLI name positioning ────────────────────────────────────
  // The CLI name MUST appear after all flags to avoid clap's trailing_var_arg
  // swallowing named flags as positional args.

  describe("CLI name is always appended at the end (not prepended)", () => {
    it("appends CLI name after flags", () => {
      const result = buildRustArgs(argv("--timeout", "1h"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--timeout", "1h", "claude"]);
    });

    it("appends CLI name after multiple flags", () => {
      const result = buildRustArgs(
        argv("--timeout", "30s", "--verbose", "--robust", "true"),
        "claude",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--timeout", "30s", "--verbose", "--robust", "true", "claude"]);
    });

    it("CLI name is the last element", () => {
      const result = buildRustArgs(argv("--timeout", "5m"), "codex", SUPPORTED_CLIS);
      expect(result[result.length - 1]).toBe("codex");
    });
  });

  // ─── The original bug: --timeout swallowed by trailing_var_arg ─────

  describe("regression: flags must not be swallowed by CLI name position", () => {
    it("--timeout is preserved before CLI name (the original bug)", () => {
      const result = buildRustArgs(argv("--timeout", "1h"), "claude", SUPPORTED_CLIS);
      const timeoutIdx = result.indexOf("--timeout");
      const cliIdx = result.indexOf("claude");
      expect(timeoutIdx).toBeGreaterThanOrEqual(0);
      expect(cliIdx).toBeGreaterThan(timeoutIdx);
    });

    it("--verbose is preserved before CLI name", () => {
      const result = buildRustArgs(argv("--verbose"), "claude", SUPPORTED_CLIS);
      const verboseIdx = result.indexOf("--verbose");
      const cliIdx = result.indexOf("claude");
      expect(verboseIdx).toBeGreaterThanOrEqual(0);
      expect(cliIdx).toBeGreaterThan(verboseIdx);
    });

    it("-c (continue) flag is preserved before CLI name", () => {
      const result = buildRustArgs(argv("-c"), "claude", SUPPORTED_CLIS);
      expect(result.indexOf("-c")).toBeLessThan(result.indexOf("claude"));
    });

    it("--robust flag is preserved before CLI name", () => {
      const result = buildRustArgs(argv("--robust", "true"), "gemini", SUPPORTED_CLIS);
      expect(result.indexOf("--robust")).toBeLessThan(result.indexOf("gemini"));
    });

    it("all flags come before CLI name in complex invocation", () => {
      const result = buildRustArgs(
        argv("--timeout", "1h", "--verbose", "-c", "--robust", "true"),
        "claude",
        SUPPORTED_CLIS,
      );
      const cliIdx = result.indexOf("claude");
      for (const flag of ["--timeout", "--verbose", "-c", "--robust"]) {
        expect(result.indexOf(flag)).toBeLessThan(cliIdx);
      }
    });
  });

  // ─── --rust flag filtering ─────────────────────────────────────────

  describe("--rust flag is filtered out", () => {
    it("removes --rust from args", () => {
      const result = buildRustArgs(argv("--rust", "--timeout", "30s"), "claude", SUPPORTED_CLIS);
      expect(result).not.toContain("--rust");
      expect(result).toContain("--timeout");
    });

    it("removes --rust= variant from args", () => {
      const result = buildRustArgs(argv("--rust=true", "--verbose"), "claude", SUPPORTED_CLIS);
      expect(result).not.toContain("--rust=true");
      expect(result).toContain("--verbose");
    });

    it("removes --rust regardless of position", () => {
      const result = buildRustArgs(
        argv("--verbose", "--rust", "--timeout", "5m"),
        "claude",
        SUPPORTED_CLIS,
      );
      expect(result).not.toContain("--rust");
      expect(result).toEqual(["--verbose", "--timeout", "5m", "claude"]);
    });
  });

  // ─── CLI name detection in args ────────────────────────────────────

  describe("does not duplicate CLI name if already in args", () => {
    it("skips appending when CLI name is already a positional arg", () => {
      const result = buildRustArgs(argv("--timeout", "30s", "claude"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--timeout", "30s", "claude"]);
      expect(result.filter((a) => a === "claude")).toHaveLength(1);
    });

    it("skips appending when --cli= flag is used", () => {
      const result = buildRustArgs(
        argv("--cli=gemini", "--timeout", "30s"),
        "claude",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--cli=gemini", "--timeout", "30s"]);
      expect(result).not.toContain("claude");
    });

    it("skips appending when --cli flag is used (separate value)", () => {
      const result = buildRustArgs(
        argv("--cli", "gemini", "--timeout", "30s"),
        "claude",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--cli", "gemini", "--timeout", "30s"]);
      expect(result).not.toContain("claude");
    });

    it("detects any supported CLI name in args", () => {
      for (const cli of ["gemini", "codex", "copilot", "cursor", "grok"]) {
        const result = buildRustArgs(argv("--timeout", "1m", cli), "claude", SUPPORTED_CLIS);
        expect(result).not.toContain("claude");
        expect(result).toContain(cli);
      }
    });
  });

  // ─── Swarm mode ────────────────────────────────────────────────────

  describe("swarm mode skips CLI name", () => {
    it("does not append CLI name when --swarm is present", () => {
      const result = buildRustArgs(argv("--swarm", "my-topic"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--swarm", "my-topic"]);
      expect(result).not.toContain("claude");
    });

    it("does not append CLI name when --swarm= is present", () => {
      const result = buildRustArgs(argv("--swarm=my-topic"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--swarm=my-topic"]);
      expect(result).not.toContain("claude");
    });

    it("does not append CLI name for bare --swarm", () => {
      const result = buildRustArgs(argv("--swarm"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--swarm"]);
      expect(result).not.toContain("claude");
    });
  });

  // ─── No CLI from script name ───────────────────────────────────────

  describe("no CLI from script name (agent-yes / ay)", () => {
    it("returns raw args when cliFromScript is undefined", () => {
      const result = buildRustArgs(argv("--timeout", "30s"), undefined, SUPPORTED_CLIS);
      expect(result).toEqual(["--timeout", "30s"]);
    });

    it("returns raw args when cliFromScript is empty string", () => {
      const result = buildRustArgs(argv("--timeout", "30s"), "", SUPPORTED_CLIS);
      expect(result).toEqual(["--timeout", "30s"]);
    });
  });

  // ─── Edge cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles no user args at all", () => {
      const result = buildRustArgs(["node", "/path/to/claude-yes"], "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["claude"]);
    });

    it("handles -- prompt separator correctly", () => {
      const result = buildRustArgs(
        argv("--timeout", "1h", "--", "do", "the", "thing"),
        "claude",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--timeout", "1h", "--", "do", "the", "thing", "claude"]);
      expect(result.indexOf("--timeout")).toBeLessThan(result.lastIndexOf("claude"));
    });

    it("handles -p prompt flag", () => {
      const result = buildRustArgs(argv("-p", "hello world"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["-p", "hello world", "claude"]);
    });

    it("preserves args with hyphen values (e.g. negative numbers)", () => {
      const result = buildRustArgs(argv("--some-flag", "-1"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--some-flag", "-1", "claude"]);
    });

    it("handles multiple --rust flags (all filtered)", () => {
      const result = buildRustArgs(argv("--rust", "--rust", "--verbose"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--verbose", "claude"]);
    });

    it("does not treat --swarm-topic as --swarm", () => {
      const result = buildRustArgs(argv("--swarm-topic", "my-topic"), "claude", SUPPORTED_CLIS);
      // --swarm-topic is NOT --swarm, so CLI name should still be appended
      expect(result).toContain("claude");
    });

    it("does not treat --cli-like strings inside values as CLI names", () => {
      // e.g. --prompt "use claude to ..." should not detect "claude" as a CLI arg
      // because "use claude to ..." is a value, not a standalone arg
      const result = buildRustArgs(argv("-p", "use claude to fix"), undefined, SUPPORTED_CLIS);
      // "claude" appears inside a value, but since cliFromScript is undefined, nothing appended
      expect(result).toEqual(["-p", "use claude to fix"]);
    });
  });

  // ─── Real-world command scenarios ──────────────────────────────────

  describe("real-world scenarios", () => {
    it("claude-yes --rust --timeout 1h (the original failing case)", () => {
      const result = buildRustArgs(argv("--rust", "--timeout", "1h"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--timeout", "1h", "claude"]);
    });

    it("claude-yes --rust --timeout 30s --verbose", () => {
      const result = buildRustArgs(
        argv("--rust", "--timeout", "30s", "--verbose"),
        "claude",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--timeout", "30s", "--verbose", "claude"]);
    });

    it("claude-yes --rust -c (continue session)", () => {
      const result = buildRustArgs(argv("--rust", "-c"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["-c", "claude"]);
    });

    it("codex-yes --rust --timeout 5m -- fix all bugs", () => {
      const result = buildRustArgs(
        argv("--rust", "--timeout", "5m", "--", "fix", "all", "bugs"),
        "codex",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--timeout", "5m", "--", "fix", "all", "bugs", "codex"]);
    });

    it("agent-yes --rust claude --timeout 1h (explicit CLI in args)", () => {
      const result = buildRustArgs(
        argv("--rust", "claude", "--timeout", "1h"),
        undefined,
        SUPPORTED_CLIS,
      );
      // cliFromScript is undefined (agent-yes), CLI already in args
      expect(result).toEqual(["claude", "--timeout", "1h"]);
    });

    it("agent-yes --rust --swarm my-project --timeout 1h", () => {
      const result = buildRustArgs(
        argv("--rust", "--swarm", "my-project", "--timeout", "1h"),
        "claude",
        SUPPORTED_CLIS,
      );
      // Swarm mode: no CLI name appended
      expect(result).toEqual(["--swarm", "my-project", "--timeout", "1h"]);
      expect(result).not.toContain("claude");
    });

    it("gemini-yes --rust --timeout 2m --verbose -p 'hello'", () => {
      const result = buildRustArgs(
        argv("--rust", "--timeout", "2m", "--verbose", "-p", "hello"),
        "gemini",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--timeout", "2m", "--verbose", "-p", "hello", "gemini"]);
    });

    it("claude-yes --rust --auto=no --timeout 10m", () => {
      const result = buildRustArgs(
        argv("--rust", "--auto=no", "--timeout", "10m"),
        "claude",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--auto=no", "--timeout", "10m", "claude"]);
    });
  });
});
