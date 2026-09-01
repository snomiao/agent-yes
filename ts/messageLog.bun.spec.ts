import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
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

describe("messageLog terminal-chatter filter", () => {
  let dir: string;
  let prevCwd: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "msglog-chatter-"));
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await rm(dir, { recursive: true, force: true });
  });

  // Byte shapes are terminal protocol; every surrounding record is synthetic.
  const CHATTER = [
    ["cursor position report", "\x1b[?59;3R"],
    ["device attributes reply", "\x1b[?1;2c"],
    ["background colour reply", "\x1b]11;rgb:0d0d/1111/1717\x1b\\"],
    ["pointer motion", "\x1b[<65;24;18M"],
    ["a burst of seven cursor reports", "\x1b[?59;29R" + "\x1b[?59;3R".repeat(6)],
    ["a mixed attach handshake", "\x1b[1;1R\x1b]11;rgb:ffff/ffff/ffff\x1b\\\x1b[?1;2c"],
  ] as const;

  const REAL = [
    ["down arrow — how a dialog gets answered", "\x1b[B"],
    ["left arrow", "\x1b[D"],
    ["Delete", "\x1b[3~"],
    ["focus in (uncovered, deliberately kept)", "\x1b[I"],
    ["a lone DEL is a backspace keypress", "\x7f"],
    ["ordinary prose", "the deploy is green"],
    ["prose that CONTAINS a report", "cursor came back as \x1b[?59;3R — ignore it"],
  ] as const;

  it("drops senderless chatter and keeps everything else", () => {
    for (const [name, body] of CHATTER)
      expect(shouldRecord(makeRecord({ from: null, body })), `drop ${name}`).toBe(false);
    for (const [name, body] of REAL)
      expect(shouldRecord(makeRecord({ from: null, body })), `keep ${name}`).toBe(true);
  });

  it("never drops chatter an agent deliberately sent", () => {
    // Shape decides; the sender is the safety margin. An agent that means to
    // push these bytes still gets a durable record of having done it.
    for (const [name, body] of CHATTER) {
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

  it("writes NO mailbox line for senderless chatter, end to end", async () => {
    const to = path.join(dir, "recipient");
    process.chdir(dir);
    for (const [, body] of CHATTER)
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

  it("a chatter burst past the cap leaves an earlier real message recoverable", async () => {
    // The regression this exists to prevent: the mailbox is the recovery path
    // for a truncated message, and chatter was evicting it within minutes.
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
  });
});
