/**
 * Rust binary helper - finds or downloads the appropriate prebuilt binary
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { chmod, copyFile } from "fs/promises";
import path from "path";
import pkg from "../package.json" with { type: "json" };

// Platform/arch to binary name mapping
const PLATFORM_MAP: Record<string, string> = {
  "linux-x64": "agent-yes-linux-x64-musl", // Use musl for better compatibility
  "linux-arm64": "agent-yes-linux-arm64-musl",
  "darwin-x64": "agent-yes-darwin-x64",
  "darwin-arm64": "agent-yes-darwin-arm64",
  "win32-x64": "agent-yes-win32-x64",
};

/**
 * Get the binary name for the current platform
 */
export function getBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;
  const key = `${platform}-${arch}`;

  const binaryName = PLATFORM_MAP[key];
  if (!binaryName) {
    throw new Error(
      `Unsupported platform: ${platform}-${arch}. ` +
        `Supported: ${Object.keys(PLATFORM_MAP).join(", ")}`,
    );
  }

  return binaryName + (platform === "win32" ? ".exe" : "");
}

/**
 * Get the directory where binaries are stored
 */
export function getBinDir(): string {
  // First check for binaries in the npm package
  const packageBinDir = path.resolve(import.meta.dirname ?? import.meta.dir, "../bin");
  if (existsSync(packageBinDir)) {
    return packageBinDir;
  }

  // Fall back to user's cache directory
  const cacheDir =
    process.env.AGENT_YES_CACHE_DIR ||
    path.join(
      process.env.XDG_CACHE_HOME || path.join(process.env.HOME || "/tmp", ".cache"),
      "agent-yes",
    );

  return path.join(cacheDir, "bin");
}

/**
 * Find the Rust binary, checking multiple locations
 */
export function findRustBinary(verbose = false): string | undefined {
  const binaryName = getBinaryName();

  const ext = process.platform === "win32" ? ".exe" : "";
  const searchPaths = [
    // 1. Check relative to this script (in the repo during development)
    path.resolve(import.meta.dirname ?? import.meta.dir, `../rs/target/release/agent-yes${ext}`),
    path.resolve(import.meta.dirname ?? import.meta.dir, `../rs/target/debug/agent-yes${ext}`),

    // 2. Check in npm package bin directory
    path.join(getBinDir(), binaryName),

    // 3. Check in user's cache directory
    path.join(getBinDir(), binaryName),
  ];

  if (verbose) {
    console.log(`[rust] Looking for binary: ${binaryName}`);
    console.log(`[rust] Search paths:`);
  }

  for (const p of searchPaths) {
    if (verbose) {
      console.log(`[rust]   - ${p}: ${existsSync(p) ? "FOUND" : "not found"}`);
    }
    if (existsSync(p)) {
      return p;
    }
  }

  return undefined;
}

/**
 * Get GitHub release download URL for the binary
 */
export function getDownloadUrl(version = "latest"): string {
  const binaryName = getBinaryName().replace(/\.exe$/, "");
  const isWindows = process.platform === "win32";
  const ext = isWindows ? ".zip" : ".tar.gz";

  if (version === "latest") {
    return `https://github.com/snomiao/agent-yes/releases/latest/download/${binaryName}${ext}`;
  }

  return `https://github.com/snomiao/agent-yes/releases/download/v${version}/${binaryName}${ext}`;
}

/**
 * Download and extract the binary
 */
export async function downloadBinary(verbose = false): Promise<string> {
  const binDir = getBinDir();
  const binaryName = getBinaryName();
  const binaryPath = path.join(binDir, binaryName);

  // Create bin directory if needed
  mkdirSync(binDir, { recursive: true });

  const url = getDownloadUrl();
  if (verbose) {
    console.log(`[rust] Downloading binary from: ${url}`);
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download binary: ${response.status} ${response.statusText}`);
  }

  const isWindows = process.platform === "win32";

  if (isWindows) {
    // For Windows, download and extract zip
    const tempZipPath = path.join(binDir, "temp.zip");
    await Bun.write(tempZipPath, await response.arrayBuffer());

    // Use PowerShell to extract zip
    const proc = Bun.spawn(
      [
        "powershell",
        "-Command",
        `Expand-Archive -Path '${tempZipPath}' -DestinationPath '${binDir}' -Force`,
      ],
      { cwd: binDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    await proc.exited;

    // Clean up
    try {
      unlinkSync(tempZipPath);
    } catch {}
  } else {
    // For Unix, download and extract tar.gz
    const tarPath = path.join(binDir, "temp.tar.gz");
    await Bun.write(tarPath, await response.arrayBuffer());

    // Extract using tar command
    const proc = Bun.spawn(["tar", "-xzf", tarPath, "-C", binDir], {
      cwd: binDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await proc.exited;

    // The extracted file might have a different name, find and rename it
    const extractedName = binaryName.replace(/-musl$/, "").replace(/-gnu$/, "");
    const possibleNames = ["agent-yes", extractedName, binaryName];

    for (const name of possibleNames) {
      const extractedPath = path.join(binDir, name);
      if (existsSync(extractedPath) && extractedPath !== binaryPath) {
        try {
          await copyFile(extractedPath, binaryPath);
          unlinkSync(extractedPath);
        } catch {}
        break;
      }
    }

    // Clean up tar file
    try {
      unlinkSync(tarPath);
    } catch {}

    // Make executable
    await chmod(binaryPath, 0o755);
  }

  if (verbose) {
    console.log(`[rust] Binary downloaded to: ${binaryPath}`);
  }

  return binaryPath;
}

/**
 * Get the version of a Rust binary by running it with --version
 */
function getRustBinaryVersion(binaryPath: string): string | null {
  try {
    const output = execFileSync(binaryPath, ["--version"], {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // Output is like "agent-yes 1.72.3" or "agent-yes v1.72.3"
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Check if a binary path is inside a git repo (dev build), and rebuild if outdated.
 * Returns the same path if up-to-date or rebuilt, undefined if rebuild failed.
 */
function autoRebuildIfOutdated(binaryPath: string, verbose: boolean): boolean {
  // Only auto-rebuild for local dev builds (target/release or target/debug)
  if (!binaryPath.includes("/target/release") && !binaryPath.includes("/target/debug")) {
    return true; // not a dev build, skip
  }

  const binaryVersion = getRustBinaryVersion(binaryPath);
  if (verbose) {
    console.log(`[rust] Binary version: ${binaryVersion}, package version: ${pkg.version}`);
  }

  if (binaryVersion === pkg.version) {
    return true; // up to date
  }

  // Find the rs/ directory relative to the binary (binary is at rs/target/release/agent-yes)
  const rsDir = binaryPath.replace(/\/target\/(release|debug)\/agent-yes.*$/, "");
  if (!existsSync(path.join(rsDir, "Cargo.toml"))) {
    if (verbose) console.log(`[rust] Cannot find Cargo.toml at ${rsDir}, skipping rebuild`);
    return true; // can't rebuild, use as-is
  }

  process.stderr.write(
    `\x1b[33m[rust] Binary outdated (${binaryVersion ?? "unknown"} → ${pkg.version}), rebuilding…\x1b[0m\n`,
  );

  try {
    const isRelease = binaryPath.includes("/target/release");
    const args = ["build", ...(isRelease ? ["--release"] : [])];
    execFileSync("cargo", args, {
      cwd: rsDir,
      stdio: "inherit",
      timeout: 300_000, // 5 min max
    });
    process.stderr.write(`\x1b[32m[rust] Rebuild complete\x1b[0m\n`);
    return true;
  } catch {
    process.stderr.write(`\x1b[31m[rust] Auto-rebuild failed, using outdated binary\x1b[0m\n`);
    return true; // still usable, just old
  }
}

/**
 * Get or download the Rust binary
 */
export async function getRustBinary(
  options: {
    verbose?: boolean;
    forceDownload?: boolean;
  } = {},
): Promise<string> {
  const { verbose = false, forceDownload = false } = options;

  // First try to find existing binary
  if (!forceDownload) {
    const existing = findRustBinary(verbose);
    if (existing) {
      if (verbose) {
        console.log(`[rust] Using existing binary: ${existing}`);
      }
      // Auto-rebuild if it's a dev build and version is outdated
      autoRebuildIfOutdated(existing, verbose);
      return existing;
    }
  }

  // Download if not found
  if (verbose) {
    console.log(`[rust] Binary not found, downloading...`);
  }

  try {
    return await downloadBinary(verbose);
  } catch (err) {
    throw new Error(
      `Failed to get Rust binary: ${err instanceof Error ? err.message : err}\n` +
        `You can build manually with: cd rs && cargo build --release`,
    );
  }
}
