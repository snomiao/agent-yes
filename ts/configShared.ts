import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { AgentCliConfig, AgentYesConfig } from "./index.ts";

export type RegexSource = string | { pattern: string; flags?: string };

type RawCliConfig = Omit<
  AgentCliConfig,
  | "ready"
  | "fatal"
  | "working"
  | "enter"
  | "enterExclude"
  | "typingRespond"
  | "restartWithoutContinueArg"
  | "updateAvailable"
  | "exitCommands"
> & {
  ready?: RegexSource[];
  fatal?: RegexSource[];
  working?: RegexSource[];
  enter?: RegexSource[];
  enterExclude?: RegexSource[];
  typingRespond?: Record<string, RegexSource[]>;
  restartWithoutContinueArg?: RegexSource[];
  updateAvailable?: RegexSource[];
  exitCommands?: string[];
  exitCommand?: string[];
};

type RawAgentYesConfig = {
  configDir?: string;
  logsDir?: string;
  clis?: Record<string, RawCliConfig>;
};

function isRegexSourceObject(value: unknown): value is { pattern: string; flags?: string } {
  return (
    !!value &&
    typeof value === "object" &&
    "pattern" in value &&
    typeof (value as { pattern?: unknown }).pattern === "string" &&
    (!("flags" in value) || typeof (value as { flags?: unknown }).flags === "string")
  );
}

export function compileRegexSource(source: RegexSource | RegExp): RegExp {
  if (source instanceof RegExp) return source;
  if (typeof source === "string") return new RegExp(source);
  return new RegExp(source.pattern, source.flags ?? "");
}

function compileRegexList(sources?: (RegexSource | RegExp)[]): RegExp[] | undefined {
  return sources?.map((source) => compileRegexSource(source));
}

function compileTypingRespond(
  typingRespond?: Record<string, RegexSource[]>,
): Record<string, RegExp[]> | undefined {
  if (!typingRespond) return undefined;
  return Object.fromEntries(
    Object.entries(typingRespond).map(([message, patterns]) => [
      message,
      patterns.map(compileRegexSource),
    ]),
  );
}

export function normalizeCliConfig(raw: RawCliConfig): AgentCliConfig {
  const {
    ready,
    fatal,
    working,
    enter,
    enterExclude,
    typingRespond,
    restartWithoutContinueArg,
    updateAvailable,
    exitCommands,
    exitCommand,
    ...rest
  } = raw;

  return {
    ...rest,
    ready: compileRegexList(ready),
    fatal: compileRegexList(fatal),
    working: compileRegexList(working),
    enter: compileRegexList(enter),
    enterExclude: compileRegexList(enterExclude),
    typingRespond: compileTypingRespond(typingRespond),
    restartWithoutContinueArg: compileRegexList(restartWithoutContinueArg),
    updateAvailable: compileRegexList(updateAvailable),
    exitCommands: exitCommands ?? exitCommand,
  };
}

export function normalizeAgentYesConfig(raw: RawAgentYesConfig): Partial<AgentYesConfig> {
  const normalized: Partial<AgentYesConfig> = {};

  if (raw.configDir !== undefined) normalized.configDir = raw.configDir;
  if (raw.logsDir !== undefined) normalized.logsDir = raw.logsDir;

  if (raw.clis) {
    normalized.clis = Object.fromEntries(
      Object.entries(raw.clis).map(([name, cliConfig]) => [name, normalizeCliConfig(cliConfig)]),
    );
  }

  return normalized;
}

async function fileExists(filepath: string) {
  try {
    await access(filepath);
    return true;
  } catch {
    return false;
  }
}

export async function findSharedCliDefaultsPath(
  fromUrl: string = import.meta.url,
): Promise<string> {
  let currentDir = path.dirname(fileURLToPath(fromUrl));

  while (true) {
    const candidate = path.resolve(currentDir, "config", "cli-defaults.yaml");
    if (await fileExists(candidate)) return candidate;

    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  throw new Error("Unable to locate config/cli-defaults.yaml from current package path");
}

export async function loadSharedCliDefaults(
  fromUrl: string = import.meta.url,
): Promise<Record<string, AgentCliConfig>> {
  const filepath = await findSharedCliDefaultsPath(fromUrl);
  const content = await readFile(filepath, "utf8");
  const parsed = parseYaml(content);

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid shared CLI defaults file: ${filepath}`);
  }

  const normalized = normalizeAgentYesConfig(parsed as RawAgentYesConfig);
  return normalized.clis ?? {};
}

export function isRegexSource(value: unknown): value is RegexSource {
  return typeof value === "string" || isRegexSourceObject(value);
}
