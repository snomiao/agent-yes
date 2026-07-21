import { appendFile, mkdir, open, readFile, stat, unlink, writeFile } from "fs/promises";
import { existsSync, renameSync, watch, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import {
  arch,
  cpus,
  freemem,
  homedir,
  hostname,
  loadavg,
  platform,
  totalmem,
  uptime,
  userInfo,
} from "os";
import path from "path";
import yargs from "yargs";
import {
  controlCodeFromName,
  deriveLiveStatus,
  extractBadges,
  extractNeedsInput,
  extractTaskCounts,
  isUserTyping,
  listRecords,
  readNotes,
  readPtysize,
  recentMessageEdges,
  recentReadEdges,
  renderLogTailLines,
  renderRawLog,
  renderRawLogLines,
  resolveOne,
  snapshotStatus,
  writeToIpc,
  type CommonOpts,
} from "./subcommands.ts";
import { TYPING_BADGE } from "./badges.ts";
import { isTerminalReply } from "./terminalReply.ts";
import { parseStatusText } from "./statusText.ts";
import { ensureNodeRuntime, liveEnv } from "./nodeRuntime.ts";
import { acquireWebrtcHostLock, type ServeLockOwner } from "./serveLock.ts";
import { type MailParty, recordInbox } from "./messageLog.ts";
import { updateGlobalPidStatus } from "./globalPidIndex.ts";
import { spawnRejectionReason } from "./spawnGate.ts";
import { findSpawnHiddenLauncher } from "./rustBinary.ts";
import { pgidForWrapper } from "./reaper.ts";
import { SUPPORTED_CLIS } from "./SUPPORTED_CLIS.ts";
import { getInstalledPackage } from "./versionChecker.ts";
import { negotiateSize, sanitizeCap, type SizeCap } from "./sizeNego.ts";
import { listStrayServeProcesses } from "./strayServe.ts";
import {
  getProvisionHook,
  getProvisionRoot,
  getSpawnHook,
  hasProvisionHook,
  hasSpawnHook,
  isProvisionAllowed,
  resolveSpawnCwd,
} from "./workspaceConfig.ts";

const DEFAULT_PORT = 0;
const PORTLESS_APP_NAME = "agent-yes";
const PORTLESS_CHILD_ENV = "AGENT_YES_PORTLESS_CHILD";

export function portlessConsoleUrl(token?: string): string {
  return portlessConsoleUrlForOrigin(
    process.env.PORTLESS_URL?.replace(/\/$/, "") || `https://${PORTLESS_APP_NAME}.localhost`,
    token,
  );
}

function portlessConsoleUrlForOrigin(origin: string, token?: string): string {
  const fragment = token ? `/#k=${encodeURIComponent(token)}` : "/";
  return `${origin}${fragment}`;
}

async function resolvedPortlessConsoleUrl(token?: string): Promise<string> {
  if (process.env.PORTLESS_URL) return portlessConsoleUrl(token);
  try {
    const port = Number(
      (await readFile(path.join(homedir(), ".portless", "proxy.port"), "utf-8")).trim(),
    );
    if (Number.isInteger(port) && port > 0)
      return portlessConsoleUrlForOrigin(
        `https://${PORTLESS_APP_NAME}.localhost${port === 443 ? "" : `:${port}`}`,
        token,
      );
  } catch {
    /* Portless has not created state yet. */
  }
  return portlessConsoleUrl(token);
}

async function runWithPortless(rest: string[]): Promise<number> {
  const portless = Bun.which("portless");
  if (!portless) {
    process.stderr.write(
      "ay serve: Portless is required for local HTTPS. Install it with: npm install -g portless\n",
    );
    return 1;
  }
  const script = process.argv[1];
  const self =
    script && /\.[cm]?[jt]s$/.test(script) ? [process.execPath, script] : [process.execPath];
  const proc = Bun.spawn([portless, PORTLESS_APP_NAME, ...self, "serve", ...rest], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...liveEnv(), [PORTLESS_CHILD_ENV]: "1" },
  });
  return (await proc.exited) ?? 1;
}

/**
 * Normalize a user-supplied GitHub-ish source into the standard
 * `<owner>/<repo>/tree/<branch>` path that codehost/provision's `parseSpec`
 * understands. Interim fallback used only when the linked codehost build
 * predates `parseSource` (the canonical normalizer in the standard):
 *   https://github.com/o/r/tree/b · github.com/o/r/tree/b · o/r/tree/b
 *   o/r@branch · o/r (→ default branch main)
 */
function normalizeGithubSource(s: string): string {
  let v = s
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "");
  v = v
    .replace(/[?#].*$/, "")
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "");
  const at = v.match(/^([^/]+)\/([^/@]+)@(.+)$/);
  if (at) return `${at[1]}/${at[2]}/tree/${at[3]}`;
  if (/^[^/]+\/[^/]+$/.test(v)) return `${v}/tree/main`;
  return v;
}

function agentYesHome(): string {
  return process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes");
}

function tokenPath(): string {
  return path.join(agentYesHome(), ".serve-token");
}

// Liveness heartbeat for the WebRTC daemon. The native WebRTC stack
// (node-datachannel) has been observed to freeze the entire JS event loop after
// long uptime — main thread stuck in a pthread rendezvous — so signaling stays
// connected but the host answers nobody, and NO in-process timer (self-heal,
// idle-restart) can recover it because JS has stopped running. The serve loop
// stamps this file every HEARTBEAT_WRITE_MS; `ay serve healthcheck` reports the
// daemon unhealthy once it goes stale, and oxmgr's --health-cmd restarts it.
function heartbeatPath(): string {
  return path.join(agentYesHome(), ".serve-heartbeat");
}
// /api/search — chat-history search (v1). Per-agent rendered-tail cache, keyed
// on the log's (size, mtime): the expensive part is the headless-xterm replay,
// so an unchanged log never re-renders. Map insertion order doubles as LRU.
const SEARCH_TAIL_BYTES = 256 * 1024;
const SEARCH_MAX_HITS = 20;
const SEARCH_CACHE_MAX = 300;
const searchTextCache = new Map<string, { size: number; mtimeMs: number; text: string }>();

const HEARTBEAT_WRITE_MS = 5_000;
const HEARTBEAT_STALE_MS = 15_000; // event loop is wedged if no stamp this long (3 missed)

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
  // The agent-yes wrapper pid of the agent that launched `ay serve`. A daemon
  // started from inside an agent's shell carries that agent's AGENT_YES_PID for
  // its whole lifetime; without stripping it, every console-spawned agent would
  // inherit it and be recorded with parent_pid = that stale agent, mis-rooting
  // the whole subagent tree under an unrelated agent. Dropping it makes console
  // spawns clean top-level agents (parent_pid = None).
  "AGENT_YES_PID",
]);

// The login-shell environment, captured once and cached for the daemon's
// lifetime. `ay serve` is daemonized by oxmgr/launchd/pm2, which start it with a
// minimal PATH that never sourced the user's ~/.zshrc / ~/.zprofile — so it lacks
// ~/.bun/bin, ~/.cargo/bin, Homebrew, nvm shims, etc. A console-spawned agent
// that inherits that env can't find `bun`/`bunx`/etc. (the user reported "bunx:
// command not found" when spawning a new agent from the web UI). We recover the
// real environment by running the user's LOGIN shell and dumping its env.
//
// IMPORTANT: NON-interactive (`-lc`, not `-ilc`). An interactive shell (`-i`)
// HANGS indefinitely when the daemon has no controlling TTY — exactly the case
// under any process manager (oxmgr/systemd/launchd/pm2) — and Bun's `spawnSync`
// `timeout` does NOT kill the hung interactive shell. Because this runs
// synchronously on the event loop from the /api/spawn handler, the interactive
// variant PERMANENTLY WEDGED the daemon on the first console spawn (heartbeat
// froze → healthcheck restart → cache lost → next spawn wedged again), making
// console spawns impossible on a headless daemon. `-l` still sources the profile
// chain (`~/.profile`/`~/.bash_profile` → `~/.bashrc`), so the tool PATHs are
// still recovered. Returns null on Windows (no rc-file model — the process env is
// already the right one) or on any failure, so callers fall back to process.env.
let loginShellEnvCache: Record<string, string> | null | undefined;
function loginShellEnv(): Record<string, string> | null {
  if (loginShellEnvCache !== undefined) return loginShellEnvCache;
  loginShellEnvCache = null;
  if (process.platform === "win32") return loginShellEnvCache;
  try {
    const shell = process.env.SHELL || "/bin/sh";
    // Delimiters fence off the env dump from any banner/prompt noise the rc files
    // print to stdout; `env -0` is NUL-separated so values with newlines survive.
    const delim = "_AY_SHELL_ENV_DELIM_";
    const res = Bun.spawnSync(
      [shell, "-lc", `printf %s "${delim}"; env -0; printf %s "${delim}"`],
      {
        stdin: "ignore",
        stderr: "ignore",
        timeout: 5_000,
        env: process.env as Record<string, string>,
      },
    );
    const out = res.stdout?.toString() ?? "";
    const start = out.indexOf(delim);
    const end = out.lastIndexOf(delim);
    if (start === -1 || end <= start) return loginShellEnvCache;
    const dump = out.slice(start + delim.length, end);
    const env: Record<string, string> = {};
    for (const pair of dump.split("\0")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    // Require a usable result — a PATH carrying ~/.bun/bin is the whole point.
    if (env.PATH) loginShellEnvCache = env;
  } catch {
    // best-effort; fall back to process.env
  }
  return loginShellEnvCache;
}

// Env for a console-spawned agent, minus only the session-pinning vars above. If
// `ay serve` was launched from inside Claude Code (or any shell carrying these),
// it would otherwise leak the parent's SSE port / session id into every spawned
// agent — so the new `claude` thinks it's a nested child and tries to attach to a
// stale port, surfacing as "fail to connect". Dropping them makes each agent a
// clean top-level session; all config/provider env (CLAUDE_EFFORT, CLAUDE_CODE_*
// settings) is preserved.
//
// The base is the login-shell env (see loginShellEnv) so the agent behaves like
// one launched from a fresh terminal — PATH and anything ~/.zshrc exports are
// present. Daemon-only vars that the login shell doesn't define (e.g. provider
// keys exported when `ay serve` was launched) are layered back on so nothing the
// daemon was deliberately given is lost; for keys in both, the login shell wins.
function freshAgentEnv(): Record<string, string> {
  const login = loginShellEnv();
  const env: Record<string, string> = {};
  const base = login ?? (process.env as Record<string, string>);
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || SESSION_PIN_ENV.has(k)) continue;
    env[k] = v;
  }
  if (login) {
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || SESSION_PIN_ENV.has(k) || k in env) continue;
      env[k] = v;
    }
  }
  return env;
}

// Best-effort owner/repo from a worktree's github origin remote — used to build
// the KOHO_* env a provision hook branches on (which account to select for this
// repo). Mirrors codehost's forkWorktree parse; null when there's no github
// origin (the hook still runs, just without KOHO_OWNER/REPO).
function originOwnerRepo(cwd: string): { owner: string; repo: string } | null {
  try {
    const r = Bun.spawnSync(["git", "-C", cwd, "remote", "get-url", "origin"]);
    if (r.exitCode !== 0) return null;
    const url = new TextDecoder().decode(r.stdout).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
    return m && m[1] && m[2] ? { owner: m[1], repo: m[2] } : null;
  } catch {
    return null;
  }
}

type ProvisionHookResult =
  | { ran: false }
  | { ran: true; ok: boolean; code: number | null; detail: string };

// Run the "koho-style" provision hook (a host-local trusted shell hook) BEFORE a
// fork/from git op. Its purpose is to prepare the host for provisioning — most
// usefully to select the right git identity (e.g. `gh auth switch --user <who>`,
// keyed on the KOHO_* env we export) before the clone/worktree/setup runs. When
// configured it is ALSO the provisioning gate: its exit code decides admission
// (0 = allow, non-zero = deny), overriding the static provisionAllowlist.
// Returns { ran:false } when no hook is set, so the caller falls back to the
// allowlist. Unlike the spawn hook there is no `exec "$@"`: this hook runs to
// completion and hands control back — it prepares state, it is not the agent.
async function runProvisionHook(
  cwd: string,
  koho: Record<string, string>,
): Promise<ProvisionHookResult> {
  const hook = getProvisionHook();
  if (!hook) return { ran: false };
  const shell =
    process.env.AGENT_YES_PROVISION_SHELL?.trim() ||
    process.env.AGENT_YES_SPAWN_SHELL?.trim() ||
    "/bin/sh";
  const outPath = path.join(
    agentYesHome(),
    `provision-hook-${process.pid}-${performance.now().toString(36).replace(".", "")}.log`,
  );
  const timeoutMs = Number(process.env.AGENT_YES_PROVISION_HOOK_TIMEOUT_MS) || 60_000;
  let code: number | null = null;
  try {
    // Recovered login-shell env (freshAgentEnv), NOT the daemon's raw env: the
    // oxmgr/launchd daemon runs with a minimal PATH (/usr/bin:/bin:…) that lacks
    // Homebrew/bun/etc., so `gh`/`git` would be "command not found" and `set -e`
    // would deny EVERY provision. freshAgentEnv re-derives the user's real PATH
    // (as a fresh terminal would) while preserving HOME — so the hook finds `gh`
    // and its credential store. `set -e` so any failing step denies the provision.
    const child = Bun.spawn([shell, "-c", `set -e\n${hook}`], {
      cwd,
      env: { ...freshAgentEnv(), ...koho },
      stdin: "ignore",
      stdout: Bun.file(outPath),
      stderr: Bun.file(outPath),
    });
    code = await Promise.race([
      child.exited,
      new Promise<number>((r) => setTimeout(() => r(124), timeoutMs)),
    ]);
    if (code === 124) child.kill();
  } catch (e) {
    return { ran: true, ok: false, code: null, detail: (e as Error).message };
  }
  let detail = "";
  try {
    detail = (await Bun.file(outPath).text()).slice(0, 4096).trimEnd();
  } catch {
    /* no output captured */
  }
  await unlink(outPath).catch(() => {});
  return { ran: true, ok: code === 0, code, detail };
}

// ---------------------------------------------------------------------------
// ay serve install / uninstall / logs  (oxmgr daemon management)
// ---------------------------------------------------------------------------

const DAEMON_NAME = "agent-yes";

type DaemonManager = { id: "oxmgr" | "pm2"; bin: string };

// Parse an `oxmgr --version` line ("oxmgr 0.4.0+winfix") and decide whether the
// build carries the Windows daemon-socket-inheritance fix. oxmgr's daemon talks
// over a fixed TCP port; on stock builds <= 0.4.0 a crashed daemon leaves that
// listener inherited by a managed child (bInheritHandles) onto a dead PID, which
// wedges every subsequent oxmgr command with "daemon did not become ready in
// time". The fix clears HANDLE_FLAG_INHERIT on the listeners and ships as the
// `+winfix` build-metadata tag on the fork (snomiao/OxMgr,
// fix/windows-daemon-socket-inheritance), and is assumed present in any release
// strictly newer than the last wedged stock build (0.4.0) once it's upstreamed.
// Split out from the probe so it's unit-testable without spawning.
export function oxmgrVersionHasWindowsFix(versionOutput: string): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?/.exec(versionOutput);
  if (!m) return false;
  const build = m[4] ?? "";
  if (/winfix/i.test(build)) return true;
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (maj !== 0) return maj > 0; // 1.x.x and up → fix assumed upstreamed
  if (min !== 4) return min > 4; // 0.5.x+ → assumed upstreamed
  return pat > 0; // 0.4.1+ → assumed upstreamed; 0.4.0 and earlier still wedge
}

// Probe the installed oxmgr for the Windows fix (cheap synchronous
// `oxmgr --version`, cached for the process lifetime). On any probe failure we
// treat it as UNFIXED so a broken/ancient oxmgr can't wedge Windows — the caller
// falls back to pm2.
let oxmgrWinFixCache: boolean | undefined;
function oxmgrHasWindowsFix(bin: string): boolean {
  if (oxmgrWinFixCache !== undefined) return oxmgrWinFixCache;
  try {
    const out = execFileSync(bin, ["--version"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env } as NodeJS.ProcessEnv,
    });
    oxmgrWinFixCache = oxmgrVersionHasWindowsFix(out);
  } catch {
    oxmgrWinFixCache = false;
  }
  return oxmgrWinFixCache;
}

// Pick the process manager used to daemonize `ay serve`. oxmgr is the default
// everywhere — including Windows, now that its daemon-socket-inheritance wedge is
// fixed (see oxmgrVersionHasWindowsFix). The one Windows caveat: only PREFER
// oxmgr there when the installed build actually carries the fix; stock builds
// <= 0.4.0 still wedge, so on those we fall back to pm2 (whose named-pipe daemon
// never had that failure mode) and keep oxmgr only as a last resort if pm2 is
// absent. AGENT_YES_DAEMON_MANAGER=pm2|oxmgr forces a choice (bypasses the probe).
function resolveDaemonManager(): DaemonManager | null {
  const oxmgrBin = Bun.which("oxmgr");
  const pm2Bin = Bun.which("pm2");
  const override = process.env.AGENT_YES_DAEMON_MANAGER?.toLowerCase();
  if (override === "pm2") return pm2Bin ? { id: "pm2", bin: pm2Bin } : null;
  if (override === "oxmgr") return oxmgrBin ? { id: "oxmgr", bin: oxmgrBin } : null;
  const oxmgr: DaemonManager | null = oxmgrBin ? { id: "oxmgr", bin: oxmgrBin } : null;
  const pm2: DaemonManager | null = pm2Bin ? { id: "pm2", bin: pm2Bin } : null;
  // On Windows, demote oxmgr below pm2 unless it's the winfix build.
  const winWedge = process.platform === "win32" && oxmgr && !oxmgrHasWindowsFix(oxmgr.bin);
  const order: Array<DaemonManager | null> = winWedge ? [pm2, oxmgr] : [oxmgr, pm2];
  return order.find((m): m is DaemonManager => !!m) ?? null;
}

// Ask a JS package manager for its global bin dir, so a binary we just
// `-g`-installed is discoverable in THIS process even though a fresh login
// shell hasn't added that dir to PATH yet (setup.sh warns about exactly this).
//   - bun: `bun pm bin -g` prints the dir directly.
//   - npm: `npm prefix -g` prints the prefix; the bin lives at <prefix>/bin.
async function globalBinDir(installer: string[]): Promise<string | null> {
  const isBun = installer[1] === "add";
  const query = isBun ? [installer[0]!, "pm", "bin", "-g"] : [installer[0]!, "prefix", "-g"];
  const p = Bun.spawn(query, { stdout: "pipe", stderr: "ignore" });
  if ((await p.exited) !== 0) return null;
  const out = (await new Response(p.stdout).text()).trim();
  if (!out) return null;
  return isBun ? out : path.join(out, "bin");
}

// Did an exec attempt die because `env` couldn't find a node runtime? macOS/BSD
// env says `env: node: No such file or directory`, GNU coreutils quotes it
// (`env: 'node': …`), Windows cmd says `'node' is not recognized`.
export function isNoNodeExecError(stderr: string): boolean {
  return (
    /env: '?node'?: No such file or directory/.test(stderr) ||
    /'node' is not recognized/.test(stderr)
  );
}

// Probe one manager binary with `--version`, capturing stderr so a failure can
// be diagnosed (glibc mismatch vs missing node runtime vs anything else).
// LC_ALL=C pins env(1)/libc error text to English so isNoNodeExecError's
// patterns hold on localized systems.
async function managerProbe(mgr: DaemonManager): Promise<{ ok: boolean; stderr: string }> {
  try {
    const p = Bun.spawn([mgr.bin, "--version"], {
      stdout: "ignore",
      stderr: "pipe",
      env: { ...liveEnv(), LC_ALL: "C" },
    });
    const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    return { ok: (code ?? 1) === 0, stderr };
  } catch (e) {
    return { ok: false, stderr: String(e) };
  }
}

// Does this manager's binary actually execute? A `bun add -g oxmgr` can succeed
// yet leave a binary that can't run: oxmgr vendors a native binary requiring
// GLIBC_2.39, which a box like Debian 12 (glibc 2.36) lacks, so exec dies with
// "GLIBC_2.39 not found"; and on a node-less box the `env node` shebang itself
// fails (see ensureNodeRuntime, applied here so every probe self-heals). Probe
// with `--version`: exit 0 means runnable; a non-zero exit or spawn failure
// means the shim is on PATH but unusable.
async function managerRunnable(mgr: DaemonManager): Promise<boolean> {
  await ensureNodeRuntime();
  return (await managerProbe(mgr)).ok;
}

// Which manager is ACTUALLY running our daemon? `resolveDaemonManager` picks by
// PATH order without a liveness check, so after a bootstrap oxmgr→pm2 fallback a
// broken oxmgr shim (first on PATH) shadows the pm2 that really holds the daemon
// — making `ay serve status` report `manager: oxmgr / installed: no` while pm2
// serves. For reporting, probe each present manager and prefer the one that is
// runnable AND has our daemon registered; fall back to the first runnable one,
// else whatever resolveDaemonManager returns.
async function resolveActiveManager(): Promise<DaemonManager | null> {
  const oxmgr = Bun.which("oxmgr");
  const pm2 = Bun.which("pm2");
  const present: DaemonManager[] = [];
  if (oxmgr) present.push({ id: "oxmgr", bin: oxmgr });
  if (pm2) present.push({ id: "pm2", bin: pm2 });
  let firstRunnable: DaemonManager | null = null;
  for (const m of present) {
    if (!(await managerRunnable(m))) continue;
    firstRunnable ??= m;
    if ((await readDaemonServeArgs(m)) !== null) return m; // this one holds the daemon
  }
  return firstRunnable ?? resolveDaemonManager();
}

// The install command for one PM package. oxmgr gets `--trust` under bun: its
// native binary arrives via the package's postinstall (scripts/install.js
// downloads the platform build), and bun BLOCKS lifecycle scripts of untrusted
// packages by default — which leaves a JS launcher that dies with "oxmgr binary
// is missing" and was the real reason bootstrap kept falling back to pm2 on
// fresh boxes. Re-adding with --trust also heals such a blocked install. pm2 is
// pure JS with no required scripts, so it stays untrusted. npm runs lifecycle
// scripts by default — no flag needed.
export function installerArgv(
  pkg: "oxmgr" | "pm2",
  bun: string | null,
  npm: string | null,
): string[] | null {
  if (bun) return [bun, "add", "-g", ...(pkg === "oxmgr" ? ["--trust"] : []), pkg];
  if (npm) return [npm, "install", "-g", pkg];
  return null;
}

// Install one PM package globally via the SAME JS package manager that installed
// `ay` (bun preferred, npm fallback — no Rust toolchain required, so a fresh
// Linux box with only bun from setup.sh works), then confirm the resulting
// binary actually execs. Returns a runnable manager, or null if the install
// failed or the binary can't run here (caller then tries the next candidate).
async function installAndVerify(pkg: "oxmgr" | "pm2"): Promise<DaemonManager | null> {
  const installer = installerArgv(pkg, Bun.which("bun"), Bun.which("npm"));
  if (!installer) return null;
  // The node→bun shim must exist BEFORE the install, not just before the probe:
  // oxmgr's postinstall itself runs `node scripts/install.js` to fetch the
  // native binary, so on a bun-only box a missing shim silently skips the
  // download even when the script is trusted.
  await ensureNodeRuntime();
  process.stderr.write(`ay serve install: installing ${pkg}…\n`);
  const code =
    (await Bun.spawn(installer, {
      stdio: ["ignore", "inherit", "inherit"],
      env: liveEnv(),
    }).exited) ?? 1;
  if (code !== 0) {
    process.stderr.write(`ay serve install: '${installer.join(" ")}' failed (exit ${code})\n`);
    return null;
  }
  // The shim landed in the PM's global bin dir, which may not be on our PATH —
  // prepend it before resolving so Bun.which can see the fresh binary.
  const binDir = await globalBinDir(installer);
  if (binDir) process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  const bin = Bun.which(pkg);
  if (!bin) return null;
  const mgr: DaemonManager = { id: pkg, bin };
  await ensureNodeRuntime();
  const probe = await managerProbe(mgr);
  if (!probe.ok) {
    // Name the ACTUAL reason from the probe's stderr. A missing node runtime
    // hits both managers identically (`env: node: No such file or directory` —
    // their bins are `#!/usr/bin/env node` scripts), and reporting that as a
    // "glibc mismatch" is nonsense on macOS where glibc doesn't exist. Only
    // blame glibc for an oxmgr that got PAST the shebang and died natively;
    // any other failure just gets the probe's own last stderr line — claiming
    // "no node runtime" here would be false, ensureNodeRuntime just provided one.
    const detailLine = probe.stderr.trim().split("\n").filter(Boolean).pop()?.slice(0, 160);
    const detail = detailLine ? ` — ${detailLine}` : "";
    const why = isNoNodeExecError(probe.stderr)
      ? `${pkg} needs a Node.js runtime (its bin is a '#!/usr/bin/env node' script) and none was found`
      : pkg === "oxmgr"
        ? `likely a native binary mismatch, e.g. glibc < 2.39 on Linux${detail}`
        : `exec probe failed${detail}`;
    process.stderr.write(
      `ay serve install: ${pkg} installed but can't exec here (${why})` +
        (pkg === "oxmgr" ? " — falling back to pm2\n" : "\n"),
    );
    return null;
  }
  return mgr;
}

// No usable process manager → bootstrap one so `ay serve install` works out of
// the box on a fresh machine. Try candidates in preference order (oxmgr first on
// non-Windows, pm2 first on Windows where oxmgr's TCP daemon socket wedges);
// each must actually EXEC, so a glibc-incompatible oxmgr transparently falls
// through to pm2 — pure JS, runs anywhere bun/node does. This is why the old
// `cargo install oxmgr`-only hint left serve-install dead on arrival on Linux.
// AGENT_YES_NO_PM_BOOTSTRAP=1 opts out.
async function bootstrapDaemonManager(): Promise<DaemonManager | null> {
  if (process.env.AGENT_YES_NO_PM_BOOTSTRAP === "1") return null;
  const candidates: Array<"oxmgr" | "pm2"> =
    process.platform === "win32" ? ["pm2", "oxmgr"] : ["oxmgr", "pm2"];
  for (const pkg of candidates) {
    const mgr = await installAndVerify(pkg);
    if (mgr) return mgr;
  }
  return null;
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
//   - Windows (oxmgr): `oxmgr service install` registers a Task Scheduler
//     ONLOGON task (`oxmgr daemon run`); on login the daemon comes up and
//     restarts our `--restart always` managed process. This is oxmgr's native
//     Windows persistence — no HKCU Run entry / `resurrect` needed (that path is
//     pm2-only, below). Handled by the shared oxmgr branch — no Windows special-
//     casing in the code, just in the receipt wording.
//   - Windows (pm2, fallback when oxmgr lacks the winfix build): pm2 core can't
//     install a startup hook here, so we save the process list and add a HKCU Run
//     entry that runs `pm2 resurrect` at login.
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
    return (
      (await Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"], env: liveEnv() }).exited) ?? 1
    );
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
      const p = Bun.spawn([mgr.bin, "status", DAEMON_NAME], {
        stdout: "pipe",
        stderr: "ignore",
        env: liveEnv(),
      });
      const out = await new Response(p.stdout).text();
      if ((await p.exited) !== 0) return null;
      const m = /Command:\s*(.+)/.exec(out);
      if (!m) return null;
      const after = /\bserve\b\s*(.*)$/.exec(m[1]!.trim());
      return after ? after[1]!.split(/\s+/).filter(Boolean) : [];
    }
    const p = Bun.spawn([mgr.bin, "jlist"], { stdout: "pipe", stderr: "ignore", env: liveEnv() });
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

function portFromArgs(args: string[]): number | null {
  const m = /--port[=\s](\d+)/.exec(args.join(" "));
  return m ? Number(m[1]) : null;
}

function argsUsePortless(args: string[]): boolean {
  const wantsHttp =
    args.some((a) => a.startsWith("--http") || a.startsWith("--share")) ||
    !args.some((a) => a.startsWith("--webrtc"));
  return wantsHttp && portFromArgs(args) === null;
}

async function portlessAppPort(): Promise<number | null> {
  try {
    const routes = JSON.parse(
      await readFile(path.join(homedir(), ".portless", "routes.json"), "utf-8"),
    ) as { hostname?: string; port?: number }[];
    const route = routes.find((r) => r.hostname === `${PORTLESS_APP_NAME}.localhost`);
    return typeof route?.port === "number" ? route.port : null;
  } catch {
    return null;
  }
}

async function warnStrayServeProcesses(): Promise<void> {
  const stray = await listStrayServeProcesses();
  if (stray.length === 0) return;
  const pids = stray.map((p) => p.pid);
  process.stderr.write(
    `warning: ${stray.length} unmanaged ay serve process(es) running (pid ${pids.join(
      ", ",
    )}) — they will fight the daemon for the WebRTC room; stop them: kill ${pids.join(" ")}\n`,
  );
}

// An explicit webrtc:// URL passed to --webrtc/--share in the daemon's serve args,
// or undefined for a bare flag (which mints a persisted room instead). Mirrors how
// cmdServe resolves argv.webrtc/argv.share, but over the raw arg list install holds
// (oxmgr splits the command on whitespace → `--webrtc url`; pm2/`=` → `--webrtc=url`).
function explicitWebrtcUrl(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const flag of ["--webrtc", "--share"]) {
      if (a === flag && args[i + 1]?.startsWith("webrtc://")) return args[i + 1];
      if (a.startsWith(`${flag}=`)) {
        const v = a.slice(flag.length + 1);
        if (v.startsWith("webrtc://")) return v;
      }
    }
  }
  return undefined;
}

// Ask the live daemon its version over the local HTTP API. null if it's not
// listening (webrtc-only) or too old to expose /api/version — both of which we
// treat as "outdated" so a re-install rolls it forward.
async function fetchDaemonVersion(port: number | null, token: string): Promise<string | null> {
  if (port === null) return null;
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
  // Uninstall first, before any manager resolution/bootstrap: it must sweep
  // EVERY present manager, not just the currently-preferred one. After a
  // manager switch (pm2 → oxmgr via the --trust fix) the old manager still
  // holds a live daemon, and asking only the new one leaves that orphan
  // running — two processes then grab the same WebRTC room (seen on sym003).
  // It also must never bootstrap-install a manager just to uninstall.
  if (sub === "uninstall") {
    const present: DaemonManager[] = [];
    const oxmgrBin = Bun.which("oxmgr");
    const pm2Bin = Bun.which("pm2");
    if (oxmgrBin) present.push({ id: "oxmgr", bin: oxmgrBin });
    if (pm2Bin) present.push({ id: "pm2", bin: pm2Bin });
    let removed = 0;
    let failed = 0;
    for (const m of present) {
      if (!(await managerRunnable(m))) continue;
      if ((await readDaemonServeArgs(m)) === null) continue; // not registered here
      const code =
        (await Bun.spawn([m.bin, "delete", DAEMON_NAME], {
          stdio: ["ignore", "inherit", "inherit"],
          env: liveEnv(),
        }).exited) ?? 1;
      if (code !== 0) {
        failed++;
        process.stderr.write(`ay serve uninstall: ${m.id} delete failed (exit ${code})\n`);
        continue;
      }
      removed++;
      process.stdout.write(`removed '${DAEMON_NAME}' from ${m.id}\n`);
      if (m.id === "pm2") {
        // Drop it from the persisted pm2 list too, so `pm2 resurrect` won't
        // revive it. --force is required: with the process list now empty, a
        // plain `pm2 save` REFUSES to overwrite the dump ("Nothing to save!
        // Please use --force") and the deleted daemon stays in dump.pm2 —
        // resurrect/startup would then boot it alongside the new manager's.
        await spawnExit([m.bin, "save", "--force"]);
        // Remove the Windows login auto-start entry we added at install time.
        if (process.platform === "win32")
          await spawnExit(["reg", "delete", WIN_RUN_KEY, "/v", WIN_RUN_VALUE, "/f"]);
      }
    }
    if (removed === 0 && failed === 0)
      process.stdout.write(`no '${DAEMON_NAME}' daemon registered with any manager\n`);
    await warnStrayServeProcesses();
    return failed ? 1 : 0;
  }

  // Prefer an already-installed manager — but only if it actually execs. A
  // glibc-incompatible oxmgr (Debian 12: GLIBC_2.39 not found) can sit on PATH
  // yet be unusable; treat it as absent so we bootstrap a working one instead of
  // handing serve-install a manager that dies at runtime. Otherwise bootstrap
  // (oxmgr→pm2 fallback) so a fresh box works out of the box.
  let mgr = resolveDaemonManager();
  if (mgr && !(await managerRunnable(mgr))) {
    process.stderr.write(
      `ay serve install: ${mgr.id} is on PATH but can't exec here — bootstrapping a working manager…\n`,
    );
    mgr = null;
  }
  if (!mgr) mgr = await bootstrapDaemonManager();
  if (!mgr) {
    process.stderr.write(
      "ay serve install: no usable process manager (need oxmgr or pm2)\n" +
        "  - oxmgr: bun add -g oxmgr   (native binary; needs glibc ≥ 2.39 on Linux)\n" +
        "  - pm2:   bun add -g pm2     (pure JS; needs a node runtime — on a bun-only box\n" +
        "           ay auto-writes a node→bun shim into ~/.agent-yes/bin, so if you still\n" +
        "           see this, check that dir is writable or install node)\n",
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

    // WebRTC daemon: resolve the share link up front so we can print it on every
    // install path (fresh install, roll-forward, and the already-up-to-date no-op).
    // The link is a pure transform of the room URL, so the foreground install
    // command can show it even though the background daemon is what runs the bridge.
    // Resolve (and persist, when auto-minting) the room BEFORE spawning, so the
    // daemon reads the SAME ~/.agent-yes/.share-room and can't race us into minting
    // a divergent one. We print the link directly — the install receipt already
    // prints the bearer token, so the operator's terminal is the right trust scope
    // for a secret-bearing link (unlike the daemon's persisted logs, which omit it).
    const webrtcDaemon = effArgs.some((a) => a.startsWith("--webrtc") || a.startsWith("--share"));
    let shareLink: string | null = null;
    let shareLinkMinted = false; // auto-minted (persisted/rotatable) vs explicit URL
    if (webrtcDaemon) {
      try {
        const { loadOrCreateShareRoom, shareLinkFromRoomUrl } = await import("./share.ts");
        const explicit = explicitWebrtcUrl(effArgs);
        shareLink = shareLinkFromRoomUrl(explicit ?? (await loadOrCreateShareRoom()));
        shareLinkMinted = !explicit;
      } catch {
        /* best effort — fall back to the .share-link file hint in emitShareLink */
      }
    }
    const emitShareLink = async () => {
      if (!webrtcDaemon) return;
      if (shareLink) {
        process.stdout.write(
          `\nshared over WebRTC — open this link (the token is eaten from the URL on open):\n` +
            `  ${shareLink}\n` +
            (shareLinkMinted
              ? `  (persistent room — same link across restarts; delete ~/.agent-yes/.share-room to rotate)\n`
              : ``),
        );
        // Offer to jump straight into the console (default yes); no-ops on a
        // non-TTY or headless box, leaving the link printed above.
        const { offerOpenInBrowser } = await import("./openBrowser.ts");
        await offerOpenInBrowser(shareLink);
      } else
        process.stdout.write(
          `\nthe WebRTC share link carries a secret, so the daemon does NOT log it —\n` +
            `read it from ~/.agent-yes/.share-link (mode 0600). The room persists in\n` +
            `~/.agent-yes/.share-room, so the link survives restarts.\n`,
        );
    };

    if (priorArgs !== null) {
      // A daemon already exists. Treat this as a no-op only when it's BOTH current
      // AND already running the requested config — otherwise a config change (e.g.
      // `install --webrtc` over an --http daemon, which the version probe still
      // reaches on the default port) would be silently ignored, and we'd print a
      // share link for a WebRTC bridge that isn't actually running. A bare re-run
      // passes no args, so effArgs === priorArgs and this stays a no-op as before.
      const sameConfig = JSON.stringify(effArgs) === JSON.stringify(priorArgs);
      const daemonPort = argsUsePortless(effArgs) ? await portlessAppPort() : portFromArgs(effArgs);
      const runningVer = await fetchDaemonVersion(daemonPort, token);
      if (runningVer === current && sameConfig) {
        await ensureBootAutostart(mgr);
        process.stdout.write(`'${DAEMON_NAME}' already running v${current} (up to date)\n`);
        await emitShareLink();
        return 0;
      }
      // Outdated, unreachable, or reconfigured → graceful roll-forward. `stop` sends
      // SIGTERM, which cmdServe handles cleanly (closing share peers so browsers
      // reconnect fast), then we re-create with the new binary/args.
      process.stdout.write(
        runningVer === current
          ? `reconfiguring '${DAEMON_NAME}' (serve args changed)…\n`
          : `rolling '${DAEMON_NAME}' ${runningVer ? `v${runningVer}` : "(unknown)"} → v${current}…\n`,
      );
      await spawnExit([mgr.bin, "stop", DAEMON_NAME]);
      await spawnExit([mgr.bin, "delete", DAEMON_NAME]);
    }
    await warnStrayServeProcesses();

    // oxmgr takes the command as one string; pm2 takes the binary plus its
    // args after `--`. Both auto-restart on crash by default (pm2) / via the
    // explicit flag (oxmgr).
    const serveArgv = ayServeArgv(effArgs);
    // On Windows, interpose the window-less launcher so the manager (pm2/oxmgr)
    // doesn't flash a console window on each (re)start. `ay-spawn-hidden` is a
    // GUI-subsystem shim that starts the real `ay serve …` with CREATE_NO_WINDOW
    // and mirrors its lifetime/exit-code, so the manager still tracks it exactly.
    // Resolves to undefined off Windows or when the launcher isn't installed
    // (older builds / a release predating it) → fall back to the raw command.
    const spawnHidden = findSpawnHiddenLauncher();
    // The command the manager launches: unchanged normally, or the launcher
    // followed by the real argv when interposing. Split into program + args for
    // pm2 (which takes `<program> … -- <args>`); oxmgr takes the joined string.
    const managedArgv = spawnHidden ? [spawnHidden, ...serveArgv] : serveArgv;
    // WebRTC daemons get an oxmgr health watchdog: the native WebRTC stack can
    // freeze the JS event loop (host answers nobody, no in-process timer can
    // recover it), so an EXTERNAL probe of the serve heartbeat is the only thing
    // that can detect+restart it. 15s stale + 3 misses at 10s ≈ 45s to auto-recover.
    // (webrtcDaemon resolved above, where we also derive the share link.)
    const oxmgrHealth =
      webrtcDaemon && mgr.id === "oxmgr"
        ? [
            "--health-cmd",
            ayServeArgv(["healthcheck"]).join(" "),
            "--health-interval",
            "10",
            "--health-timeout",
            "5",
            "--health-max-failures",
            "3",
          ]
        : [];
    const startArgv =
      mgr.id === "oxmgr"
        ? [
            mgr.bin,
            "start",
            managedArgv.join(" "),
            "--name",
            DAEMON_NAME,
            "--restart",
            "always",
            // Persistent daemon: oxmgr's default lifetime cap of 10 restarts would
            // eventually stop respawning it (updates, reboots, the health-watchdog
            // recovering a frozen WebRTC stack). Raise it far out of the way; the
            // crash-restart-limit still guards against a tight crash loop.
            "--max-restarts",
            "1000000",
            ...oxmgrHealth,
          ]
        : [
            mgr.bin,
            "start",
            managedArgv[0]!,
            "--name",
            DAEMON_NAME,
            "--interpreter",
            "none",
            // Exponential restart backoff: a persistent crash (e.g. a port held
            // by a stale instance) must NOT hammer-restart. pm2's default is an
            // instant respawn, which storms — hundreds of restarts/min, each
            // briefly grabbing window focus. exp-backoff grows the delay on
            // repeated quick crashes and resets once the process stays up.
            "--exp-backoff-restart-delay",
            "200",
            "--",
            ...managedArgv.slice(1),
          ];
    const proc = Bun.spawn(startArgv, { stdio: ["ignore", "inherit", "inherit"], env: liveEnv() });
    const code = await proc.exited;
    if (code === 0) {
      const onBoot = await ensureBootAutostart(mgr);
      const port = argsUsePortless(effArgs) ? await portlessAppPort() : portFromArgs(effArgs);
      const localUrl = argsUsePortless(effArgs) ? await resolvedPortlessConsoleUrl(token) : null;
      // Mirror cmdServe's mode resolution: webrtc-only daemons open no HTTP port.
      const httpish =
        effArgs.some((a) => a.startsWith("--http") || a.startsWith("--share")) ||
        !effArgs.some((a) => a.startsWith("--webrtc"));
      process.stdout.write(
        `\n${priorArgs !== null ? `rolled '${DAEMON_NAME}' forward to` : `installed '${DAEMON_NAME}' as a daemon via ${mgr.id} —`} v${current}\n`,
      );
      if (mgr.id === "oxmgr" && process.platform === "win32")
        process.stdout.write(
          onBoot
            ? `start-on-login: enabled (Task Scheduler ONLOGON runs \`oxmgr daemon run\`)\n`
            : `start-on-login: not registered — run \`oxmgr service install\` to enable\n`,
        );
      else if (mgr.id === "oxmgr")
        process.stdout.write(
          onBoot
            ? process.platform === "darwin"
              ? `start-on-boot: enabled (launchd user agent, starts at login)\n`
              : `start-on-boot: enabled (systemd --user + linger, starts at boot)\n`
            : process.platform === "darwin"
              ? `start-on-boot: not registered — run \`oxmgr service install\` to enable\n`
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
        if (argsUsePortless(effArgs)) {
          process.stdout.write(`  web console: ${localUrl}\n`);
        } else if (port !== null) {
          process.stdout.write(`  ay ls   ${token}@<host>:${port}\n`);
          process.stdout.write(`  ay remote add <alias> http://${token}@<host>:${port}\n`);
        }
      }
      process.stdout.write(`  ay serve logs                # view server logs\n`);
      process.stdout.write(`  ay serve uninstall           # remove daemon\n`);
      await emitShareLink();
    }
    return code ?? 1;
  }

  if (sub === "logs") {
    const proc = Bun.spawn([mgr.bin, "logs", DAEMON_NAME, ...args], {
      stdio: ["ignore", "inherit", "inherit"],
      env: liveEnv(),
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
  const mgr = await resolveActiveManager();
  const token = await loadTokenReadOnly();
  const shareLink = await readShareLink();

  // A non-null arg list means the daemon is registered with the manager.
  const daemonArgs = mgr ? await readDaemonServeArgs(mgr) : null;
  const installed = daemonArgs !== null;
  const a = daemonArgs ?? [];
  const local = argsUsePortless(a);
  const port = local ? await portlessAppPort() : portFromArgs(a);
  const localUrl = local ? await resolvedPortlessConsoleUrl(token ?? undefined) : null;
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
          localUrl: httpish ? localUrl : null,
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
    w(`mode:         ${mode}${httpish ? (local ? `  (${localUrl})` : `  (port ${port})`) : ""}`);
    if (a.length) w(`args:         ${a.join(" ")}`);
  } else {
    w(`installed:    no — start a daemon with:  ay serve install [--share]`);
  }
  if (runningVersion !== null) {
    const tag = runningVersion === current ? "up to date" : `outdated (current v${current})`;
    w(
      `http api:     reachable ${local ? `via ${localUrl}` : `on 127.0.0.1:${port}`} — v${runningVersion} (${tag})`,
    );
  } else if (mode === "webrtc") {
    w(`http api:     none (webrtc-only)`);
  } else {
    w(
      `http api:     not reachable ${local ? `via ${localUrl}` : `on 127.0.0.1:${port}`} (not running)`,
    );
  }
  w(`token:        ${token ?? "(none yet — created on first serve)"}`);
  if (shareLink) w(`share link:   ${shareLink}`);
  if (token && httpish) {
    w();
    if (local) w(`console:  ${localUrl}`);
    else if (port !== null) {
      w(`connect:  ay ls   ${token}@<host>:${port}`);
      w(`          ay remote add <alias> http://${token}@<host>:${port}`);
    }
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
        `  --port N          Bypass Portless and listen on a fixed HTTP port\n` +
        `  --host HOST       Interface to bind (default: 127.0.0.1; use 0.0.0.0 to expose)\n` +
        `  --token TOKEN     Auth token (auto-generated and saved if omitted)\n` +
        `  -d, --daemon      Install these flags as a background daemon (pm2/oxmgr)\n` +
        `                    (same as: ay serve install <flags>)\n` +
        `  --local           Explicitly use Portless (the default for HTTP mode)\n` +
        `                    ${portlessConsoleUrl()}\n` +
        `  --allow-spawn     Deprecated no-op — the console can always spawn agents\n` +
        `  --tls-cert FILE   TLS certificate PEM\n` +
        `  --tls-key  FILE   TLS private key PEM\n\n` +
        `Subcommands:\n` +
        `  ay serve install    install as background daemon (oxmgr; pm2 fallback on Windows without the winfix build)\n` +
        `  ay serve status     show daemon/server status (add --json for scripts)\n` +
        `  ay serve uninstall  remove daemon\n` +
        `  ay serve logs       view daemon logs\n\n` +
        `Once running, connect from another machine:\n` +
        `  ay ls   <token>@<host>:<port>\n` +
        `  ay remote add <alias> http://<token>@<host>:<port>\n`,
    );
    return 0;
  }

  // Daemon subcommands
  const sub = rest[0];
  if (sub === "status") return cmdServeStatus(rest.slice(1));
  if (sub === "healthcheck") {
    // oxmgr --health-cmd liveness probe. Exit non-zero only when the heartbeat is
    // demonstrably stale (event loop wedged), so the manager restarts us. A
    // missing/just-started/unparseable heartbeat is treated as healthy to avoid
    // flapping a daemon that simply hasn't stamped yet.
    try {
      const raw = (await readFile(heartbeatPath(), "utf-8")).trim();
      const ts = Number(raw);
      // Only declare unhealthy on a VALID, genuinely-old stamp. Empty/partial/NaN
      // (Number("") === 0!) is treated as healthy so a torn read or a not-yet-
      // written file can't trigger a false restart. (Writes are atomic via
      // temp+rename, so a torn read shouldn't happen — this is belt-and-braces.)
      const age = Date.now() - ts;
      if (raw.length > 0 && Number.isFinite(ts) && ts > 0 && age > HEARTBEAT_STALE_MS) {
        process.stderr.write(`unhealthy: serve heartbeat stale by ${age}ms\n`);
        return 1;
      }
    } catch {
      /* no heartbeat yet — treat as healthy */
    }
    return 0;
  }
  if (sub === "install" || sub === "uninstall" || sub === "logs") {
    return cmdServeDaemon(sub, rest.slice(1));
  }

  const y = yargs(rest)
    .usage("Usage: ay serve [options]")
    .option("port", { type: "number", description: "Bypass Portless and listen on a fixed port" })
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
    .option("local", {
      type: "boolean",
      default: false,
      description: `Use Portless at ${portlessConsoleUrl()} (default for HTTP mode)`,
    })
    .option("allow-spawn", {
      type: "boolean",
      default: false,
      description: "Deprecated no-op — the console can always spawn agents",
    })
    .option("takeover", {
      type: "boolean",
      default: false,
      description:
        "If another ay serve already hosts this home's WebRTC room, stop it and take the room",
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

  const wantWebrtc = argv.webrtc !== undefined || argv.share !== undefined;
  const wantHttp = argv.http === true || argv.share !== undefined || argv.webrtc === undefined;
  const fixedPort = typeof argv.port === "number";
  const usePortless = wantHttp && !fixedPort;
  if (argv.local === true && fixedPort) {
    process.stderr.write("ay serve: --local and --port cannot be used together\n");
    return 1;
  }
  if (usePortless && process.env[PORTLESS_CHILD_ENV] !== "1" && process.env.PORTLESS !== "0") {
    return runWithPortless(rest);
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

  // Drop the AGENT_YES_PID we may have inherited from the shell/agent that
  // launched us. A serve daemon outlives that agent, but the env var sticks for
  // our whole lifetime; if left in place, freshAgentEnv() aside, any descendant
  // we spawn would be recorded with parent_pid = that long-dead agent, mis-rooting
  // the subagent tree. Clearing it once at startup makes console spawns clean
  // top-level agents regardless of the spawn path.
  delete process.env.AGENT_YES_PID;

  const port = (argv.port as number | undefined) ?? (Number(process.env.PORT) || DEFAULT_PORT);
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

  // Singleton WebRTC host per ~/.agent-yes: a second host joining the SAME
  // persisted room (~/.agent-yes/.share-room) fights the first over every
  // viewer connection — seen live as an unloadable share link plus the managed
  // daemon crash-looping under the health watchdog while an orphaned manual
  // `ay serve --webrtc` held the room. Fail fast with a pointer to the owner
  // instead of contending. HTTP-only serves skip this (port collisions already
  // fail naturally with EADDRINUSE). AGENT_YES_NO_SERVE_LOCK=1 opts out for
  // exotic multi-room setups (explicit webrtc:// URLs to different rooms).
  let releaseHostLock: (() => Promise<void>) | null = null;
  if (wantWebrtc && process.env.AGENT_YES_NO_SERVE_LOCK !== "1") {
    const lock = await acquireWebrtcHostLock({ takeover: argv.takeover === true });
    if (!lock.ok) {
      const o: ServeLockOwner | null = lock.owner;
      const since = o ? new Date(o.started_at).toLocaleString() : "unknown";
      process.stderr.write(
        `ay serve: another instance${o ? ` (pid ${o.pid}, started ${since})` : ""} already hosts this home's WebRTC room\n` +
          `  ay serve status              # inspect it\n` +
          `  ay serve --webrtc --takeover # stop it and take the room\n` +
          `  AGENT_YES_NO_SERVE_LOCK=1    # opt out (multi-room setups only)\n`,
      );
      return 1;
    }
    releaseHostLock = lock.release;
  }

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
        // Defense-in-depth: this title is remote-controlled text (an agent sets its
        // own terminal title) that the web console renders. The console escapes it,
        // but strip C0/C1 control bytes and cap the length at the SOURCE too, so a
        // hostile title can't smuggle control characters into any current/future
        // sink. Quotes are left intact (legitimate titles contain them) and handled
        // by the console's HTML escaper.
        if (title) {
          // eslint-disable-next-line no-control-regex
          title =
            title
              .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
              .slice(0, 256)
              .trim() || null;
        }
        titleCache.set(logFile, { size, mtimeMs, title });
        return title;
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  };

  // Per-agent federated terminal preview: last ~12 rendered TUI lines for the
  // /api/graph feed's renderHints.preview (rgui draws them as a real TUI card —
  // see lib/rgui src/render/terminalPreview.ts). Cached per (size, mtime) like
  // logTitle so a 5s feed poll over a big fleet stays cheap. Coarse redaction at
  // the SOURCE: secret-shaped lines are dropped to "···" and long credential-ish
  // blobs masked — the feed is token-gated, but tails travel to other rgui hosts.
  const previewCache = new Map<string, { size: number; mtimeMs: number; lines: string[] | null }>();
  const SECRETISH =
    /(api[-_]?key|secret|token|password|passwd|bearer|authorization|private[-_]?key)\s*[=:]/i;
  const logPreviewLines = async (logFile: string | null | undefined): Promise<string[] | null> => {
    if (!logFile) return null;
    try {
      const { size, mtimeMs } = await stat(logFile);
      const hit = previewCache.get(logFile);
      if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.lines;
      const raw = await renderLogTailLines(logFile, 12);
      const lines =
        raw?.map((ln) =>
          SECRETISH.test(ln) ? "···" : ln.replace(/[A-Za-z0-9+/_-]{40,}/g, "····").slice(0, 160),
        ) ?? null;
      while (lines?.length && !lines[lines.length - 1]!.trim()) lines.pop();
      previewCache.set(logFile, { size, mtimeMs, lines });
      return lines;
    } catch {
      return null;
    }
  };

  // Per-agent task progress ({done,total}) parsed from the agent's rendered TUI
  // screen (the durable raw log). Cached per (size, mtime) exactly like logTitle:
  // re-parse only when the log grew, so the 1s tick stays cheap even though each
  // parse renders a log window through xterm. Works for every CLI — the source is
  // the drawn todo block, not a CLI-specific session file. See extractTaskCounts.
  const taskCache = new Map<
    string,
    { size: number; mtimeMs: number; tasks: { done: number; total: number } | null }
  >();
  const logTasks = async (
    logFile: string | null | undefined,
  ): Promise<{ done: number; total: number } | null> => {
    if (!logFile) return null;
    try {
      const { size, mtimeMs } = await stat(logFile);
      const hit = taskCache.get(logFile);
      if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.tasks;
      const tasks = await extractTaskCounts(logFile);
      taskCache.set(logFile, { size, mtimeMs, tasks });
      return tasks;
    } catch {
      return null;
    }
  };

  // Per-agent status badges/flags (see badges.ts) matched against the agent's
  // rendered screen — e.g. an active /goal Stop-hook loop. Cached per
  // (size, mtime) exactly like logTasks. Extend BADGE_DEFS in badges.ts to
  // surface more patterns (error banners, other flags); no server changes
  // needed beyond that.
  const badgeCache = new Map<string, { size: number; mtimeMs: number; badges: string[] }>();
  const logBadges = async (logFile: string | null | undefined): Promise<string[]> => {
    if (!logFile) return [];
    try {
      const { size, mtimeMs } = await stat(logFile);
      const hit = badgeCache.get(logFile);
      if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.badges;
      const badges = await extractBadges(logFile);
      badgeCache.set(logFile, { size, mtimeMs, badges });
      return badges;
    } catch {
      return [];
    }
  };

  // Per-agent live status description from the rendered screen. Claude Code
  // paints a spinner/status line while working; surfacing it lets the left panel
  // show "what it's doing" without opening the terminal.
  const statusTextCache = new Map<
    string,
    { size: number; mtimeMs: number; statusText: string | null }
  >();
  const logStatusText = async (logFile: string | null | undefined): Promise<string | null> => {
    if (!logFile) return null;
    try {
      const { size, mtimeMs } = await stat(logFile);
      const hit = statusTextCache.get(logFile);
      if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.statusText;
      const lines = await renderLogTailLines(logFile, 40);
      const statusText = lines ? parseStatusText(lines) : null;
      statusTextCache.set(logFile, { size, mtimeMs, statusText });
      return statusText;
    } catch {
      return null;
    }
  };

  // Per-agent "waiting on you" detection: the agent is parked on an interactive
  // menu it did NOT auto-resolve (config `needsInput` patterns). Same source and
  // classifier as `ay ls` / `ay status`, so the console's dot matches the CLI's
  // needs_input. Cached per (size, mtime) exactly like logTitle/logTasks — each
  // miss renders a log window through xterm, so the 1s list tick stays cheap on
  // an idle fleet. Returns the pending question text (surfaced in the UI), or
  // null when the agent isn't blocked.
  const niCache = new Map<string, { size: number; mtimeMs: number; question: string | null }>();
  const logNeedsInput = async (
    logFile: string | null | undefined,
    cli: string,
  ): Promise<string | null> => {
    if (!logFile) return null;
    try {
      const { size, mtimeMs } = await stat(logFile);
      const hit = niCache.get(logFile);
      if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.question;
      const ni = await extractNeedsInput(logFile, cli);
      const question = ni?.question ?? null;
      niCache.set(logFile, { size, mtimeMs, question });
      return question;
    } catch {
      return null;
    }
  };

  // Per-repo git snapshot for the list (branch + dirty/changed + ahead/behind, from
  // one `git status --porcelain=v2 --branch`). v2 (not v1) so the submodule field
  // lets us split real file changes from submodule pin-drift, which would otherwise
  // inflate `changed` — in a superproject with many submodules the constant gitlink
  // drift buries the real edits. WATCHER-INVALIDATED, not polled: a read
  // returns the cached snapshot instantly and NEVER spawns `git status` on the
  // request path. A per-repo-root fs watcher recomputes (debounced) only when the
  // repo actually changes, so an idle fleet costs ~0 git processes. The old design
  // forked one `git status` per agent every poll tick — with dozens of agents that
  // concurrent fan-out pinned host load (high load-average, low CPU: fork + I/O,
  // not compute). Modeled on VSCode's git extension: watch + debounce, no interval
  // poll (just a slow safety recompute for events a watcher might miss).
  interface GitInfo {
    branch: string | null;
    dirty: boolean;
    changed: number; // real file changes (excludes submodule pin-bumps & internal dirt)
    pins: number; // submodule gitlinks pointing at new commit(s) — pin-bump/drift
    subDirty: number; // submodule has internal changes but its recorded pin is unchanged
    ahead: number;
    behind: number;
  }
  const GIT_DEBOUNCE_MS = 800; // coalesce a burst of edits into one recompute
  const GIT_SAFETY_MS = 60_000; // backstop recompute for any missed watch event
  const runGit = async (args: string[], cwd: string): Promise<string | null> => {
    try {
      const proc = Bun.spawn(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "ignore",
        signal: AbortSignal.timeout(2000),
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return proc.exitCode === 0 ? out : null;
    } catch {
      return null; // git missing, not a repo, or timed out
    }
  };
  const parseGitStatus = (out: string): GitInfo => {
    // porcelain=v2 --branch: "# branch.*" headers then one line per changed entry.
    let branch: string | null = null;
    let ahead = 0;
    let behind = 0;
    let changed = 0; // real file changes
    let pins = 0; // submodule pin-bumps (gitlink → new commit)
    let subDirty = 0; // submodule internal dirt, recorded pin unchanged
    for (const line of out.split("\n")) {
      if (line.length === 0) continue;
      if (line[0] === "#") {
        // "# branch.head <name|(detached)>" and "# branch.ab +A -B" (ab absent
        // when there's no upstream). branch.head carries the name even on an
        // unborn branch, so no special-casing needed.
        const head = /^# branch\.head (.+)$/.exec(line);
        if (head) {
          branch = head[1] === "(detached)" ? null : head[1]!;
          continue;
        }
        const ab = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
        if (ab) {
          ahead = Number(ab[1]);
          behind = Number(ab[2]);
        }
        continue;
      }
      // Changed-entry lines. Untracked ("?") and unmerged ("u") are always real
      // work; ignored ("!") never appears (we don't pass --ignored). For ordinary
      // ("1") / renamed ("2") entries the 3rd space-delimited token is the
      // submodule field <sub>: "N..." for a normal path, or "S<c><m><u>" for a
      // submodule where c=C means its gitlink moved to new commit(s) (pin-bump),
      // and m/u flag internal dirty/untracked with the recorded pin unchanged.
      // Paths (which may contain spaces) come after token 2, so counting by token
      // index is robust without -z.
      const type = line[0];
      if (type === "?") {
        changed++;
      } else if (type === "u") {
        changed++;
      } else if (type === "1" || type === "2") {
        const sub = line.split(" ")[2] ?? "N...";
        if (sub[0] === "S") {
          if (sub[1] === "C") pins++;
          else subDirty++;
        } else {
          changed++;
        }
      }
    }
    return { branch, dirty: changed > 0, changed, pins, subDirty, ahead, behind };
  };
  // cwd -> repo root ("" = resolved, not a repo). Resolved once per cwd via a cheap
  // `git rev-parse --show-toplevel` (no tree scan) and cached, so many agents in the
  // same repo (or its submodules/subdirs) share one watcher + snapshot.
  const rootOfCwd = new Map<string, string>();
  const resolveRoot = async (cwd: string): Promise<string> => {
    const cached = rootOfCwd.get(cwd);
    if (cached !== undefined) return cached;
    const root = ((await runGit(["rev-parse", "--show-toplevel"], cwd)) ?? "").trim();
    rootOfCwd.set(cwd, root);
    return root;
  };
  interface RepoWatch {
    val: GitInfo | null;
    busy: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  }
  const repoWatch = new Map<string, RepoWatch>();
  const recompute = (root: string, rw: RepoWatch) => {
    if (rw.timer) return; // a recompute is already queued (debounce + throttle)
    rw.timer = setTimeout(async () => {
      rw.timer = null;
      if (rw.busy) return void recompute(root, rw); // re-arm if one is in flight
      rw.busy = true;
      try {
        const out = await runGit(["status", "--porcelain=v2", "--branch"], root);
        if (out != null) rw.val = parseGitStatus(out);
      } finally {
        rw.busy = false;
      }
    }, GIT_DEBOUNCE_MS);
  };
  const ensureRepoWatch = (root: string): RepoWatch => {
    const existing = repoWatch.get(root);
    if (existing) return existing;
    const rw: RepoWatch = { val: null, busy: false, timer: null };
    repoWatch.set(root, rw);
    recompute(root, rw); // initial snapshot
    // Ignore high-churn paths that never change `git status` output: our own log
    // dir (.agent-yes, written on every PTY byte — would re-trigger forever),
    // gitignored deps (node_modules), and git's own lock files.
    const onChange = (file: string) => {
      if (file.includes(".agent-yes") || file.includes("node_modules") || file.endsWith(".lock"))
        return;
      recompute(root, rw);
    };
    try {
      // macOS/Windows: one recursive watcher (FSEvents/ReadDirectoryChanges) covers
      // the working tree (dirty) AND .git (branch/ahead-behind) cheaply.
      watch(root, { recursive: true }, (_e, f) => onChange(String(f ?? "")));
    } catch {
      // Recursive watch unsupported (some Linux/Bun builds): watch .git only —
      // catches commit/branch/stage instantly; dirty count rides the safety tick.
      try {
        watch(path.join(root, ".git"), (_e, f) => onChange(".git/" + String(f ?? "")));
      } catch {
        /* no watcher available — rely solely on the safety recompute */
      }
    }
    setInterval(() => recompute(root, rw), GIT_SAFETY_MS);
    return rw;
  };
  const gitStatus = async (cwd: string | null | undefined): Promise<GitInfo | null> => {
    if (!cwd) return null;
    const root = await resolveRoot(cwd);
    if (!root) return null; // not a git repo
    return ensureRepoWatch(root).val; // cached — the request path never spawns `git status`
  };

  // Denoised "last meaningful stdin" tracking — drives the console's stdin flash
  // and the `stdin` sort order. The FIFO's mtime alone is too noisy: xterm forwards
  // the agent TUI's terminal-protocol auto-replies (cursor-position / device-
  // attributes reports) to stdin, so a mere resize/redraw would bump it and the row
  // would false-flash. So we stamp what WE write, split two ways: `meaningfulStdinAt`
  // skips those auto-replies; `anyDaemonWriteAt` records every write we make. A FIFO
  // mtime NEWER than any write we made can only be a local `ay send` (which writes
  // the FIFO directly, bypassing us) — always meaningful — so it still counts. See
  // resolveLastStdinAt below and the /api/send handler that stamps these.
  const meaningfulStdinAt = new Map<number, number>();
  const anyDaemonWriteAt = new Map<number, number>();
  // isTerminalReply (ts/terminalReply.ts) spots payloads that are purely such
  // auto-replies — incl. the DECXCPR `ESC[?r;cR` form and bursts of several
  // replies concatenated in one chunk — so they never count as meaningful.
  // Stamp both maps after a daemon FIFO write, keyed off the FIFO's post-write mtime
  // (so `anyDaemonWriteAt` is exactly our write's mtime — an external write bumps it
  // strictly higher, which is how resolveLastStdinAt tells them apart with no clock skew).
  const noteStdinWrite = async (pid: number, fifo: string, meaningful: boolean) => {
    const mt = await stat(fifo)
      .then((s) => s.mtimeMs)
      .catch(() => null);
    if (mt == null) return;
    anyDaemonWriteAt.set(pid, mt);
    if (meaningful) meaningfulStdinAt.set(pid, mt);
  };
  // last_stdin_at for a record: newest of (a) the last meaningful write we made and
  // (b) a FIFO write we did NOT make (a local `ay send`, always meaningful). A mtime
  // at/below our last write means the newest write was ours → use the meaningful stamp
  // (which excludes auto-replies); a strictly newer mtime is an external real write.
  const resolveLastStdinAt = async (r: { pid: number; fifo_file?: string | null }) => {
    const meaningful = meaningfulStdinAt.get(r.pid) ?? null;
    if (!r.fifo_file) return meaningful;
    const mtime = await stat(r.fifo_file)
      .then((s) => s.mtimeMs)
      .catch(() => null);
    if (mtime == null) return meaningful;
    return mtime > (anyDaemonWriteAt.get(r.pid) ?? 0) ? mtime : meaningful;
  };

  // One agent record decorated for the console: the latest OSC title + a git
  // snapshot (skipped for exited agents — their repo state is no longer live).
  const withMeta = async (r: Awaited<ReturnType<typeof listRecords>>[number]) => {
    // The stored `status` field lags (the wrapper's idle mirror is fire-and-forget),
    // so the console showed agents as "active" long after they went quiet. Derive
    // the LIVE status here — same liveness+log-mtime basis as `ay ls` — so the
    // console's dot (and the browser tab glyph) flips to idle in step with `ay ls`.
    const status = await deriveLiveStatus(r);
    // "Waiting on you": alive, quiet, but parked on an unanswered menu. Checked
    // only for live agents, and skipped when unresponsive (the Rust wedge signal
    // wins) — mirroring deriveLiveState's precedence in `ay ls` so the console's
    // dot and the CLI agree.
    const question =
      status !== "exited" && !r.unresponsive ? await logNeedsInput(r.log_file, r.cli) : null;
    // Last-active time: the log file's mtime, i.e. when the agent last wrote
    // output (stdout). The console's left panel shows the age off this instead
    // of started_at, so a long-lived-but-quiet agent reads as stale, not "new".
    // Falls back to started_at when there's no log yet (freshly spawned).
    const lastActiveAt = r.log_file
      ? await stat(r.log_file)
          .then((s) => s.mtimeMs)
          .catch(() => r.started_at)
      : r.started_at;
    // Last-stdin time: when this agent was last fed MEANINGFUL input — a real
    // keystroke, the console composer, or an `ay send` (local or remote) — but NOT
    // the TUI's terminal-protocol auto-replies, which would otherwise make a resize
    // or redraw look like input. The console flashes a row when this advances (so a
    // collaborator sees input land even when they weren't the one sending it) and can
    // sort by it. See resolveLastStdinAt / noteStdinWrite. Null for exited agents.
    const lastStdinAt = status !== "exited" ? await resolveLastStdinAt(r) : null;
    return {
      ...r,
      last_active_at: lastActiveAt,
      last_stdin_at: lastStdinAt,
      // Precedence: exited stays exited; the Rust supervisor's unresponsive flag is
      // an authoritative wedge signal (`stuck`); then a blocked menu (`needs_input`);
      // else the base live status — so the console's dot matches `ay ls`. (A dead
      // agent is never unresponsive — Rust clears the flag on exit.)
      status:
        status === "exited" ? status : r.unresponsive ? "stuck" : question ? "needs_input" : status,
      // The pending menu/question text when needs_input, for the console to show
      // WHAT the agent is waiting on. Null otherwise.
      question,
      title: await logTitle(r.log_file),
      status_text: status === "exited" ? null : await logStatusText(r.log_file),
      git: status === "exited" ? null : await gitStatus(r.cwd),
      // Task progress from the rendered todo block (null when none detected → no
      // badge). Skipped for exited agents — their screen is no longer live.
      tasks: status === "exited" ? null : await logTasks(r.log_file),
      // Status flags matched against the rendered screen (see badges.ts) — e.g.
      // an active /goal loop. [] when none matched or for exited agents. The
      // time-derived "typing" chip (user typing at the terminal) is appended
      // from the stdin-activity marker, not the screen — same chip `ay ls` shows.
      badges:
        status === "exited"
          ? []
          : await logBadges(r.log_file).then(async (b) =>
              (await isUserTyping(r.pid)) ? [...b, TYPING_BADGE.id] : b,
            ),
    };
  };

  // Multi-peer presence blackboard: viewerId -> what that viewer is watching +
  // its viewport/selection. Purely cosmetic ("who else is looking at this agent"),
  // never a security surface — viewers self-report. Pruned by TTL on read.
  const presence = new Map<
    string,
    {
      viewer: string;
      agent: string;
      cols: number;
      rows: number;
      sel: string | null;
      cap: SizeCap | null;
      ts: number;
    }
  >();
  const PRESENCE_TTL_MS = 12_000;

  // ── PTY size negotiation — tmux's "smallest client wins" ──────────────────
  // Writable viewers report their readable capacity (`cap`) alongside their
  // presence; we resize the agent's PTY to the elementwise min across live caps
  // (see sizeNego.ts), so a phone gets a grid it can read while wider viewers
  // letterbox the shared canvas. Uses the same winsize-file + SIGWINCH path as
  // POST /api/resize. When the last cap leaves (viewer switched agent, tab
  // died → TTL), the size is withdrawn: the file is deleted ONLY if its content
  // is still our own last write (so `ay attach`'s pushed size is never
  // clobbered) and the wrapper falls back to the real tty size.
  //
  // Two guards keep the withdraw from CAUSING the churn it exists to undo:
  //  • grace: quick switch-away-and-back (⌘↑/⌘↓ cycling) must not reflow the
  //    TUI twice, so the last negotiated size lingers NEGO_WITHDRAW_GRACE_MS
  //    after the final cap leaves before the file is removed.
  //  • headless agents (console-spawned, `ps -o tty=` says "??") have NO real
  //    terminal to yield to — withdrawing would drop the wrapper to its 80×24
  //    default and visibly shrink every future open. For them the negotiated
  //    size persists until the next viewer arrives.
  const negoApplied = new Map<number, { cols: number; rows: number; content: string }>();
  const negoTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const negoCapsGoneAt = new Map<number, number>(); // pid → when the last cap left
  const NEGO_DEBOUNCE_MS = 350;
  const NEGO_WITHDRAW_GRACE_MS = 30_000;
  // Does the agent have a real controlling terminal? Darwin/Linux `ps` prints
  // "??"/"?" for none. Errors (ps missing, pid gone) and Windows report
  // "no tty" — the safe side, since withdrawing is what needs a tty to exist.
  const hasRealTty = (pid: number): boolean => {
    if (process.platform === "win32") return false;
    try {
      const out = execFileSync("ps", ["-o", "tty=", "-p", String(pid)], {
        timeout: 2000,
      })
        .toString()
        .trim();
      return out !== "" && !out.includes("?");
    } catch {
      return false;
    }
  };
  const winsizePathFor = (pid: number) =>
    path.join(
      process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes"),
      "winsize",
      String(pid),
    );
  const liveCapsFor = (pid: number): SizeCap[] => {
    const now = Date.now();
    const caps: SizeCap[] = [];
    for (const v of presence.values())
      if (now - v.ts <= PRESENCE_TTL_MS && String(v.agent) === String(pid) && v.cap)
        caps.push(v.cap);
    return caps;
  };
  const applyNego = async (pid: number) => {
    negoTimers.delete(pid);
    const eff = negotiateSize(liveCapsFor(pid));
    const file = winsizePathFor(pid);
    const prev = negoApplied.get(pid);
    try {
      if (eff) {
        negoCapsGoneAt.delete(pid); // caps are back — cancel any pending withdraw
        // ±1-cell dead band: a viewer's reported capacity jitters by a row/col
        // between visits (open-time layout vs steady state), and a 1-cell
        // SIGWINCH reflow on every re-visit is exactly the churn users notice.
        if (prev && Math.abs(prev.cols - eff.cols) <= 1 && Math.abs(prev.rows - eff.rows) <= 1)
          return;
        const content = `${eff.cols} ${eff.rows} ${Date.now()}\n`;
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content);
        negoApplied.set(pid, { ...eff, content });
      } else {
        if (!prev) return;
        // Headless agent: nothing to yield to — keep the negotiated size until
        // the next viewer shows up (the wrapper would otherwise snap to 80×24).
        if (!hasRealTty(pid)) return;
        // Grace: hold the size briefly so ⌘-cycling away and back doesn't
        // reflow the TUI twice. The 5s sweep re-runs this until it expires.
        const gone = negoCapsGoneAt.get(pid);
        if (!gone) {
          negoCapsGoneAt.set(pid, Date.now());
          return;
        }
        if (Date.now() - gone < NEGO_WITHDRAW_GRACE_MS) return;
        negoApplied.delete(pid);
        negoCapsGoneAt.delete(pid);
        try {
          // withdraw only what we wrote — a different content means ay attach
          // (or a direct /api/resize) owns the size now; leave it alone.
          if ((await readFile(file, "utf-8")) !== prev.content) return;
          await unlink(file);
        } catch {
          return; // already gone — nothing to signal
        }
      }
      try {
        process.kill(pid, "SIGWINCH");
      } catch {
        /* agent gone */
      }
    } catch {
      /* best-effort: a failed write just leaves the previous size in place */
    }
  };
  const scheduleNego = (pid: number) => {
    if (!Number.isFinite(pid) || pid <= 0 || negoTimers.has(pid)) return;
    negoTimers.set(
      pid,
      setTimeout(() => void applyNego(pid), NEGO_DEBOUNCE_MS),
    );
  };
  // TTL grow-back sweep: a viewer that vanished without clearing its presence
  // (tab killed, phone locked) stops refreshing; once its entry expires the
  // negotiated size must be recomputed even though no presence POST arrives.
  setInterval(() => {
    for (const pid of negoApplied.keys()) scheduleNego(pid);
  }, 5_000);

  // The whole API as a plain handler: served over HTTP by Bun.serve (--http)
  // and called in-process by the WebRTC bridge (--webrtc) — the latter needs
  // no TCP port at all.
  const apiFetch = async (req: Request, srv?: { upgrade: (r: Request, o?: unknown) => boolean }): Promise<Response> => {
    if (!checkAuth(req, token)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(req.url);
    const p = url.pathname;

    // GET /api/mux — WebSocket request multiplexer. HTTP/1.1 gives a browser
    // ~6 concurrent same-origin connections and no multiplexing, so console
    // bursts (a palette query fans out ~20 tail reads + a history search)
    // queue behind each other for seconds. The mux carries {id, method, path,
    // body} frames over ONE socket and answers {id, status, text} — each frame
    // is dispatched through THIS same handler (with the socket's token), so
    // there is exactly one API surface. Streams (SSE) don't fit req/res
    // frames and stay on EventSource; the handler refuses them.
    if (p === "/api/mux" && srv && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const muxToken = url.searchParams.get("token") || "";
      if (srv.upgrade(req, { data: { muxToken } })) return undefined as unknown as Response;
      return new Response("expected websocket", { status: 426 });
    }

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

    // GET /api/search?q= — chat-history search across every agent's log.
    // v1 ("simple" scope, by design): no sidecar index yet — each agent's raw
    // log TAIL (SEARCH_TAIL_BYTES) is rendered through the same headless-xterm
    // path the reader uses (so TUI redraw spam collapses into real transcript
    // lines) and cached by (size, mtime); only agents whose log moved re-render.
    // Requests scan newest-first under a time budget and return partial:true
    // when the budget ran out before the fleet was covered — the console just
    // re-queries and hits the now-warm cache. Upgrade path: an incremental
    // transcript sidecar + full-history index (see the /api/ws pattern).
    if (req.method === "GET" && p === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 2) return Response.json({ hits: [], scanned: 0, total: 0, partial: false });
      const ql = q.toLowerCase();
      const budget = Math.min(3000, Number(url.searchParams.get("budget_ms")) || 900);
      const t0 = Date.now();
      try {
        const records = await listRecords(undefined, defaultOpts({ all: true }));
        // newest activity first — the log mtime is the stop/activity clock.
        const stats = await Promise.all(
          records.map(async (r) => ({
            r,
            st: r.log_file ? await stat(r.log_file).catch(() => null) : null,
          })),
        );
        const live = stats
          .filter((x) => x.st)
          .sort((a, b) => (b.st!.mtimeMs || 0) - (a.st!.mtimeMs || 0));
        const hits: unknown[] = [];
        let scanned = 0;
        let partial = false;
        for (const { r, st } of live) {
          if (hits.length >= SEARCH_MAX_HITS) break;
          if (Date.now() - t0 > budget) {
            partial = true;
            break;
          }
          const key = String(r.pid);
          let ent = searchTextCache.get(key);
          if (!ent || ent.size !== st!.size || ent.mtimeMs !== st!.mtimeMs) {
            try {
              const fh = await open(r.log_file!, "r");
              let buf: Uint8Array;
              try {
                if (st!.size <= SEARCH_TAIL_BYTES) {
                  const data = await fh.readFile();
                  buf = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                } else {
                  const tmp = Buffer.alloc(SEARCH_TAIL_BYTES);
                  const { bytesRead } = await fh.read(
                    tmp,
                    0,
                    SEARCH_TAIL_BYTES,
                    st!.size - SEARCH_TAIL_BYTES,
                  );
                  buf = new Uint8Array(tmp.buffer, 0, bytesRead);
                }
              } finally {
                await fh.close();
              }
              const geom = (await readPtysize(r.pid).catch(() => null)) ?? undefined;
              const lines = await renderRawLogLines(buf, geom ?? undefined);
              ent = { size: st!.size, mtimeMs: st!.mtimeMs, text: lines.join("\n") };
              searchTextCache.set(key, ent);
              // bound the cache: drop the oldest entries past the cap
              if (searchTextCache.size > SEARCH_CACHE_MAX) {
                const k = searchTextCache.keys().next().value;
                if (k !== undefined) searchTextCache.delete(k);
              }
            } catch {
              continue; // unreadable log — skip this agent
            }
          } else {
            // refresh LRU position
            searchTextCache.delete(key);
            searchTextCache.set(key, ent);
          }
          scanned++;
          const tl = ent.text.toLowerCase();
          const idx = tl.lastIndexOf(ql); // latest occurrence reads most relevant
          if (idx < 0) continue;
          const from = Math.max(0, idx - 60);
          const snippet = ent.text
            .slice(from, idx + ql.length + 60)
            .replace(/\s+/g, " ")
            .trim();
          hits.push({ pid: r.pid, cli: r.cli, cwd: r.cwd, snippet, match_at: idx });
        }
        return Response.json({ hits, scanned, total: live.length, partial });
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

    // GET /api/edges — recent inter-agent relationship edges for the /rgui + /w
    // wire view. Two directional, ephemeral edge sets:
    //   reads — agent `by` read/tailed agent `target` (from ~/.agent-yes/reads.jsonl)
    //   sends — agent `by` sent `target` a message/key/select (from the per-cwd
    //           outbox logs); carries the send `kind` so the UI can style it.
    // Both are last-minute windows the client fades out by `at`.
    if (req.method === "GET" && p === "/api/edges") {
      try {
        const [reads, sends] = await Promise.all([recentReadEdges(), recentMessageEdges()]);
        return Response.json({ reads, sends });
      } catch (e) {
        return new Response((e as Error).message, { status: 500 });
      }
    }

    // GET /api/graph — the fleet as a read-only federated rgui graph envelope
    // (org.rgui.graph.v1 — see lib/rgui src/core/federation.ts) so other rgui
    // hosts (otoji.org etc.) can mirror it. A REDACTED projection of /api/ls:
    // pid, cli type, status and the parent/subagent shape only — no cwd, prompt,
    // question, or terminal bytes ever leave through this route. CORS-open on
    // purpose: read-only + redacted, and the serve token still gates it like
    // every /api route (hand out the feed URL with ?token=). The newest codex
    // agent is ALSO exposed under the shared demo-chain id
    // ay://agent-yes/codex-agent so cross-system edges have a stable target.
    if (req.method === "GET" && p === "/api/graph") {
      try {
        const records = await listRecords(undefined, defaultOpts());
        // ONE namespace for the whole feed: ns == `${producer.app}://${producer.origin}`
        // == every node id's prefix, so a consumer can enforce "a feed only
        // speaks for its own namespace" with a plain prefix check. The machine
        // name is metadata (producer.deviceId/label), NOT part of the namespace —
        // the shared demo-chain id ay://agent-yes/codex-agent must live in the
        // same ns as the rest of the fleet or enforcement would drop it.
        const origin = "agent-yes";
        const ns = `ay://${origin}`;
        const textIn = { id: "text-in", label: "text", kind: "text" };
        const textOut = { id: "text-out", label: "text", kind: "text" };
        // otoji environment-node adoption: agents also carry an `env` input fed
        // by ONE host environment node (below) — "this fleet runs on this
        // machine". Only the HOST is published as an environment; worktree envs
        // stay local-only (their cwd paths are exactly what this route redacts).
        const envIn = { id: "env", label: "env", kind: "environment" };
        const envOut = { id: "env", label: "env", kind: "environment" };
        const envNodeId = `${ns}/env-${hostname()}`;
        const byWrapper = new Map(records.map((r) => [r.wrapper_pid ?? r.pid, r.pid]));
        const nid = (pid: number) => `${ns}/${pid}`;
        // renderHints.preview: the REAL agent TUI tail (redacted in
        // logPreviewLines), drawn by rgui's federatedTerminalPreview as a live
        // terminal card on the mirroring host
        // renderHints.embed: the publisher's own single-agent live view — the
        // consumer iframes it over the node rect (preview stays the LOD
        // fallback). Carries the serve token: the feed itself is gated by the
        // same token, so its consumers hold it already.
        const embedBase = `${url.protocol}//${url.host}`;
        // node size mirrors the agent's REAL PTY aspect so a consumer that
        // derives height from width (otoji chain slots) shows the embed with no
        // letterboxing. Terminal cells are ~1:2 (w:h), so px aspect = cols/(2*rows).
        const NODE_W = 520;
        const sizeOf = async (pid: number) => {
          const s = await readPtysize(pid).catch(() => null);
          const aspect = s?.cols && s?.rows ? s.cols / (2 * s.rows) : 2;
          return { w: NODE_W, h: Math.round(Math.min(NODE_W * 2, Math.max(96, NODE_W / aspect))) };
        };
        const hintsOf = async (r: (typeof records)[number]) => {
          const embed = {
            url: `${embedBase}/r/#node=${r.pid}&embed&k=${encodeURIComponent(token)}`,
          };
          const lines = await logPreviewLines(r.log_file);
          if (!lines?.length) return { embed };
          const title = (await logTitle(r.log_file)) ?? `${r.cli} #${r.pid}`;
          return { embed, preview: { kind: "terminal", title, status: r.status, lines } };
        };
        const nodes = await Promise.all(
          records.map(async (r, i) => ({
            id: nid(r.pid),
            app: "agent-yes",
            type: `${r.cli}-agent`,
            title: `${r.cli} #${r.pid}`,
            category: "agent-yes",
            owner: `agent-yes:${hostname()}`,
            status: r.status,
            parent:
              r.parent_pid && byWrapper.has(r.parent_pid)
                ? nid(byWrapper.get(r.parent_pid)!)
                : undefined,
            pos: { x: (i % 8) * (NODE_W + 64), y: Math.floor(i / 8) * 480 },
            size: await sizeOf(r.pid),
            inputs: [textIn, envIn],
            outputs: [textOut],
            renderHints: await hintsOf(r),
          })),
        );
        // The host environment node: identity + capability flags only (no cwd,
        // no load numbers — health telemetry stays behind /api/host).
        nodes.push({
          id: envNodeId,
          app: "agent-yes",
          type: "environment",
          title: `env @ ${hostname()}`,
          category: "environment",
          owner: `agent-yes:${hostname()}`,
          status: "active",
          parent: undefined,
          pos: { x: -NODE_W - 96, y: 0 },
          size: { w: NODE_W, h: 160 },
          inputs: [],
          outputs: [envOut],
          renderHints: undefined,
          configPublic: {
            scope: "native-device",
            runtime: "native",
            caps: {
              send: true,
              kill: true,
              spawn: true,
              spawnHook: hasSpawnHook(),
              provision: hasProvisionHook(),
            },
          },
        } as unknown as (typeof nodes)[number]); // configPublic is envelope-legal but absent from the agent-node literal type
        const codex = records
          .filter((r) => r.cli === "codex")
          .sort((a, b) => (b.last_active_at ?? 0) - (a.last_active_at ?? 0))[0];
        nodes.push({
          id: "ay://agent-yes/codex-agent",
          app: "agent-yes",
          type: "codex-agent",
          title: "Codex Agent",
          category: "agent-yes",
          owner: `agent-yes:${hostname()}`,
          status: codex?.status ?? "offline",
          parent: undefined,
          pos: { x: 0, y: -560 },
          size: codex ? await sizeOf(codex.pid) : { w: NODE_W, h: 260 },
          inputs: [textIn, envIn],
          outputs: [textOut],
          renderHints: codex ? await hintsOf(codex) : undefined,
        });
        const present = new Set(nodes.map((n) => n.id));
        const edges: {
          source: { node: string; port: string; type: string };
          target: { node: string; port: string; type: string };
          status: string;
          label?: string;
        }[] = (await recentReadEdges())
          .filter((e) => e.by !== e.target && present.has(nid(e.target)) && present.has(nid(e.by)))
          .map((e) => ({
            source: { node: nid(e.target), port: "text-out", type: "text" },
            target: { node: nid(e.by), port: "text-in", type: "text" },
            status: "readonly",
            label: "reads",
          }));
        // env wiring: host environment → each ROOT agent (children inherit the
        // environment through containment — wiring every agent would be noise)
        for (const n of nodes) {
          if (n.id === envNodeId || n.parent) continue;
          edges.push({
            source: { node: envNodeId, port: "env", type: "environment" },
            target: { node: n.id, port: "env", type: "environment" },
            status: "readonly",
          });
        }
        return Response.json(
          {
            kind: "rgui-federated-graph",
            schema: "org.rgui.graph.v1",
            producer: {
              app: "ay",
              origin,
              deviceId: hostname(),
              label: `agent-yes fleet @ ${hostname()}`,
            },
            revision: Date.now(),
            ts: Date.now(),
            graph: { nodes, edges },
            capabilities: {
              nodeTypes: [...new Set(nodes.map((n) => n.type))],
              portTypes: ["text", "environment"],
            },
          },
          { headers: { "Access-Control-Allow-Origin": "*" } },
        );
      } catch (e) {
        return new Response((e as Error).message, { status: 500 });
      }
    }

    // GET /api/whoami — this host's device label (user@host), so a remote
    // console can tag each agent with the machine it came from. Unlike codehost,
    // `ay serve --share` carries no per-agent device id; the viewer fetches this
    // once per room and stamps it. os.userInfo()/hostname() are cross-platform
    // (Windows included), so every machine reports a name, not just Unix ones.
    if (req.method === "GET" && p === "/api/whoami") {
      let user = "";
      try {
        // Bun's userInfo() doesn't always throw on a uid with no /etc/passwd
        // entry (arbitrary-uid / minimal containers) — it can return the literal
        // "unknown". Treat that (and "") as a miss so the fallbacks run; without
        // this a root container surfaced as `unknown@host`, not `root@host`.
        const u = userInfo().username;
        if (u && u !== "unknown") user = u;
      } catch {
        /* userInfo can still throw outright on some platforms */
      }
      user ||= process.env.USER || process.env.LOGNAME || process.env.USERNAME || "";
      // Last resort on Unix: resolve the uid against the passwd db directly,
      // which returns `root` for uid 0 even when the env carries no USER.
      if (!user && process.platform !== "win32") {
        try {
          user = execFileSync("id", ["-un"], { encoding: "utf8" }).trim();
        } catch {
          /* no `id` on PATH — leave user blank, host-only label */
        }
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

    // GET /api/spawn-config — read-only disclosure of WHETHER a host-local spawn
    // hook is configured. Deliberately returns only a boolean, never the hook
    // body: the hook is arbitrary local code and console/room clients holding the
    // share token are not necessarily host admins. Setting it stays host-local
    // (edit ~/.agent-yes/config.json) — there is no PUT.
    if (req.method === "GET" && p === "/api/spawn-config") {
      return Response.json({
        hasSpawnHook: hasSpawnHook(),
        hasProvisionHook: hasProvisionHook(),
        // the CLIs /api/spawn accepts, so the console can render a picker
        // instead of a free-text field (unknown values 400 anyway)
        clis: SUPPORTED_CLIS,
      });
    }

    // GET /api/host — this machine as an ENVIRONMENT: identity + live health
    // (load, memory) + what the environment permits (capability flags, otoji
    // environment-node style). The /rgui viewer renders it as the host env node
    // every agent implicitly runs inside. Read-only, token-gated like the rest;
    // loadavg is [0,0,0] on Windows — the viewer treats that as "n/a".
    if (req.method === "GET" && p === "/api/host") {
      return Response.json({
        host: hostname(),
        platform: platform(),
        arch: arch(),
        cpus: cpus().length,
        loadavg: loadavg(),
        mem: { total: totalmem(), free: freemem() },
        uptime: uptime(),
        caps: {
          send: true, // the console can always drive agent stdin
          kill: true,
          spawn: true, // /api/spawn is always on; hooks below shape it
          spawnHook: hasSpawnHook(),
          provision: hasProvisionHook(),
        },
      });
    }

    // GET /api/ws — every workspace under the codehost layout
    // (<wsRoot>/<owner>/<repo>/tree/<branch>) with live-agent counts. This is
    // what the console's ⌘K "/ws" browser renders: unlike /api/ls it also shows
    // workspaces with NO agents in them, so you can spawn into an idle checkout.
    // Read-only and cheap (a directory walk, no git); per-workspace git state is
    // fetched lazily via /api/ws/status below. 501 mirrors the fork path when
    // codehost/provision isn't installed on this host.
    if (req.method === "GET" && p === "/api/ws") {
      const ws = await import("./ws.ts");
      try {
        await ws.loadProvision();
      } catch (e) {
        return new Response((e as Error).message, { status: 501 });
      }
      try {
        const { wsRoot, workspaces } = await ws.collectWorkspaces();
        return Response.json({ schema: ws.WS_JSON_SCHEMA, wsRoot, workspaces });
      } catch (e) {
        return new Response(`workspace walk failed: ${(e as Error).message}`, { status: 500 });
      }
    }

    // GET /api/ws/status?path=<dir> — one workspace's git state (dirty / ahead /
    // behind / no-upstream) + live-agent count. The path must sit inside the
    // workspace root: this endpoint runs `git status` on the directory, and a
    // console client with the share token is not necessarily a host admin, so it
    // must not be able to probe arbitrary host paths.
    if (req.method === "GET" && p === "/api/ws/status") {
      const dirRaw = url.searchParams.get("path");
      if (!dirRaw) return new Response("missing ?path=<workspace dir>", { status: 400 });
      const ws = await import("./ws.ts");
      let prov: Awaited<ReturnType<typeof ws.loadProvision>>;
      try {
        prov = await ws.loadProvision();
      } catch (e) {
        return new Response((e as Error).message, { status: 501 });
      }
      const wsRoot = prov.resolveWsRoot(getProvisionRoot());
      const dir = path.resolve(dirRaw);
      if (!ws.isPathInside(wsRoot, dir))
        return new Response(`path is outside the workspace root ${wsRoot}`, { status: 400 });
      if (!existsSync(path.join(dir, ".git")))
        return new Response(`not a workspace checkout (no .git): ${dir}`, { status: 404 });
      try {
        const workspace = await ws.workspaceStatus(dir);
        return Response.json({ schema: ws.WS_JSON_SCHEMA, workspace });
      } catch (e) {
        return new Response(`git status failed: ${(e as Error).message}`, { status: 502 });
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
        const size = await readPtysize(record.pid);
        const text = await renderRawLog(buf, { mode, n, cols: size?.cols, rows: size?.rows });
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
        const size = await readPtysize(record.pid);
        return Response.json({
          pid: record.pid,
          cols: size?.cols ?? null,
          rows: size?.rows ?? null,
          // This host negotiates the PTY size from viewer capacities (presence
          // `cap`) — a capable console should report its cap instead of pushing
          // /api/resize directly, so viewers stop fighting last-writer-wins.
          nego: true,
        });
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

        // Assigned inside start(); called by BOTH the stream's cancel() and the
        // req.signal abort listener, so client-disconnect teardown can't leak.
        let cleanup = () => {};
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
            const flush = async (viaPoll = false) => {
              if (closed || reading || !fh) return;
              reading = true;
              try {
                const { size } = await fh.stat();
                if (size < offset) offset = size; // truncated/rotated
                if (size > offset) {
                  // The safety-net poll found appended bytes the watcher never
                  // announced — suspicious: the watcher may be dead (a
                  // long-lived daemon can reach a state where fs.watch
                  // callbacks stop firing process-wide; observed alongside the
                  // node-datachannel native-stack pathologies), leaving every
                  // keystroke echo riding the slow poll (~500ms felt lag). But
                  // a HEALTHY watcher's callback may merely be queued behind
                  // this very tick (sparse append landing just before the poll,
                  // with lastWatcherFireAt stale from an idle stretch) — so
                  // verify before demoting: give it 100ms to fire, and only
                  // then demote this stream to the fast poll it would have used
                  // had watch() failed outright.
                  if (
                    viaPoll &&
                    watcher &&
                    !demoteCheck &&
                    Date.now() - lastWatcherFireAt > POLL_WATCHED - 50
                  ) {
                    const suspectAt = Date.now();
                    demoteCheck = setTimeout(() => {
                      demoteCheck = null;
                      if (closed || !watcher) return;
                      if (lastWatcherFireAt >= suspectAt) return; // fired since — healthy
                      try {
                        watcher.close();
                      } catch {
                        /* already dead */
                      }
                      watcher = null;
                      clearInterval(poller);
                      poller = setInterval(() => void flush(true), POLL_UNWATCHED);
                    }, 100);
                  }
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

            let lastWatcherFireAt = Date.now(); // grace at open — see demotion above
            let demoteCheck: ReturnType<typeof setTimeout> | null = null;
            let watcher: ReturnType<typeof watch> | null = null;
            try {
              watcher = watch(logPath, () => {
                lastWatcherFireAt = Date.now();
                void flush();
              });
            } catch {
              /* fs.watch unsupported — the fallback poll below still works */
            }
            // When fs.watch is live it already gives instant echo, so the poll is
            // only a safety net → 500ms. Without a watcher it IS the primary path
            // → keep it at 60ms for low typing-echo latency. This matters when many
            // /api/tail streams are open at once (the /rgui viewer opens one per
            // node): N × a 60ms poll each was needless load on the event loop.
            // (If the watcher turns out to be dead, flush() demotes to 60ms.)
            const POLL_WATCHED = 500;
            const POLL_UNWATCHED = 60;
            let poller = setInterval(
              () => void flush(true),
              watcher ? POLL_WATCHED : POLL_UNWATCHED,
            );

            // Tear down on client disconnect via BOTH the req.signal 'abort'
            // listener and the stream's cancel() — whichever the runtime fires
            // (Bun uses abort here; other runtimes/paths may only cancel). `closed`
            // makes it idempotent so it runs exactly once and never leaks the
            // heartbeat/poller/fs-watcher/fd, however many /api/tail streams churn
            // (the /rgui viewer opens+drops one per node while panning/zooming).
            cleanup = () => {
              if (closed) return;
              closed = true;
              clearInterval(heartbeat);
              clearInterval(poller);
              if (demoteCheck) clearTimeout(demoteCheck);
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
            };
            req.signal.addEventListener("abort", cleanup);
          },
          cancel() {
            cleanup();
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

    // POST /api/send  body: {keyword, msg, code?, from?}
    if (req.method === "POST" && p === "/api/send") {
      let body: {
        keyword: string;
        msg: string;
        code?: string;
        from?: MailParty | null;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return new Response("invalid JSON body", { status: 400 });
      }
      const { keyword, msg = "", code = "enter", from = null } = body;
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
        // Record this write for the stdin flash / sort. A payload that is purely a
        // terminal auto-reply (xterm answering the TUI's cursor/DA query, forwarded
        // over this same wire) is protocol noise, not input — stamp anyDaemonWriteAt
        // but not the "meaningful" time, so a resize/redraw can't trip the flash.
        await noteStdinWrite(record.pid, record.fifo_file, !isTerminalReply(msg));
        // Record the recipient's inbox on THIS host (the sender records its own
        // outbox on its host). The sender crossed the wire, so `from.cwd` names a
        // path on another machine — mark it remote so the peer's cwd isn't misread
        // as local. Only real message bodies are logged. Best-effort.
        if (msg) {
          const senderParty: MailParty | null =
            from && typeof from === "object" && typeof from.pid === "number"
              ? {
                  pid: from.pid,
                  cli: String(from.cli ?? "?"),
                  cwd: String(from.cwd ?? ""),
                  agent_id: from.agent_id ?? undefined,
                }
              : null;
          await recordInbox({
            at: Date.now(),
            from: senderParty,
            to: {
              pid: record.pid,
              cli: record.cli,
              cwd: record.cwd,
              agent_id: record.agent_id,
            },
            body: msg,
            code: code.toLowerCase() === "enter" ? undefined : code.toLowerCase(),
            confirmed: true,
            wrapped: false,
            remote: senderParty ? "wire" : undefined,
          });
        }
        return Response.json({
          ok: true,
          pid: record.pid,
          cli: record.cli,
          cwd: record.cwd,
          agentId: record.agent_id ?? undefined,
        });
      } catch (e) {
        return new Response((e as Error).message, { status: 404 });
      }
    }

    // POST /api/kill  body {keyword}  — force-kill a stuck agent. The console can
    // already send keystrokes (Ctrl+C, /exit) via /api/send; this is the escalation
    // for an agent too wedged to respond to those: a real SIGKILL of its process
    // GROUP (wrapper + CLI + children), via the pgid the reaper recorded. The >1
    // guards are critical — process.kill(-1)/kill(0) would signal far too much.
    if (req.method === "POST" && p === "/api/kill") {
      let body: { keyword?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return new Response("invalid JSON body", { status: 400 });
      }
      const keyword = body.keyword;
      if (!keyword || typeof keyword !== "string")
        return new Response("missing keyword", { status: 400 });
      if (process.platform === "win32")
        return new Response("force-kill unsupported on a Windows serve", { status: 501 });
      try {
        const record = await resolveOne(keyword, defaultOpts({ all: true }));
        const killed: string[] = [];
        const sig = (target: number, label: string) => {
          if (!target || target <= 1) return;
          try {
            process.kill(target, "SIGKILL");
            killed.push(label);
          } catch {
            /* ESRCH: already gone */
          }
        };
        // Whole process group first (kills children too), then the pids directly in
        // case they aren't group leaders.
        const pgid = await pgidForWrapper(record.wrapper_pid ?? 0);
        if (pgid && pgid > 1) {
          try {
            process.kill(-pgid, "SIGKILL");
            killed.push(`group ${pgid}`);
          } catch {
            /* group already gone */
          }
        }
        sig(record.pid, `pid ${record.pid}`);
        if (record.wrapper_pid && record.wrapper_pid !== record.pid)
          sig(record.wrapper_pid, `wrapper ${record.wrapper_pid}`);
        await updateGlobalPidStatus(record.pid, {
          status: "exited",
          exit_reason: "force-killed via console",
        }).catch(() => {});
        return Response.json({ ok: true, pid: record.pid, killed });
      } catch (e) {
        return new Response((e as Error).message, { status: 404 });
      }
    }

    // POST /api/restart  body {keyword, fresh?} — the console-native `ay restart`:
    // stop the agent (if live) then relaunch it RESUMING its session. Restart is a
    // multi-second flow (graceful /exit → wait for exit → relaunch) that must
    // OUTLIVE this request and must NOT be a child of the agent it restarts — so we
    // kick it off as a detached `agent-yes restart` and return immediately; the
    // console sees the old→new pid swap over /api/ls/subscribe. This is why restart
    // is a real server action and not a prompt typed into the agent.
    if (req.method === "POST" && p === "/api/restart") {
      let body: { keyword?: string; fresh?: boolean };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return new Response("invalid JSON body", { status: 400 });
      }
      const keyword = body.keyword;
      if (!keyword || typeof keyword !== "string")
        return new Response("missing keyword", { status: 400 });
      try {
        const record = await resolveOne(keyword, defaultOpts({ all: true }));
        const args = ["restart", String(record.pid)];
        if (body.fresh) args.push("--fresh");
        // Resolve `ay` to an absolute command — same as the /api/spawn path below.
        // The detached daemon (oxmgr/launchd/pm2) usually has a PATH WITHOUT
        // ~/.bun/bin and ~/.cargo/bin, so a bare "agent-yes"/"ay" fails with
        // "Executable not found in $PATH" — the exact error the console surfaced on
        // restart. Prefer PATH; fall back to re-running THIS process's own ay entry
        // (process.argv[1]) — always present, since the daemon is itself an `ay serve`.
        const ayBin = Bun.which("ay") ?? process.argv[1];
        const ayCmd =
          process.platform === "win32" && ayBin.toLowerCase().endsWith(".exe")
            ? [ayBin]
            : [process.execPath, ayBin];
        const child = Bun.spawn([...ayCmd, ...args], {
          cwd: record.cwd,
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
        });
        child.unref();
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

    // POST /api/presence  body {viewer, agent, cols, rows, sel?} — a viewer
    // self-reports which agent it's watching + its viewport (agent=null clears).
    // POST /api/perf-beacon — a viewer that MEASURED slowness reports it here.
    // The console beacons (60s cadence, only when its window saw connect.fail
    // or p95 ≥ its slow threshold) over whatever transport it already has —
    // local fetch, /api/mux, or the room's WebRTC channel — so a slow PHONE
    // lands in the same place as a slow same-PC tab. Rows append to
    // <AGENT_YES_HOME>/perf-beacons.jsonl: purely local (no cloud/telemetry
    // service), and anything headless — an agent tailing the file, a cron —
    // can watch for slowness without driving a browser. Size-capped by
    // truncate-to-recent so it can't grow unbounded.
    if (req.method === "POST" && p === "/api/perf-beacon") {
      let b: { summary?: unknown; build?: string; ua?: string; room?: string; viewer?: string };
      try {
        b = (await req.json()) as typeof b;
      } catch {
        return new Response("invalid JSON body", { status: 400 });
      }
      try {
        const home = process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes");
        const file = path.join(home, "perf-beacons.jsonl");
        const line = JSON.stringify({
          t: Date.now(),
          room: String(b.room ?? "").slice(0, 64),
          viewer: String(b.viewer ?? "").slice(0, 64),
          build: String(b.build ?? "").slice(0, 16),
          ua: String(b.ua ?? "").slice(0, 120),
          summary: b.summary ?? null,
        });
        await mkdir(home, { recursive: true });
        await appendFile(file, line + "\n");
        // cap: keep the newest half once the file passes 4MB
        const st = await stat(file).catch(() => null);
        if (st && st.size > 4 * 1024 * 1024) {
          const txt = await readFile(file, "utf-8");
          await writeFile(file, txt.slice(Math.floor(txt.length / 2)).replace(/^[^\n]*\n/, ""));
        }
      } catch {
        /* best-effort — a failed beacon write must never error the viewer */
      }
      return new Response(null, { status: 204 });
    }

    if (req.method === "POST" && p === "/api/presence") {
      let b: {
        viewer?: string;
        agent?: string | number | null;
        cols?: number;
        rows?: number;
        sel?: string;
        cap?: { cols?: number; rows?: number };
      };
      try {
        b = (await req.json()) as typeof b;
      } catch {
        return new Response("invalid JSON body", { status: 400 });
      }
      const viewer = String(b.viewer ?? "").slice(0, 64);
      if (!viewer) return new Response("missing viewer", { status: 400 });
      // The agent this viewer WAS on — if the entry moves (agent switch) or
      // clears, that agent's negotiated size must be recomputed (grow-back).
      const prevAgent = presence.get(viewer)?.agent;
      if (b.agent == null) presence.delete(viewer);
      else
        presence.set(viewer, {
          viewer,
          agent: String(b.agent),
          cols: Math.max(0, Math.floor(Number(b.cols) || 0)),
          rows: Math.max(0, Math.floor(Number(b.rows) || 0)),
          sel: typeof b.sel === "string" ? b.sel.slice(0, 200) : null,
          cap: sanitizeCap(b.cap),
          ts: Date.now(),
        });
      if (b.agent != null) scheduleNego(Number(b.agent));
      if (prevAgent != null && String(prevAgent) !== String(b.agent ?? ""))
        scheduleNego(Number(prevAgent));
      return new Response(null, { status: 204 });
    }
    // GET /api/presence — all live viewers (TTL-pruned), for "who's watching".
    if (req.method === "GET" && p === "/api/presence") {
      const now = Date.now();
      const live: unknown[] = [];
      for (const [k, v] of presence) {
        if (now - v.ts > PRESENCE_TTL_MS) presence.delete(k);
        else live.push(v);
      }
      return Response.json(live);
    }

    // POST /api/spawn  body {cli, cwd?, from?, prompt?} — launch a new agent.
    // `from` (a GitHub URL / owner/repo@branch / owner/repo/tree/branch) is
    // resolved to a ready worktree via codehost/provision (the shared workspace
    // standard); otherwise `cwd` is resolved against the workspace root and
    // created if missing (Layer-0 plain-dir provisioning — no more ENOENT 500).
    if (req.method === "POST" && p === "/api/spawn") {
      let body: {
        cli?: string;
        cwd?: string;
        from?: string;
        prompt?: string;
        fork?: { fromCwd?: string; branch?: string };
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return new Response("invalid JSON body", { status: 400 });
      }
      const cli = String(body.cli ?? "claude");
      if (!SUPPORTED_CLIS.includes(cli as never))
        return new Response(`unsupported cli: ${cli}`, { status: 400 });
      const prompt = String(body.prompt ?? "");

      // Admission control BEFORE any provisioning (clone/worktree) so a capped
      // request fails fast without doing expensive work. Enforces the optional
      // concurrency cap + memory floor that keep a fan-out of agents from
      // driving the host into the OOM-killer. 429 = back-pressure, retry later.
      const reject = await spawnRejectionReason();
      if (reject) return new Response(reject, { status: 429 });

      // Resolve the working directory. A `from` source is provisioned (clone /
      // worktree) through codehost/provision; a plain `cwd` is resolved to the
      // workspace root and mkdir-p'd so a missing dir no longer ENOENTs.
      let cwd: string;
      let provisioned: { action: string; folder: string } | null = null;
      const fork =
        body.fork &&
        typeof body.fork.fromCwd === "string" &&
        body.fork.fromCwd.trim() &&
        typeof body.fork.branch === "string" &&
        body.fork.branch.trim()
          ? { fromCwd: body.fork.fromCwd.trim(), branch: body.fork.branch.trim() }
          : null;
      // A fork request that didn't resolve to a valid source must fail LOUDLY, not
      // silently fall through to the plain-`cwd` branch below — that would spawn
      // the agent in the workspace root (≈ where `ay serve` runs) instead of a
      // worktree off the intended branch, which looks like the agent "ignoring"
      // the fork. An empty/garbled fork object is a client bug; surface it as 400.
      if (body.fork != null && !fork)
        return new Response("fork requires a non-empty fromCwd and branch", { status: 400 });
      const from = typeof body.from === "string" ? body.from.trim() : "";
      if (fork) {
        // Fork the anchor agent's branch into a new sibling worktree via
        // codehost/provision (git worktree off HEAD, no clone), then spawn the
        // agent there. The fork is clean — committed work only; the source's
        // uncommitted changes stay put (codehost forkWorktree defaults wip:false,
        // and we don't opt in).
        let prov: {
          forkWorktree: (o: { fromCwd: string; branch: string; wsRoot?: string }) => Promise<{
            ok: boolean;
            folder: string;
            action: string;
            error?: string;
            spec?: { owner: string; repo: string };
          }>;
        };
        try {
          prov = (await import("codehost/provision")) as typeof prov;
        } catch (e) {
          return new Response(
            `fork needs the 'codehost' package (codehost/provision) — install it ` +
              `(npm i -g codehost) or 'bun link' it for local dev: ${(e as Error).message}`,
            { status: 501 },
          );
        }
        // koho-style provision gate — runs BEFORE the worktree + setup-repo.sh so
        // it can select the git identity for this fork; its exit code overrides
        // the allowlist. When no hook is configured, falls through to the allowlist
        // check after the fork resolves owner/repo.
        const forkOrigin = originOwnerRepo(fork.fromCwd);
        const forkHook = await runProvisionHook(fork.fromCwd, {
          KOHO_ACTION: "fork",
          KOHO_FROM_CWD: fork.fromCwd,
          KOHO_BRANCH: fork.branch,
          KOHO_OWNER: forkOrigin?.owner ?? "",
          KOHO_REPO: forkOrigin?.repo ?? "",
          KOHO_WS_ROOT: getProvisionRoot() ?? "",
        });
        if (forkHook.ran && !forkHook.ok)
          return new Response(
            `provision hook denied this fork (exit ${forkHook.code})` +
              (forkHook.detail ? `:\n${forkHook.detail}` : ""),
            { status: 403 },
          );
        let result: {
          ok: boolean;
          folder: string;
          action: string;
          error?: string;
          spec?: { owner: string; repo: string };
        };
        try {
          const wsRoot = getProvisionRoot();
          result = await prov.forkWorktree({
            fromCwd: fork.fromCwd,
            branch: fork.branch,
            ...(wsRoot ? { wsRoot } : {}),
          });
        } catch (e) {
          return new Response(`fork failed: ${(e as Error).message}`, { status: 502 });
        }
        if (!result?.ok) return new Response(result?.error ?? "fork failed", { status: 502 });
        // Allowlist gate — only when a provision hook did NOT already gate this
        // (a configured hook overrides the allowlist). The fork runs setup-repo.sh
        // (code exec), the same risk surface as `from`.
        if (
          !forkHook.ran &&
          result.spec &&
          !isProvisionAllowed(result.spec.owner, result.spec.repo)
        )
          return new Response(
            `forking '${result.spec.owner}/${result.spec.repo}' is not allowed — add the owner ` +
              `to provisionAllowlist in ~/.agent-yes/config.json (or "*" to allow all), ` +
              `or set a provisionHook to gate it yourself`,
            { status: 403 },
          );
        cwd = result.folder;
        provisioned = { action: result.action, folder: result.folder };
      } else if (from) {
        type Spec = { owner: string; repo: string; branch: string };
        let prov: {
          parseSource?: (s: string) => Spec | null;
          parseSpec: (s: string) => Spec | null;
          provision: (
            spec: Spec,
            opts?: { wsRoot?: string },
          ) => Promise<{ ok: boolean; folder: string; action: string; error?: string }>;
        };
        try {
          prov = (await import("codehost/provision")) as typeof prov;
        } catch (e) {
          return new Response(
            `spawn-from needs the 'codehost' package (codehost/provision) — install it ` +
              `(npm i -g codehost) or 'bun link' it for local dev: ${(e as Error).message}`,
            { status: 501 },
          );
        }
        // Malformed input (e.g. bad %-encoding) must surface as 400, not a 500.
        let spec: Spec | null;
        try {
          spec =
            typeof prov.parseSource === "function"
              ? prov.parseSource(from)
              : prov.parseSpec(normalizeGithubSource(from));
        } catch {
          spec = null;
        }
        if (!spec) return new Response(`unrecognized spawn source: ${from}`, { status: 400 });
        // Provisioning clones the repo and runs its setup script (dependency
        // installs + package lifecycle hooks = code execution on the host), so it
        // is gated. A koho-style provision hook, when configured, runs first (to
        // select the git identity for the clone) and its exit code IS the gate,
        // overriding the allowlist; otherwise the owner/repo allowlist gates it
        // (empty allowlist = deny all).
        const fromHook = await runProvisionHook(getProvisionRoot() ?? homedir(), {
          KOHO_ACTION: "from",
          KOHO_SOURCE: from,
          KOHO_OWNER: spec.owner,
          KOHO_REPO: spec.repo,
          KOHO_BRANCH: spec.branch,
          KOHO_WS_ROOT: getProvisionRoot() ?? "",
        });
        if (fromHook.ran) {
          if (!fromHook.ok)
            return new Response(
              `provision hook denied '${spec.owner}/${spec.repo}' (exit ${fromHook.code})` +
                (fromHook.detail ? `:\n${fromHook.detail}` : ""),
              { status: 403 },
            );
        } else if (!isProvisionAllowed(spec.owner, spec.repo)) {
          return new Response(
            `provisioning '${spec.owner}/${spec.repo}' is not allowed — add the owner to ` +
              `provisionAllowlist in ~/.agent-yes/config.json (or "*" to allow all), ` +
              `or set a provisionHook to gate it yourself`,
            { status: 403 },
          );
        }
        let result: { ok: boolean; folder: string; action: string; error?: string };
        try {
          const wsRoot = getProvisionRoot();
          result = await prov.provision(spec, wsRoot ? { wsRoot } : undefined);
        } catch (e) {
          return new Response(`provision failed: ${(e as Error).message}`, { status: 502 });
        }
        if (!result?.ok) return new Response(result?.error ?? "provision failed", { status: 502 });
        cwd = result.folder;
        provisioned = { action: result.action, folder: result.folder };
      } else {
        cwd = resolveSpawnCwd(body.cwd);
        try {
          await mkdir(cwd, { recursive: true });
        } catch (e) {
          return new Response(`cannot create cwd ${cwd}: ${(e as Error).message}`, { status: 500 });
        }
      }
      process.stderr.write(
        `→ console spawned:  ay ${cli}${prompt ? ` -- "${prompt.slice(0, 60)}"` : ""}  (cwd: ${cwd}${provisioned ? `, ${provisioned.action}` : ""})\n`,
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
      const agentArgv = [...ayCmd, cli, ...(prompt ? ["--", prompt] : [])];
      // don't leak our Claude Code session into the agent
      const agentEnv = freshAgentEnv();
      // Correlation id: the spawn response returns the `ay` LAUNCHER pid, which is
      // NOT the agent's registered pid — so the caller can't find the agent it just
      // spawned. Mint a 12-hex id (the agent_id format), inject it as
      // AGENT_YES_AGENT_ID, and return it. Both runtimes adopt it as their agent_id
      // (instead of minting a random one) and strip it from the wrapped CLI's env so
      // subagents don't inherit and collide. The caller can then address the agent
      // immediately: `ay <verb> <remote>:<agentId>`.
      const agentId = randomBytes(6).toString("hex");
      // Detach the agent into its OWN session (setsid). When `ay serve` runs WITH a
      // controlling terminal (started in a shell rather than as a headless daemon),
      // an undetached child inherits the daemon's session + controlling tty and lands
      // in a *background* process group. The first terminal op it makes then raises
      // SIGTTOU/SIGTTIN → the child is STOPPED before emitting any output (console
      // renders nothing), and the stop hits the whole group — freezing `ay serve`
      // itself. `detached: true` (setsid) gives the agent a fresh session with no
      // controlling terminal, immune to both. Matches the restart/openBrowser paths.
      try {
        const hook = getSpawnHook();
        if (hook) {
          // Host-local spawn hook (trusted local code, never network-writable). We
          // run it via POSIX `sh -c` then `exec "$@"` the real agent — the agent
          // argv is passed as positional params ($1…), so the prompt is NEVER
          // shell-parsed (no quoting/injection surface). `set -e` aborts the spawn
          // if any hook step fails. No `-l`: we don't re-source rc files here (the
          // env is already the recovered login-shell env via freshAgentEnv). cwd
          // and cli are exposed as env for the hook to consume.
          const shell = process.env.AGENT_YES_SPAWN_SHELL?.trim() || "/bin/sh";
          const script = `set -e\n${hook}\nexec "$@"`;
          const errPath = path.join(
            agentYesHome(),
            `spawn-hook-${process.pid}-${performance.now().toString(36).replace(".", "")}.err`,
          );
          // File-backed stderr never blocks the child (a pipe we stop draining
          // after exec would), and bounds our read to the first few KB.
          const child = Bun.spawn([shell, "-c", script, "ay-spawn", ...agentArgv], {
            cwd,
            detached: true,
            env: {
              ...agentEnv,
              AGENT_YES_CWD: cwd,
              AGENT_YES_CLI: cli,
              AGENT_YES_AGENT_ID: agentId,
            },
            stdin: "ignore",
            stdout: "ignore",
            stderr: Bun.file(errPath),
          });
          // Handshake: surface an EARLY hook/provision failure synchronously. If
          // the child exits non-zero within the window, the hook failed before the
          // agent settled — return the captured stderr. If it's still alive after
          // the window, `exec` succeeded (or the agent is running) → detach and
          // report success. We can't always attribute a failure to the hook vs the
          // agent, so we just surface the captured output.
          const windowMs = Number(process.env.AGENT_YES_SPAWN_HOOK_TIMEOUT_MS) || 5000;
          const exitCode = await Promise.race([
            child.exited,
            new Promise<null>((r) => setTimeout(() => r(null), windowMs)),
          ]);
          if (exitCode !== null && exitCode !== 0) {
            let detail = "";
            try {
              detail = (await Bun.file(errPath).text()).slice(0, 4096);
            } catch {
              /* no stderr captured */
            }
            await unlink(errPath).catch(() => {});
            return new Response(
              `spawn hook failed (exit ${exitCode})${detail ? `:\n${detail.trimEnd()}` : ""}`,
              { status: 502 },
            );
          }
          child.unref();
          // Clean up the stderr sidecar. On POSIX the running agent may still hold
          // the fd; unlinking an open file is harmless (the inode lives until
          // close), so a brief delay is enough to keep early-failure reads valid.
          setTimeout(() => void unlink(errPath).catch(() => {}), 60_000).unref?.();
          return Response.json({
            ok: true,
            pid: child.pid,
            agentId,
            cli,
            cwd,
            hook: true,
            ...(provisioned ? { provisioned } : {}),
          });
        }
        const child = Bun.spawn(agentArgv, {
          cwd,
          detached: true,
          env: { ...agentEnv, AGENT_YES_AGENT_ID: agentId },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        child.unref();
        return Response.json({
          ok: true,
          pid: child.pid,
          agentId,
          cli,
          cwd,
          ...(provisioned ? { provisioned } : {}),
        });
      } catch (e) {
        return new Response((e as Error).message, { status: 500 });
      }
    }

    // ---- Single-agent view-only shares (docs/agent-sharing.md, Option X) ------
    // Mint / list / revoke scoped share rooms. Reachable by whoever already holds
    // full control of this host (the local token or the master fleet room) — a
    // scoped viewer can't reach these (its scopedFetch 403s /api/share*).

    // POST /api/share  body {agent, perm?}  → mint a fresh view-only room for ONE
    // agent and return its share link.
    if (req.method === "POST" && p === "/api/share") {
      let body: { agent?: string; perm?: "r" | "rw" };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return new Response("invalid JSON body", { status: 400 });
      }
      if (!body.agent) return new Response("agent required", { status: 400 });
      const perm = body.perm ?? "r";
      if (perm !== "r" && perm !== "rw")
        return new Response(`invalid perm ${perm} (want r or rw)`, { status: 400 });
      try {
        const { createScopedShare } = await import("./agentShare.ts");
        const share = await createScopedShare({
          agent: body.agent,
          perm,
          localFetch: apiFetch,
          apiToken: token,
        });
        return Response.json(share);
      } catch (e) {
        const msg = (e as Error).message;
        const status = /too many active shares/.test(msg)
          ? 409
          : /no agent matched|no stable/.test(msg)
            ? 404
            : 500;
        return new Response(msg, { status });
      }
    }

    // GET /api/shares  → active scoped shares (for the manage/revoke UI).
    if (req.method === "GET" && p === "/api/shares") {
      const { listShares } = await import("./agentShare.ts");
      return Response.json(listShares());
    }

    // DELETE /api/share/:shareId  → revoke (close the room).
    const revokeM = /^\/api\/share\/([^/]+)$/.exec(p);
    if (req.method === "DELETE" && revokeM) {
      const { revokeShare } = await import("./agentShare.ts");
      const ok = revokeShare(decodeURIComponent(revokeM[1]!));
      return new Response(ok ? "revoked" : "no such share", { status: ok ? 200 : 404 });
    }

    // POST /api/expose  body {port}  → share 127.0.0.1:<port> through the edge
    // relay and return {url, claim} (a fresh single-use claim link each call).
    if (req.method === "POST" && p === "/api/expose") {
      let body: { port?: number; relay?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return new Response("invalid JSON body", { status: 400 });
      }
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return new Response("valid port required", { status: 400 });
      }
      try {
        const { ensureExposure } = await import("./expose.ts");
        const h = await ensureExposure(port, body.relay);
        return Response.json({
          id: h.id,
          port: h.port,
          url: h.url,
          claim: h.mintClaim(),
          createdAt: h.createdAt,
        });
      } catch (e) {
        return new Response(`expose failed: ${(e as Error).message}`, { status: 502 });
      }
    }

    // GET /api/exposes  → active port exposures (for the console's ports manager).
    if (req.method === "GET" && p === "/api/exposes") {
      const { listExposures } = await import("./expose.ts");
      return Response.json(listExposures());
    }

    // DELETE /api/expose/:port  → revoke (the URL then answers 502).
    const unexposeM = /^\/api\/expose\/(\d+)$/.exec(p);
    if (req.method === "DELETE" && unexposeM) {
      const { stopExposure } = await import("./expose.ts");
      const ok = stopExposure(Number(unexposeM[1]));
      return new Response(ok ? "revoked" : "no such exposure", { status: ok ? 200 : 404 });
    }

    return new Response("Not Found", { status: 404 });
  };

  // Web console: the lab UI served straight from the package, so --http needs
  // no separate proxy and no agent-yes.com. Static routes are unauthenticated
  // (the page holds no secrets); the page carries the token via the #k= link
  // and sends it on every /api call.
  const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lab", "ui");
  // Defense-in-depth CSP for the console document served by --http (mirrors the
  // one in lab/ui/cf/worker.ts — keep them in sync). The console renders remote
  // host-supplied agent metadata, so we constrain where an injection could send
  // data even though output is escaped. connect-src allows any wss: so custom
  // signaling hosts still work; 'self' covers same-origin /api + EventSource.
  const CONSOLE_CSP = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
    "connect-src 'self' https://s.agent-yes.com https://agent-yes.com wss:",
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join("; ");
  // The /r (rgui) page is embeddable: its #node=<pid>&embed view is the
  // federation renderHints.embed target, iframed by OTHER rgui hosts over the
  // node rect — so frame-ancestors opens up, unlike the console's 'none'.
  const RGUI_CSP = CONSOLE_CSP.replace("frame-ancestors 'none'", "frame-ancestors *")
    // #feed= mirrors fetch OTHER rgui hosts' envelopes (federation consumers):
    // otoji.org in prod, localhost/loopback for wrangler-dev feeds
    .replace(
      "connect-src 'self'",
      "connect-src 'self' https://otoji.org http://127.0.0.1:* http://localhost:*",
    );
  const serveUiFile = async (name: string, type: string, csp = CONSOLE_CSP): Promise<Response> => {
    try {
      const buf = await readFile(path.join(uiDir, name));
      const headers: Record<string, string> = { "Content-Type": type };
      if (type.includes("text/html")) headers["Content-Security-Policy"] = csp;
      return new Response(buf, { headers });
    } catch {
      return new Response("UI assets not found in this install — use the /api endpoints", {
        status: 404,
      });
    }
  };
  const httpFetch = async (req: Request, srv?: { upgrade: (r: Request, o?: unknown) => boolean }): Promise<Response> => {
    const p = new URL(req.url).pathname;
    if (req.method === "GET" && (p === "/" || p === "/index.html"))
      return serveUiFile("index.html", "text/html; charset=utf-8");
    // /r — the rgui forest page (built to lab/ui/rgui/dist by scripts/build-rgui.ts),
    // served here so renderHints.embed URLs work with no extra host. Relative
    // asset paths need the trailing slash, so bare /r redirects.
    if (req.method === "GET" && p === "/r") return Response.redirect("/r/", 302);
    if (req.method === "GET" && (p === "/r/" || p === "/r/index.html"))
      return serveUiFile("rgui/dist/index.html", "text/html; charset=utf-8", RGUI_CSP);
    if (req.method === "GET" && p === "/r/main.js")
      return serveUiFile("rgui/dist/main.js", "text/javascript; charset=utf-8");
    if (req.method === "GET" && p === "/r/main.js.map")
      return serveUiFile("rgui/dist/main.js.map", "application/json");
    if (req.method === "GET" && p === "/room-client.js")
      return serveUiFile("room-client.js", "text/javascript; charset=utf-8");
    if (req.method === "GET" && p === "/console-logic.js")
      return serveUiFile("console-logic.js", "text/javascript; charset=utf-8");
    // rtc.js is a STATIC import of the console module (import { RTCClient }) — a
    // 401 here fails the whole module link and the console never boots.
    if (req.method === "GET" && p === "/rtc.js")
      return serveUiFile("rtc.js", "text/javascript; charset=utf-8");
    if (req.method === "GET" && p === "/e2e.js")
      return serveUiFile("e2e.js", "text/javascript; charset=utf-8");
    if (req.method === "GET" && p === "/qrcode.js")
      return serveUiFile("qrcode.js", "text/javascript; charset=utf-8");
    // The PWA / preview Service Worker. Without it, --http never registers a SW
    // (so the in-console P2P preview can't proxy). Served at the console root so
    // its scope covers /p/<src>/<port>/*.
    if (req.method === "GET" && p === "/sw.js")
      return serveUiFile("sw.js", "text/javascript; charset=utf-8");
    if (req.method === "GET" && p === "/manifest.webmanifest")
      return serveUiFile("manifest.webmanifest", "application/manifest+json");
    if (req.method === "GET" && p === "/icon.svg") return serveUiFile("icon.svg", "image/svg+xml");
    if (req.method === "GET" && p === "/favicon.ico") return new Response(null, { status: 204 });
    return apiFetch(req, srv);
  };

  const serverOpts: any = {
    hostname: host,
    port,
    idleTimeout: 0, // never time out SSE/tail streams
    fetch: (req: Request, srv: unknown) =>
      httpFetch(req, srv as { upgrade: (r: Request, o?: unknown) => boolean }),
    // /api/mux frames — each one re-enters apiFetch as a synthetic Request
    // carrying the socket's token, so auth and routing stay single-sourced.
    websocket: {
      // Bun's per-socket idle cap; the console reconnects lazily on drop, but
      // don't let a quiet-but-alive console churn sockets every 2 minutes.
      idleTimeout: 960,
      message: async (ws: any, raw: string | Buffer) => {
        let m: { id?: number; method?: string; path?: string; body?: unknown };
        try {
          m = JSON.parse(String(raw));
        } catch {
          return; // not a mux frame — drop
        }
        const { id, method, path, body } = m || {};
        if (!id || typeof path !== "string" || !path.startsWith("/api/")) return;
        try {
          const tok = ws.data?.muxToken || "";
          const u =
            "http://mux.internal" +
            path +
            (tok ? (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(tok) : "");
          const req = new Request(u, {
            method: method || "GET",
            headers: body != null ? { "content-type": "application/json" } : undefined,
            body: body != null ? JSON.stringify(body) : undefined,
          });
          const res = await apiFetch(req);
          // Streams can't ride a req/res frame — refuse instead of buffering an
          // endless SSE body (subscribe stays on EventSource client-side).
          if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
            try {
              await res.body?.cancel();
            } catch {
              /* already closed */
            }
            ws.send(JSON.stringify({ id, status: 501, text: "streams not supported over mux" }));
            return;
          }
          const text = await res.text();
          ws.send(JSON.stringify({ id, status: res.status, text }));
        } catch (e) {
          try {
            ws.send(JSON.stringify({ id, status: 599, text: String((e as Error)?.message ?? e) }));
          } catch {
            /* socket gone */
          }
        }
      },
    },
  };
  if (useHttps) {
    serverOpts.tls = { cert: Bun.file(certPath!), key: Bun.file(keyPath!) };
  }

  let server: ReturnType<typeof Bun.serve> | null = null;
  if (wantHttp) {
    // A daemon restart can race the previous instance's port release (TIME_WAIT
    // / slow shutdown), so a single Bun.serve would EADDRINUSE and the daemon
    // would exit 1 straight into another restart. Retry with backoff first so a
    // restart self-heals; only give up (and let the manager back off) if the
    // port stays held — e.g. by an unrelated/stale process.
    for (let attempt = 0; ; attempt++) {
      try {
        server = Bun.serve(serverOpts);
        break;
      } catch (e) {
        const inUse = (e as { code?: string }).code === "EADDRINUSE";
        if (inUse && attempt < 5) {
          await Bun.sleep(Math.min(2000, 250 * 2 ** attempt));
          continue;
        }
        if (inUse) {
          // The port is wedged by something we can't evict — classically a dead
          // serve whose spawned child agents inherited its listen-socket handle
          // (on Windows the socket lacks non-inheritable/CLOEXEC semantics, so it
          // survives the parent and keeps :port LISTENING under a defunct PID).
          // Exiting here just feeds a pm2 restart loop that can never re-bind.
          // When WebRTC is also requested, degrade to WebRTC-only instead: the
          // console still reaches this machine peer-to-peer with no port, so the
          // daemon stays useful and stops crash-looping. Only give up when
          // there's no WebRTC transport to fall back to (pure --http).
          if (wantWebrtc) {
            process.stderr.write(
              `ay serve: port ${port} is still in use after retries — continuing WebRTC-only ` +
                `(HTTP API disabled). Free the port and restart to re-enable HTTP, ` +
                `or pick another with --port N.\n`,
            );
            server = null;
            break;
          }
          process.stderr.write(
            `ay serve: port ${port} is still in use after retries — pick another with --port N,\n` +
              `or run a port-free WebRTC-only share with: ay serve --webrtc\n`,
          );
          return 1;
        }
        throw e;
      }
    }

    // server is null only when we degraded to WebRTC-only above (port wedged);
    // skip the HTTP connection banner since nothing is listening on the port.
    if (server) {
      const listenPort = server.port;
      const uiHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
      process.stdout.write(`ay serve  ${scheme}://${host}:${listenPort}\n`);
      process.stdout.write(`token:    ${token}\n\n`);
      process.stdout.write(`web console (token in the # is eaten on open):\n`);
      process.stdout.write(
        `  ${usePortless ? portlessConsoleUrl(token) : `${scheme}://${uiHost}:${listenPort}/#k=${token}`}\n\n`,
      );
      process.stdout.write(`connect from another machine:\n`);
      process.stdout.write(`  ay ls   ${token}@<host>:${listenPort}\n`);
      process.stdout.write(`  ay tail ${token}@<host>:${listenPort}:<keyword>\n`);
      process.stdout.write(`  ay send ${token}@<host>:${listenPort}:<keyword> "message"\n\n`);
      process.stdout.write(`save as alias:\n`);
      process.stdout.write(`  ay remote add <alias> ${scheme}://${token}@<host>:${listenPort}\n\n`);
      if (!useHttps) {
        process.stdout.write(
          `for HTTPS: ay serve --tls-cert cert.pem --tls-key key.pem\n` +
            `  openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj '/CN=localhost'\n\n`,
        );
      }
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
          // Offer to open the console (default yes) on the FIRST share only —
          // an auto-rotation shouldn't pop a fresh tab from under the operator.
          if (!rotated) {
            const { offerOpenInBrowser } = await import("./openBrowser.ts");
            await offerOpenInBrowser(link);
          }
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
      if (!wantHttp) {
        // Release promptly so the manager's instant respawn doesn't have to
        // wait out the stale window to reclaim the host lock.
        await releaseHostLock?.().catch(() => {});
        return 1; // nothing else is running
      }
    }
  }

  // Liveness heartbeat (WebRTC daemons only — that's where the native stack can
  // freeze the loop). If the event loop wedges, this interval stops firing, the
  // file goes stale, and oxmgr's --health-cmd (ay serve healthcheck) restarts us.
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (wantWebrtc) {
    const stamp = () => {
      try {
        // Atomic: write a temp file then rename over the target, so a concurrent
        // `ay serve healthcheck` reader never sees a truncated/partial timestamp.
        const tmp = `${heartbeatPath()}.tmp`;
        writeFileSync(tmp, String(Date.now()));
        renameSync(tmp, heartbeatPath());
      } catch {
        /* best effort */
      }
    };
    stamp();
    heartbeat = setInterval(stamp, HEARTBEAT_WRITE_MS);
  }

  process.stdout.write(`(Ctrl-C to stop)\n`);

  const shutdown = (resolve: () => void) => {
    if (heartbeat) clearInterval(heartbeat);
    closeShare?.();
    // Close any scoped single-agent share rooms so viewers get an immediate drop.
    void import("./agentShare.ts").then((m) => m.revokeAllShares()).catch(() => {});
    server?.stop();
    // Gate exit on the lock release: resolve() ends cmdServe and the process,
    // and an un-awaited rm would race that exit — leaving a lock the next host
    // (a manager's instant respawn) must wait a full stale window to steal.
    void Promise.resolve(releaseHostLock?.())
      .catch(() => {})
      .then(resolve);
  };
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => shutdown(resolve));
    process.on("SIGTERM", () => shutdown(resolve));
  });

  return 0;
}
