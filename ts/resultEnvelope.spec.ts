import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildStoredResult, normalizeEnvelope, resultPath, resultsDir } from "./resultEnvelope.ts";

describe("normalizeEnvelope", () => {
  it("passes a JSON object through unchanged", () => {
    const out = normalizeEnvelope('{"status":"done","commits":["abc123"]}');
    expect(out).toEqual({ status: "done", commits: ["abc123"] });
  });

  it("keeps JSON arrays and scalars as-is (agent owns the shape)", () => {
    expect(normalizeEnvelope("[1,2,3]")).toEqual([1, 2, 3]);
    expect(normalizeEnvelope("42")).toBe(42);
  });

  it("wraps non-JSON text as a summary instead of rejecting", () => {
    expect(normalizeEnvelope("shipped the fix")).toEqual({ summary: "shipped the fix" });
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(normalizeEnvelope('  \n {"ok":true}\n ')).toEqual({ ok: true });
  });

  it("returns null for empty / whitespace-only input", () => {
    expect(normalizeEnvelope("")).toBeNull();
    expect(normalizeEnvelope("   \n\t")).toBeNull();
  });
});

describe("buildStoredResult", () => {
  it("wraps the payload with correlation metadata", () => {
    expect(buildStoredResult(123, { status: "done" }, 1000)).toEqual({
      pid: 123,
      written_at: 1000,
      result: { status: "done" },
    });
  });
});

describe("resultPath", () => {
  it("derives a per-pid path under the results dir", () => {
    // Use path.join (not a hardcoded "/") so the expectation matches the
    // platform separator — resultPath itself joins, so on Windows it's "\".
    expect(resultPath(777)).toBe(path.join(resultsDir(), "777.json"));
  });
});
