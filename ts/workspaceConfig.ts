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
  const h = readConfig().spawnHook;
  if (!h || !h.trim()) return null;
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
  return h;
}

/** Whether a usable {@link getSpawnHook} is configured (for read-only disclosure). */
export function hasSpawnHook(): boolean {
  return getSpawnHook() !== null;
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
