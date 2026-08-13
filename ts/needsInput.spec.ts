import { expect, test } from "vitest";
import { classifyNeedsInput, isWorkingScreen, parseMenu } from "./needsInput.ts";
import { loadSharedCliDefaults } from "./configShared.ts";

// Use the REAL shipped claude/codex patterns so the test guards the actual config.
const defaults = await loadSharedCliDefaults();
const claude = { needsInput: defaults.claude?.needsInput, working: defaults.claude?.working };
const codex = { needsInput: defaults.codex?.needsInput, working: defaults.codex?.working };

test("claude config actually ships a needsInput pattern", () => {
  expect(claude.needsInput?.length).toBeGreaterThan(0);
});

test("claude config ships a working busy marker (the stuck detector keys off it)", () => {
  expect(claude.working?.length).toBeGreaterThan(0);
});

test("isWorkingScreen: true when the shipped claude busy marker is on screen", () => {
  const screen = ["⏺ Running the test suite…", "", "esc to interrupt · ← for agents"];
  expect(isWorkingScreen(screen, claude.working)).toBe(true);
});

test("isWorkingScreen: false at a finished/idle prompt (no busy marker)", () => {
  const screen = ["⏺ Done — all tests pass.", "", "❯", "", "? for shortcuts"];
  expect(isWorkingScreen(screen, claude.working)).toBe(false);
});

test("isWorkingScreen: false when no working patterns are configured", () => {
  expect(isWorkingScreen(["esc to interrupt"], undefined)).toBe(false);
  expect(isWorkingScreen(["esc to interrupt"], [])).toBe(false);
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

test("parseMenu: cursor on option 1, all options collected (for ay select)", () => {
  const screen = [
    "Which auth method should we use?",
    "",
    "❯ 1. Session tokens",
    "  2. JWT",
    "  3. OAuth",
    "",
    "? for shortcuts",
  ];
  const menu = parseMenu(screen, claude);
  expect(menu).not.toBeNull();
  expect(menu!.cursor).toBe(1);
  expect(menu!.options).toEqual([1, 2, 3]);
});

test("parseMenu: reads a pre-highlighted non-first default (cursor delta, not blind N-1)", () => {
  const screen = ["Proceed?", "  1. Yes", "❯ 2. No, ask again", "  3. Cancel"];
  const menu = parseMenu(screen, claude);
  expect(menu!.cursor).toBe(2);
  expect(menu!.options).toEqual([1, 2, 3]);
});

test("parseMenu: codex › cursor", () => {
  const menu = parseMenu(["Pick a branch", "  1. main", "› 2. develop"], codex);
  expect(menu!.cursor).toBe(2);
  expect(menu!.options).toEqual([1, 2]);
});

test("parseMenu: null when not on a menu (idle prompt / working)", () => {
  expect(parseMenu(['❯ Try "fix the bug"', "? for shortcuts"], claude)).toBeNull();
  expect(parseMenu(["❯ 1. Session tokens", "✻ Working… (esc to interrupt)"], claude)).toBeNull();
});

test("parseMenu: a 'N.M' version in an option label isn't mistaken for another option", () => {
  const screen = ["Cleanup?", "❯ 1. Delete 3.5GB of cache", "  2. Keep"];
  const menu = parseMenu(screen, claude);
  expect(menu!.cursor).toBe(1);
  expect(menu!.options).toEqual([1, 2]);
});

// Claude renders its permission / AskUserQuestion dialogs INSIDE a rounded box,
// so every option row arrives with a leading "│" border (the shipped config's own
// markers show this: a typingRespond keyed on '│ Do you want to use this API key\?'
// and `enter` rows like "│ ● 1. Yes, allow once"). Option rows must still be
// collected through that border — otherwise `ay select N` can only ever pick the
// option the cursor already sits on.
test("parseMenu: collects options through a box border (claude permission dialog)", () => {
  const screen = [
    "╭──────────────────────────────────────────────────────────╮",
    "│ Do you want to proceed?                                  │",
    "│ ❯ 1. Yes                                                 │",
    "│   2. Yes, and don't ask again for rm commands in /repo   │",
    "│   3. No, and tell Claude what to do differently (esc)    │",
    "╰──────────────────────────────────────────────────────────╯",
  ];
  const menu = parseMenu(screen, claude);
  expect(menu!.cursor).toBe(1);
  expect(menu!.options).toEqual([1, 2, 3]);
});

test("parseMenu: collects boxed bullet rows ('│ ● 1. Yes, allow once')", () => {
  const screen = [
    "│ Apply this change?          │",
    "│ ❯ 1. Yes, allow once        │",
    "│ ● 2. Yes, allow always      │",
    "│ ● 3. No (esc)               │",
  ];
  const menu = parseMenu(screen, claude);
  expect(menu!.cursor).toBe(1);
  expect(menu!.options).toEqual([1, 2, 3]);
});

test("parseMenu: a boxed 'N.M' version still isn't mistaken for an option", () => {
  const screen = [
    "│ Cleanup?              │",
    "│ ❯ 1. Delete 3.5GB     │",
    "│   2. Keep             │",
  ];
  const menu = parseMenu(screen, claude);
  expect(menu!.options).toEqual([1, 2]);
});
