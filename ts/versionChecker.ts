import { execaCommand } from "execa";
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
  if (process.env.BUN_INSTALL || process.env.npm_execpath?.includes("bun")) return "bun";
  return "npm";
}

/**
 * Check for updates and auto-install if a newer version is available.
 * Uses a 1-hour TTL cache to avoid hitting the registry on every run.
 * All errors are swallowed — network issues must never break the tool.
 * Set AGENT_YES_NO_UPDATE=1 to opt out.
 */
export async function checkAndAutoUpdate(): Promise<void> {
  if (process.env.AGENT_YES_NO_UPDATE) return;

  try {
    // Check cache TTL
    const cache = await readUpdateCache();
    if (cache && Date.now() - cache.checkedAt < TTL_MS) {
      // Use cached result
      if (compareVersions(pkg.version, cache.latestVersion) < 0) {
        await runInstall(cache.latestVersion);
      }
      return;
    }

    // Fetch latest from registry
    const latestVersion = await fetchLatestVersion();
    if (!latestVersion) return;

    await writeUpdateCache({ checkedAt: Date.now(), latestVersion });

    if (compareVersions(pkg.version, latestVersion) < 0) {
      await runInstall(latestVersion);
    }
  } catch {
    // Silently ignore all errors
  }
}

async function runInstall(latestVersion: string): Promise<void> {
  const pm = detectPackageManager();
  const installArgs =
    pm === "bun"
      ? `bun add -g agent-yes@${latestVersion}`
      : `npm install -g agent-yes@${latestVersion}`;

  process.stderr.write(`\x1b[33m[agent-yes] Updating ${pkg.version} → ${latestVersion}…\x1b[0m\n`);
  try {
    await execaCommand(installArgs, { stdio: "inherit" });
    // Clear cache so next run re-checks
    await writeUpdateCache({ checkedAt: 0, latestVersion });
    process.stderr.write(`\x1b[32m[agent-yes] Updated to ${latestVersion}\x1b[0m\n`);
  } catch {
    process.stderr.write(`\x1b[31m[agent-yes] Auto-update failed. Run: ${installArgs}\x1b[0m\n`);
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
 * Display version information with async latest version check
 */
export async function displayVersion(): Promise<void> {
  // Display current version immediately
  console.log(pkg.version);

  // Check latest version asynchronously
  const latestVersion = await fetchLatestVersion();

  if (latestVersion) {
    const comparison = compareVersions(pkg.version, latestVersion);

    if (comparison < 0) {
      // Current version is older
      console.log(`\x1b[33m${latestVersion} (update available)\x1b[0m`);
    } else if (comparison > 0) {
      // Current version is newer (pre-release or local dev)
      console.log(`${latestVersion} (latest published)`);
    } else {
      // Versions are equal
      console.log(`${latestVersion} (latest)`);
    }
  } else {
    // Failed to fetch latest version
    console.log("(unable to check for updates)");
  }
}
