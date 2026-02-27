/**
 * Rust binary helper - finds or downloads the appropriate prebuilt binary
 */

import { existsSync, mkdirSync, unlinkSync, renameSync, copyFileSync } from "fs";
import { chmod, unlink, rename, copyFile } from "fs/promises";
import path from "path";

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
        `Supported: ${Object.keys(PLATFORM_MAP).join(", ")}`
    );
  }

  return binaryName + (platform === "win32" ? ".exe" : "");
}

/**
 * Get the directory where binaries are stored
 */
export function getBinDir(): string {
  // First check for binaries in the npm package
  const packageBinDir = path.resolve(import.meta.dir, "../bin");
  if (existsSync(packageBinDir)) {
    return packageBinDir;
  }

  // Fall back to user's cache directory
  const cacheDir =
    process.env.AGENT_YES_CACHE_DIR ||
    path.join(
      process.env.XDG_CACHE_HOME || path.join(process.env.HOME || "/tmp", ".cache"),
      "agent-yes"
    );

  return path.join(cacheDir, "bin");
}

/**
 * Find the Rust binary, checking multiple locations
 */
export function findRustBinary(verbose = false): string | undefined {
  const binaryName = getBinaryName();
  const baseName = binaryName.replace(/\.exe$/, "");

  const searchPaths = [
    // 1. Check in npm package bin directory
    path.join(getBinDir(), binaryName),

    // 2. Check relative to this script (in the repo during development)
    path.resolve(import.meta.dir, "../rs/target/release/agent-yes"),
    path.resolve(import.meta.dir, "../rs/target/debug/agent-yes"),

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
      ["powershell", "-Command", `Expand-Archive -Path '${tempZipPath}' -DestinationPath '${binDir}' -Force`],
      { cwd: binDir, stdio: ["ignore", "pipe", "pipe"] }
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
 * Get or download the Rust binary
 */
export async function getRustBinary(options: {
  verbose?: boolean;
  forceDownload?: boolean;
} = {}): Promise<string> {
  const { verbose = false, forceDownload = false } = options;

  // First try to find existing binary
  if (!forceDownload) {
    const existing = findRustBinary(verbose);
    if (existing) {
      if (verbose) {
        console.log(`[rust] Using existing binary: ${existing}`);
      }
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
        `You can build manually with: cd rs && cargo build --release`
    );
  }
}
