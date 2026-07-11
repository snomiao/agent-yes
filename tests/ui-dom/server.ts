/**
 * Stub server for the deterministic DOM test of the REAL console
 * (lab/ui/index.html). It serves the actual UI files and a stubbed `ay serve`
 * API so the page renders a fixed set of agents with no live backend.
 *
 * Node http (works in both bun and node). Endpoints mirror what the console's
 * local transport calls (see Conn in lab/ui/index.html):
 *   GET  /                      → index.html
 *   GET  /console-logic.js      → the real ESM module
 *   GET  /e2e.js                → the real end-to-end-encryption module
 *   GET  /room-client.js        → the real codehost transport
 *   GET  /api/ls?all=1          → AGENTS fixture (JSON)
 *   GET  /api/size/:pid         → { cols, rows }
 *   GET  /api/tail/:pid?raw=1   → SSE; one JSON-encoded chunk then keep-alive
 *   POST /api/resize/:pid       → ok
 *   POST /api/send              → ok
 *   POST /api/kill              → { ok: true }  (Cmd+K /kill, ⋯ Force-kill)
 *   POST /api/restart           → { ok: true }  (Cmd+K /restart, ⋯ Restart)
 */
import http from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI = join(__dirname, "../../lab/ui");

// Deterministic fixture. started_at is set once at module load so age() is
// stable enough for the run; tests don't assert exact ages. Three agents:
//  - 101 default claude  → identity leads (no cli label), repo agent-yes/main
//  - 102 codex           → shows the cli label, repo widgets/dev
//  - 103 default claude  → repo bar/feature-x
const T0 = 1_700_000_000_000;
export const AGENTS = [
  {
    pid: 101,
    cli: "claude",
    cwd: "/home/u/ws/snomiao/agent-yes/tree/main",
    title: "first agent",
    prompt: "",
    status: "active",
    started_at: T0,
  },
  {
    pid: 102,
    cli: "codex",
    cwd: "/home/u/ws/acme/widgets/tree/dev",
    title: "second agent",
    prompt: "",
    status: "idle",
    started_at: T0,
  },
  {
    pid: 103,
    cli: "claude",
    cwd: "/home/u/ws/foo/bar/tree/feature-x",
    title: "third agent",
    prompt: "",
    status: "active",
    started_at: T0,
  },
];

function file(res: http.ServerResponse, path: string, type: string) {
  res.writeHead(200, { "Content-Type": type });
  res.end(readFileSync(path));
}

// `agents` defaults to the flat AGENTS fixture; a test can pass its own set
// (e.g. a nested parent+subagent tree) to exercise fold-specific wiring without
// disturbing the shared fixture the other tests assert exact counts against.
export async function startServer(
  agents: unknown[] = AGENTS,
): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const p = url.pathname;

    if (req.method === "GET" && (p === "/" || p === "/index.html"))
      return file(res, join(UI, "index.html"), "text/html; charset=utf-8");
    if (req.method === "GET" && p === "/console-logic.js")
      return file(res, join(UI, "console-logic.js"), "text/javascript; charset=utf-8");
    // index.html statically imports ./e2e.js too; without it the whole page
    // module fails to load and nothing renders (the list stays empty). Same for
    // ./rtc.js (the extracted ay-share WebRTC wire) — a 404 on a module import
    // halts the whole graph, so every row test times out. qrcode.js is a classic
    // <script> (its 404 is non-fatal) but we serve it so the console stays clean.
    if (req.method === "GET" && p === "/e2e.js")
      return file(res, join(UI, "e2e.js"), "text/javascript; charset=utf-8");
    if (req.method === "GET" && p === "/room-client.js")
      return file(res, join(UI, "room-client.js"), "text/javascript; charset=utf-8");
    if (req.method === "GET" && p === "/rtc.js")
      return file(res, join(UI, "rtc.js"), "text/javascript; charset=utf-8");
    if (req.method === "GET" && p === "/qrcode.js")
      return file(res, join(UI, "qrcode.js"), "text/javascript; charset=utf-8");

    if (req.method === "GET" && p === "/api/ls") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(agents));
    }
    if (req.method === "GET" && p.startsWith("/api/size/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ cols: 80, rows: 24 }));
    }
    if (req.method === "GET" && p.startsWith("/api/tail/")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // One xterm-render chunk (the payload is a JSON-encoded string, matching
      // the real SSE: onText(JSON.parse(e.data)) → term.write(string)).
      res.write(`data: ${JSON.stringify("agent output\r\n")}\n\n`);
      return; // keep open
    }
    if (req.method === "POST" && (p.startsWith("/api/resize/") || p === "/api/send")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }
    // Recovery endpoints (Cmd+K /kill · /restart, and the ⋯-menu buttons). Ack ok
    // so restartAgent()'s success path runs; the test asserts the target from the
    // captured request body.
    if (req.method === "POST" && (p === "/api/kill" || p === "/api/restart")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  };
}
