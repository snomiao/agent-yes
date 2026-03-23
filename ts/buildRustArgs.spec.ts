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
  // ─── Core: CLI name passed via --cli= flag ─────────────────────────
  // The CLI name is passed via --cli= flag at the start, so it doesn't
  // get mixed with trailing positional args (which are prompt text).

  describe("CLI name is passed via --cli= flag", () => {
    it("prepends --cli= flag before other args", () => {
      const result = buildRustArgs(argv("--timeout", "1h"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--cli=claude", "--timeout", "1h"]);
    });

    it("prepends --cli= flag before multiple flags", () => {
      const result = buildRustArgs(
        argv("--timeout", "30s", "--verbose", "--robust", "true"),
        "claude",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--cli=claude", "--timeout", "30s", "--verbose", "--robust", "true"]);
    });

    it("--cli= is the first element", () => {
      const result = buildRustArgs(argv("--timeout", "5m"), "codex", SUPPORTED_CLIS);
      expect(result[0]).toBe("--cli=codex");
    });
  });

  // ─── Regression: flags must not be swallowed ───────────────────────

  describe("regression: flags are preserved alongside --cli=", () => {
    it("--timeout is preserved", () => {
      const result = buildRustArgs(argv("--timeout", "1h"), "claude", SUPPORTED_CLIS);
      expect(result).toContain("--timeout");
      expect(result).toContain("1h");
    });

    it("--verbose is preserved", () => {
      const result = buildRustArgs(argv("--verbose"), "claude", SUPPORTED_CLIS);
      expect(result).toContain("--verbose");
    });

    it("-c (continue) flag is preserved", () => {
      const result = buildRustArgs(argv("-c"), "claude", SUPPORTED_CLIS);
      expect(result).toContain("-c");
    });

    it("all flags are preserved in complex invocation", () => {
      const result = buildRustArgs(
        argv("--timeout", "1h", "--verbose", "-c", "--robust", "true"),
        "claude",
        SUPPORTED_CLIS,
      );
      for (const flag of ["--timeout", "--verbose", "-c", "--robust"]) {
        expect(result).toContain(flag);
      }
      expect(result[0]).toBe("--cli=claude");
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
      expect(result).toEqual(["--cli=claude", "--verbose", "--timeout", "5m"]);
    });
  });

  // ─── CLI name detection in args ────────────────────────────────────

  describe("does not duplicate CLI name if already in args", () => {
    it("skips --cli= when CLI name is already a positional arg", () => {
      const result = buildRustArgs(argv("--timeout", "30s", "claude"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--timeout", "30s", "claude"]);
      expect(result.filter((a) => a.includes("claude"))).toHaveLength(1);
    });

    it("skips --cli= when --cli= flag is already used", () => {
      const result = buildRustArgs(
        argv("--cli=gemini", "--timeout", "30s"),
        "claude",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--cli=gemini", "--timeout", "30s"]);
      expect(result).not.toContain("--cli=claude");
    });

    it("skips --cli= when --cli flag is used (separate value)", () => {
      const result = buildRustArgs(
        argv("--cli", "gemini", "--timeout", "30s"),
        "claude",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--cli", "gemini", "--timeout", "30s"]);
      expect(result).not.toContain("--cli=claude");
    });

    it("detects any supported CLI name in args", () => {
      for (const cli of ["gemini", "codex", "copilot", "cursor", "grok"]) {
        const result = buildRustArgs(argv("--timeout", "1m", cli), "claude", SUPPORTED_CLIS);
        expect(result).not.toContain("--cli=claude");
        expect(result).toContain(cli);
      }
    });
  });

  // ─── Swarm mode ────────────────────────────────────────────────────

  describe("swarm mode skips CLI name", () => {
    it("does not add --cli= when --swarm is present", () => {
      const result = buildRustArgs(argv("--swarm", "my-topic"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--swarm", "my-topic"]);
      expect(result).not.toContain("--cli=claude");
    });

    it("does not add --cli= when --swarm= is present", () => {
      const result = buildRustArgs(argv("--swarm=my-topic"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--swarm=my-topic"]);
      expect(result).not.toContain("--cli=claude");
    });

    it("does not add --cli= for bare --swarm", () => {
      const result = buildRustArgs(argv("--swarm"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--swarm"]);
      expect(result).not.toContain("--cli=claude");
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
      expect(result).toEqual(["--cli=claude"]);
    });

    it("handles -- prompt separator correctly", () => {
      const result = buildRustArgs(
        argv("--timeout", "1h", "--", "do", "the", "thing"),
        "claude",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--cli=claude", "--timeout", "1h", "--", "do", "the", "thing"]);
    });

    it("handles -p prompt flag", () => {
      const result = buildRustArgs(argv("-p", "hello world"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--cli=claude", "-p", "hello world"]);
    });

    it("preserves args with hyphen values (e.g. negative numbers)", () => {
      const result = buildRustArgs(argv("--some-flag", "-1"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--cli=claude", "--some-flag", "-1"]);
    });

    it("handles multiple --rust flags (all filtered)", () => {
      const result = buildRustArgs(argv("--rust", "--rust", "--verbose"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--cli=claude", "--verbose"]);
    });

    it("does not treat --swarm-topic as --swarm", () => {
      const result = buildRustArgs(argv("--swarm-topic", "my-topic"), "claude", SUPPORTED_CLIS);
      // --swarm-topic is NOT --swarm, so --cli= should still be added
      expect(result[0]).toBe("--cli=claude");
    });

    it("does not treat --cli-like strings inside values as CLI names", () => {
      const result = buildRustArgs(argv("-p", "use claude to fix"), undefined, SUPPORTED_CLIS);
      // "claude" appears inside a value, but since cliFromScript is undefined, nothing added
      expect(result).toEqual(["-p", "use claude to fix"]);
    });

    it("bare words (prompt without --) are passed through for Rust to handle", () => {
      const result = buildRustArgs(
        argv("rebuild", "and", "analyze", "problems"),
        "claude",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--cli=claude", "rebuild", "and", "analyze", "problems"]);
    });
  });

  // ─── Real-world command scenarios ──────────────────────────────────

  describe("real-world scenarios", () => {
    it("claude-yes --rust --timeout 1h (the original failing case)", () => {
      const result = buildRustArgs(argv("--rust", "--timeout", "1h"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--cli=claude", "--timeout", "1h"]);
    });

    it("claude-yes --rust --timeout 30s --verbose", () => {
      const result = buildRustArgs(
        argv("--rust", "--timeout", "30s", "--verbose"),
        "claude",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--cli=claude", "--timeout", "30s", "--verbose"]);
    });

    it("claude-yes --rust -c (continue session)", () => {
      const result = buildRustArgs(argv("--rust", "-c"), "claude", SUPPORTED_CLIS);
      expect(result).toEqual(["--cli=claude", "-c"]);
    });

    it("codex-yes --rust --timeout 5m -- fix all bugs", () => {
      const result = buildRustArgs(
        argv("--rust", "--timeout", "5m", "--", "fix", "all", "bugs"),
        "codex",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--cli=codex", "--timeout", "5m", "--", "fix", "all", "bugs"]);
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
      // Swarm mode: no CLI name added
      expect(result).toEqual(["--swarm", "my-project", "--timeout", "1h"]);
      expect(result).not.toContain("--cli=claude");
    });

    it("gemini-yes --rust --timeout 2m --verbose -p 'hello'", () => {
      const result = buildRustArgs(
        argv("--rust", "--timeout", "2m", "--verbose", "-p", "hello"),
        "gemini",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--cli=gemini", "--timeout", "2m", "--verbose", "-p", "hello"]);
    });

    it("claude-yes --rust --auto=no --timeout 10m", () => {
      const result = buildRustArgs(
        argv("--rust", "--auto=no", "--timeout", "10m"),
        "claude",
        SUPPORTED_CLIS,
      );
      expect(result).toEqual(["--cli=claude", "--auto=no", "--timeout", "10m"]);
    });

    it("cy rebuild and analyze problems (bare prompt words)", () => {
      const result = buildRustArgs(
        argv("rebuild", "and", "analyze", "problems"),
        "claude",
        SUPPORTED_CLIS,
      );
      // CLI passed via --cli=, bare words passed through for Rust to interpret as prompt
      expect(result).toEqual(["--cli=claude", "rebuild", "and", "analyze", "problems"]);
    });
  });
});
