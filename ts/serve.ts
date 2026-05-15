import { mkdir, readFile, writeFile } from "fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { homedir } from "os";
import path from "path";
import yargs from "yargs";
import {
  controlCodeFromName,
  listRecords,
  readNotes,
  renderRawLog,
  resolveOne,
  snapshotStatus,
  writeToIpc,
  type CommonOpts,
} from "./subcommands.ts";

const DEFAULT_PORT = 7432;

function agentYesHome(): string {
  return process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes");
}

function tokenPath(): string {
  return path.join(agentYesHome(), ".serve-token");
}

async function loadOrCreateToken(tokenFlag?: string): Promise<string> {
  if (tokenFlag) return tokenFlag;
  try {
    return (await readFile(tokenPath(), "utf-8")).trim();
  } catch {
    const token = randomBytes(20).toString("hex");
    await mkdir(agentYesHome(), { recursive: true });
    await writeFile(tokenPath(), token, { mode: 0o600 });
    return token;
  }
}

function checkAuth(req: Request, expectedToken: string): boolean {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const provided = auth.slice(7);
  // Constant-time compare; pad both to the same length first
  const maxLen = Math.max(provided.length, expectedToken.length);
  const a = Buffer.from(provided.padEnd(maxLen, "\0"));
  const b = Buffer.from(expectedToken.padEnd(maxLen, "\0"));
  return timingSafeEqual(a, b) && provided.length === expectedToken.length;
}

const defaultOpts = (overrides: Partial<CommonOpts> = {}): CommonOpts => ({
  all: false,
  active: false,
  json: true,
  latest: true,
  cwdScope: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// ay serve
// ---------------------------------------------------------------------------

export async function cmdServe(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage("Usage: ay serve [options]")
    .option("port", { type: "number", default: DEFAULT_PORT, description: "Port to listen on" })
    .option("host", {
      type: "string",
      default: "127.0.0.1",
      description: "Interface to bind (use 0.0.0.0 to expose)",
    })
    .option("token", { type: "string", description: "Auth token (auto-generated if omitted)" })
    .option("tls-cert", { type: "string", description: "TLS certificate file (PEM)" })
    .option("tls-key", { type: "string", description: "TLS private key file (PEM)" })
    .help(false)
    .version(false)
    .exitProcess(false);

  const argv = await y.parseAsync();
  const port = (argv.port as number) ?? DEFAULT_PORT;
  const host = (argv.host as string) ?? "127.0.0.1";
  const tokenFlag = typeof argv.token === "string" ? argv.token : undefined;
  const certPath = typeof argv["tls-cert"] === "string" ? argv["tls-cert"] : undefined;
  const keyPath = typeof argv["tls-key"] === "string" ? argv["tls-key"] : undefined;

  if ((certPath && !keyPath) || (!certPath && keyPath)) {
    process.stderr.write("ay serve: --tls-cert and --tls-key must both be provided\n");
    return 1;
  }
  const useHttps = !!(certPath && keyPath);
  const scheme = useHttps ? "https" : "http";

  if (host !== "127.0.0.1" && host !== "localhost") {
    process.stderr.write(
      "ay serve: warning: binding to non-loopback — ensure your network is trusted or use Tailscale/VPN\n",
    );
  }

  const token = await loadOrCreateToken(tokenFlag);

  const serverOpts: any = {
    hostname: host,
    port,
    async fetch(req: Request): Promise<Response> {
      if (!checkAuth(req, token)) {
        return new Response("Unauthorized", { status: 401 });
      }

      const url = new URL(req.url);
      const p = url.pathname;

      // GET /api/ls
      if (req.method === "GET" && p === "/api/ls") {
        const keyword = url.searchParams.get("keyword") ?? undefined;
        const opts = defaultOpts({
          all: url.searchParams.get("all") === "1",
          active: url.searchParams.get("active") === "1",
        });
        try {
          const records = await listRecords(keyword, opts);
          return Response.json(records);
        } catch (e) {
          return new Response((e as Error).message, { status: 500 });
        }
      }

      // GET /api/notes
      if (req.method === "GET" && p === "/api/notes") {
        const notes = await readNotes();
        return Response.json(Object.fromEntries(notes));
      }

      // GET /api/status/:keyword
      const statusM = /^\/api\/status\/(.+)$/.exec(p);
      if (req.method === "GET" && statusM) {
        const keyword = decodeURIComponent(statusM[1]!);
        try {
          const record = await resolveOne(keyword, defaultOpts({ all: true }));
          const snap = await snapshotStatus(record);
          return Response.json(snap);
        } catch (e) {
          return new Response((e as Error).message, { status: 404 });
        }
      }

      // GET /api/read/:keyword?mode=cat|tail|head&n=N  — static log read
      const readM = /^\/api\/read\/(.+)$/.exec(p);
      if (req.method === "GET" && readM) {
        const keyword = decodeURIComponent(readM[1]!);
        const mode = (url.searchParams.get("mode") ?? "tail") as "cat" | "tail" | "head";
        const n = parseInt(url.searchParams.get("n") ?? "96", 10) || 96;
        try {
          const record = await resolveOne(keyword, defaultOpts());
          if (!record.log_file)
            return new Response(`pid ${record.pid}: no log_file`, { status: 404 });
          const buf = await readFile(record.log_file);
          const text = await renderRawLog(buf, { mode, n });
          return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        } catch (e) {
          return new Response((e as Error).message, { status: 404 });
        }
      }

      // GET /api/tail/:keyword  — SSE streaming
      const tailM = /^\/api\/tail\/(.+)$/.exec(p);
      if (req.method === "GET" && tailM) {
        const keyword = decodeURIComponent(tailM[1]!);
        try {
          const record = await resolveOne(keyword, defaultOpts());
          if (!record.log_file)
            return new Response(`pid ${record.pid}: no log_file`, { status: 404 });
          const logPath = record.log_file;

          const stream = new ReadableStream({
            async start(ctrl) {
              const enc = new TextEncoder();
              const send = (text: string) =>
                ctrl.enqueue(enc.encode(`data: ${JSON.stringify(text)}\n\n`));
              const ping = () => ctrl.enqueue(enc.encode(": ping\n\n"));

              // Initial tail
              const initBuf = await readFile(logPath).catch(() => Buffer.alloc(0));
              const initText = await renderRawLog(initBuf, { mode: "tail", n: 96 });
              send(initText);

              let offset = initBuf.length;
              let closed = false;

              const heartbeat = setInterval(() => {
                if (closed) {
                  clearInterval(heartbeat);
                  return;
                }
                ping();
              }, 15_000);

              // eslint-disable-next-line no-control-regex
              const ansiRe =
                /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
              // eslint-disable-next-line no-control-regex
              const ctrlRe = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

              const poller = setInterval(async () => {
                if (closed) {
                  clearInterval(poller);
                  return;
                }
                try {
                  const full = await readFile(logPath);
                  if (full.length <= offset) return;
                  const chunk = full.slice(offset);
                  offset = full.length;
                  const text = new TextDecoder()
                    .decode(chunk)
                    .replace(ansiRe, "")
                    .replace(ctrlRe, "");
                  if (text.trim()) send(text.trimStart());
                } catch {
                  /* log gone */
                }
              }, 300);

              req.signal.addEventListener("abort", () => {
                closed = true;
                clearInterval(heartbeat);
                clearInterval(poller);
                try {
                  ctrl.close();
                } catch {
                  /* already closed */
                }
              });
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        } catch (e) {
          return new Response((e as Error).message, { status: 404 });
        }
      }

      // POST /api/send  body: {keyword, msg, code?}
      if (req.method === "POST" && p === "/api/send") {
        let body: { keyword: string; msg: string; code?: string };
        try {
          body = await req.json();
        } catch {
          return new Response("invalid JSON body", { status: 400 });
        }
        const { keyword, msg = "", code = "enter" } = body;
        if (!keyword || typeof keyword !== "string") {
          return new Response("missing keyword", { status: 400 });
        }
        try {
          const record = await resolveOne(keyword, defaultOpts());
          if (!record.fifo_file)
            return new Response(`pid ${record.pid}: no fifo_file`, { status: 409 });
          const trailing = controlCodeFromName(code.toLowerCase());
          if (msg && trailing) {
            await writeToIpc(record.fifo_file, msg);
            await new Promise((r) => setTimeout(r, 200));
            await writeToIpc(record.fifo_file, trailing);
          } else {
            await writeToIpc(record.fifo_file, msg + trailing);
          }
          return Response.json({ ok: true, pid: record.pid });
        } catch (e) {
          return new Response((e as Error).message, { status: 404 });
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  };

  if (useHttps) {
    serverOpts.tls = { cert: Bun.file(certPath!), key: Bun.file(keyPath!) };
  }

  const server = Bun.serve(serverOpts);

  process.stdout.write(`ay serve  ${scheme}://${host}:${port}\n`);
  process.stdout.write(`token:    ${token}\n\n`);
  process.stdout.write(`connect from another machine:\n`);
  process.stdout.write(`  ay ls   ${token}@<host>:${port}\n`);
  process.stdout.write(`  ay tail ${token}@<host>:${port}:<keyword>\n`);
  process.stdout.write(`  ay send ${token}@<host>:${port}:<keyword> "message"\n\n`);
  if (!useHttps) {
    process.stdout.write(
      `for HTTPS: ay serve --tls-cert cert.pem --tls-key key.pem\n` +
        `  openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj '/CN=localhost'\n\n`,
    );
  }
  process.stdout.write(`(Ctrl-C to stop)\n`);

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      server.stop();
      resolve();
    });
    process.on("SIGTERM", () => {
      server.stop();
      resolve();
    });
  });

  return 0;
}
