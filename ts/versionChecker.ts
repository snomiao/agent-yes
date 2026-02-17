import pkg from "../package.json" with { type: "json" };

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

    const data = await response.json() as { version: string };
    return data.version;
  } catch (error) {
    // Silently fail if network is unavailable or request times out
    return null;
  }
}

/**
 * Compare two semantic versions
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

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
