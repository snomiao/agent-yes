import { describe, expect, it } from "vitest";
import { CLAUDE_SESSION_PIN_ENV, stripClaudeSessionPin } from "./sessionEnv.ts";

describe("CLAUDE_SESSION_PIN_ENV", () => {
  it("includes the markers that cause the child-session symptoms", () => {
    // CLAUDE_CODE_CHILD_SESSION → "Transcript saving is off"; SSE_PORT/SESSION_ID
    // → nested-attach "fail to connect". All must be in the strip set.
    for (const k of [
      "CLAUDECODE",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_SSE_PORT",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_ENTRYPOINT",
    ]) {
      expect(CLAUDE_SESSION_PIN_ENV).toContain(k);
    }
  });

  it("does NOT include AGENT_YES_PID (re-stamped per path, not shared)", () => {
    expect(CLAUDE_SESSION_PIN_ENV).not.toContain("AGENT_YES_PID");
  });
});

describe("stripClaudeSessionPin", () => {
  it("removes every pin var so the child is a clean top-level session", () => {
    const env: Record<string, string | undefined> = {
      CLAUDECODE: "1",
      CLAUDE_CODE_SSE_PORT: "12345",
      CLAUDE_CODE_SESSION_ID: "abc-123",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
    };
    stripClaudeSessionPin(env);
    for (const k of CLAUDE_SESSION_PIN_ENV) expect(env[k]).toBeUndefined();
  });

  it("preserves non-pin CLAUDE_CODE_* config and unrelated vars", () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_CHILD_SESSION: "1",
      // provider/auth/limit config that must survive
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
      CLAUDE_EFFORT: "high",
      ANTHROPIC_API_KEY: "sk-xxx",
      PATH: "/usr/bin",
      AGENT_YES_PID: "999",
    };
    stripClaudeSessionPin(env);
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("8000");
    expect(env.CLAUDE_EFFORT).toBe("high");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-xxx");
    expect(env.PATH).toBe("/usr/bin");
    // AGENT_YES_PID is this path's own concern (re-stamped), not stripped here.
    expect(env.AGENT_YES_PID).toBe("999");
  });

  it("is idempotent and returns the same object (already-clean env)", () => {
    const env: Record<string, string | undefined> = { PATH: "/bin" };
    const out = stripClaudeSessionPin(env);
    expect(out).toBe(env);
    expect(out).toEqual({ PATH: "/bin" });
  });
});
