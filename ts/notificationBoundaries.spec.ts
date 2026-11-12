import { describe, expect, it } from "vitest";
import path from "node:path";
import { classifyNeedsInput, isWorkingScreen, parseMenu } from "./needsInput.ts";
import {
  cursorPath,
  notifyDir,
  filterSinceTs,
  liveWatcherPids,
  maxSeq,
  rotateKeep,
  type NotifyEvent,
} from "./notifyInbox.ts";

const event = (seq: number): NotifyEvent => ({
  seq,
  ts: seq,
  host: "local",
  parent_pid: 1111,
  child_pid: 2222,
  cli: "claude",
  cwd: "/repo/alpha",
  edge: "idle",
  prev_state: "active",
  state: "idle",
  question: null,
});

describe("notification screen and inbox boundaries", () => {
  it("does not let global or sticky patterns alternate between busy and idle", () => {
    const working = [/busy/gy];
    working[0]!.lastIndex = 4;
    for (let i = 0; i < 3; i++) expect(isWorkingScreen(["busy"], working)).toBe(true);
    expect(working[0]!.lastIndex).toBe(4);
    const cfg = { needsInput: [/❯ \d+\./g] };
    expect(classifyNeedsInput(["❯ 1. Yes"], cfg)?.question).toBe("❯ 1. Yes");
    expect(classifyNeedsInput(["❯ 1. Yes"], cfg)?.question).toBe("❯ 1. Yes");
  });

  it("rejects menus without a numbered cursor and recognizes multiline matchers", () => {
    expect(parseMenu(["Choose an option", "❯ Confirm"], { needsInput: [/❯/] })).toBeNull();
    expect(parseMenu(["Choose", "1. Yes"], { needsInput: [/Choose\n1\./] })).toBeNull();
    expect(classifyNeedsInput(["plain output"], {})).toBeNull();
  });

  it("deduplicates option rows and includes a cursor in a nonstandard row", () => {
    expect(
      parseMenu(["1. Yes", "1. Yes", "2. No", "cursor 3. Cancel"], {
        needsInput: [/cursor 3\./],
      }),
    ).toMatchObject({ cursor: 3, options: [1, 2, 3] });
  });

  it("keeps question evidence while dropping terminal chrome", () => {
    const lines = [
      "Pick an action",
      "────",
      "❯ 1. Yes",
      "esc to cancel",
      "? for shortcuts",
      "80% until auto-compact",
    ];
    expect(classifyNeedsInput(lines, { needsInput: [/❯/] })?.question).toBe(
      "Pick an action • ❯ 1. Yes",
    );
  });

  it("uses safe path defaults for blank and reserved host and consumer segments", () => {
    for (const segment of ["", ".", ".."]) {
      expect(cursorPath(segment, 1111, segment)).toBe(
        path.join(notifyDir(), "cursors", "localhost", "1111", "parent.json"),
      );
    }
    expect(cursorPath("local", 1111)).toBe(
      path.join(notifyDir(), "cursors", "local", "1111", "parent.json"),
    );
    expect(path.basename(cursorPath("local", 1111, "reader/a"))).toBe("reader_a.json");
  });

  it("honors an explicit watcher TTL and handles out-of-order legacy sequence entries", () => {
    expect([
      ...liveWatcherPids(
        [
          { pid: 1111, ts: 100 },
          { pid: 2222, ts: 80 },
        ],
        110,
        15,
      ),
    ]).toEqual([1111]);
    expect(maxSeq([event(3), event(1), event(2)])).toBe(3);
    expect(filterSinceTs([event(1)], -1)).toEqual([event(1)]);
  });

  it("protects every unread event when rotation uses its default watermark", () => {
    const events = Array.from({ length: 101 }, (_, i) => event(i + 1));
    expect(rotateKeep(events, 1)).toEqual(events);
    expect(rotateKeep(events, 1, 101, 1)).toEqual([event(101)]);
  });
});
