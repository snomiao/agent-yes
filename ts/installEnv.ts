import { readFile } from "node:fs/promises";
import path from "node:path";

// Install dir is one level up from this file (ts/ -> package root)
const installDir = path.join(import.meta.dir, "..");

function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

let _installEnv: Record<string, string> | null = null;

/**
 * Load .env from the agent-yes install directory (not the working dir).
 * Install dir is ${import.meta.dir}/.. relative to this file.
 * Cached after first load.
 */
export async function loadInstallEnv(): Promise<Record<string, string>> {
  if (_installEnv) return _installEnv;
  const envPath = path.join(installDir, ".env");
  try {
    const content = await readFile(envPath, "utf-8");
    _installEnv = parseEnvContent(content);
  } catch {
    _installEnv = {};
  }
  return _installEnv;
}

/**
 * Get a value from the install .env, falling back to process.env.
 */
export async function getInstallEnv(key: string): Promise<string | undefined> {
  const env = await loadInstallEnv();
  return env[key] ?? process.env[key];
}
