import { describe, expect, it } from "vitest";
import { parseStatusText } from "./statusText.ts";

describe("parseStatusText", () => {
  it("returns the latest Claude spinner/status line", () => {
    expect(
      parseStatusText([
        "older output",
        "✶ Verifying calendar meetings with real data… (6m 30s · ↓ 19.5k tokens)",
      ]),
    ).toBe("✶ Verifying calendar meetings with real data… (6m 30s · ↓ 19.5k tokens)");
  });

  it("ignores non-status terminal prose", () => {
    expect(parseStatusText(["hello", "Done", ""])).toBe(null);
  });
});
