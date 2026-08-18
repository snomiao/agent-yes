import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  discoverTranscripts,
  encodeProjectSlug,
  histPage,
  projectRecord,
  readCodexCwd,
  readLinesBackward,
  tailTranscript,
  type TranscriptFile,
} from "./histStore.ts";

// histStore takes `home` explicitly rather than calling homedir(), so these
// tests point it at a tempdir instead of mocking the os module.
let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "agent-yes-hist-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => null);
});

const CWD = "/code/snomiao/agent-yes/tree/main";

function claudeTurn(role: "user" | "assistant", text: string, ts: string, extra = {}) {
  return JSON.stringify({
    type: role,
    timestamp: ts,
    cwd: CWD,
    message: { role, content: [{ type: "text", text }] },
    ...extra,
  });
}

function codexEvent(kind: "user_message" | "agent_message", message: string, ts: string) {
  return JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: kind, message } });
}

async function writeClaudeSession(session: string, lines: string[], cwd = CWD) {
  const dir = path.join(home, ".claude", "projects", encodeProjectSlug(cwd));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${session}.jsonl`);
  await writeFile(file, lines.length ? lines.join("\n") + "\n" : "");
  return file;
}

async function writeCodexSession(session: string, lines: string[], cwd = CWD) {
  const dir = path.join(home, ".codex", "sessions", "2026", "08", "03");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-${session}.jsonl`);
  const meta = JSON.stringify({
    timestamp: "2026-08-03T00:00:00.000Z",
    type: "session_meta",
    payload: { session_id: session, cwd },
  });
  await writeFile(file, [meta, ...lines].join("\n") + "\n");
  return file;
}

function asFile(p: string, source: "claude" | "codex"): TranscriptFile {
  return { path: p, source, sessionId: path.basename(p, ".jsonl"), mtimeMs: 0, size: 0 };
}

describe("encodeProjectSlug", () => {
  it("matches Claude's cwd-to-directory encoding", () => {
    expect(encodeProjectSlug("/code/snomiao/agent-yes/tree/main")).toBe(
      "-code-snomiao-agent-yes-tree-main",
    );
  });

  it("collapses dots, as Claude does for domain-shaped directories", () => {
    expect(encodeProjectSlug("/code/snomiao/cv.snomiao.com/tree/main")).toBe(
      "-code-snomiao-cv-snomiao-com-tree-main",
    );
  });
});

describe("readLinesBackward", () => {
  it("yields lines newest-first with correct byte offsets", async () => {
    const file = path.join(home, "a.jsonl");
    await writeFile(file, "one\ntwo\nthree\n");
    const got = [];
    for await (const l of readLinesBackward(file)) got.push(l);
    expect(got.map((g) => g.text)).toEqual(["three", "two", "one"]);
    expect(got.map((g) => g.offset)).toEqual([8, 4, 0]);
  });

  it("reassembles lines that straddle chunk boundaries", async () => {
    const file = path.join(home, "big.jsonl");
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}-${"x".repeat(i % 37)}`);
    await writeFile(file, lines.join("\n") + "\n");
    const got = [];
    // A chunk far smaller than the file forces the carry-over path repeatedly.
    for await (const l of readLinesBackward(file, { chunkSize: 16 })) got.push(l.text);
    expect(got).toEqual([...lines].reverse());
  });

  it("handles a file with no trailing newline", async () => {
    const file = path.join(home, "b.jsonl");
    await writeFile(file, "one\ntwo");
    const got = [];
    for await (const l of readLinesBackward(file)) got.push(l.text);
    // "two" is unterminated, so it is treated as a partial write and skipped.
    expect(got).toEqual(["one"]);
  });

  it("drops a half-written trailing record from a live session", async () => {
    const file = path.join(home, "live.jsonl");
    await writeFile(file, `${claudeTurn("user", "done", "2026-08-01T00:00:00Z")}\n{"type":"assi`);
    const got = [];
    for await (const l of readLinesBackward(file)) got.push(l.text);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain("done");
  });

  it("reads only what the consumer asks for", async () => {
    const file = path.join(home, "huge.jsonl");
    // 5MB of records; taking one must not depend on reading them all.
    const lines = Array.from({ length: 500 }, (_, i) => `${i}:${"y".repeat(10_000)}`);
    await writeFile(file, lines.join("\n") + "\n");
    const it = readLinesBackward(file, { chunkSize: 4096 })[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value?.text.startsWith("499:")).toBe(true);
    await it.return?.(undefined);
  });

  it("returns nothing for an empty file", async () => {
    const file = path.join(home, "empty.jsonl");
    await writeFile(file, "");
    const got = [];
    for await (const l of readLinesBackward(file)) got.push(l);
    expect(got).toEqual([]);
  });
});

describe("projectRecord", () => {
  it("extracts Claude text turns", () => {
    const r = projectRecord(claudeTurn("assistant", "hello", "2026-08-01T00:00:00Z"), "claude");
    expect(r).toEqual({ ts: "2026-08-01T00:00:00Z", role: "assistant", text: "hello" });
  });

  it("skips Claude sidechains unless asked", () => {
    const line = claudeTurn("assistant", "sub", "2026-08-01T00:00:00Z", { isSidechain: true });
    expect(projectRecord(line, "claude")).toBeNull();
    expect(projectRecord(line, "claude", { includeSidechains: true })?.text).toBe("sub");
  });

  it("drops tool plumbing by default and marks it when requested", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-01T00:00:00Z",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] },
    });
    expect(projectRecord(line, "claude")).toBeNull();
    expect(projectRecord(line, "claude", { includeTools: true })?.text).toBe("[tool: Bash]");
  });

  it("accepts Claude's string-shaped content", () => {
    const line = JSON.stringify({
      type: "user",
      timestamp: "2026-08-01T00:00:00Z",
      message: { role: "user", content: "plain" },
    });
    expect(projectRecord(line, "claude")?.text).toBe("plain");
  });

  it("reads Codex event messages and ignores duplicate response_items", () => {
    expect(
      projectRecord(codexEvent("agent_message", "hi", "2026-08-03T01:00:00Z"), "codex"),
    ).toEqual({ ts: "2026-08-03T01:00:00Z", role: "assistant", text: "hi" });
    const dup = JSON.stringify({
      timestamp: "2026-08-03T01:00:00Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ text: "hi" }] },
    });
    expect(projectRecord(dup, "codex")).toBeNull();
  });

  it("ignores metadata and malformed lines rather than throwing", () => {
    expect(projectRecord("{not json", "claude")).toBeNull();
    expect(projectRecord(JSON.stringify({ type: "ai-title" }), "claude")).toBeNull();
    expect(projectRecord(JSON.stringify({ type: "session_meta" }), "codex")).toBeNull();
  });
});

describe("discoverTranscripts", () => {
  it("finds both sources and filters Claude by cwd slug", async () => {
    await writeClaudeSession("s1", [claudeTurn("user", "a", "2026-08-01T00:00:00Z")]);
    await writeClaudeSession(
      "s2",
      [claudeTurn("user", "b", "2026-08-01T00:00:00Z")],
      "/other/repo",
    );
    await writeCodexSession("c1", [codexEvent("user_message", "c", "2026-08-03T00:00:01Z")]);

    const all = await discoverTranscripts({ home });
    expect(all.map((f) => f.sessionId).sort()).toEqual(["rollout-c1", "s1", "s2"]);

    const scoped = await discoverTranscripts({ home, cwd: CWD });
    expect(scoped.map((f) => f.sessionId).sort()).toEqual(["rollout-c1", "s1"]);
  });

  it("filters Codex by the cwd inside session_meta", async () => {
    await writeCodexSession("c1", [codexEvent("user_message", "c", "2026-08-03T00:00:01Z")]);
    await writeCodexSession(
      "c2",
      [codexEvent("user_message", "d", "2026-08-03T00:00:02Z")],
      "/elsewhere",
    );
    const scoped = await discoverTranscripts({ home, cwd: CWD });
    expect(scoped.map((f) => f.sessionId)).toEqual(["rollout-c1"]);
  });

  it("ignores codex history.jsonl and empty files", async () => {
    const dir = path.join(home, ".codex", "sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "history.jsonl"), '{"x":1}\n');
    await writeClaudeSession("empty", []);
    expect(await discoverTranscripts({ home })).toEqual([]);
  });

  it("returns empty when no agent transcripts exist at all", async () => {
    expect(await discoverTranscripts({ home })).toEqual([]);
  });
});

describe("readCodexCwd", () => {
  it("reads cwd without consuming the whole file", async () => {
    const file = await writeCodexSession("c1", [
      codexEvent("user_message", "x".repeat(200_000), "2026-08-03T00:00:01Z"),
    ]);
    expect(await readCodexCwd(file)).toBe(CWD);
  });
});

describe("tailTranscript", () => {
  it("returns the newest N records oldest-first", async () => {
    const file = await writeClaudeSession(
      "s1",
      Array.from({ length: 20 }, (_, i) =>
        claudeTurn("user", `msg-${i}`, `2026-08-01T00:00:${String(i).padStart(2, "0")}Z`),
      ),
    );
    const got = await tailTranscript(asFile(file, "claude"), { limit: 3 });
    expect(got.map((r) => r.text)).toEqual(["msg-17", "msg-18", "msg-19"]);
  });

  it("honours the before cursor and role filter", async () => {
    const file = await writeClaudeSession("s1", [
      claudeTurn("user", "q1", "2026-08-01T00:00:01Z"),
      claudeTurn("assistant", "a1", "2026-08-01T00:00:02Z"),
      claudeTurn("user", "q2", "2026-08-01T00:00:03Z"),
    ]);
    const f = asFile(file, "claude");
    expect(
      (await tailTranscript(f, { limit: 10, before: "2026-08-01T00:00:03Z" })).map((r) => r.text),
    ).toEqual(["q1", "a1"]);
    expect((await tailTranscript(f, { limit: 10, role: "user" })).map((r) => r.text)).toEqual([
      "q1",
      "q2",
    ]);
  });
});

describe("histPage", () => {
  it("merges sessions chronologically and caps to the limit", async () => {
    await writeClaudeSession("s1", [
      claudeTurn("user", "claude-early", "2026-08-01T00:00:01Z"),
      claudeTurn("assistant", "claude-late", "2026-08-01T00:00:05Z"),
    ]);
    await writeCodexSession("c1", [
      codexEvent("user_message", "codex-mid", "2026-08-01T00:00:03Z"),
    ]);

    const page = await histPage({ home, cwd: CWD, limit: 2 });
    expect(page.records.map((r) => r.text)).toEqual(["codex-mid", "claude-late"]);
    expect(page.scanned).toBe(2);
  });

  it("returns a cursor that pages backwards without overlap", async () => {
    await writeClaudeSession(
      "s1",
      Array.from({ length: 10 }, (_, i) =>
        claudeTurn("user", `m${i}`, `2026-08-01T00:00:${String(i).padStart(2, "0")}Z`),
      ),
    );
    const first = await histPage({ home, cwd: CWD, limit: 3 });
    expect(first.records.map((r) => r.text)).toEqual(["m7", "m8", "m9"]);
    expect(first.cursor).toBeTruthy();

    const second = await histPage({ home, cwd: CWD, limit: 3, before: first.cursor! });
    expect(second.records.map((r) => r.text)).toEqual(["m4", "m5", "m6"]);
  });

  it("pages through records that share one timestamp without losing any", async () => {
    // Transcripts routinely record several turns inside the same millisecond.
    // A bare-timestamp cursor drops every record tying with the page boundary.
    const ts = "2026-08-01T00:00:00.000Z";
    await writeClaudeSession(
      "s1",
      ["a", "b", "c", "d"].map((t) => claudeTurn("user", t, ts)),
    );

    const first = await histPage({ home, cwd: CWD, limit: 2 });
    expect(first.records.map((r) => r.text)).toEqual(["c", "d"]);
    const second = await histPage({ home, cwd: CWD, limit: 2, before: first.cursor! });
    expect(second.records.map((r) => r.text)).toEqual(["a", "b"]);
    expect(second.cursor).toBeNull();
  });

  it("walks the entire history in pages without gaps or repeats", async () => {
    await writeClaudeSession(
      "s1",
      Array.from({ length: 7 }, (_, i) => claudeTurn("user", `x${i}`, "2026-08-01T00:00:00.000Z")),
    );
    await writeCodexSession(
      "c1",
      Array.from({ length: 5 }, (_, i) =>
        codexEvent("user_message", `y${i}`, "2026-08-01T00:00:00.000Z"),
      ),
    );

    const seen: string[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await histPage({ home, cwd: CWD, limit: 3, before });
      seen.unshift(...page.records.map((r) => r.text));
      if (!page.cursor) break;
      before = page.cursor;
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  it("still accepts a hand-typed ISO timestamp for --before", async () => {
    await writeClaudeSession("s1", [
      claudeTurn("user", "old", "2026-08-01T00:00:01Z"),
      claudeTurn("user", "new", "2026-08-01T00:00:09Z"),
    ]);
    const page = await histPage({ home, cwd: CWD, limit: 5, before: "2026-08-01T00:00:05Z" });
    expect(page.records.map((r) => r.text)).toEqual(["old"]);
  });

  it("reports no cursor once the history is exhausted", async () => {
    await writeClaudeSession("s1", [claudeTurn("user", "only", "2026-08-01T00:00:01Z")]);
    const page = await histPage({ home, cwd: CWD, limit: 6 });
    expect(page.records).toHaveLength(1);
    expect(page.cursor).toBeNull();
  });
});
