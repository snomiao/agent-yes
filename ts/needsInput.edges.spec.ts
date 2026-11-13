import { describe, expect, it } from "vitest";
import { classifyNeedsInput, parseMenu } from "./needsInput.ts";

describe("permission menu parsing edges", () => {
  it("does not leak state from global or sticky configuration expressions", () => {
    const pattern = /❯ 2\./gy;
    pattern.lastIndex = 20;
    for (let i = 0; i < 2; i++)
      expect(classifyNeedsInput(["❯ 2. Deny"], { needsInput: [pattern] })).not.toBeNull();
  });
  it("does not treat a multiline-only match or non-numbered confirmation as a navigable menu", () => {
    expect(parseMenu(["Confirm", "operation"], { needsInput: [/Confirm\noperation/] })).toBeNull();
    expect(parseMenu(["Confirm operation"], { needsInput: [/Confirm operation/] })).toBeNull();
    expect(classifyNeedsInput(["idle"], {})).toBeNull();
  });
  it("collects each option once and retains a cursor number from a custom menu layout", () => {
    const result = parseMenu(["1. Allow", "1. Allow", "selection: 3. Deny"], {
      needsInput: [/selection: 3\./],
    });
    expect(result?.cursor).toBe(3);
    expect(result?.options).toEqual([1, 3]);
  });
});
