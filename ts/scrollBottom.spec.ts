import { describe, expect, it } from "vitest";
import { scrollBottomIdleMs, shouldScrollBottom } from "./scrollBottom.ts";

describe("shouldScrollBottom", () => {
  const limit = 300_000;
  it("fires only when scrolled up and idle long enough", () => {
    expect(shouldScrollBottom(true, limit, limit, "a", null)).toBe(true);
    expect(shouldScrollBottom(false, limit, limit, "a", null)).toBe(false);
    expect(shouldScrollBottom(true, limit - 1, limit, "a", null)).toBe(false);
  });
  it("does not repeat on the same screen, retries on a changed one", () => {
    expect(shouldScrollBottom(true, limit, limit, "a", "a")).toBe(false);
    expect(shouldScrollBottom(true, limit, limit, "b", "a")).toBe(true);
  });
  it("is disabled by a zero limit", () => {
    expect(shouldScrollBottom(true, limit, 0, "a", null)).toBe(false);
  });
});

describe("scrollBottomIdleMs", () => {
  it("defaults to 5 min and honours the env override", () => {
    expect(scrollBottomIdleMs({})).toBe(300_000);
    expect(scrollBottomIdleMs({ AGENT_YES_SCROLL_BOTTOM_IDLE_SECS: "60" })).toBe(60_000);
    expect(scrollBottomIdleMs({ AGENT_YES_SCROLL_BOTTOM_IDLE_SECS: "0" })).toBe(0);
  });
});
