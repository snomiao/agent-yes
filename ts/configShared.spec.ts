import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileRegexSource,
  findSharedCliDefaultsPath,
  isRegexSource,
  loadSharedCliDefaults,
  normalizeAgentYesConfig,
  normalizeCliConfig,
} from "./configShared.ts";

describe("configShared", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("compiles structured regex sources with flags", () => {
    const regex = compileRegexSource({ pattern: "^foo$", flags: "m" });
    expect(regex).toBeInstanceOf(RegExp);
    expect(regex.flags).toContain("m");
  });

  it("returns RegExp instances unchanged", () => {
    const regex = /foo/;
    expect(compileRegexSource(regex)).toBe(regex);
  });

  it("normalizes legacy exitCommand to exitCommands", () => {
    const config = normalizeCliConfig({ exitCommand: ["/quit"] });
    expect(config.exitCommands).toEqual(["/quit"]);
  });

  it("normalizes configDir, logsDir, and regex arrays", () => {
    const config = normalizeAgentYesConfig({
      configDir: "/cfg",
      logsDir: "/logs",
      clis: {
        claude: {
          ready: [{ pattern: "^ready$", flags: "m" }],
          typingRespond: {
            "1\n": ["^confirm$"],
          },
        },
      },
    });

    expect(config.configDir).toBe("/cfg");
    expect(config.logsDir).toBe("/logs");
    expect(config.clis?.claude.ready?.[0]).toBeInstanceOf(RegExp);
    expect(config.clis?.claude.typingRespond?.["1\n"]?.[0]).toBeInstanceOf(RegExp);
  });

  it("loads shared YAML defaults for codex", async () => {
    const clis = await loadSharedCliDefaults(import.meta.url);
    expect(clis.codex).toBeDefined();
    expect(clis.codex.ready?.some((regex) => regex.test("› "))).toBe(true);
    expect(clis.codex.ready?.some((regex) => regex.test("⏎ send"))).toBe(true);
  });

  it("finds the shared defaults file by walking upward", async () => {
    const found = await findSharedCliDefaultsPath(import.meta.url);
    expect(found.endsWith(path.join("config", "cli-defaults.yaml"))).toBe(true);
  });

  it("throws when no shared defaults file exists in parent directories", async () => {
    const tempDir = path.join(os.tmpdir(), `agent-yes-config-shared-${Date.now()}-missing`);
    tempRoots.push(tempDir);
    await mkdir(tempDir, { recursive: true });

    await expect(
      findSharedCliDefaultsPath(pathToFileURL(path.join(tempDir, "entry.js")).href),
    ).rejects.toThrow("Unable to locate");
  });

  it("throws when the located shared defaults file is not an object", async () => {
    const tempDir = path.join(os.tmpdir(), `agent-yes-config-shared-${Date.now()}-invalid`);
    tempRoots.push(tempDir);
    await mkdir(path.join(tempDir, "config"), { recursive: true });
    await writeFile(path.join(tempDir, "config", "cli-defaults.yaml"), "123\n");

    await expect(
      loadSharedCliDefaults(pathToFileURL(path.join(tempDir, "entry.js")).href),
    ).rejects.toThrow("Invalid shared CLI defaults file");
  });

  it("recognizes valid and invalid regex source shapes", () => {
    expect(isRegexSource("^ready$")).toBe(true);
    expect(isRegexSource({ pattern: "^ready$", flags: "m" })).toBe(true);
    expect(isRegexSource({ pattern: 123 })).toBe(false);
    expect(isRegexSource({ pattern: "^ready$", flags: 1 })).toBe(false);
  });
});
