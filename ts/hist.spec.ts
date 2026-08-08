import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdHist, renderRecord, snippet } from "./hist.ts";
import { histPage, type HistRecord } from "./histStore.ts";

vi.mock("./histStore.ts", () => ({ histPage: vi.fn() }));

const rec: HistRecord = {
  ts: "2026-08-06T09:29:37.533Z",
  role: "user",
  text: "hello there",
  source: "claude",
  sessionId: "ff1f38ee-78aa-48a6",
  file: "/tmp/x.jsonl",
  offset: 0,
};

describe("snippet", () => {
  it("leaves short text alone", () => {
    expect(snippet("short", 100)).toBe("short");
  });

  it("truncates and reports what was withheld", () => {
    const out = snippet("a".repeat(50) + "\n" + "b".repeat(50), 10);
    expect(out.startsWith("a".repeat(10))).toBe(true);
    expect(out).toContain("+91 chars");
    expect(out).toContain("2 more lines");
  });

  it("treats max 0 as unlimited, for --full", () => {
    const long = "x".repeat(5000);
    expect(snippet(long, 0)).toBe(long);
  });
});

describe("renderRecord", () => {
  it("labels the human as user and the agent by its source", () => {
    expect(renderRecord(rec, { color: false, max: 0 })).toContain("user");
    expect(renderRecord({ ...rec, role: "assistant" }, { color: false, max: 0 })).toContain(
      "claude",
    );
    expect(
      renderRecord({ ...rec, role: "assistant", source: "codex" }, { color: false, max: 0 }),
    ).toContain("codex");
  });

  it("emits no ANSI when color is off, so pipes stay clean", () => {
    const out = renderRecord(rec, { color: false, max: 0 });
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(false);
  });

  it("indents the body and shows a short session id", () => {
    const out = renderRecord(rec, { color: false, max: 0 });
    expect(out).toContain("\n  hello there");
    expect(out).toContain("ff1f38ee");
    expect(out).not.toContain("ff1f38ee-78aa");
  });

  it("survives a missing timestamp", () => {
    expect(renderRecord({ ...rec, ts: null }, { color: false, max: 0 })).toContain("??:??");
  });
});

/**
 * `cmdHist` — the CLI surface. The pure helpers above are easy; this is the
 * half that decides exit codes and what a script sees on stdout, so it is the
 * half worth pinning down.
 */
describe("cmdHist", () => {
  const page = (records: HistRecord[], extra: Partial<{ scanned: number; cursor: string }> = {}) =>
    ({ records, scanned: extra.scanned ?? records.length, cursor: extra.cursor ?? null }) as never;

  let out: string[];
  let err: string[];
  let tty: boolean | undefined;

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    tty = process.stdout.isTTY;
    process.stdout.isTTY = false;
    vi.mocked(histPage).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.stdout.isTTY = tty;
  });

  it("prints one JSON object per turn, so scripts can read it", async () => {
    vi.mocked(histPage).mockResolvedValue(page([rec, { ...rec, text: "second" }]));

    expect(await cmdHist(["--json"])).toBe(0);
    const lines = out.join("").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).text).toBe("hello there");
    expect(JSON.parse(lines[1]!).text).toBe("second");
  });

  it("exits non-zero on an empty --json page, so `&&` chains stop", async () => {
    vi.mocked(histPage).mockResolvedValue(page([]));

    expect(await cmdHist(["--json"])).toBe(1);
    expect(out.join("")).toBe("");
  });

  it("suggests --all when a directory-scoped search finds nothing", async () => {
    vi.mocked(histPage).mockResolvedValue(page([], { scanned: 3 }));

    expect(await cmdHist(["--cwd", "/tmp/project"])).toBe(1);
    const message = err.join("");
    expect(message).toContain("/tmp/project");
    expect(message).toContain("scanned 3 transcripts");
    expect(message).toContain("ay hist --all");
  });

  it("does not suggest --all when --all already found nothing", async () => {
    vi.mocked(histPage).mockResolvedValue(page([], { scanned: 1 }));

    expect(await cmdHist(["--all"])).toBe(1);
    const message = err.join("");
    expect(message).toContain("on this machine");
    expect(message).toContain("scanned 1 transcript");
    expect(message).not.toContain("scanned 1 transcripts");
    expect(message).not.toContain("--all");
  });

  it("scopes to the current directory unless --all is given", async () => {
    vi.mocked(histPage).mockResolvedValue(page([rec]));

    await cmdHist([]);
    expect(vi.mocked(histPage).mock.calls[0]![0]!.cwd).toBe(process.cwd());

    vi.mocked(histPage).mockClear();
    await cmdHist(["--all"]);
    expect(vi.mocked(histPage).mock.calls[0]![0]!.cwd).toBeUndefined();

    vi.mocked(histPage).mockClear();
    await cmdHist(["--cwd", "/elsewhere"]);
    expect(vi.mocked(histPage).mock.calls[0]![0]!.cwd).toBe("/elsewhere");
  });

  it("passes the filters through rather than filtering afterwards", async () => {
    vi.mocked(histPage).mockResolvedValue(page([rec]));

    await cmdHist(["--source", "codex", "--role", "user", "-n", "2", "--tools", "--sidechains"]);
    const args = vi.mocked(histPage).mock.calls[0]![0]!;

    expect(args.sources).toEqual(["codex"]);
    expect(args.role).toBe("user");
    expect(args.limit).toBe(2);
    expect(args.includeTools).toBe(true);
    expect(args.includeSidechains).toBe(true);
  });

  it("truncates by default and leaves turns whole under --full", async () => {
    const long = { ...rec, text: "y".repeat(2000) };
    vi.mocked(histPage).mockResolvedValue(page([long]));

    await cmdHist([]);
    expect(out.join("")).toContain("chars,");

    out = [];
    vi.mocked(histPage).mockResolvedValue(page([long]));
    await cmdHist(["--full"]);
    expect(out.join("")).toContain("y".repeat(2000));
    expect(out.join("")).not.toContain("chars,");
  });

  it("tells you how to page further only when there is more", async () => {
    vi.mocked(histPage).mockResolvedValue(page([rec], { cursor: "2026-08-06T09:00:00.000Z" }));
    expect(await cmdHist([])).toBe(0);
    expect(err.join("")).toContain("ay hist --before 2026-08-06T09:00:00.000Z");

    err = [];
    vi.mocked(histPage).mockResolvedValue(page([rec]));
    await cmdHist([]);
    expect(err.join("")).toBe("");
  });

  it("keeps ANSI out of a pipe and puts it back on a terminal", async () => {
    vi.mocked(histPage).mockResolvedValue(page([rec]));
    await cmdHist([]);
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out.join(""))).toBe(false);

    out = [];
    process.stdout.isTTY = true;
    vi.mocked(histPage).mockResolvedValue(page([rec]));
    await cmdHist([]);
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out.join(""))).toBe(true);
  });
});
