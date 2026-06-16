import { mkdir, open, readFile, writeFile } from "fs/promises";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { homedir, hostname, userInfo } from "os";
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
import { getInstalledPackage } from "./versionChecker.ts";

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

// Read the serve token WITHOUT creating one — `ay serve status` must be a pure
// read (creating a token as a side effect of asking "is it running?" is wrong).
async function loadTokenReadOnly(): Promise<string | null> {
  try {
    return (await readFile(tokenPath(), "utf-8")).trim();
  } catch {
    return null;
  }
}

// The persisted WebRTC share link (mode 0600), written by a --share/--webrtc
// daemon so the secret-bearing link survives restarts. null if not sharing.
async function readShareLink(): Promise<string | null> {
  try {
    return (await readFile(path.join(agentYesHome(), ".share-link"), "utf-8")).trim();
  } catch {
    return null;
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

// The vars that pin a process to a PARENT Claude Code session — NOT the many
// other CLAUDE_CODE_* settings that configure provider/auth/limits (USE_BEDROCK,
// USE_VERTEX, MAX_OUTPUT_TOKENS, …), which must pass through untouched.
const SESSION_PIN_ENV = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
]);

// Env for a console-spawned agent, minus only the session-pinning vars above. If
// `ay serve` was launched from inside Claude Code (or any shell carrying these),
// it would otherwise leak the parent's SSE port / session id into every spawned
// agent — so the new `claude` thinks it's a nested child and tries to attach to a
// stale port, surfacing as "fail to connect". Dropping them makes each agent a
// clean top-level session; all config/provider env (CLAUDE_EFFORT, CLAUDE_CODE_*
// settings) is preserved.
function freshAgentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || SESSION_PIN_ENV.has(k)) continue;
    env[k] = v;
  }
  return env;
}

// ---------------------------------------------------------------------------
// ay serve install / uninstall / logs  (oxmgr daemon management)
// ---------------------------------------------------------------------------

const DAEMON_NAME = "agent-yes";

type DaemonManager = { id: "oxmgr" | "pm2"; bin: string };

// Pick the process manager used to daemonize `ay serve`. oxmgr's daemon talks
// over a fixed TCP port; on Windows a crashed daemon routinely leaves the
// socket orphaned on a dead PID, which wedges every subsequent oxmgr command
// with "daemon did not become ready in time". pm2's named-pipe daemon does not
// have that failure mode, so we prefer pm2 on Windows. Elsewhere oxmgr stays
// the default. AGENT_YES_DAEMON_MANAGER=pm2|oxmgr forces a choice.
function resolveDaemonManager(): DaemonManager | null {
  const oxmgr = Bun.which("oxmgr");
  const pm2 = Bun.which("pm2");
  const override = process.env.AGENT_YES_DAEMON_MANAGER?.toLowerCase();
  if (override === "pm2") return pm2 ? { id: "pm2", bin: pm2 } : null;
  if (override === "oxmgr") return oxmgr ? { id: "oxmgr", bin: oxmgr } : null;
  const order: Array<DaemonManager | null> =
    process.platform === "win32"
      ? [pm2 && { id: "pm2", bin: pm2 }, oxmgr && { id: "oxmgr", bin: oxmgr }]
      : [oxmgr && { id: "oxmgr", bin: oxmgr }, pm2 && { id: "pm2", bin: pm2 }];
  return order.find((m): m is DaemonManager => !!m) ?? null;
}

// Resolve the argv that launches `ay serve …` from the daemon. The daemon's
// environment may not have ~/.bun/bin on PATH, so we use an absolute path.
// On Windows the `ay` bin is a self-contained launcher (ay.exe) we exec
// directly; on POSIX it's a `#!/usr/bin/env bun` script we run through bun.
function ayServeArgv(args: string[]): string[] {
  const ayBin = Bun.which("ay");
  const launcher = ayBin
    ? process.platform === "win32"
      ? [ayBin]
      : [process.execPath, ayBin]
    : ["ay"];
  return [...launcher, "serve", ...args];
}

// Per-user login auto-start entry on Windows. pm2 core has no Windows startup
// integration (`pm2 startup` errors "Init system not found"), so we register a
// HKCU Run value that runs `pm2 resurrect` at login — no admin, removed on
// uninstall. HKCU (not HKLM) keeps it user-scoped and admin-free.
const WIN_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WIN_RUN_VALUE = DAEMON_NAME;

// Register the daemon to come up automatically. The *scope* is per-platform by
// design: Linux → at system boot (before login); macOS/Windows → at user login.
//   - Linux (oxmgr): `oxmgr service install` wires a systemd **--user** unit,
//     which on its own only starts after the user logs in. To make it start at
//     boot without requiring root (no system-scope unit, no sudo), we also
//     `loginctl enable-linger`, which keeps the user's systemd instance — and
//     thus our service — running from boot. Best-effort; linger failing just
//     downgrades us to login-scope.
//   - Windows (pm2): pm2 core can't install a startup hook here, so we save the
//     process list and add a HKCU Run entry that runs `pm2 resurrect` at login.
//   - macOS (pm2): `pm2 startup` wires a launchd agent (best-effort).
// Idempotent and best-effort: returns false on failure without aborting the
// install — the process is still crash-managed, just not boot/login-persistent.
async function ensureBootAutostart(mgr: DaemonManager): Promise<boolean> {
  try {
    if (mgr.id === "oxmgr") {
      // Skip `service install` when the service is ALREADY registered: re-running
      // it re-bootstraps the oxmgr daemon, which restarts every managed process —
      // it once took down a VS Code serve-web session on each `ay serve install`.
      // `oxmgr service status` exits 0 only when already installed.
      // oxmgr's --system defaults to "auto" (launchd/systemd/Task Scheduler); it's
      // a `service`-level flag, so it goes before the subcommand, not after.
      const installed =
        (await spawnExit([mgr.bin, "service", "status"])) === 0 ||
        (await spawnExit([mgr.bin, "service", "install"])) === 0;
      if (installed && process.platform === "linux") {
        // Upgrade login-scope → boot-scope: linger starts the user manager at boot.
        await spawnExit(["loginctl", "enable-linger", userInfo().username]);
      }
      return installed;
    }
    // pm2: persist the current process list first — boot/login resurrect reads it.
    if ((await spawnExit([mgr.bin, "save"])) !== 0) return false;
    if (process.platform === "win32") {
      // pm2 has no Windows startup integration — add a HKCU Run entry ourselves.
      const data = mgr.bin.includes(" ") ? `"${mgr.bin}" resurrect` : `${mgr.bin} resurrect`;
      return (
        (await spawnExit([
          "reg",
          "add",
          WIN_RUN_KEY,
          "/v",
          WIN_RUN_VALUE,
          "/t",
          "REG_SZ",
          "/d",
          data,
          "/f",
        ])) === 0
      );
    }
    // macOS (and any non-Windows pm2 install): pm2 startup wires the init script
    // (may need sudo; best-effort).
    return (await spawnExit([mgr.bin, "startup"])) === 0;
  } catch {
    return false;
  }
}

async function spawnExit(cmd: string[]): Promise<number> {
  try {
    return (await Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] }).exited) ?? 1;
  } catch {
    return 1;
  }
}

// The `serve` args the running daemon was started with, so a bare
// `ay serve install` can re-launch with the SAME args. null when no daemon is
// registered. oxmgr stores the full command line (`… ay serve --share`); pm2
// keeps the post-`--` argv in pm2_env.args (with a leading "serve" we strip).
async function readDaemonServeArgs(mgr: DaemonManager): Promise<string[] | null> {
  try {
    if (mgr.id === "oxmgr") {
      const p = Bun.spawn([mgr.bin, "status", DAEMON_NAME], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(p.stdout).text();
      if ((await p.exited) !== 0) return null;
      const m = /Command:\s*(.+)/.exec(out);
      if (!m) return null;
      const after = /\bserve\b\s*(.*)$/.exec(m[1]!.trim());
      return after ? after[1]!.split(/\s+/).filter(Boolean) : [];
    }
    const p = Bun.spawn([mgr.bin, "jlist"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return null;
    const list = JSON.parse(out) as Array<{ name?: string; pm2_env?: { args?: string[] } }>;
    const proc = list.find((x) => x.name === DAEMON_NAME);
    if (!proc) return null;
    const a = proc.pm2_env?.args ?? [];
    return a[0] === "serve" ? a.slice(1) : a;
  } catch {
    return null;
  }
}

function portFromArgs(args: string[]): number {
  const m = /--port[=\s](\d+)/.exec(args.join(" "));
  return m ? Number(m[1]) : DEFAULT_PORT;
}

// Ask the live daemon its version over the local HTTP API. null if it's not
// listening (webrtc-only) or too old to expose /api/version — both of which we
// treat as "outdated" so a re-install rolls it forward.
async function fetchDaemonVersion(port: number, token: string): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/version`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    return ((await r.json()) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

async function cmdServeDaemon(sub: string, args: string[]): Promise<number> {
  const mgr = resolveDaemonManager();
  if (!mgr) {
    process.stderr.write(
      "ay serve install: no process manager found (need pm2 or oxmgr)\n" +
        "  install with:  bun add -g pm2\n" +
        "             or: cargo install oxmgr\n",
    );
    return 1;
  }

  if (sub === "install") {
    const token = await loadOrCreateToken(undefined);

    // Re-running install rolls a stale daemon forward: reuse the args it was
    // started with (so a bare `ay serve install` stays "the same daemon"), unless
    // new args are given. The persisted room + token mean the share link is
    // unchanged across the restart.
    const priorArgs = await readDaemonServeArgs(mgr);
    const effArgs = args.length ? args : (priorArgs ?? []);
    const current = getInstalledPackage().version;

    if (priorArgs !== null) {
      // A daemon already exists — only disturb it if it's actually outdated.
      const runningVer = await fetchDaemonVersion(portFromArgs(effArgs), token);
      if (runningVer === current) {
        await ensureBootAutostart(mgr);
        process.stdout.write(`'${DAEMON_NAME}' already running v${current} (up to date)\n`);
        return 0;
      }
      // Outdated (or unreachable/too-old to report) → graceful roll-forward.
      // `stop` sends SIGTERM, which cmdServe handles cleanly (closing share
      // peers so browsers reconnect fast), then we re-create with the new binary.
      process.stdout.write(
        `rolling '${DAEMON_NAME}' ${runningVer ? `v${runningVer}` : "(unknown)"} → v${current}…\n`,
      );
      await spawnExit([mgr.bin, "stop", DAEMON_NAME]);
      await spawnExit([mgr.bin, "delete", DAEMON_NAME]);
    }

    // oxmgr takes the command as one string; pm2 takes the binary plus its
    // args after `--`. Both auto-restart on crash by default (pm2) / via the
    // explicit flag (oxmgr).
    const serveArgv = ayServeArgv(effArgs);
    const startArgv =
      mgr.id === "oxmgr"
        ? [mgr.bin, "start", serveArgv.join(" "), "--name", DAEMON_NAME, "--restart", "always"]
        : [
            mgr.bin,
            "start",
            serveArgv[0]!,
            "--name",
            DAEMON_NAME,
            "--interpreter",
            "none",
            "--",
            ...serveArgv.slice(1),
          ];
    const proc = Bun.spawn(startArgv, { stdio: ["ignore", "inherit", "inherit"] });
    const code = await proc.exited;
    if (code === 0) {
      const onBoot = await ensureBootAutostart(mgr);
      const port = portFromArgs(effArgs);
      // Mirror cmdServe's mode resolution: webrtc-only daemons open no HTTP port.
      const webrtcish = effArgs.some((a) => a.startsWith("--webrtc") || a.startsWith("--share"));
      const httpish =
        effArgs.some((a) => a.startsWith("--http") || a.startsWith("--share")) ||
        !effArgs.some((a) => a.startsWith("--webrtc"));
      process.stdout.write(
        `\n${priorArgs !== null ? `rolled '${DAEMON_NAME}' forward to` : `installed '${DAEMON_NAME}' as a daemon via ${mgr.id} —`} v${current}\n`,
      );
      if (mgr.id === "oxmgr")
        process.stdout.write(
          onBoot
            ? `start-on-boot: enabled (systemd --user + linger, starts at boot)\n`
            : `start-on-boot: not registered — needs a user systemd session; run \`oxmgr service install\` to enable\n`,
        );
      else if (process.platform === "win32")
        process.stdout.write(
          onBoot
            ? `start-on-login: enabled (a HKCU Run entry runs \`pm2 resurrect\`)\n`
            : `start-on-login: not registered — \`pm2 save\` or the registry write failed\n`,
        );
      else
        process.stdout.write(
          onBoot
            ? `start-on-boot: enabled (pm2 startup registered with the system init)\n`
            : `start-on-boot: not registered — run \`pm2 startup\` (may need sudo) to enable\n`,
        );
      process.stdout.write(`token: ${token}\n\n`);
      if (httpish) {
        process.stdout.write(`  ay ls   ${token}@<host>:${port}\n`);
        process.stdout.write(`  ay remote add <alias> http://${token}@<host>:${port}\n`);
      }
      process.stdout.write(`  ay serve logs                # view server logs\n`);
      process.stdout.write(`  ay serve uninstall           # remove daemon\n`);
      if (webrtcish) {
        process.stdout.write(
          `\nthe WebRTC share link carries a secret, so the daemon does NOT log it —\n` +
            `read it from ~/.agent-yes/.share-link (mode 0600). The room persists in\n` +
            `~/.agent-yes/.share-room, so the link survives restarts.\n`,
        );
      }
    }
    return code ?? 1;
  }

  if (sub === "uninstall") {
    const proc = Bun.spawn([mgr.bin, "delete", DAEMON_NAME], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    const code = (await proc.exited) ?? 1;
    if (mgr.id === "pm2" && code === 0) {
      // Drop it from the persisted pm2 list too, so `pm2 resurrect` won't revive it.
      await spawnExit([mgr.bin, "save"]);
      // Remove the Windows login auto-start entry we added at install time.
      if (process.platform === "win32")
        await spawnExit(["reg", "delete", WIN_RUN_KEY, "/v", WIN_RUN_VALUE, "/f"]);
    }
    return code;
  }

  if (sub === "logs") {
    const proc = Bun.spawn([mgr.bin, "logs", DAEMON_NAME, ...args], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    return (await proc.exited) ?? 1;
  }

  return 1;
}

// ay serve status — report whether the server is installed as a daemon and/or
// currently reachable, plus its mode, port, version, token, and share link.
// Read-only: never mints a token or disturbs the daemon. `--json` for scripts.
async function cmdServeStatus(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const mgr = resolveDaemonManager();
  const token = await loadTokenReadOnly();
  const shareLink = await readShareLink();

  // A non-null arg list means the daemon is registered with the manager.
  const daemonArgs = mgr ? await readDaemonServeArgs(mgr) : null;
  const installed = daemonArgs !== null;
  const a = daemonArgs ?? [];
  const port = portFromArgs(a);
  // Mirror cmdServe/install mode resolution: webrtc when --webrtc/--share; http
  // when --http/--share OR no --webrtc at all (http is the implicit default).
  const webrtcish = a.some((x) => x.startsWith("--webrtc") || x.startsWith("--share"));
  const httpish =
    a.some((x) => x.startsWith("--http") || x.startsWith("--share")) ||
    !a.some((x) => x.startsWith("--webrtc"));
  const mode = httpish && webrtcish ? "http+webrtc" : webrtcish ? "webrtc" : "http";

  // Probe the local HTTP API — catches both a daemon and a foreground `ay serve`.
  // Webrtc-only servers open no port, so a null probe there is expected, not down.
  const runningVersion = httpish && token ? await fetchDaemonVersion(port, token) : null;
  const current = getInstalledPackage().version;

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          manager: mgr?.id ?? null,
          installed,
          mode,
          port: httpish ? port : null,
          reachable: runningVersion !== null,
          runningVersion,
          currentVersion: current,
          upToDate: runningVersion !== null && runningVersion === current,
          args: a,
          hasToken: !!token,
          shareLink,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  const w = (s = "") => process.stdout.write(s + "\n");
  w(`daemon name:  ${DAEMON_NAME}`);
  w(`manager:      ${mgr ? mgr.id : "none — install pm2 or oxmgr to daemonize"}`);
  if (installed) {
    w(`installed:    yes (via ${mgr!.id})`);
    w(`mode:         ${mode}${httpish ? `  (port ${port})` : ""}`);
    if (a.length) w(`args:         ${a.join(" ")}`);
  } else {
    w(`installed:    no — start a daemon with:  ay serve install [--share]`);
  }
  if (runningVersion !== null) {
    const tag = runningVersion === current ? "up to date" : `outdated (current v${current})`;
    w(`http api:     reachable on 127.0.0.1:${port} — v${runningVersion} (${tag})`);
  } else if (mode === "webrtc") {
    w(`http api:     none (webrtc-only)`);
  } else {
    w(`http api:     not reachable on 127.0.0.1:${port} (not running)`);
  }
  w(`token:        ${token ?? "(none yet — created on first serve)"}`);
  if (shareLink) w(`share link:   ${shareLink}`);
  if (token && httpish) {
    w();
    w(`connect:  ay ls   ${token}@<host>:${port}`);
    w(`          ay remote add <alias> http://${token}@<host>:${port}`);
  }
  return 0;
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
        `                    The minted room persists in ~/.agent-yes/.share-room\n` +
        `                    (stable link across restarts; delete the file to rotate).\n` +
        `  --share [URL]     Legacy alias for --http --webrtc\n\n` +
        `Options:\n` +
        `  --port N          Port to listen on (default: ${DEFAULT_PORT})\n` +
        `  --host HOST       Interface to bind (default: 127.0.0.1; use 0.0.0.0 to expose)\n` +
        `  --token TOKEN     Auth token (auto-generated and saved if omitted)\n` +
        `  -d, --daemon      Install these flags as a background daemon (pm2/oxmgr)\n` +
        `                    (same as: ay serve install <flags>)\n` +
        `  --allow-spawn     Deprecated no-op — the console can always spawn agents\n` +
        `  --tls-cert FILE   TLS certificate PEM\n` +
        `  --tls-key  FILE   TLS private key PEM\n\n` +
        `Subcommands:\n` +
        `  ay serve install    install as background daemon (pm2 on Windows, else oxmgr)\n` +
        `  ay serve status     show daemon/server status (add --json for scripts)\n` +
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
  if (sub === "status") return cmdServeStatus(rest.slice(1));
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
    .option("daemon", {
      alias: "d",
      type: "boolean",
      default: false,
      description: "Install as a background daemon (same as: ay serve install <flags>)",
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

  // --daemon/-d: install these exact flags as the background daemon instead of
  // serving in the foreground (sugar for `ay serve install <flags>`).
  if (argv.daemon) {
    const fwd = rest.filter((a) => a !== "--daemon" && a !== "-d");
    return cmdServeDaemon("install", fwd);
  }

  // `ay serve` takes only flags (plus the install/uninstall/logs subcommands
  // handled above). A bare word like `ay serve share` is silently dropped into
  // argv._ by yargs and would otherwise start in the wrong mode — most often
  // it's a typo for the `--share` flag — so warn instead of quietly ignoring it.
  const stray = (argv._ as Array<string | number>).map(String);
  if (stray.length) {
    const hint = stray.includes("share") ? " (did you mean --share?)" : "";
    process.stderr.write(
      `ay serve: ignoring unknown argument${stray.length > 1 ? "s" : ""}: ${stray.join(" ")}${hint}\n`,
    );
  }

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

  // Agents retitle their terminal by writing OSC 0/2 (\x1b]2;name\x07) into the
  // PTY stream we log; surfacing the most recent one lets the console label list
  // rows without streaming every log. Cached per (size, mtime) — the UI polls
  // /api/ls every few seconds and exited agents' logs never change again.
  const titleCache = new Map<string, { size: number; mtimeMs: number; title: string | null }>();
  const logTitle = async (logFile: string | null | undefined): Promise<string | null> => {
    if (!logFile) return null;
    try {
      const fh = await open(logFile, "r");
      try {
        const { size, mtimeMs } = await fh.stat();
        const hit = titleCache.get(logFile);
        if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.title;
        const len = Math.min(size, 65536);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, size - len);
        const text = buf.toString("utf-8", 0, bytesRead);
        // eslint-disable-next-line no-control-regex
        const oscTitleRe = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
        let title: string | null = null;
        for (let m; (m = oscTitleRe.exec(text)); ) if (m[1]!.trim()) title = m[1]!.trim();
        titleCache.set(logFile, { size, mtimeMs, title });
        return title;
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  };

  // Per-cwd git snapshot for the list: branch + dirty/changed count + ahead/behind
  // vs upstream, all from a single `git status --porcelain --branch`. Cached per
  // cwd with a short TTL so the 1s subscribe tick (and /api/ls polls) spawn at most
  // one git per repo every few seconds — agents sharing a cwd share the result.
  // Non-git dirs, errors, and timeouts cache as null.
  interface GitInfo {
    branch: string | null;
    dirty: boolean;
    changed: number;
    ahead: number;
    behind: number;
  }
  const GIT_TTL_MS = 5000;
  const gitCache = new Map<string, { at: number; val: GitInfo | null }>();
  const gitStatus = async (cwd: string | null | undefined): Promise<GitInfo | null> => {
    if (!cwd) return null;
    const now = Date.now();
    const hit = gitCache.get(cwd);
    if (hit && now - hit.at < GIT_TTL_MS) return hit.val;
    let val: GitInfo | null = null;
    try {
      const proc = Bun.spawn(["git", "status", "--porcelain", "--branch"], {
        cwd,
        stdout: "pipe",
        stderr: "ignore",
        signal: AbortSignal.timeout(2000),
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      if (proc.exitCode === 0) {
        const lines = out.split("\n");
        // Branch header, e.g. "## main...origin/main [ahead 1, behind 2]",
        // "## main" (no upstream), "## HEAD (no branch)", or "## No commits yet on x".
        const h = /^## (.+)$/.exec(lines[0] ?? "")?.[1] ?? "";
        const unborn = /^No commits yet on (.+)$/.exec(h);
        const branch = unborn ? unborn[1]! : /^(.+?)(?:\.\.\.|\s|$)/.exec(h)?.[1] || null;
        const ahead = Number(/\bahead (\d+)/.exec(h)?.[1] ?? 0);
        const behind = Number(/\bbehind (\d+)/.exec(h)?.[1] ?? 0);
        const changed = lines.slice(1).filter((l) => l.trim().length > 0).length;
        val = { branch, dirty: changed > 0, changed, ahead, behind };
      }
    } catch {
      val = null; // git missing, not a repo, or timed out
    }
    gitCache.set(cwd, { at: now, val });
    return val;
  };

  // One agent record decorated for the console: the latest OSC title + a git
  // snapshot (skipped for exited agents — their repo state is no longer live).
  const withMeta = async (r: Awaited<ReturnType<typeof listRecords>>[number]) => ({
    ...r,
    title: await logTitle(r.log_file),
    git: r.status === "exited" ? null : await gitStatus(r.cwd),
  });

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
        return Response.json(await Promise.all(records.map(withMeta)));
      } catch (e) {
        return new Response((e as Error).message, { status: 500 });
      }
    }

    // GET /api/ls/subscribe — SSE: throttled live deltas of the agent list.
    // The console used to re-poll /api/ls every 3s; this streams the SAME records
    // (incl. each agent's OSC title) but only what CHANGED since the last tick, so
    // an idle fleet costs ~nothing on the wire. The first event is a full snapshot
    // ({ full:true, upsert:[all] }); each later event carries { upsert:[changed
    // records], remove:[gone pids] }. listRecords is a couple of JSONL reads and
    // logTitle is cached by (size,mtime), so the 1s tick stays cheap.
    if (req.method === "GET" && p === "/api/ls/subscribe") {
      const keyword = url.searchParams.get("keyword") ?? undefined;
      const opts = defaultOpts({
        all: url.searchParams.get("all") === "1",
        active: url.searchParams.get("active") === "1",
      });
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(ctrl) {
          let closed = false;
          const send = (obj: unknown) => {
            try {
              ctrl.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
            } catch {
              /* stream already closed */
            }
          };
          // pid -> JSON of the last record we sent, for cheap change detection.
          const sent = new Map<number, string>();
          const compute = async () => {
            const records = await listRecords(keyword, opts);
            return Promise.all(records.map(withMeta));
          };
          const tick = async (first: boolean) => {
            if (closed) return;
            // Transient read error → skip this tick, retry on the next.
            const list = await compute().catch(() => null);
            if (!list) return;
            const upsert: typeof list = [];
            const seen = new Set<number>();
            for (const r of list) {
              seen.add(r.pid);
              const j = JSON.stringify(r);
              if (sent.get(r.pid) !== j) {
                upsert.push(r);
                sent.set(r.pid, j);
              }
            }
            const remove: number[] = [];
            for (const pid of sent.keys())
              if (!seen.has(pid)) {
                remove.push(pid);
                sent.delete(pid);
              }
            if (first) send({ full: true, upsert: list, remove: [] });
            else if (upsert.length || remove.length) send({ upsert, remove });
          };

          await tick(true);
          const timer = setInterval(() => void tick(false), 1000);
          const heartbeat = setInterval(() => {
            try {
              ctrl.enqueue(enc.encode(": ping\n\n"));
            } catch {
              /* closed */
            }
          }, 15_000);
          req.signal.addEventListener("abort", () => {
            closed = true;
            clearInterval(timer);
            clearInterval(heartbeat);
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
    }

    // GET /api/whoami — this host's device label (user@host), so a remote
    // console can tag each agent with the machine it came from. Unlike codehost,
    // `ay serve --share` carries no per-agent device id; the viewer fetches this
    // once per room and stamps it. os.userInfo()/hostname() are cross-platform
    // (Windows included), so every machine reports a name, not just Unix ones.
    if (req.method === "GET" && p === "/api/whoami") {
      let user = "";
      try {
        user = userInfo().username;
      } catch {
        /* userInfo throws if there's no passwd entry (some containers) */
      }
      const host = hostname();
      return Response.json({ host: user ? `${user}@${host}` : host });
    }

    // GET /api/version — the running daemon's package version, so a re-run of
    // `ay serve install` can tell whether the live daemon is stale and roll it
    // forward. A daemon too old to expose this just 404s → treated as outdated.
    if (req.method === "GET" && p === "/api/version") {
      return Response.json({ version: getInstalledPackage().version });
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
          const [c = 0, r = 0] = txt.trim().split(/\s+/).map(Number);
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
        body = (await req.json()) as typeof body;
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
        body = (await req.json()) as typeof body;
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
        body = (await req.json()) as typeof body;
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
      // Resolve `ay` to an absolute command. The detached daemon (oxmgr/launchd/
      // pm2) usually has a PATH WITHOUT ~/.bun/bin, so a bare "ay" fails with
      // "Executable not found in $PATH: ay". Prefer PATH; fall back to re-running
      // THIS process's own ay entry (process.argv[1]) — always present, since the
      // daemon is itself an `ay serve`.
      const ayBin = Bun.which("ay") ?? process.argv[1];
      const ayCmd =
        process.platform === "win32" && ayBin.toLowerCase().endsWith(".exe")
          ? [ayBin]
          : [process.execPath, ayBin];
      try {
        const child = Bun.spawn([...ayCmd, cli, ...(prompt ? ["--", prompt] : [])], {
          cwd,
          env: freshAgentEnv(), // don't leak our Claude Code session into the agent
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
    if (req.method === "GET" && p === "/console-logic.js")
      return serveUiFile("console-logic.js", "text/javascript; charset=utf-8");
    if (req.method === "GET" && p === "/e2e.js")
      return serveUiFile("e2e.js", "text/javascript; charset=utf-8");
    if (req.method === "GET" && p === "/favicon.ico") return new Response(null, { status: 204 });
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
  let closeShare: (() => void) | undefined; // closes WebRTC peers on shutdown
  if (wantWebrtc) {
    const webrtcVal = (argv.webrtc ?? argv.share) as string | undefined;
    const explicitUrl =
      typeof webrtcVal === "string" && webrtcVal.startsWith("webrtc://") ? webrtcVal : undefined;
    try {
      const { startShare, loadOrCreateShareRoom } = await import("./share.ts");
      const linkFile = path.join(
        process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes"),
        ".share-link",
      );
      // Announce the link — reused for the initial share and for any auto-rotation
      // (when the signaling server rejects a stale persisted room).
      const announce = async (room: string, link: string, rotated: boolean) => {
        const lead = rotated
          ? "the room was rejected by signaling (stale generation) — rotated to a fresh link"
          : "shared over WebRTC — open this link (the token is eaten from the URL on open)";
        if (process.stdout.isTTY) {
          const persistNote = explicitUrl
            ? "\n"
            : `  (persistent room — same link across restarts; delete ~/.agent-yes/.share-room to rotate)\n\n`;
          process.stdout.write(`${wantHttp ? "\n" : ""}${lead}:\n  ${link}\n` + persistNote);
        } else {
          // Non-TTY (daemon/journal/CI): the link embeds the room secret S, so never
          // write it to a log stream. Stash it in a 0600 file and point there instead.
          try {
            await writeFile(linkFile, link + "\n", { mode: 0o600 });
          } catch {
            /* best effort */
          }
          process.stdout.write(
            `${wantHttp ? "\n" : ""}${rotated ? "rotated WebRTC room" : "shared over WebRTC"} · room ${room} — the link carries a secret, so it is NOT logged.\n` +
              `  read it from ${linkFile} (mode 0600); delete ~/.agent-yes/.share-room to rotate\n\n`,
          );
        }
      };
      // No explicit webrtc:// URL → reuse the persisted room (minted once and
      // saved like the serve token), so the link is stable across restarts.
      // Only the persisted path may auto-rotate (onRotate set); an explicit URL
      // is the operator's choice and must not be silently changed.
      const { room, link, close } = await startShare({
        url: explicitUrl ?? (await loadOrCreateShareRoom()),
        localFetch: apiFetch,
        apiToken: token,
        onRotate: explicitUrl ? undefined : (info) => announce(info.room, info.link, true),
      });
      closeShare = close;
      await announce(room, link, false);
    } catch (e) {
      process.stderr.write(`ay serve --webrtc failed: ${(e as Error).message}\n`);
      if (!wantHttp) return 1; // nothing else is running
    }
  }

  process.stdout.write(`(Ctrl-C to stop)\n`);

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      closeShare?.();
      server?.stop();
      resolve();
    });
    process.on("SIGTERM", () => {
      closeShare?.();
      server?.stop();
      resolve();
    });
  });

  return 0;
}
