import { mkdir, open, readFile, writeFile } from "fs/promises";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { SUPPORTED_CLIS } from "./SUPPORTED_CLIS.ts";

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

function tokenEqual(provided: string, expectedToken: string): boolean {
  // Constant-time compare; pad both to the same length first
  const maxLen = Math.max(provided.length, expectedToken.length);
  const a = Buffer.from(provided.padEnd(maxLen, "\0"));
  const b = Buffer.from(expectedToken.padEnd(maxLen, "\0"));
  return timingSafeEqual(a, b) && provided.length === expectedToken.length;
}

function checkAuth(req: Request, expectedToken: string): boolean {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) return tokenEqual(auth.slice(7), expectedToken);
  // Fallback: ?token= query param — the web UI's EventSource cannot set headers.
  const q = new URL(req.url).searchParams.get("token");
  return q ? tokenEqual(q, expectedToken) : false;
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
// ay serve install / uninstall / logs  (oxmgr daemon management)
// ---------------------------------------------------------------------------

const DAEMON_NAME = "agent-yes";

async function cmdServeDaemon(sub: string, args: string[]): Promise<number> {
  const oxmgrBin = Bun.which("oxmgr");
  if (!oxmgrBin) {
    process.stderr.write(
      "ay serve install: oxmgr not found\n" +
        "  install with:  cargo install oxmgr\n" +
        "             or: bun add -g oxmgr\n",
    );
    return 1;
  }

  if (sub === "install") {
    const token = await loadOrCreateToken(undefined);
    // Build the ay serve command with forwarded args (port, host, etc.)
    const serveCmd = ["ay", "serve", ...args].join(" ");
    const proc = Bun.spawn(
      [oxmgrBin, "start", serveCmd, "--name", DAEMON_NAME, "--restart", "always"],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    const code = await proc.exited;
    if (code === 0) {
      process.stdout.write(`\ninstalled '${DAEMON_NAME}' as a daemon via oxmgr\n`);
      process.stdout.write(`token: ${token}\n\n`);
      process.stdout.write(`  ay ls   ${token}@<host>:${DEFAULT_PORT}\n`);
      process.stdout.write(`  ay remote add <alias> http://${token}@<host>:${DEFAULT_PORT}\n`);
      process.stdout.write(`  ay serve logs                # view server logs\n`);
      process.stdout.write(`  ay serve uninstall           # remove daemon\n`);
    }
    return code ?? 1;
  }

  if (sub === "uninstall") {
    const proc = Bun.spawn([oxmgrBin, "delete", DAEMON_NAME], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    return (await proc.exited) ?? 1;
  }

  if (sub === "logs") {
    const proc = Bun.spawn([oxmgrBin, "logs", DAEMON_NAME, ...args], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    return (await proc.exited) ?? 1;
  }

  return 1;
}

// ---------------------------------------------------------------------------
// ay serve
// ---------------------------------------------------------------------------

export async function cmdServe(rest: string[]): Promise<number> {
  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(
      `Usage: ay serve [options]\n\n` +
        `Start an API server (HTTP and/or WebRTC) so browsers and remote machines\n` +
        `can list/tail/send agents.\n\n` +
        `Modes (default: --http):\n` +
        `  --http            HTTP API + web console on --port; no WebRTC\n` +
        `  --webrtc [URL]    Share over WebRTC (bare flag mints a room+link on\n` +
        `                    agent-yes.com, or pass webrtc://room:token@host).\n` +
        `                    Alone it needs NO port — combine with --http for both.\n` +
        `  --share [URL]     Legacy alias for --http --webrtc\n\n` +
        `Options:\n` +
        `  --port N          Port to listen on (default: ${DEFAULT_PORT})\n` +
        `  --host HOST       Interface to bind (default: 127.0.0.1; use 0.0.0.0 to expose)\n` +
        `  --token TOKEN     Auth token (auto-generated and saved if omitted)\n` +
        `  --allow-spawn     Deprecated no-op — the console can always spawn agents\n` +
        `  --tls-cert FILE   TLS certificate PEM\n` +
        `  --tls-key  FILE   TLS private key PEM\n\n` +
        `Subcommands:\n` +
        `  ay serve install    install as background daemon via oxmgr\n` +
        `  ay serve uninstall  remove daemon\n` +
        `  ay serve logs       view daemon logs\n\n` +
        `Once running, connect from another machine:\n` +
        `  ay ls   <token>@<host>:${DEFAULT_PORT}\n` +
        `  ay remote add <alias> http://<token>@<host>:${DEFAULT_PORT}\n`,
    );
    return 0;
  }

  // Daemon subcommands
  const sub = rest[0];
  if (sub === "install" || sub === "uninstall" || sub === "logs") {
    return cmdServeDaemon(sub, rest.slice(1));
  }

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
    .option("http", {
      type: "boolean",
      description: "Serve the HTTP API + web console on --port (default mode)",
    })
    .option("webrtc", {
      type: "string",
      description:
        "Share over WebRTC: bare flag mints a room+link, or pass webrtc://room:token@host. Needs no port unless combined with --http",
    })
    .option("share", {
      type: "string",
      description: "Legacy alias for --http --webrtc",
    })
    .option("allow-spawn", {
      type: "boolean",
      default: false,
      description: "Deprecated no-op — the console can always spawn agents",
    })
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

  // Modes: --http (HTTP listener + web console), --webrtc (port-free WebRTC
  // share), or both. Bare `ay serve` stays HTTP-only; --share keeps its old
  // meaning (HTTP + WebRTC) for existing invocations.
  const wantWebrtc = argv.webrtc !== undefined || argv.share !== undefined;
  const wantHttp = argv.http === true || argv.share !== undefined || argv.webrtc === undefined;

  if (wantHttp && host !== "127.0.0.1" && host !== "localhost") {
    process.stderr.write(
      "ay serve: warning: binding to non-loopback — ensure your network is trusted or use Tailscale/VPN\n",
    );
  }

  const token = await loadOrCreateToken(tokenFlag);
  // Spawning is always allowed: a connected console already has full read-write
  // control over every running agent (it writes straight to their stdin), so it
  // can already make an agent do anything — gating /api/spawn behind a flag or a
  // y/N prompt bought no real safety. We just log each spawn so the host sees it.
  // (--allow-spawn is still accepted as a no-op for older invocations.)

  // The whole API as a plain handler: served over HTTP by Bun.serve (--http)
  // and called in-process by the WebRTC bridge (--webrtc) — the latter needs
  // no TCP port at all.
  const apiFetch = async (req: Request): Promise<Response> => {
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

    // GET /api/size/:keyword — the agent's current PTY size, so the console can
    // render the existing buffer at the agent's real width before adapting.
    const sizeM = /^\/api\/size\/(.+)$/.exec(p);
    if (req.method === "GET" && sizeM) {
      const keyword = decodeURIComponent(sizeM[1]!);
      try {
        const record = await resolveOne(keyword, defaultOpts());
        const ayHome = process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes");
        let cols: number | null = null;
        let rows: number | null = null;
        try {
          const txt = await readFile(path.join(ayHome, "ptysize", String(record.pid)), "utf-8");
          const [c, r] = txt.trim().split(/\s+/).map(Number);
          if (c > 0 && r > 0) {
            cols = c;
            rows = r;
          }
        } catch {
          /* no ptysize sidecar (older agent or not yet written) */
        }
        return Response.json({ pid: record.pid, cols, rows });
      } catch (e) {
        return new Response((e as Error).message, { status: 404 });
      }
    }

    // GET /api/tail/:keyword  — SSE streaming
    const tailM = /^\/api\/tail\/(.+)$/.exec(p);
    if (req.method === "GET" && tailM) {
      const keyword = decodeURIComponent(tailM[1]!);
      // raw=1 streams the unmodified PTY bytes (ANSI/cursor control intact) so a
      // browser xterm.js can render the real terminal; default stays ANSI-stripped.
      const raw = url.searchParams.get("raw") === "1";
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

            // Initial tail. Raw: replay the last ~64 KB of PTY bytes (enough to
            // contain a recent full-screen redraw so xterm converges fast).
            const initBuf = await readFile(logPath).catch(() => Buffer.alloc(0));
            if (raw)
              send(new TextDecoder().decode(initBuf.slice(Math.max(0, initBuf.length - 65536))));
            else send(await renderRawLog(initBuf, { mode: "tail", n: 96 }));

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

            // Stream only the bytes appended since `offset` (incremental read,
            // not a full re-read), driven by fs.watch for near-instant echo with
            // a short fallback poll in case the watcher misses an event. The old
            // 300 ms full-file poll was the dominant typing-echo latency.
            const fh = await open(logPath, "r").catch(() => null);
            let reading = false;
            const flush = async () => {
              if (closed || reading || !fh) return;
              reading = true;
              try {
                const { size } = await fh.stat();
                if (size < offset) offset = size; // truncated/rotated
                if (size > offset) {
                  const len = size - offset;
                  const buf = Buffer.allocUnsafe(len);
                  const { bytesRead } = await fh.read(buf, 0, len, offset);
                  offset += bytesRead;
                  const chunk = buf.subarray(0, bytesRead);
                  if (raw) {
                    send(new TextDecoder().decode(chunk));
                  } else {
                    const text = new TextDecoder()
                      .decode(chunk)
                      .replace(ansiRe, "")
                      .replace(ctrlRe, "");
                    if (text.trim()) send(text.trimStart());
                  }
                }
              } catch {
                /* log gone */
              } finally {
                reading = false;
              }
            };

            let watcher: ReturnType<typeof watch> | null = null;
            try {
              watcher = watch(logPath, () => void flush());
            } catch {
              /* fs.watch unsupported — the fallback poll below still works */
            }
            const poller = setInterval(() => void flush(), 60);

            req.signal.addEventListener("abort", () => {
              closed = true;
              clearInterval(heartbeat);
              clearInterval(poller);
              try {
                watcher?.close();
              } catch {
                /* already closed */
              }
              void fh?.close().catch(() => {});
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

    // POST /api/resize/:keyword  body {cols, rows} — drive the agent's PTY size.
    // Mirrors `ay attach`: write ~/.agent-yes/winsize/<pid> then SIGWINCH; the
    // agent's resize listener picks it up and reflows its TUI to that width.
    const resizeM = /^\/api\/resize\/(.+)$/.exec(p);
    if (req.method === "POST" && resizeM) {
      const keyword = decodeURIComponent(resizeM[1]!);
      let body: { cols?: number; rows?: number };
      try {
        body = await req.json();
      } catch {
        return new Response("invalid JSON body", { status: 400 });
      }
      const cols = Math.max(1, Math.floor(Number(body.cols) || 0));
      const rows = Math.max(1, Math.floor(Number(body.rows) || 0));
      if (!cols || !rows) return new Response("missing cols/rows", { status: 400 });
      try {
        const record = await resolveOne(keyword, defaultOpts());
        const ayHome = process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes");
        const winsizeDir = path.join(ayHome, "winsize");
        await mkdir(winsizeDir, { recursive: true });
        await writeFile(
          path.join(winsizeDir, String(record.pid)),
          `${cols} ${rows} ${Date.now()}\n`,
        );
        try {
          process.kill(record.pid, "SIGWINCH");
        } catch {
          /* agent gone */
        }
        return Response.json({ ok: true, pid: record.pid, cols, rows });
      } catch (e) {
        return new Response((e as Error).message, { status: 404 });
      }
    }

    // POST /api/spawn  body {cli, cwd, prompt} — launch a new agent
    if (req.method === "POST" && p === "/api/spawn") {
      let body: { cli?: string; cwd?: string; prompt?: string };
      try {
        body = await req.json();
      } catch {
        return new Response("invalid JSON body", { status: 400 });
      }
      const cli = String(body.cli ?? "claude");
      if (!SUPPORTED_CLIS.includes(cli as never))
        return new Response(`unsupported cli: ${cli}`, { status: 400 });
      const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd();
      const prompt = String(body.prompt ?? "");
      process.stderr.write(
        `→ console spawned:  ay ${cli}${prompt ? ` -- "${prompt.slice(0, 60)}"` : ""}  (cwd: ${cwd})\n`,
      );
      try {
        const child = Bun.spawn(["ay", cli, ...(prompt ? ["--", prompt] : [])], {
          cwd,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        child.unref();
        return Response.json({ ok: true, pid: child.pid, cli, cwd });
      } catch (e) {
        return new Response((e as Error).message, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  };

  // Web console: the lab UI served straight from the package, so --http needs
  // no separate proxy and no agent-yes.com. Static routes are unauthenticated
  // (the page holds no secrets); the page carries the token via the #k= link
  // and sends it on every /api call.
  const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lab", "ui");
  const serveUiFile = async (name: string, type: string): Promise<Response> => {
    try {
      const buf = await readFile(path.join(uiDir, name));
      return new Response(buf, { headers: { "Content-Type": type } });
    } catch {
      return new Response("UI assets not found in this install — use the /api endpoints", {
        status: 404,
      });
    }
  };
  const httpFetch = async (req: Request): Promise<Response> => {
    const p = new URL(req.url).pathname;
    if (req.method === "GET" && (p === "/" || p === "/index.html"))
      return serveUiFile("index.html", "text/html; charset=utf-8");
    if (req.method === "GET" && p === "/room-client.js")
      return serveUiFile("room-client.js", "text/javascript; charset=utf-8");
    return apiFetch(req);
  };

  const serverOpts: any = {
    hostname: host,
    port,
    idleTimeout: 0, // never time out SSE/tail streams
    fetch: httpFetch,
  };
  if (useHttps) {
    serverOpts.tls = { cert: Bun.file(certPath!), key: Bun.file(keyPath!) };
  }

  let server: ReturnType<typeof Bun.serve> | null = null;
  if (wantHttp) {
    try {
      server = Bun.serve(serverOpts);
    } catch (e) {
      if ((e as { code?: string }).code === "EADDRINUSE") {
        process.stderr.write(
          `ay serve: port ${port} is already in use — pick another with --port N,\n` +
            `or run a port-free WebRTC-only share with: ay serve --webrtc\n`,
        );
        return 1;
      }
      throw e;
    }

    const uiHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    process.stdout.write(`ay serve  ${scheme}://${host}:${port}\n`);
    process.stdout.write(`token:    ${token}\n\n`);
    process.stdout.write(`web console (token in the # is eaten on open):\n`);
    process.stdout.write(`  ${scheme}://${uiHost}:${port}/#k=${token}\n\n`);
    process.stdout.write(`connect from another machine:\n`);
    process.stdout.write(`  ay ls   ${token}@<host>:${port}\n`);
    process.stdout.write(`  ay tail ${token}@<host>:${port}:<keyword>\n`);
    process.stdout.write(`  ay send ${token}@<host>:${port}:<keyword> "message"\n\n`);
    process.stdout.write(`save as alias:\n`);
    process.stdout.write(`  ay remote add <alias> ${scheme}://${token}@<host>:${port}\n\n`);
    if (!useHttps) {
      process.stdout.write(
        `for HTTPS: ay serve --tls-cert cert.pem --tls-key key.pem\n` +
          `  openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj '/CN=localhost'\n\n`,
      );
    }
  }

  // --webrtc / --share: bridge to a WebRTC room so the agent-yes.com console
  // can reach this machine peer-to-peer. The bridge calls apiFetch in-process,
  // so without --http no port is opened at all. Bare flag mints a room; a
  // webrtc:// value joins an explicit one.
  if (wantWebrtc) {
    const webrtcVal = (argv.webrtc ?? argv.share) as string | undefined;
    const shareUrl =
      typeof webrtcVal === "string" && webrtcVal.startsWith("webrtc://") ? webrtcVal : undefined;
    try {
      const { startShare } = await import("./share.ts");
      const { link } = await startShare({
        url: shareUrl,
        localFetch: apiFetch,
        apiToken: token,
      });
      process.stdout.write(
        `${wantHttp ? "\n" : ""}shared over WebRTC — open this link (the token is eaten from the URL on open):\n  ${link}\n\n`,
      );
    } catch (e) {
      process.stderr.write(`ay serve --webrtc failed: ${(e as Error).message}\n`);
      if (!wantHttp) return 1; // nothing else is running
    }
  }

  process.stdout.write(`(Ctrl-C to stop)\n`);

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      server?.stop();
      resolve();
    });
    process.on("SIGTERM", () => {
      server?.stop();
      resolve();
    });
  });

  return 0;
}
