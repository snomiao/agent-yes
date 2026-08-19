/**
 * `ay hist` — CLI surface over {@link ./histStore.ts}.
 *
 * Reads past coding-agent conversations (Claude Code, Codex) that already exist
 * on disk. Distinct from `ay tail`, which follows the live PTY log of a process
 * agent-yes spawned; `ay hist` reads the CLI's own durable transcript, so it
 * still works for sessions that already exited.
 */

import yargs from "yargs";
import { histPage, type HistRecord, type HistSource } from "./histStore.ts";

const DEFAULT_LIMIT = 6;
const DEFAULT_SNIPPET = 600;

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function shortTime(ts: string | null): string {
  if (!ts) return "??:??";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "??:??";
  const now = Date.now();
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const hhmm = d.toTimeString().slice(0, 5);
  return sameDay ? hhmm : `${d.toISOString().slice(5, 10)} ${hhmm}`;
}

/** Collapse a turn to `max` chars, noting how much was withheld. */
export function snippet(text: string, max: number): string {
  const trimmed = text.trim();
  if (max <= 0 || trimmed.length <= max) return trimmed;
  const head = trimmed.slice(0, max);
  const hiddenLines = trimmed.slice(max).split("\n").length;
  return `${head}… ${DIM}(+${trimmed.length - max} chars, ${hiddenLines} more lines)${RESET}`;
}

export function renderRecord(r: HistRecord, opts: { color: boolean; max: number }): string {
  const who = r.role === "user" ? "user" : r.source;
  const tint = opts.color ? (r.role === "user" ? CYAN : GREEN) : "";
  const dim = opts.color ? DIM : "";
  const off = opts.color ? RESET : "";
  const body = snippet(r.text, opts.max)
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  const head = `${tint}${who}${off} ${dim}${shortTime(r.ts)} ${r.sessionId.slice(0, 8)}${off}`;
  return `${head}\n${body}\n`;
}

export async function cmdHist(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage(
      "Usage: ay hist [options]\n\n" +
        "Tail past coding-agent conversations (Claude Code, Codex) from this machine.\n" +
        "Defaults to sessions for the current directory, newest last.\n\n" +
        "Pagination: rerun with --before <cursor> using the cursor printed at the end.",
    )
    .option("n", {
      type: "number",
      default: DEFAULT_LIMIT,
      description: `Number of turns (default ${DEFAULT_LIMIT}; 0 = no cap)`,
    })
    .option("all", {
      type: "boolean",
      default: false,
      description: "All projects, not just the current directory",
    })
    .option("cwd", { type: "string", description: "Scope to this directory instead of $PWD" })
    .option("source", {
      choices: ["claude", "codex"] as const,
      description: "Only one agent's transcripts",
    })
    .option("role", {
      choices: ["user", "assistant"] as const,
      description: "Only my prompts, or only the agent's replies",
    })
    .option("before", {
      type: "string",
      description: "Cursor: only turns older than this ISO timestamp",
    })
    .option("tools", {
      type: "boolean",
      default: false,
      description: "Include tool calls/results and thinking as markers",
    })
    .option("sidechains", {
      type: "boolean",
      default: false,
      description: "Include Claude sub-agent turns",
    })
    .option("full", { type: "boolean", default: false, description: "Do not truncate turns" })
    .option("json", { type: "boolean", default: false, description: "JSONL for scripts/agents" })
    .help();

  const argv = await y.parse();

  const cwd = argv.all ? undefined : ((argv.cwd as string | undefined) ?? process.cwd());
  const page = await histPage({
    cwd,
    limit: Number(argv.n),
    before: argv.before as string | undefined,
    role: argv.role as "user" | "assistant" | undefined,
    sources: argv.source ? ([argv.source] as HistSource[]) : undefined,
    includeTools: Boolean(argv.tools),
    includeSidechains: Boolean(argv.sidechains),
  });

  if (argv.json) {
    for (const r of page.records) process.stdout.write(JSON.stringify(r) + "\n");
    return page.records.length ? 0 : 1;
  }

  if (!page.records.length) {
    const where = cwd ? `for ${cwd}` : "on this machine";
    process.stderr.write(
      `no agent conversation history ${where} (scanned ${page.scanned} transcript${
        page.scanned === 1 ? "" : "s"
      }).\n` + (cwd ? `try: ay hist --all\n` : ""),
    );
    return 1;
  }

  const color = process.stdout.isTTY === true;
  const max = argv.full ? 0 : DEFAULT_SNIPPET;
  for (const r of page.records) process.stdout.write(renderRecord(r, { color, max }) + "\n");

  if (page.cursor) {
    const dim = color ? DIM : "";
    const off = color ? RESET : "";
    process.stderr.write(`${dim}older: ay hist --before ${page.cursor}${off}\n`);
  }
  return 0;
}
