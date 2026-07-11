import { lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { agentYesHome } from "./agentYesHome.ts";

/**
 * Machine-global agent-yes config (workspace root, etc.), stored alongside the
 * pid index and serve token under `agentYesHome()`. Kept tiny and synchronous —
 * it's read on the spawn hot path and written once during `ay setup`.
 *
 * The *workspace root* is the default directory new agents are spawned into when
 * the console doesn't pass an explicit cwd. It defaults to the user's home dir so
 * a non-engineer can just run agents in their files without knowing about paths.
 */

interface Config {
  workspace?: string;
  /** Root for `from`-provisioned worktrees (`<root>/<owner>/<repo>/tree/<branch>`). */
  provisionRoot?: string;
  /** Owners/repos permitted for `from`-provisioning; empty = deny all. */
  provisionAllowlist?: string[];
  /**
   * A trusted, HOST-LOCAL shell hook run before each console/CLI spawn. See
   * {@link getSpawnHook}. Intentionally NOT settable over the network — it is
   * arbitrary local code that runs on every spawn.
   */
  spawnHook?: string;
  /**
   * A trusted, HOST-LOCAL shell hook run before a `fork`/`from` provisioning git
   * op ("koho-style" provisioning). See {@link getProvisionHook}. When set it is
   * the provisioning GATE: exit 0 = allow (and it has prepared the environment,
   * e.g. `gh auth switch` to the right account), non-zero = deny — it OVERRIDES
   * {@link provisionAllowlist}. Like {@link spawnHook} it is arbitrary local code,
   * so it is intentionally NOT settable over the network.
   */
  provisionHook?: string;
  /**
   * Max number of concurrently-live agents the daemon will admit via
   * `/api/spawn`. `0`/unset = unlimited (current behavior). See {@link getMaxAgents}.
   */
  maxAgents?: number;
  /**
   * Refuse a new spawn when system MemAvailable is below this many MB — a memory
   * floor so a burst of spawns can't drive the host into the OOM-killer. `0`/unset
   * = no floor. See {@link getMinFreeMb}.
   */
  minFreeMb?: number;
  /**
   * How long (ms) a CLI spawn will block-and-wait for capacity (φ-backoff) before
   * failing open and proceeding anyway. Prevents a burst of recursive `ay <cli>`
   * spawns from storming the host while never permanently deadlocking a workflow.
   * Unset = default 10 min. See {@link getSpawnWaitMs}.
   */
  spawnWaitMs?: number;
}

function configPath(): string {
  return path.join(agentYesHome(), "config.json");
}

function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(configPath(), "utf-8")) as Config;
  } catch {
    return {};
  }
}

/** Expand a leading `~` (`~` or `~/x`) to an absolute home-based path. */
export function expandTilde(p: string): string {
  const s = p.trim();
  if (s === "~") return homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(homedir(), s.slice(2));
  return s;
}

/** The configured workspace root (absolute), or the home dir if unset. */
export function getWorkspaceRoot(): string {
  const w = readConfig().workspace;
  return w && w.trim() ? w : homedir();
}

/**
 * Root for `from`-provisioned worktrees, handed to codehost/provision so they
 * land in `<root>/<owner>/<repo>/tree/<branch>`. Resolution order: env
 * `CODEHOST_WS_ROOT` wins (ops override), then the configured `provisionRoot`,
 * else undefined — letting codehost/provision fall back to its own `~/ws`
 * default. Kept separate from `workspace` (the plain-cwd default), which may be a
 * specific project dir rather than a root.
 */
export function getProvisionRoot(): string | undefined {
  const env = process.env.CODEHOST_WS_ROOT?.trim();
  if (env) return path.resolve(expandTilde(env));
  const r = readConfig().provisionRoot;
  return r && r.trim() ? path.resolve(expandTilde(r)) : undefined;
}

/**
 * Owner/repo allowlist for `from`-provisioning. Provisioning clones a repo and
 * runs its setup script (dependency installs + package lifecycle hooks = code
 * execution on the host), so an **empty allowlist means DENY ALL** — a secure
 * default the host opts out of by listing owners it trusts. Entries match
 * `<owner>` (any repo of that owner), `<owner>/<repo>` (exact), or `*` (allow
 * all — an explicit opt-in to the wide-open behavior). Env
 * `CODEHOST_PROVISION_ALLOWLIST` (comma-separated) overrides the config.
 */
export function getProvisionAllowlist(): string[] {
  const env = process.env.CODEHOST_PROVISION_ALLOWLIST?.trim();
  const raw = env ? env.split(",") : (readConfig().provisionAllowlist ?? []);
  return raw.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Whether `<owner>/<repo>` may be `from`-provisioned, per {@link getProvisionAllowlist}. */
export function isProvisionAllowed(owner: string, repo: string): boolean {
  const list = getProvisionAllowlist();
  if (list.includes("*")) return true;
  const o = owner.toLowerCase();
  const full = `${owner}/${repo}`.toLowerCase();
  return list.some((e) => e.replace(/\/\*$/, "") === o || e === full);
}

/**
 * A trusted, HOST-LOCAL shell hook run before each agent spawn. It is a POSIX
 * `sh -c` script that prepares the environment (provisioning, env, cd) and that
 * agent-yes runs as `sh -c "set -e\n<hook>\nexec \"$@\"" ay-spawn <agent argv…>`
 * — so the real agent argv is passed as positional params and the prompt is
 * never shell-parsed. `set -e` aborts the spawn if any hook step fails.
 *
 * This is arbitrary local code that runs on EVERY spawn, so it is deliberately
 * NOT writable over the network. Set it on the machine by editing
 * `~/.agent-yes/config.json` (`"spawnHook"`), or via env `AGENT_YES_SPAWN_HOOK`.
 *
 * Tampering guard (POSIX): a file-backed hook is ignored when the config file is
 * a symlink, is not owned by us, or is group/world-writable — we refuse to run a
 * hook from a file other users can swap or rewrite. The env override is trusted
 * (it comes from the daemon's own environment). Returns null when unset/guarded.
 */
export function getSpawnHook(): string | null {
  const env = process.env.AGENT_YES_SPAWN_HOOK;
  if (env && env.trim()) return env;
  return configHookIfTrusted(readConfig().spawnHook);
}

/**
 * Return a config-file hook value only when the config file is safe to trust as
 * a source of code to run: not a symlink (can't be swapped out from under us),
 * owned by us, and not group/world-writable (no other user can rewrite it). The
 * env-var forms of these hooks bypass this — they come from the daemon's own
 * environment, which is already trusted. Returns null when unset or guarded out.
 */
function configHookIfTrusted(value: string | undefined): string | null {
  if (!value || !value.trim()) return null;
  if (process.platform !== "win32") {
    try {
      if (lstatSync(configPath()).isSymbolicLink()) return null;
      const st = statSync(configPath());
      if ((st.mode & 0o022) !== 0) return null; // group/world-writable
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null;
    } catch {
      return null;
    }
  }
  return value;
}

/** Whether a usable {@link getSpawnHook} is configured (for read-only disclosure). */
export function hasSpawnHook(): boolean {
  return getSpawnHook() !== null;
}

/**
 * A trusted, HOST-LOCAL shell hook run BEFORE a `fork`/`from` provisioning git
 * op — "koho-style" (codehost-style) provisioning. Env `AGENT_YES_PROVISION_HOOK`
 * overrides the config `provisionHook`; the config form is subject to the same
 * tamper guard as {@link getSpawnHook} ({@link configHookIfTrusted}).
 *
 * Its purpose is to prepare the host for provisioning — most usefully to select
 * the right git identity (e.g. `gh auth switch --user <who>`, keyed on the
 * `KOHO_OWNER`/`KOHO_REPO` env the caller exports) before the clone/worktree/
 * setup runs. When configured it is ALSO the provisioning gate: its exit code
 * decides admission (0 = allow, non-zero = deny), overriding
 * {@link getProvisionAllowlist}. Returns null when unset/guarded.
 */
export function getProvisionHook(): string | null {
  const env = process.env.AGENT_YES_PROVISION_HOOK;
  if (env && env.trim()) return env;
  return configHookIfTrusted(readConfig().provisionHook);
}

/** Whether a usable {@link getProvisionHook} is configured (for read-only disclosure). */
export function hasProvisionHook(): boolean {
  return getProvisionHook() !== null;
}

/**
 * Cap on concurrently-live agents admitted via `/api/spawn`. Env
 * `AGENT_YES_MAX_AGENTS` overrides the config `maxAgents`. A non-positive,
 * missing, or unparseable value means **unlimited** (returns undefined), which
 * preserves the historical no-cap behavior. Exists to stop an unbounded fan-out
 * of agents from exhausting host RAM and tripping the OOM-killer.
 */
export function getMaxAgents(): number | undefined {
  const raw = process.env.AGENT_YES_MAX_AGENTS?.trim();
  const n = raw !== undefined && raw !== "" ? Number(raw) : readConfig().maxAgents;
  // Floor BEFORE the >0 check: a fractional 0<n<1 would otherwise floor to 0 and
  // turn "invalid/unlimited" into "reject every spawn" (live >= 0 always true).
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : NaN;
  return v > 0 ? v : undefined;
}

/**
 * Minimum system MemAvailable (MB) required to admit a new spawn. Env
 * `AGENT_YES_MIN_FREE_MB` overrides config `minFreeMb`. Non-positive/unset =
 * no floor (undefined). Complements {@link getMaxAgents}: a count cap alone
 * can't stop OOM when individual agents are large, so we also refuse to spawn
 * when free memory is already low.
 */
export function getMinFreeMb(): number | undefined {
  const raw = process.env.AGENT_YES_MIN_FREE_MB?.trim();
  const n = raw !== undefined && raw !== "" ? Number(raw) : readConfig().minFreeMb;
  // Floor before the >0 check (see getMaxAgents) so a fractional value can't
  // collapse to a meaningless 0 floor.
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : NaN;
  return v > 0 ? v : undefined;
}

/**
 * Max time (ms) a CLI spawn blocks waiting for capacity before failing open.
 * Env `AGENT_YES_SPAWN_WAIT_MS` overrides config `spawnWaitMs`. A non-negative
 * finite value is used as-is (0 = don't wait, check once then proceed); anything
 * missing/garbage falls back to the 10-minute default. Bounded fail-open is
 * deliberate: recursive spawns must never deadlock permanently on each other.
 */
export function getSpawnWaitMs(): number {
  const DEFAULT = 600_000;
  const raw = process.env.AGENT_YES_SPAWN_WAIT_MS?.trim();
  const n = raw !== undefined && raw !== "" ? Number(raw) : readConfig().spawnWaitMs;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT;
}

/** Persist the workspace root, tilde-expanded and resolved to an absolute path. */
export function setWorkspaceRoot(dir: string): string {
  const abs = path.resolve(expandTilde(dir));
  const cfg = readConfig();
  cfg.workspace = abs;
  mkdirSync(agentYesHome(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  return abs;
}

/**
 * Resolve a user-supplied spawn location to an absolute cwd:
 * - empty            → the workspace root
 * - a bare name      → `<workspace>/<name>` (so "myproject" lands under the root)
 * - `~`-prefixed     → home-based absolute
 * - anything with a path separator → resolved as-is
 */
export function resolveSpawnCwd(input?: string): string {
  const root = getWorkspaceRoot();
  const v = (input ?? "").trim();
  if (!v) return root;
  if (v.startsWith("~")) return path.resolve(expandTilde(v));
  if (v.includes("/") || v.includes("\\") || path.isAbsolute(v)) return path.resolve(v);
  return path.join(root, v);
}
