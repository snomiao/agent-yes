import { describe, expect, it } from "vitest";
import { interruptBeforeSend, interruptScreenState, type InterruptState } from "./interruptSend.ts";

describe("interrupt screen classification", () => {
  const cfg = { working: [/esc to (interrupt|cancel)/g], needsInput: [/❯ 1\. Allow/g] };
  it("prioritizes confirmation prompts over lingering busy chrome", () => {
    for (const menu of [
      "❯ 1. Allow",
      "› 2. Deny",
      "> 1. Yes",
      "┃ ctrl+k approve · alt+j manage",
      "┃ task needs approval",
    ])
      expect(interruptScreenState("claude", ["esc to interrupt", menu], cfg)).toBe("permission");
  });
  it("recognizes busy, idle and unknown screens without stateful regexp matches", () => {
    for (let i = 0; i < 2; i++)
      expect(interruptScreenState("codex", ["esc to interrupt", "›"], cfg)).toBe("busy");
    expect(interruptScreenState("agy", [">"], {})).toBe("idle");
    expect(interruptScreenState("claude", ["❯ draft"], {})).toBe("idle");
    expect(interruptScreenState("codex", ["›"], {})).toBe("idle");
    expect(interruptScreenState("codex", ["> quoted transcript"], {})).toBe("unknown");
    expect(interruptScreenState("agy", [], {})).toBe("unknown");
    expect(
      interruptScreenState("claude", ["confirm operation"], { needsInput: [/confirm operation/] }),
    ).toBe("permission");
  });
});

describe("interrupt before delivery", () => {
  function fixture(states: InterruptState[]) {
    const events: string[] = [];
    return {
      events,
      deps: {
        readState: async () => {
          const state = states.length > 1 ? states.shift()! : states[0]!;
          events.push(state);
          return state;
        },
        write: async (code: string) => {
          events.push(code);
        },
        sleep: async (ms: number) => {
          events.push(`wait ${ms}`);
        },
      },
    };
  }
  it.each(["claude", "codex", "agy"])(
    "cancels %s once and waits for the idle prompt before delivery",
    async (cli) => {
      const { events, deps } = fixture(["busy", "busy", "unknown", "idle"]);
      expect(await interruptBeforeSend(cli, deps)).toBe("interrupted");
      events.push("paste message");
      expect(events).toEqual([
        "busy",
        "\x1b",
        "wait 100",
        "busy",
        "wait 100",
        "unknown",
        "wait 100",
        "idle",
        "paste message",
      ]);
    },
  );
  it.each(["idle", "permission", "unknown"] as const)(
    "does not inject a cancellation key at %s",
    async (state) => {
      const { events, deps } = fixture([state]);
      expect(await interruptBeforeSend("claude", deps)).toBe(state);
      expect(events).toEqual([state]);
    },
  );
  it("stops waiting when a permission prompt appears during cancellation", async () => {
    const { events, deps } = fixture(["busy", "permission"]);
    expect(await interruptBeforeSend("agy", deps)).toBe("permission");
    expect(events.filter((event) => event === "\x1b")).toHaveLength(1);
  });
  it("does not guess an unsupported CLI's key", async () => {
    const { events, deps } = fixture(["busy"]);
    expect(await interruptBeforeSend("other", deps)).toBe("unsupported");
    expect(events).toEqual([]);
  });
  it("times out without delivering or repeatedly cancelling", async () => {
    const { events, deps } = fixture(["busy"]);
    await expect(interruptBeforeSend("codex", deps, 200)).rejects.toThrow("message was not sent");
    expect(events).toEqual(["busy", "\x1b", "wait 100", "busy", "wait 100", "busy"]);
  });
  it("propagates an IPC failure before delivery", async () => {
    const { deps } = fixture(["busy"]);
    deps.write = async () => {
      throw new Error("broken FIFO");
    };
    await expect(interruptBeforeSend("agy", deps)).rejects.toThrow("broken FIFO");
  });
});
