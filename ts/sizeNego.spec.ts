import { describe, expect, it } from "vitest";
import { NEGO_FLOOR_COLS, NEGO_FLOOR_ROWS, negotiateSize, sanitizeCap } from "./sizeNego.ts";

describe("sanitizeCap", () => {
  it("accepts a normal viewer capacity", () => {
    expect(sanitizeCap({ cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 });
  });
  it("floors fractional values", () => {
    expect(sanitizeCap({ cols: 80.9, rows: 24.7 })).toEqual({ cols: 80, rows: 24 });
  });
  it("rejects null / non-object / missing fields", () => {
    expect(sanitizeCap(null)).toBeNull();
    expect(sanitizeCap(undefined)).toBeNull();
    expect(sanitizeCap("80x24")).toBeNull();
    expect(sanitizeCap({})).toBeNull();
    expect(sanitizeCap({ cols: 80 })).toBeNull();
  });
  it("rejects out-of-range junk (mid-layout 0x0, absurd sizes)", () => {
    expect(sanitizeCap({ cols: 0, rows: 0 })).toBeNull();
    expect(sanitizeCap({ cols: 10, rows: 24 })).toBeNull(); // below min cols
    expect(sanitizeCap({ cols: 80, rows: 2 })).toBeNull(); // below min rows
    expect(sanitizeCap({ cols: 9999, rows: 24 })).toBeNull();
    expect(sanitizeCap({ cols: 80, rows: 9999 })).toBeNull();
    expect(sanitizeCap({ cols: NaN, rows: 24 })).toBeNull();
  });
});

describe("negotiateSize", () => {
  it("returns null with no caps (withdraw → tty size rules)", () => {
    expect(negotiateSize([])).toBeNull();
  });
  it("single viewer: adopts its capacity", () => {
    expect(negotiateSize([{ cols: 133, rows: 40 }])).toEqual({ cols: 133, rows: 40 });
  });
  it("phone + desktop: elementwise min (the tmux rule)", () => {
    // phone is narrow but tall, desktop is wide but short → min of each axis
    const phone = { cols: 51, rows: 60 };
    const desktop = { cols: 200, rows: 50 };
    expect(negotiateSize([phone, desktop])).toEqual({ cols: 51, rows: 50 });
  });
  it("clamps to the floor so a tiny viewer can't wedge the agent", () => {
    expect(negotiateSize([{ cols: 20, rows: 5 }])).toEqual({
      cols: NEGO_FLOOR_COLS,
      rows: NEGO_FLOOR_ROWS,
    });
  });
  it("three viewers: min wins per axis", () => {
    expect(
      negotiateSize([
        { cols: 100, rows: 30 },
        { cols: 80, rows: 50 },
        { cols: 120, rows: 24 },
      ]),
    ).toEqual({ cols: 80, rows: 24 });
  });
});
