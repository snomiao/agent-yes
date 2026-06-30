import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const spawn = vi.fn();
const createInterface = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...a: unknown[]) => spawn(...a) }));
vi.mock("node:readline", () => ({
  createInterface: (...a: unknown[]) => createInterface(...a),
}));

import { resolveOpener, openInBrowser, offerOpenInBrowser } from "./openBrowser.ts";

const URL = "https://agent-yes.com/w/#room:tok";

// A fake child whose .on()/.unref() are inert — enough for openInBrowser's
// fire-and-forget launch.
const fakeChild = () => ({ on: vi.fn(), unref: vi.fn() });
// A fake readline that answers `reply` to the next question() call.
const fakeRl = (reply: string) => ({
  question: (_q: string, cb: (a: string) => void) => cb(reply),
  close: vi.fn(),
});

// Force a resolvable opener regardless of the host platform: on Linux runners
// (incl. headless CI) resolveOpener needs a display, so pin one. macOS/Windows
// resolve an opener anyway, so this is harmless there.
let savedDisplay: string | undefined;
beforeEach(() => {
  spawn.mockReset();
  createInterface.mockReset();
  savedDisplay = process.env.DISPLAY;
  process.env.DISPLAY = ":99";
});
afterEach(() => {
  if (savedDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = savedDisplay;
});

// resolveOpener is the pure resolution table — the only branching worth pinning.
describe("resolveOpener", () => {
  it("uses `open` on macOS", () => {
    expect(resolveOpener(URL, "darwin", {})).toEqual({ cmd: "open", args: [URL] });
  });

  it("uses cmd /c start with an empty title arg on Windows", () => {
    expect(resolveOpener(URL, "win32", {})).toEqual({
      cmd: "cmd",
      args: ["/c", "start", "", URL],
    });
  });

  it("uses xdg-open on Linux when a display is present (X11 or Wayland)", () => {
    expect(resolveOpener(URL, "linux", { DISPLAY: ":0" })).toEqual({
      cmd: "xdg-open",
      args: [URL],
    });
    expect(resolveOpener(URL, "linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual({
      cmd: "xdg-open",
      args: [URL],
    });
  });

  it("returns null on a headless Linux box (no display → nothing to open)", () => {
    expect(resolveOpener(URL, "linux", {})).toBeNull();
  });
});

describe("openInBrowser", () => {
  it("spawns the platform opener detached and returns true when one exists", () => {
    spawn.mockReturnValue(fakeChild());
    expect(openInBrowser(URL)).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("returns false (and never spawns) when spawn throws", () => {
    spawn.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(openInBrowser(URL)).toBe(false);
  });
});

describe("offerOpenInBrowser", () => {
  const withTTY = async (fn: () => Promise<void>) => {
    const [si, so] = [process.stdin.isTTY, process.stdout.isTTY];
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    try {
      await fn();
    } finally {
      process.stdin.isTTY = si;
      process.stdout.isTTY = so;
    }
  };

  it("no-ops without prompting when stdin is not a TTY (curl|sh / CI / daemon)", async () => {
    const orig = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      expect(await offerOpenInBrowser(URL)).toBe(false);
      expect(createInterface).not.toHaveBeenCalled();
    } finally {
      process.stdin.isTTY = orig;
    }
  });

  it("opens on an empty answer (default yes)", async () => {
    await withTTY(async () => {
      createInterface.mockReturnValue(fakeRl(""));
      spawn.mockReturnValue(fakeChild());
      expect(await offerOpenInBrowser(URL)).toBe(true);
      expect(spawn).toHaveBeenCalledOnce();
    });
  });

  it("opens on an explicit yes", async () => {
    await withTTY(async () => {
      createInterface.mockReturnValue(fakeRl("Y"));
      spawn.mockReturnValue(fakeChild());
      expect(await offerOpenInBrowser(URL)).toBe(true);
    });
  });

  it("does not open when the operator declines", async () => {
    await withTTY(async () => {
      createInterface.mockReturnValue(fakeRl("n"));
      expect(await offerOpenInBrowser(URL)).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    });
  });
});
