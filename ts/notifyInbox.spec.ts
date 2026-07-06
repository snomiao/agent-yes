import { describe, expect, it } from "vitest";
import path from "path";
import {
  type NotifyEvent,
  notifyDir,
  filterSinceSeq,
  filterSinceTs,
  filterUnread,
  inboxPath,
  inboxesToGC,
  liveWatcherPids,
  maxSeq,
  nextSeq,
  parseCursor,
  parseInboxText,
  rotateKeep,
  serializeCursor,
  serializeEvent,
} from "./notifyInbox.ts";

const ev = (over: Partial<NotifyEvent> = {}): NotifyEvent => ({
  seq: 1,
  ts: 1_000,
  host: "h1",
  parent_pid: 1,
  child_pid: 100,
  cli: "claude",
  cwd: "/repo",
  edge: "idle",
  prev_state: "active",
  state: "idle",
  question: null,
  ...over,
});

describe("notifyInbox — paths", () => {
  it("namespaces the inbox by host and parent pid", () => {
    const p = inboxPath("my-host", 42);
    expect(p).toContain("notify");
    expect(p.endsWith("42.ndjson")).toBe(true);
    expect(p).toContain("my-host");
  });

  it("sanitizes an unsafe host so the path stays inside the notify dir", () => {
    const p = path.resolve(inboxPath("../../etc", 1));
    // Separators are stripped, so the resolved path can't climb out of notify/
    // even though the dots survive as harmless literal filename chars.
    expect(p.startsWith(path.resolve(notifyDir()) + path.sep)).toBe(true);
  });
});

describe("notifyInbox — NDJSON round-trip + torn-line tolerance", () => {
  it("serializes and re-parses an event", () => {
    const line = serializeEvent(ev({ seq: 7 }));
    const [got] = parseInboxText(line);
    expect(got!.seq).toBe(7);
    expect(got!.edge).toBe("idle");
  });

  it("skips a torn final line from a mid-append writer", () => {
    const text = serializeEvent(ev({ seq: 1 })) + "\n" + serializeEvent(ev({ seq: 2 })) + "\n{ \"seq\": 3, \"ed";
    const got = parseInboxText(text);
    expect(got.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("ignores blank lines and non-event JSON", () => {
    const text = ["", serializeEvent(ev({ seq: 1 })), "  ", "42", '{"foo":"bar"}'].join("\n");
    const got = parseInboxText(text);
    expect(got.map((e) => e.seq)).toEqual([1]);
  });

  it("drops a partial event missing correlation fields (full validation)", () => {
    const partial = JSON.stringify({ seq: 2, edge: "idle" }); // no parent_pid/child_pid/cwd
    const badEdge = JSON.stringify({ ...ev({ seq: 3 }), edge: "bogus" });
    const text = [serializeEvent(ev({ seq: 1 })), partial, badEdge].join("\n");
    // Only the fully-formed event survives to a consumer's output.
    expect(parseInboxText(text).map((e) => e.seq)).toEqual([1]);
  });
});

describe("notifyInbox — seq allocation", () => {
  it("nextSeq increments the last stored seq", () => {
    expect(nextSeq(0)).toBe(1);
    expect(nextSeq(41)).toBe(42);
  });

  it("nextSeq treats a missing/garbage counter as 0", () => {
    expect(nextSeq(NaN)).toBe(1);
    expect(nextSeq(-5)).toBe(1);
  });

  it("maxSeq finds the highest seq in an inbox (0 when empty)", () => {
    expect(maxSeq([])).toBe(0);
    expect(maxSeq([ev({ seq: 3 }), ev({ seq: 9 }), ev({ seq: 5 })])).toBe(9);
  });
});

describe("notifyInbox — watermark filtering", () => {
  const events = [ev({ seq: 1, ts: 100 }), ev({ seq: 2, ts: 200 }), ev({ seq: 3, ts: 300 })];

  it("filterSinceSeq returns strictly-greater seqs", () => {
    expect(filterSinceSeq(events, 1).map((e) => e.seq)).toEqual([2, 3]);
    expect(filterSinceSeq(events, 0).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(filterSinceSeq(events, undefined).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("filterSinceTs returns events at/after a wall-clock bound", () => {
    expect(filterSinceTs(events, 200).map((e) => e.seq)).toEqual([2, 3]);
  });

  it("filterUnread returns seqs above the cursor", () => {
    expect(filterUnread(events, 2).map((e) => e.seq)).toEqual([3]);
    expect(filterUnread(events, 0).map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe("notifyInbox — cursor", () => {
  it("round-trips a cursor", () => {
    expect(parseCursor(serializeCursor(5))).toEqual({ seq: 5 });
  });

  it("reads a missing/garbage cursor as seq 0", () => {
    expect(parseCursor(null)).toEqual({ seq: 0 });
    expect(parseCursor("not json")).toEqual({ seq: 0 });
    expect(parseCursor('{"seq":-1}')).toEqual({ seq: 0 });
  });
});

describe("notifyInbox — retention", () => {
  it("GCs an inbox whose parent is dead and unreferenced by any live child", () => {
    const gc = inboxesToGC([1, 2, 3], new Set([2]), new Set([3]));
    // parent 1: dead + no live child → GC. parent 2: alive → keep. parent 3:
    // referenced by a live child → keep.
    expect(gc).toEqual([1]);
  });

  it("keeps everything when all parents are alive", () => {
    expect(inboxesToGC([1, 2], new Set([1, 2]), new Set())).toEqual([]);
  });
});

describe("notifyInbox — rotation", () => {
  const many = () => Array.from({ length: 500 }, (_, i) => ev({ seq: i + 1 }));

  it("keeps EVERYTHING when nothing is acked (min cursor 0) — at-least-once", () => {
    // Every event is unacked, so none may be dropped even under a tiny cap. The
    // inbox only shrinks once a consumer acks (advances its cursor).
    const kept = rotateKeep(many(), 1, 0, 10);
    expect(kept.length).toBe(500);
  });

  it("trims ACKED events (below the min cursor) under the byte cap", () => {
    // seq 1..495 acked (min cursor 495), 496..500 unacked → only acked ones are
    // eligible for eviction under the tiny cap.
    const kept = rotateKeep(many(), 1, 495, 5);
    expect(kept.length).toBeLessThan(500);
    expect(kept[kept.length - 1]!.seq).toBe(500); // newest retained
    expect(kept.some((e) => e.seq === 1)).toBe(false); // old acked evicted
    for (let seq = 496; seq <= 500; seq++) expect(kept.some((e) => e.seq === seq)).toBe(true);
  });

  it("NEVER evicts an unacked event above the min cursor (at-least-once)", () => {
    // protectAboveSeq=490 → every event with seq>490 must survive even under a
    // tiny cap and a small minKeep. This is the guarantee codex flagged.
    const kept = rotateKeep(many(), 1, 490, 5);
    for (let seq = 491; seq <= 500; seq++) {
      expect(kept.some((e) => e.seq === seq)).toBe(true);
    }
    expect(kept.length).toBeLessThan(500); // older, acked events still trimmed
  });

  it("returns everything when under minKeep", () => {
    const events = [ev({ seq: 1 }), ev({ seq: 2 })];
    expect(rotateKeep(events, 1, 0, 100).map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe("notifyInbox — watcher liveness", () => {
  it("counts only heartbeats within the TTL", () => {
    const now = 100_000;
    const live = liveWatcherPids(
      [
        { pid: 1, ts: now - 1_000 }, // fresh
        { pid: 2, ts: now - 999_999 }, // stale
        { pid: 3, ts: now }, // fresh
      ],
      now,
      15_000,
    );
    expect([...live].sort()).toEqual([1, 3]);
  });
});
