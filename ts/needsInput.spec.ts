import { expect, test } from "bun:test";
import { classifyNeedsInput } from "./needsInput.ts";
import { loadSharedCliDefaults } from "./configShared.ts";

// Use the REAL shipped claude/codex patterns so the test guards the actual config.
const defaults = await loadSharedCliDefaults();
const claude = { needsInput: defaults.claude?.needsInput, working: defaults.claude?.working };
const codex = { needsInput: defaults.codex?.needsInput, working: defaults.codex?.working };

test("claude config actually ships a needsInput pattern", () => {
  expect(claude.needsInput?.length).toBeGreaterThan(0);
});

test("detects a claude AskUserQuestion selection menu", () => {
  const screen = [
    "Which auth method should we use?",
    "",
    "❯ 1. Session tokens",
    "  2. JWT",
    "  3. OAuth",
    "",
    "? for shortcuts",
  ];
  const ni = classifyNeedsInput(screen, claude);
  expect(ni).not.toBeNull();
  expect(ni!.question).toContain("auth method");
});

test("a plain idle prompt is NOT needs_input", () => {
  const screen = ['❯ Try "fix the bug in auth.ts"', "", "? for shortcuts"];
  expect(classifyNeedsInput(screen, claude)).toBeNull();
});

test("an actively-working agent is NOT needs_input even if a menu lingers above", () => {
  const screen = [
    "❯ 1. Session tokens", // stale menu in scrollback
    "✻ Working… (3s · esc to interrupt)",
  ];
  expect(classifyNeedsInput(screen, claude)).toBeNull();
});

test("regular numbered output (no cursor glyph) is NOT a menu", () => {
  const screen = ["Here are the steps:", "1. do this", "2. then that", "? for shortcuts"];
  expect(classifyNeedsInput(screen, claude)).toBeNull();
});

test("detects a codex selection menu (› cursor)", () => {
  const screen = ["Pick a branch to target", "› 1. main", "  2. develop"];
  const ni = classifyNeedsInput(screen, codex);
  expect(ni).not.toBeNull();
});

test("no patterns configured → always null", () => {
  expect(classifyNeedsInput(["❯ 1. anything"], { needsInput: [], working: [] })).toBeNull();
});
