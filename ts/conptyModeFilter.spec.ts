import { expect, test } from "vitest";
import { ConptyModeFilter } from "./conptyModeFilter";
test("only consumes inner ConPTY keyboard negotiation across every split", () => {
  const input =
    "hello?\x1b[?9001h\x1b[?1004;9001;2004h\x1b[?1003;1006h\x1b[A\x1b[200~paste\x1b[201~\x1b[?9001l\x1b[6n\x1b]7;cwd\x07";
  const expected =
    "hello?\x1b[?1004;2004h\x1b[?1003;1006h\x1b[A\x1b[200~paste\x1b[201~\x1b[6n\x1b]7;cwd\x07";
  for (let split = 0; split <= input.length; split++) {
    const filter = new ConptyModeFilter();
    expect(
      filter.feed(input.slice(0, split)) + filter.feed(input.slice(split)) + filter.finish(),
    ).toBe(expected);
  }
  const filter = new ConptyModeFilter();
  expect([...input].map((c) => filter.feed(c)).join("") + filter.finish()).toBe(expected);
});
test("preserves incomplete, long and unrelated sequences", () => {
  for (const input of [
    "\x1b",
    "\x1b[?",
    "\x1b[?9001",
    "\x1b[?90010h",
    "\x1b[?9001$p",
    "\x1b[?9001?",
    "\x1b[?" + "1".repeat(300),
  ]) {
    const filter = new ConptyModeFilter();
    expect(filter.feed(input) + filter.finish()).toBe(input);
  }
});
