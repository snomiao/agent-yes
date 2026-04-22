import { execFileSync } from "child_process";
import { existsSync, lstatSync, readlinkSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";
import pkg from "../package.json" with { type: "json" };

const CACHE_DIR = path.join(homedir(), ".cache", "agent-yes");
const CACHE_FILE = path.join(CACHE_DIR, "update-check.json");
const TTL_MS = 60 * 60 * 1000; // 1 hour

type UpdateCache = { checkedAt: number; latestVersion: string };

async function readUpdateCache(): Promise<UpdateCache | null> {
  try {
    const raw = await readFile(CACHE_FILE, "utf8");
    return JSON.parse(raw) as UpdateCache;
  } catch {
    return null;
  }
}

async function writeUpdateCache(data: UpdateCache): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(data));
}

function detectPackageManager(): string {
  if (
    process.env.BUN_INSTALL ||
    process.execPath?.includes("bun") ||
    process.env.npm_execpath?.includes("bun")
  )
    return "bun";
  return "npm";
}

/**
 * Check for updates, auto-install if newer version is available, and re-exec
 * so the current invocation always runs the latest code.
 *
 * Uses a 1-hour TTL cache to avoid hitting the registry on every run.
 * All errors are swallowed — network issues must never break the tool.
 * Set AGENT_YES_NO_UPDATE=1 to opt out.
 *
 * The AGENT_YES_UPDATED env var prevents infinite re-exec loops:
 * after updating we re-exec with AGENT_YES_UPDATED=<version> so the
 * new process skips the update check.
 */
export async function checkAndAutoUpdate(): Promise<void> {
  if (process.env.AGENT_YES_NO_UPDATE) return;

  // Prevent infinite re-exec: if we just updated, skip
  if (process.env.AGENT_YES_UPDATED) return;

  // Skip auto-update when running from a linked local dev checkout (git repo)
  if (import.meta.url.startsWith("file://") && !import.meta.url.includes("node_modules")) {
    const scriptDir = path.dirname(new URL(import.meta.url).pathname);
    const repoRoot = path.resolve(scriptDir, "..");
    if (existsSync(path.join(repoRoot, ".git"))) return;
  }

  try {
    let latestVersion: string | undefined;

    // Check cache TTL
    const cache = await readUpdateCache();
    if (cache && Date.now() - cache.checkedAt < TTL_MS) {
      latestVersion = cache.latestVersion;
    } else {
      // Fetch latest from registry
      const fetched = await fetchLatestVersion();
      if (!fetched) return;
      latestVersion = fetched;
      await writeUpdateCache({ checkedAt: Date.now(), latestVersion });
    }

    if (compareVersions(pkg.version, latestVersion) < 0) {
      const installed = await runInstall(latestVersion);
      if (installed) {
        reExec(latestVersion);
      }
    }
  } catch {
    // Silently ignore all errors
  }
}

async function runInstall(latestVersion: string): Promise<boolean> {
  const pm = detectPackageManager();
  const installCmd =
    pm === "bun"
      ? `bun add -g agent-yes@${latestVersion}`
      : `npm install -g agent-yes@${latestVersion}`;

  process.stderr.write(`\x1b[33m[agent-yes] Updating ${pkg.version} → ${latestVersion}…\x1b[0m\n`);
  try {
    const { execaCommand } = await import("execa");
    await execaCommand(installCmd, { stdio: "inherit" });
    process.stderr.write(`\x1b[32m[agent-yes] Updated to ${latestVersion}\x1b[0m\n`);
    return true;
  } catch {
    process.stderr.write(`\x1b[31m[agent-yes] Auto-update failed. Run: ${installCmd}\x1b[0m\n`);
    return false;
  }
}

/**
 * Re-exec the current process so the newly installed version runs.
 * Sets AGENT_YES_UPDATED=<version> to prevent an infinite loop.
 */
function reExec(version: string): never {
  const [bin, ...args] = process.argv;
  process.stderr.write(`\x1b[36m[agent-yes] Restarting with v${version}…\x1b[0m\n`);
  try {
    execFileSync(bin, args, {
      stdio: "inherit",
      env: { ...process.env, AGENT_YES_UPDATED: version },
    });
    process.exit(0);
  } catch (err: any) {
    process.exit(err.status ?? 1);
  }
}

/**
 * Fetch the latest version of the package from npm registry
 */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, {
      signal: AbortSignal.timeout(3000), // 3 second timeout
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { version: string };
    return data.version;
  } catch {
    // Silently fail if network is unavailable or request times out
    return null;
  }
}

/**
 * Compare two semantic versions
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;

    if (part1 > part2) return 1;
    if (part1 < part2) return -1;
  }

  return 0;
}

/**
 * Detect how agent-yes was installed.
 * Returns a short label: "git", "bun link", "bun", "npm", "npx", or "unknown"
 */
export function detectInstallMethod(): string {
  try {
    // Check if running from a file path outside node_modules (git clone / bun link dev)
    const scriptDir = path.dirname(new URL(import.meta.url).pathname);

    if (!scriptDir.includes("node_modules")) {
      // Running directly from source — is this a git repo?
      const repoRoot = path.resolve(scriptDir, "..");
      if (existsSync(path.join(repoRoot, ".git"))) {
        return "git";
      }
      return "source";
    }

    // Check if the node_modules entry is a symlink (bun link)
    const nodeModulesEntry = scriptDir.replace(/\/dist$/, "");
    try {
      const stat = lstatSync(nodeModulesEntry);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(nodeModulesEntry);
        // bun link creates a symlink to the local repo
        const resolvedTarget = path.resolve(path.dirname(nodeModulesEntry), target);
        if (existsSync(path.join(resolvedTarget, ".git"))) {
          return "bun link (git)";
        }
        return "bun link";
      }
    } catch {
      // not a symlink, continue
    }

    // Detect package manager from path or env
    if (scriptDir.includes(".bun/")) return "bun";
    if (scriptDir.includes(".npm/")) return "npx";
    if (process.env.npm_execpath?.includes("bun")) return "bun";
    if (process.env.npm_config_user_agent?.startsWith("bun")) return "bun";
    if (process.env.npm_config_user_agent?.startsWith("npm")) return "npm";

    return "npm";
  } catch {
    return "unknown";
  }
}

/**
 * Format version string with install method
 */
export function versionString(): string {
  return `agent-yes v${pkg.version} (${detectInstallMethod()})`;
}

/**
 * Display version information with async latest version check
 */
export async function displayVersion(): Promise<void> {
  console.log(versionString());

  const latestVersion = await fetchLatestVersion();

  if (latestVersion) {
    const comparison = compareVersions(pkg.version, latestVersion);

    if (comparison < 0) {
      console.log(`\x1b[33m${latestVersion} (update available)\x1b[0m`);
    } else if (comparison > 0) {
      console.log(`${latestVersion} (latest published)`);
    } else {
      console.log(`${latestVersion} (latest)`);
    }
  } else {
    console.log("(unable to check for updates)");
  }
}
