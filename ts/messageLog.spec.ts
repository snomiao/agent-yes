import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  MAILBOX_MAX_LINES,
  mailboxPath,
  partyMatches,
  readMailbox,
  recordInbox,
  recordMessage,
  recordOutbox,
  shouldRecord,
  type MessageRecord,
} from "./messageLog.ts";

function makeRecord(over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    at: 1_000,
    nonce: "abcd",
    from: { pid: 11, cli: "claude", cwd: "/from", agent_id: "agent-A" },
    to: { pid: 22, cli: "codex", cwd: "/to", agent_id: "agent-B" },
    body: "hello",
    confirmed: true,
    wrapped: true,
    ...over,
  };
}

describe("messageLog", () => {
  let dir: string;
  let prevCwd: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "msglog-"));
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await rm(dir, { recursive: true, force: true });
  });

  it("mailboxPath colocates under <cwd>/.agent-yes", () => {
    expect(mailboxPath("/x", "inbox")).toBe(path.join("/x", ".agent-yes", "inbox.jsonl"));
    expect(mailboxPath("/x", "outbox")).toBe(path.join("/x", ".agent-yes", "outbox.jsonl"));
  });

  it("records to sender outbox and recipient inbox", async () => {
    const from = path.join(dir, "sender");
    const to = path.join(dir, "recipient");
    const rec = makeRecord({
      from: { pid: 11, cli: "claude", cwd: from, agent_id: "A" },
      to: { pid: 22, cli: "codex", cwd: to, agent_id: "B" },
    });
    await recordMessage(rec);

    const outbox = await readMailbox(from, "outbox");
    const inbox = await readMailbox(to, "inbox");
    expect(outbox).toHaveLength(1);
    expect(inbox).toHaveLength(1);
    expect(outbox[0]!.body).toBe("hello");
    expect(inbox[0]!.to.agent_id).toBe("B");
    // The sender's inbox and recipient's outbox stay empty.
    expect(await readMailbox(from, "inbox")).toHaveLength(0);
    expect(await readMailbox(to, "outbox")).toHaveLength(0);
  });

  it("writes a human sender's outbox under process.cwd()", async () => {
    process.chdir(dir);
    const to = path.join(dir, "recipient");
    await recordMessage(makeRecord({ from: null, to: { pid: 22, cli: "codex", cwd: to } }));
    const outbox = await readMailbox(dir, "outbox");
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.from).toBeNull();
  });

  it("readMailbox skips corrupt lines and returns empty for a missing file", async () => {
    expect(await readMailbox(dir, "inbox")).toEqual([]);
    const from = path.join(dir, "s");
    await recordMessage(makeRecord({ from: { pid: 1, cli: "c", cwd: from } }));
    // Corrupt the file with a partial line; the good record still parses.
    const p = mailboxPath(from, "outbox");
    const raw = await readFile(p, "utf-8");
    const { appendFile } = await import("fs/promises");
    await appendFile(p, "{ not json\n");
    expect(raw.trim().split("\n")).toHaveLength(1);
    expect(await readMailbox(from, "outbox")).toHaveLength(1);
  });

  it("recordOutbox writes only the sender's outbox (remote peer's cwd untouched)", async () => {
    const from = path.join(dir, "local");
    const to = path.join(dir, "remote");
    await recordOutbox(
      makeRecord({
        from: { pid: 1, cli: "claude", cwd: from, agent_id: "A" },
        to: { pid: 2, cli: "codex", cwd: to, agent_id: "B" },
        remote: "http://host:8080",
        wrapped: false,
      }),
    );
    expect(await readMailbox(from, "outbox")).toHaveLength(1);
    // The remote peer's cwd is on another host — nothing is written there.
    expect(await readMailbox(to, "inbox")).toHaveLength(0);
    expect((await readMailbox(from, "outbox"))[0]!.remote).toBe("http://host:8080");
  });

  it("recordInbox writes only the recipient's inbox (remote sender's cwd untouched)", async () => {
    const from = path.join(dir, "remote-sender");
    const to = path.join(dir, "local-recipient");
    await recordInbox(
      makeRecord({
        from: { pid: 1, cli: "claude", cwd: from, agent_id: "A" },
        to: { pid: 2, cli: "codex", cwd: to, agent_id: "B" },
        remote: "wire",
        wrapped: false,
      }),
    );
    expect(await readMailbox(to, "inbox")).toHaveLength(1);
    expect(await readMailbox(from, "outbox")).toHaveLength(0);
  });

  it("preserves the kind tag for key/select events", async () => {
    const from = path.join(dir, "kfrom");
    const to = path.join(dir, "kto");
    await recordMessage(
      makeRecord({
        from: { pid: 1, cli: "bash", cwd: from, agent_id: "A" },
        to: { pid: 2, cli: "bash", cwd: to, agent_id: "B" },
        kind: "key",
        body: "down down enter",
        wrapped: false,
      }),
    );
    const rec = (await readMailbox(to, "inbox"))[0]!;
    expect(rec.kind).toBe("key");
    expect(rec.body).toBe("down down enter");
  });

  it("partyMatches prefers agent_id, falls back to pid", () => {
    const party = { pid: 5, cli: "c", cwd: "/x", agent_id: "stable" };
    expect(partyMatches(party, "stable", 999)).toBe(true); // agent_id wins across pid churn
    expect(partyMatches(party, "other", 5)).toBe(true); // pid fallback
    expect(partyMatches(party, "other", 6)).toBe(false);
    expect(partyMatches(null, "stable", 5)).toBe(false);
  });
});

describe("messageLog unprompted-reply filter", () => {
  let dir: string;
  let prevCwd: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "msglog-reply-"));
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await rm(dir, { recursive: true, force: true });
  });

  // Byte shapes are terminal protocol; every surrounding record is synthetic.
  const UNPROMPTED = [
    ["cursor position report", "\x1b[?59;3R"],
    ["device attributes reply", "\x1b[?1;2c"],
    ["device status report", "\x1b[0n"],
    ["background colour reply", "\x1b]11;rgb:0d0d/1111/1717\x1b\\"],
    ["a burst of seven cursor reports", "\x1b[?59;29R" + "\x1b[?59;3R".repeat(6)],
    [
      "the attach handshake, mixing CSI and OSC",
      "\x1b[?1;1R\x1b]11;rgb:ffff/ffff/ffff\x1b\\\x1b[?1;2c",
    ],
  ] as const;

  const REAL = [
    ["down arrow — how a dialog gets answered", "\x1b[B"],
    ["left arrow", "\x1b[D"],
    ["Delete", "\x1b[3~"],
    ["modified F3 — same final byte as a cursor report", "\x1b[1;2R"],
    ["plain CPR, excluded because modified F3 shares its shape", "\x1b[1;1R"],
    ["a mouse click inside a TUI", "\x1b[<0;12;27m"],
    ["pointer motion, indistinguishable from a click", "\x1b[<65;24;18M"],
    ["focus in (uncovered, deliberately kept)", "\x1b[I"],
    ["a lone DEL is a backspace keypress", "\x7f"],
    ["ordinary prose", "the deploy is green"],
    ["prose that CONTAINS a reply", "cursor came back as \x1b[?59;3R — ignore it"],
  ] as const;

  it("drops senderless unprompted replies and keeps everything else", () => {
    for (const [name, body] of UNPROMPTED)
      expect(shouldRecord(makeRecord({ from: null, body })), `drop ${name}`).toBe(false);
    for (const [name, body] of REAL)
      expect(shouldRecord(makeRecord({ from: null, body })), `keep ${name}`).toBe(true);
  });

  it("never drops a reply an agent deliberately sent", () => {
    // Shape decides; the sender is a margin. An agent that means to push these
    // bytes still gets a durable record of having done it.
    for (const [name, body] of UNPROMPTED) {
      const rec = makeRecord({
        from: {
          pid: 1111,
          cli: "claude",
          cwd: "/repo/alpha",
          agent_id: "agent-A",
        },
        body,
      });
      expect(shouldRecord(rec), `agent-sent ${name}`).toBe(true);
    }
  });

  it("writes NO mailbox line for a senderless unprompted reply, end to end", async () => {
    const to = path.join(dir, "recipient");
    process.chdir(dir);
    for (const [, body] of UNPROMPTED)
      await recordMessage(
        makeRecord({
          from: null,
          body,
          to: { pid: 2222, cli: "codex", cwd: to, agent_id: "agent-B" },
        }),
      );
    expect(await readMailbox(to, "inbox")).toHaveLength(0);
    expect(await readMailbox(dir, "outbox")).toHaveLength(0);
  });

  it("still writes the line for a senderless ARROW KEY, end to end", async () => {
    const to = path.join(dir, "recipient");
    process.chdir(dir);
    await recordMessage(
      makeRecord({
        from: null,
        body: "\x1b[B",
        to: { pid: 2222, cli: "codex", cwd: to, agent_id: "agent-B" },
      }),
    );
    const inbox = await readMailbox(to, "inbox");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.body).toBe("\x1b[B");
    expect(await readMailbox(dir, "outbox")).toHaveLength(1);
  });

  it("filtered replies never reach the file, so they cannot count toward the cap", async () => {
    // The regression this exists to prevent: the mailbox is the recovery path
    // for a truncated message, and replies were evicting it within minutes.
    //
    // NAMED FOR WHAT IT PROVES. An earlier draft called this "a reply burst past
    // the cap leaves an earlier real message recoverable", which promises more
    // than the body delivers: every one of the 2,500 rows below is filtered, so
    // the file never approaches MAILBOX_MAX_LINES and compaction never runs. The
    // mechanism under test is that the rows never land at all — asserted
    // directly below on the file, not just on the parsed mailbox. Compaction
    // itself is covered by the next test.
    const to = path.join(dir, "recipient");
    const toParty = { pid: 2222, cli: "codex", cwd: to, agent_id: "agent-B" };
    await recordInbox(
      makeRecord({
        from: {
          pid: 1111,
          cli: "claude",
          cwd: "/repo/alpha",
          agent_id: "agent-A",
        },
        body: "the message that arrived truncated",
        to: toParty,
      }),
    );
    for (let i = 0; i < 2500; i++)
      await recordInbox(makeRecord({ from: null, body: "\x1b[?59;3R", to: toParty }));
    const inbox = await readMailbox(to, "inbox");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.body).toBe("the message that arrived truncated");
    // The mechanism, not just the outcome: one line on disk, so the 2,500
    // replies were never written rather than written and then compacted away.
    const raw = await readFile(mailboxPath(to, "inbox"), "utf-8");
    expect(raw.split("\n").filter((l) => l.trim())).toHaveLength(1);
  });

  it("pins the cap's VALUE, because deriving from it costs the ability to notice a change", () => {
    // The behaviour test below derives its sizes from MAILBOX_MAX_LINES so a
    // deliberate cap change does not silently stop it crossing the boundary.
    // That robustness has a price: it can no longer notice the constant moving.
    // One cheap assertion buys that back — an UNintended change fails here and
    // an intended one is a single line to update, with the behaviour test still
    // valid at the new size.
    expect(MAILBOX_MAX_LINES).toBe(2000);
  });

  it("compacts to MAILBOX_MAX_LINES, dropping the OLDEST and keeping the newest", async () => {
    // The cap whose exhaustion caused the incident had no coverage at all before
    // this. It is the other half of the contract: the filter keeps replies out,
    // and this decides who survives when real traffic fills the log.
    //
    // The first 1,999 lines are written directly as a FIXTURE — driving them
    // through recordInbox would re-read the whole file 2,000 times. The rows
    // that actually cross the boundary go through the real writer.
    const to = path.join(dir, "recipient");
    const toParty = { pid: 2222, cli: "codex", cwd: to, agent_id: "agent-B" };
    const from = { pid: 1111, cli: "claude", cwd: "/repo/alpha", agent_id: "agent-A" };
    const file = mailboxPath(to, "inbox");
    await mkdir(path.dirname(file), { recursive: true });
    // Derived from the constant, not hard-coded: if the cap moves, a literal
    // seed count would quietly stop crossing the boundary and this test would
    // pass without ever compacting — the exact failure the rename above is about.
    const seeded = Array.from({ length: MAILBOX_MAX_LINES - 1 }, (_, i) =>
      JSON.stringify(makeRecord({ from, to: toParty, body: `seed ${i}` })),
    );
    await writeFile(file, seeded.join("\n") + "\n");

    // (MAX - 1) + 3 = MAX + 2, so exactly two must be evicted, oldest first.
    for (const body of ["real A", "real B", "real C"])
      await recordInbox(makeRecord({ from, to: toParty, body }));

    const inbox = await readMailbox(to, "inbox");
    expect(inbox).toHaveLength(MAILBOX_MAX_LINES);
    expect(inbox.at(-1)!.body).toBe("real C");
    expect(inbox.at(-2)!.body).toBe("real B");
    expect(inbox.at(-3)!.body).toBe("real A");
    // Oldest-first eviction: "seed 0" and "seed 1" are gone, "seed 2" is now the head.
    expect(inbox[0]!.body).toBe("seed 2");
    expect(inbox.some((r) => r.body === "seed 0")).toBe(false);
    expect(inbox.some((r) => r.body === "seed 1")).toBe(false);
  });
});
