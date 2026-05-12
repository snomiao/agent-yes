import { execFileSync } from "child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import bundledPkg from "../package.json" with { type: "json" };

const CACHE_DIR = path.join(homedir(), ".cache", "agent-yes");
const CACHE_FILE = path.join(CACHE_DIR, "update-check.json");
const TTL_MS = 60 * 60 * 1000; // 1 hour

// The release pipeline publishes both `agent-yes` and `claude-yes` from the
// same source by flipping `package.json#name` and re-running `npm publish`
// (which now triggers `bun run build`, rebuilding dist with whichever name is
// set). The auto-updater's registry lookup, install command, and shared
// cache file must all stay pinned to the canonical package — otherwise a
// `claude-yes` install would query `claude-yes/latest` while `runInstall`
// still hard-codes `agent-yes`.
const CANONICAL_PKG_NAME = "agent-yes";

let cachedInstalledPkg: { name: string; version: string } | null = null;

/**
 * Read the live `package.json` from disk for the running module.
 *
 * The bundled `package.json` import is inlined at build time; if `dist/` is
 * published without a fresh build (issue #39), the inlined `version` lies
 * and the auto-update loop fires forever. Reading the on-disk manifest each
 * run keeps the version honest even when the bundle is stale.
 */
export function getInstalledPackage(): { name: string; version: string } {
  if (cachedInstalledPkg) return cachedInstalledPkg;
  let dir: string | null = null;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // import.meta.url malformed; fall through to bundled
  }
  if (dir) {
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, "package.json");
      // A per-candidate try/catch: a transient read error, partial write, or
      // BOM on any single package.json must NOT abort the upward walk —
      // otherwise we'd silently fall back to the stale bundled manifest that
      // issue #39 was about. Keep walking until we either find a matching
      // manifest or exhaust parents.
      try {
        if (existsSync(candidate)) {
          const json = JSON.parse(readFileSync(candidate, "utf8")) as {
            name?: string;
            version?: string;
          };
          if (json.name === bundledPkg.name && typeof json.version === "string") {
            cachedInstalledPkg = { name: json.name, version: json.version };
            return cachedInstalledPkg;
          }
        }
      } catch {
        // unreadable / unparsable — continue walking
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  cachedInstalledPkg = { name: bundledPkg.name, version: bundledPkg.version };
  return cachedInstalledPkg;
}

/** Test-only: clear or seed the memoized lookup. */
export function _setInstalledPackageForTesting(
  value: { name: string; version: string } | null,
): void {
  cachedInstalledPkg = value;
}

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

    if (compareVersions(getInstalledPackage().version, latestVersion) < 0) {
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
      ? `bun add -g ${CANONICAL_PKG_NAME}@${latestVersion}`
      : `npm install -g ${CANONICAL_PKG_NAME}@${latestVersion}`;

  process.stderr.write(
    `\x1b[33m[agent-yes] Updating ${getInstalledPackage().version} → ${latestVersion}…\x1b[0m\n`,
  );
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
    const response = await fetch(`https://registry.npmjs.org/${CANONICAL_PKG_NAME}/latest`, {
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
  return `agent-yes v${getInstalledPackage().version} (${detectInstallMethod()})`;
}

/**
 * Display version information with async latest version check
 */
export async function displayVersion(): Promise<void> {
  console.log(versionString());

  const latestVersion = await fetchLatestVersion();

  if (latestVersion) {
    const comparison = compareVersions(getInstalledPackage().version, latestVersion);

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
