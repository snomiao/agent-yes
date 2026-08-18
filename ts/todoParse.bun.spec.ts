import { describe, it, expect } from "bun:test";
import { parseTaskCounts } from "./todoParse.ts";

const lines = (s: string) => s.split("\n");

describe("parseTaskCounts", () => {
  it("counts a standard ⎿-anchored todo block (done as numerator)", () => {
    const out = parseTaskCounts(
      lines(
        [
          "⏺ Update Todos",
          "  ⎿  ☒ Wire up the parser",
          "     ☒ Add the badge",
          "     ◼ Compute in /api/ls",
          "     ◻ Render in the console",
          "     ◻ Tests",
        ].join("\n"),
      ),
    );
    expect(out).toEqual({ done: 2, total: 5 });
  });

  it("treats ✔ ☑ ✓ ☒ all as done, ◼ as in-progress, ◻ ☐ as pending", () => {
    const out = parseTaskCounts(
      lines(["⎿ ✔ a", "  ☑ b", "  ✓ c", "  ☒ d", "  ◼ e", "  ◻ f", "  ☐ g"].join("\n")),
    );
    expect(out).toEqual({ done: 4, total: 7 });
  });

  it("returns null with no ⎿ anchor (avoid false positives from prose glyphs)", () => {
    const out = parseTaskCounts(
      lines(["I finished ✔ the thing", "and ◻ another note", "✓ done-ish"].join("\n")),
    );
    expect(out).toBeNull();
  });

  it("requires ≥2 marker lines", () => {
    expect(parseTaskCounts(lines(["⎿ ☒ only one"].join("\n")))).toBeNull();
  });

  it("picks the MOST RECENT block when several are present", () => {
    const out = parseTaskCounts(
      lines(
        ["⎿ ☒ old1", "  ◻ old2", "  ◻ old3", "...work...", "⎿ ☒ new1", "  ☒ new2", "  ◻ new3"].join(
          "\n",
        ),
      ),
    );
    expect(out).toEqual({ done: 2, total: 3 });
  });

  it("accepts the anchor on the line directly above the markers", () => {
    const out = parseTaskCounts(lines(["  ⎿", "  ☒ a", "  ◻ b"].join("\n")));
    expect(out).toEqual({ done: 1, total: 2 });
  });

  it("stops the block at a non-marker (wrapped/continuation) line", () => {
    // a prose line between two markers splits the run; the qualifying block is the
    // contiguous one with the anchor.
    const out = parseTaskCounts(lines(["⎿ ☒ a", "  ☒ b", "some interruption", "  ◻ c"].join("\n")));
    expect(out).toEqual({ done: 2, total: 2 });
  });

  it("returns null for empty / no-todo output", () => {
    expect(parseTaskCounts([])).toBeNull();
    expect(parseTaskCounts(lines("just some logs\nnothing here"))).toBeNull();
  });

  // The CLI branches EVERY tool result under the same ⎿ glyph, not just todo
  // blocks — and ✓ is an ordinary success glyph in program output. So a ⎿ line
  // that carries its own content is a tool-result header, not a todo anchor;
  // only a BARE ⎿ anchors the markers below it.
  it("does not invent a badge from a test run's ✓ output (⎿ tool-result header)", () => {
    const out = parseTaskCounts(
      lines(
        [
          "⏺ Bash(bun run test)",
          "  ⎿  RUN  v3.2.4 /repo",
          "     ✓ ts/badges.spec.ts (18 tests) 12ms",
          "     ✓ ts/needsInput.spec.ts (12 tests) 9ms",
          "     ✓ ts/autoRetry.spec.ts (7 tests) 4ms",
        ].join("\n"),
      ),
    );
    expect(out).toBeNull();
  });

  it("does not invent a badge from ✓ prose under a ⎿ result header", () => {
    const out = parseTaskCounts(
      lines(
        ["  ⎿  Read 120 lines (ctrl+o to expand)", "     ✓ Tests pass", "     ✓ Lint clean"].join(
          "\n",
        ),
      ),
    );
    expect(out).toBeNull();
  });
});
