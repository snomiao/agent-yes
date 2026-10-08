import { mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import {
  claimPending,
  classifyComposer,
  DUPLICATE_WINDOW_MS,
  enqueuePending,
  findRecentDuplicate,
  listPending,
  noteRecentSend,
  queuedReceipt,
  readPending,
  recentSendsPath,
  retirePending,
  rowsFromXterm,
  senderKey,
} from "./composerGuard.ts";

const RULE = "─".repeat(40);
const FOOTER = "\x1b[38;2;153;153;153m  ⏵⏵ auto mode on (shift+tab to cycle)\x1b[39m";

async function classify(frame: string, cols = 60) {
  const term = new Terminal({ cols, rows: 12, allowProposedApi: true });
  await new Promise<void>((r) => term.write(frame, r));
  return classifyComposer(rowsFromXterm(term as never, 40));
}

const box = (inner: string) => `history\r\n${RULE}\r\n❯ ${inner}\x1b[0m\r\n${RULE}\r\n${FOOTER}`;

describe("classifyComposer", () => {
  it("reads an empty prompt as empty", async () => {
    expect(await classify(box(""))).toEqual({ kind: "empty", ghost: false });
  });

  it("reads typed text as a draft (the 2026-10-08 'btw how' case)", async () => {
    expect(await classify(box("btw how"))).toEqual({ kind: "draft", chars: 6 });
  });

  it("reads Claude Code's dim prompt suggestion as ghost, not a draft", async () => {
    // Byte-for-byte the suggestion frame from a live lane's PTY log.
    expect(await classify(box("\x1b[2mcollect my pills\x1b[22m"))).toEqual({
      kind: "empty",
      ghost: true,
    });
  });

  it("reads the dim queued-messages hint as ghost", async () => {
    expect(await classify(box("\x1b[2mPress up to edit queued messages\x1b[22m"))).toEqual({
      kind: "empty",
      ghost: true,
    });
  });

  it("ignores an inverse fake cursor painted over the ghost", async () => {
    expect(await classify(box("\x1b[7mc\x1b[27m\x1b[2mollect my pills\x1b[22m"))).toEqual({
      kind: "empty",
      ghost: true,
    });
  });

  it("still sees a draft when the user's text sits before a ghost tail", async () => {
    expect((await classify(box("hi\x1b[2m there\x1b[22m"))).kind).toBe("draft");
  });

  it("counts a wrapped second line of the draft", async () => {
    const frame = `${RULE}\r\n❯\u00a0first\r\n  second line typed\r\n${RULE}\r\n${FOOTER}`;
    expect(await classify(frame)).toEqual({ kind: "draft", chars: 20 });
  });

  it("reads a collapsed paste placeholder as a draft", async () => {
    expect((await classify(box("[Pasted text #1 +4 lines]"))).kind).toBe("draft");
  });

  it("does not count history above the prompt or the footer below it", async () => {
    const frame = `❯ old submitted turn\r\nreply text\r\n${RULE}\r\n❯ \r\n${RULE}\r\n${FOOTER}`;
    expect(await classify(frame)).toEqual({ kind: "empty", ghost: false });
  });

  it("does not count a footer when the bottom rule is missing (2026-10-08 replay)", async () => {
    const frame = `${RULE}\r\n❯\u00a0\r\n\r\n\x1b[38;2;153;153;153m                · ← for agents\x1b[39m`;
    expect(await classify(frame)).toEqual({ kind: "empty", ghost: false });
  });

  it("keeps a blank line inside a multi-line draft in the box (codex review)", async () => {
    const frame = `${RULE}\r\n❯\u00a0\r\n  \r\n  human draft\r\n${RULE}\r\n${FOOTER}`;
    expect(await classify(frame)).toEqual({ kind: "draft", chars: 10 });
  });

  it("keeps a draft line that starts with a prompt glyph in the box (codex review)", async () => {
    const frame = `${RULE}\r\n❯\u00a0human draft\r\n  › \r\n${RULE}\r\n${FOOTER}`;
    expect(await classify(frame)).toEqual({ kind: "draft", chars: 11 });
  });

  it("is unknown when no composer is on screen", async () => {
    expect((await classify("Do you trust this folder?\r\n  1. Yes\r\n  2. No")).kind).toBe(
      "unknown",
    );
  });

  // Codex review (2ecc427): without a top rule the scan stopped at the first
  // blank row, so a multi-line Codex draft read as empty and was typed into.
  it("keeps a blank line inside an unboxed (Codex) multi-line draft", async () => {
    expect(await classify(`history\r\n› \r\n\r\n  human draft\r\n`)).toEqual({
      kind: "draft",
      chars: 10,
    });
  });
  it("still ends an unboxed composer at Codex's footer, past blank rows", async () => {
    expect(
      await classify(
        `› \x1b[2mAsk Codex to do anything\x1b[22m\r\n\r\n  ⏎ send   ⌃J newline   ⌃T transcript\r\n  100% context left\r\n`,
      ),
    ).toEqual({
      kind: "empty",
      ghost: true,
    });
  });

  it("reads Codex's › prompt the same way", async () => {
    expect((await classify(`› fix the bug\r\n`)).kind).toBe("draft");
    expect(await classify(`› \x1b[2mAsk Codex to do anything\x1b[22m\r\n`)).toEqual({
      kind: "empty",
      ghost: true,
    });
  });
});

describe("pending queue", () => {
  let home: string;
  const prev = process.env.AGENT_YES_HOME;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "ay-pending-"));
    process.env.AGENT_YES_HOME = home;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = prev;
    await rm(home, { recursive: true, force: true });
  });

  const msg = (queuedAt: number, fullBody: string) => ({
    queuedAt,
    pid: 4242,
    fifoPath: "/nonexistent",
    fullBody,
    trailing: "\r",
    identity: fullBody,
    record: { body: fullBody },
  });

  it("lists parked messages in send order", async () => {
    await enqueuePending(msg(2000, "second"));
    await enqueuePending(msg(1000, "first"));
    const names = await listPending(4242);
    expect(names).toHaveLength(2);
    expect((await readPending(4242, names[0]!))?.fullBody).toBe("first");
  });

  it("claims a message exactly once", async () => {
    await enqueuePending(msg(1, "only"));
    const [name] = await listPending(4242);
    expect(await claimPending(4242, name!)).toBe(true);
    expect(await claimPending(4242, name!)).toBe(false);
    expect(await listPending(4242)).toEqual([]);
  });

  it("retires a message out of the queue but keeps it on disk", async () => {
    await enqueuePending(msg(1, "stale"));
    const [name] = await listPending(4242);
    await retirePending(4242, name!, "expired");
    expect(await listPending(4242)).toEqual([]);
    const kept = await readdir(path.join(home, "pending", "4242", "undelivered"));
    expect(kept.sort()).toEqual([name!, `${name!}.why`].sort());
  });
});

// CTO 2026-10-08: [mitm-compat] sent the same report twice, 6 s apart, after
// reading rc=4 QUEUED as a failure. The sink drops the resend.
describe("duplicate suppression at the sink", () => {
  let home: string;
  const prev = process.env.AGENT_YES_HOME;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "ay-dedupe-"));
    process.env.AGENT_YES_HOME = home;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = prev;
    await rm(home, { recursive: true, force: true });
  });

  const lane = senderKey({ agent_id: "mitm-compat-1", pid: 3212601 })!;
  const other = senderKey({ agent_id: "gtm-1", pid: 3061746 })!;
  const T = 1_800_000_000_000;

  it("an identical body from the same agent within 60 s is a duplicate, and keeps the first outcome", async () => {
    await noteRecentSend(4242, lane, "[mitm-compat] report", "queued", T);
    expect(await findRecentDuplicate(4242, lane, "[mitm-compat] report", T + 6_000)).toMatchObject({
      outcome: "queued",
      at: T,
    });
  });

  it("is NOT a duplicate: another sender, another body, another target, or past the window", async () => {
    await noteRecentSend(4242, lane, "report", "sent", T);
    expect(await findRecentDuplicate(4242, other, "report", T + 1_000)).toBeNull();
    expect(await findRecentDuplicate(4242, lane, "report v2", T + 1_000)).toBeNull();
    expect(await findRecentDuplicate(4343, lane, "report", T + 1_000)).toBeNull();
    expect(await findRecentDuplicate(4242, lane, "report", T + DUPLICATE_WINDOW_MS + 1)).toBeNull();
  });

  it("a person at a shell (no agent) is never deduped", () => {
    expect(senderKey(null)).toBeNull();
    expect(senderKey({ pid: null })).toBeNull();
    expect(senderKey({ pid: 7 })).toBe("p:7");
  });

  it("the ledger keeps hashes, not bodies, and forgets entries past the window", async () => {
    await noteRecentSend(4242, lane, "secret customer detail", "sent", T);
    await noteRecentSend(4242, lane, "later", "sent", T + DUPLICATE_WINDOW_MS + 10);
    const { readFile } = await import("fs/promises");
    const raw = await readFile(recentSendsPath(4242), "utf-8");
    expect(raw).not.toContain("secret customer detail");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("every rc=4 receipt tells the caller not to resend", () => {
    for (const kind of ["parked", "cli-queued", "duplicate"] as const) {
      expect(queuedReceipt(kind, "x")).toMatch(/do not resend/i);
    }
    expect(queuedReceipt("parked", "its input box holds a draft (3 chars)")).toContain(
      "Queued, do not resend.",
    );
  });
});
