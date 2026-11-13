import { expect, test } from "bun:test";
import { controlCodeFromName, isSubmitCode } from "./subcommands.ts";

test("native queued send stays Enter; immediate Alt+M requires an explicit code", () => {
  expect(controlCodeFromName("enter")).toBe("\r");
  for (const alias of ["alt-m", "alt+m"]) {
    expect(controlCodeFromName(alias)).toBe("\x1bm");
    expect(isSubmitCode(controlCodeFromName(alias))).toBe(true);
  }
  for (const code of ["esc", "ctrl-c", "tab", "none"])
    expect(isSubmitCode(controlCodeFromName(code))).toBe(false);
});
