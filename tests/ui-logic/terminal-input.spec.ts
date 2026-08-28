import { describe, expect, it, vi } from "vitest";
import { OrderedInputQueue, PredictiveEcho } from "../../lab/ui/rgui/terminal-input";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("OrderedInputQueue", () => {
  it("coalesces keys queued behind one request and preserves order", async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => (release = resolve));
    const sent: string[] = [];
    const queue = new OrderedInputQueue(async (data) => {
      sent.push(data);
      if (sent.length === 1) await first;
      return { ok: true, text: "" };
    }, vi.fn());
    queue.push("a");
    await tick();
    queue.push("b");
    queue.push("c");
    expect(sent).toEqual(["a"]);
    release();
    await tick();
    await tick();
    expect(sent).toEqual(["a", "bc"]);
  });

  it("reports a failed batch and continues", async () => {
    const errors = vi.fn();
    const sent: string[] = [];
    const queue = new OrderedInputQueue(async (data) => {
      sent.push(data);
      return { ok: sent.length > 1, text: "denied" };
    }, errors);
    queue.push("a");
    await tick();
    queue.push("b");
    await tick();
    await tick();
    expect(sent.join("")).toBe("ab");
    expect(errors).toHaveBeenCalledOnce();
  });
});

describe("PredictiveEcho", () => {
  it("echoes a printable byte only after a quiet interval", () => {
    const echo = new PredictiveEcho();
    const write = vi.fn();
    echo.observeOutput("prompt> ", 100);
    expect(echo.tryInput("a", write, { now: 200 })).toBe(false);
    expect(echo.tryInput("a", write, { now: 400 })).toBe(true);
    expect(echo.observeOutput("a", 420)).toBe("");
  });

  it("disables prediction for alternate screens, dynamic TUIs, IME, and paste", () => {
    const write = vi.fn();
    const alt = new PredictiveEcho();
    alt.observeOutput("\x1b[?1049h", 0);
    expect(alt.tryInput("a", write, { now: 2000 })).toBe(false);
    const tui = new PredictiveEcho();
    tui.observeOutput("\x1b[2J", 0);
    expect(tui.tryInput("a", write, { now: 1000 })).toBe(false);
    expect(tui.tryInput("a", write, { now: 1600, composing: true })).toBe(false);
    expect(tui.tryInput("paste", write, { now: 1600 })).toBe(false);
  });

  it("predicts and reconciles backspace behind a predicted character", () => {
    const echo = new PredictiveEcho();
    const write = vi.fn();
    echo.observeOutput("$ ", 0);
    expect(echo.tryInput("x", write, { now: 300 })).toBe(true);
    expect(echo.tryInput("\x7f", write, { now: 301 })).toBe(true);
    expect(write).toHaveBeenLastCalledWith("\b \b");
    expect(echo.observeOutput("x\b \b", 310)).toBe("");
  });
});
