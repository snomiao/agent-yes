import { mkdirSync, readFileSync, writeFileSync } from "fs";
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
