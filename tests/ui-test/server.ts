/**
 * UI test server: serves xterm.js frontend and WebSocket PTY backend.
 * Uses Node.js http + ws so it works in both bun and vitest/node contexts.
 *
 * WebSocket protocol (text frames as JSON):
 *   client → server:  { type: "input", data: string }
 *                     { type: "resize", cols: number, rows: number }
 *   server → client:  { type: "output", data: string }  (base64-encoded bytes)
 *                     { type: "exit", code: number }
 */

import http from "http";
import { WebSocketServer, type WebSocket } from "ws";
import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, "index.html");

export interface ServerOptions {
  port?: number;
  /** Command to run inside the terminal. Defaults to mock-cli.ts */
  command?: string[];
  /** Working directory for the command */
  cwd?: string;
  /** Extra env vars */
  env?: NodeJS.ProcessEnv;
  /** Terminal cols */
  cols?: number;
  /** Terminal rows */
  rows?: number;
}

export async function startServer(opts: ServerOptions = {}): Promise<{
  url: string;
  close: () => void;
}> {
  const { port = 0, cols = 120, rows = 30, cwd = process.cwd(), env = process.env } = opts;

  const html = readFileSync(HTML_PATH, "utf8");

  // Font paths to try for JetBrains Mono
  const FONT_PATHS = [
    "/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Regular.ttf",
    "/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMonoNL-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", // fallback
  ];
  const fontPath = FONT_PATHS.find((p) => existsSync(p)) ?? null;

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/font/JetBrainsMono-Regular.ttf" && fontPath) {
      const data = readFileSync(fontPath);
      res.writeHead(200, { "Content-Type": "font/truetype" });
      return res.end(data);
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket, req) => {
    // Parse cols/rows from query string if provided
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const clientCols = Number(params.get("cols") ?? cols);
    const clientRows = Number(params.get("rows") ?? rows);

    const command = opts.command ?? ["bun", join(__dirname, "mock-cli.ts")];
    const [bin, ...args] = command;

    const proc = spawn(bin!, args, {
      cwd,
      env: {
        ...env,
        TERM: "xterm-256color",
        COLUMNS: String(clientCols),
        LINES: String(clientRows),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const send = (msg: object) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    proc.stdout?.on("data", (data: Buffer) =>
      send({ type: "output", data: data.toString("base64") }),
    );
    proc.stderr?.on("data", (data: Buffer) =>
      send({ type: "output", data: data.toString("base64") }),
    );
    proc.on("exit", (code) => send({ type: "exit", code: code ?? 0 }));

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "input" && proc.stdin) {
          proc.stdin.write(msg.data as string);
        }
        // resize messages could be handled here with node-pty if needed
      } catch {}
    });

    ws.on("close", () => proc.kill());
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));

  const addr = httpServer.address() as { port: number };
  const actualPort = addr.port;
  const url = `http://localhost:${actualPort}`;

  return {
    url,
    close: () => {
      wss.close();
      httpServer.close();
    },
  };
}

// CLI entry point
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*[/\\]/, ""))
) {
  const p = Number(process.env.PORT ?? 3737);
  const { url } = await startServer({ port: p });
  console.log(`UI test server running at ${url}`);
}
