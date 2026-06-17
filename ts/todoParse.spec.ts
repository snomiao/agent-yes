import { describe, it, expect } from "vitest";
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
});
