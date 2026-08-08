import { afterEach, describe, expect, it, vi } from "vitest";
import { cmdHist, renderRecord, snippet } from "./hist.ts";
import type { HistRecord } from "./histStore.ts";
import { histPage } from "./histStore.ts";

vi.mock("./histStore.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./histStore.ts")>()),
  histPage: vi.fn(),
}));

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
    expect(
      renderRecord({ ...rec, role: "assistant" }, { color: false, max: 0 }),
    ).toContain("claude");
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

  it("survives an unparseable timestamp", () => {
    expect(renderRecord({ ...rec, ts: "not-a-date" }, { color: false, max: 0 })).toContain(
      "??:??",
    );
  });

  it("emits ANSI tints when color is on", () => {
    const out = renderRecord(rec, { color: true, max: 0 });
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(true);
  });
});

describe("cmdHist", () => {
  const page = (over: Partial<Awaited<ReturnType<typeof histPage>>> = {}) => ({
    records: [rec],
    cursor: null,
    scanned: 3,
    ...over,
  });
  const mocked = vi.mocked(histPage);

  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    return { out, err, restore: () => (outSpy.mockRestore(), errSpy.mockRestore()) };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits JSONL and exits 0 when --json finds records", async () => {
    mocked.mockResolvedValue(page());
    const io = capture();
    const code = await cmdHist(["--json"]);
    io.restore();
    expect(code).toBe(0);
    expect(JSON.parse(io.out.join("").trim()).text).toBe("hello there");
  });

  it("exits 1 on --json with no records", async () => {
    mocked.mockResolvedValue(page({ records: [] }));
    const io = capture();
    const code = await cmdHist(["--json"]);
    io.restore();
    expect(code).toBe(1);
    expect(io.out.join("")).toBe("");
  });

  it("suggests --all when the cwd scope is empty, with singular scanned count", async () => {
    mocked.mockResolvedValue(page({ records: [], scanned: 1 }));
    const io = capture();
    const code = await cmdHist([]);
    io.restore();
    expect(code).toBe(1);
    const msg = io.err.join("");
    expect(msg).toContain("1 transcript)");
    expect(msg).not.toContain("transcripts");
    expect(msg).toContain("ay hist --all");
  });

  it("scopes machine-wide on --all and drops the suggestion", async () => {
    mocked.mockResolvedValue(page({ records: [] }));
    const io = capture();
    const code = await cmdHist(["--all"]);
    io.restore();
    expect(code).toBe(1);
    const msg = io.err.join("");
    expect(msg).toContain("on this machine");
    expect(msg).toContain("3 transcripts");
    expect(msg).not.toContain("--all\n");
    expect(mocked).toHaveBeenCalledWith(expect.objectContaining({ cwd: undefined }));
  });

  it("renders records and prints the pagination cursor on stderr", async () => {
    mocked.mockResolvedValue(page({ cursor: "2026-08-06T00:00:00.000Z" }));
    const io = capture();
    const code = await cmdHist([]);
    io.restore();
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("hello there");
    expect(io.err.join("")).toContain("older: ay hist --before 2026-08-06T00:00:00.000Z");
  });

  it("passes filters through: --cwd, --source, --role, --before, --tools, --sidechains", async () => {
    mocked.mockResolvedValue(page());
    const io = capture();
    const code = await cmdHist([
      "--cwd",
      "/some/dir",
      "--source",
      "codex",
      "--role",
      "user",
      "--before",
      "2026-01-01T00:00:00.000Z",
      "--tools",
      "--sidechains",
      "-n",
      "0",
      "--full",
    ]);
    io.restore();
    expect(code).toBe(0);
    expect(mocked).toHaveBeenCalledWith({
      cwd: "/some/dir",
      limit: 0,
      before: "2026-01-01T00:00:00.000Z",
      role: "user",
      sources: ["codex"],
      includeTools: true,
      includeSidechains: true,
    });
  });
});
