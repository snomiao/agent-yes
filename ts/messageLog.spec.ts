import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("partyMatches prefers agent_id, falls back to pid", () => {
    const party = { pid: 5, cli: "c", cwd: "/x", agent_id: "stable" };
    expect(partyMatches(party, "stable", 999)).toBe(true); // agent_id wins across pid churn
    expect(partyMatches(party, "other", 5)).toBe(true); // pid fallback
    expect(partyMatches(party, "other", 6)).toBe(false);
    expect(partyMatches(null, "stable", 5)).toBe(false);
  });
});
