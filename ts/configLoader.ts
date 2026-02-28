//! Config file loader with cascading support
//! Supports JSON, YAML, YML formats
//! Priority: project-dir > home-dir > package-dir

import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import { logger } from "./logger.ts";
import type { AgentYesConfig } from "./index.ts";
import { deepMixin } from "./utils.ts";

const CONFIG_FILENAME = ".agent-yes.config";
const CONFIG_EXTENSIONS = [".json", ".yml", ".yaml"] as const;
const SCHEMA_URL = "https://raw.githubusercontent.com/snomiao/agent-yes/main/agent-yes.config.schema.json";
const YAML_SCHEMA_COMMENT = `# yaml-language-server: $schema=${SCHEMA_URL}`;

/**
 * Check if a file exists
 */
async function fileExists(filepath: string): Promise<boolean> {
  try {
    await access(filepath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse config file based on extension
 */
async function parseConfigFile(filepath: string): Promise<Partial<AgentYesConfig>> {
  const content = await readFile(filepath, "utf-8");
  const ext = path.extname(filepath).toLowerCase();

  switch (ext) {
    case ".json":
      return JSON.parse(content);
    case ".yml":
    case ".yaml":
      return parseYaml(content) ?? {};
    default:
      throw new Error(`Unsupported config file extension: ${ext}`);
  }
}

/**
 * Find config file in a directory (checks all supported extensions)
 */
async function findConfigInDir(dir: string): Promise<string | null> {
  for (const ext of CONFIG_EXTENSIONS) {
    const filepath = path.join(dir, `${CONFIG_FILENAME}${ext}`);
    if (await fileExists(filepath)) {
      return filepath;
    }
  }
  return null;
}

/**
 * Load config from a directory if it exists
 */
async function loadConfigFromDir(dir: string): Promise<Partial<AgentYesConfig>> {
  const filepath = await findConfigInDir(dir);
  if (!filepath) {
    return {};
  }

  try {
    logger.debug(`[config] Loading config from: ${filepath}`);
    return await parseConfigFile(filepath);
  } catch (error) {
    logger.warn(`[config] Failed to parse config file ${filepath}:`, error);
    return {};
  }
}

/**
 * Get the package directory (where agent-yes is installed)
 */
function getPackageDir(): string {
  // __dirname equivalent for ESM
  return path.dirname(new URL(import.meta.url).pathname);
}

export interface ConfigLoadOptions {
  /** Override the project directory (defaults to process.cwd()) */
  projectDir?: string;
  /** Override the home directory (defaults to os.homedir()) */
  homeDir?: string;
}

/**
 * Load configs from cascading locations and merge them
 * Priority (highest to lowest): project-dir > home-dir > package-dir
 * Higher priority configs override lower priority ones
 */
export async function loadCascadingConfig(
  options: ConfigLoadOptions = {}
): Promise<Partial<AgentYesConfig>> {
  const projectDir = options.projectDir ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  const packageDir = getPackageDir();

  // Load configs from each location (lowest to highest priority)
  const configs = await Promise.all([
    // Package directory (lowest priority - defaults from package)
    loadConfigFromDir(packageDir),
    // Home directory (middle priority - user defaults)
    loadConfigFromDir(homeDir),
    // Project directory (highest priority - project-specific)
    loadConfigFromDir(projectDir),
  ]);

  // Filter out empty configs and merge
  const nonEmptyConfigs = configs.filter(
    (c) => c && Object.keys(c).length > 0
  );

  if (nonEmptyConfigs.length === 0) {
    logger.debug("[config] No config files found in any location");
    return {};
  }

  // Merge configs with deepMixin (later configs override earlier ones)
  const merged = deepMixin({}, ...nonEmptyConfigs);
  logger.debug("[config] Merged config from", nonEmptyConfigs.length, "sources");

  return merged;
}

/**
 * Get all possible config file paths (for debugging/user info)
 */
export function getConfigPaths(options: ConfigLoadOptions = {}): string[] {
  const projectDir = options.projectDir ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  const packageDir = getPackageDir();

  const paths: string[] = [];

  for (const dir of [packageDir, homeDir, projectDir]) {
    for (const ext of CONFIG_EXTENSIONS) {
      paths.push(path.join(dir, `${CONFIG_FILENAME}${ext}`));
    }
  }

  return paths;
}

/**
 * Check if a config file has a schema reference
 */
function hasSchemaReference(content: string, ext: string): boolean {
  if (ext === ".json") {
    try {
      const parsed = JSON.parse(content);
      return "$schema" in parsed;
    } catch {
      return false;
    }
  }
  // YAML/YML - check for yaml-language-server comment
  return content.includes("yaml-language-server:") && content.includes("$schema");
}

/**
 * Add schema reference to a config file content
 */
function addSchemaReference(content: string, ext: string): string {
  if (ext === ".json") {
    try {
      const parsed = JSON.parse(content);
      if ("$schema" in parsed) {
        return content; // Already has schema
      }
      // Add $schema as first property
      const withSchema = { $schema: SCHEMA_URL, ...parsed };
      return JSON.stringify(withSchema, null, 2) + "\n";
    } catch {
      return content; // Can't parse, return as-is
    }
  }

  // YAML/YML - prepend comment
  if (hasSchemaReference(content, ext)) {
    return content; // Already has schema
  }

  // Add schema comment at the top, preserving any existing comments
  const lines = content.split("\n");

  // Find the first non-empty, non-comment line to insert before actual content
  let insertIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && !line.startsWith("#")) {
      insertIndex = i;
      break;
    }
    insertIndex = i + 1;
  }

  // Insert schema comment before the first content line
  lines.splice(insertIndex, 0, YAML_SCHEMA_COMMENT, "");
  return lines.join("\n");
}

/**
 * Ensure schema reference exists in config files
 * Modifies files in-place if they don't have a schema reference
 */
export async function ensureSchemaInConfigFiles(
  options: ConfigLoadOptions = {}
): Promise<{ modified: string[]; skipped: string[] }> {
  const projectDir = options.projectDir ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();

  const modified: string[] = [];
  const skipped: string[] = [];

  // Check both project and home directories (not package dir - that's read-only)
  for (const dir of [homeDir, projectDir]) {
    const filepath = await findConfigInDir(dir);
    if (!filepath) continue;

    try {
      const content = await readFile(filepath, "utf-8");
      const ext = path.extname(filepath).toLowerCase();

      if (hasSchemaReference(content, ext)) {
        skipped.push(filepath);
        logger.debug(`[config] Schema already present in: ${filepath}`);
        continue;
      }

      const newContent = addSchemaReference(content, ext);
      if (newContent !== content) {
        await writeFile(filepath, newContent, "utf-8");
        modified.push(filepath);
        logger.info(`[config] Added schema reference to: ${filepath}`);
      }
    } catch (error) {
      logger.warn(`[config] Failed to update schema in ${filepath}:`, error);
    }
  }

  return { modified, skipped };
}
