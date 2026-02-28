import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadCascadingConfig, getConfigPaths, ensureSchemaInConfigFiles } from "./configLoader.ts";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("configLoader", () => {
  const testDir = path.join(os.tmpdir(), "agent-yes-config-test");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("should load JSON config", async () => {
    const configPath = path.join(testDir, ".agent-yes.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        configDir: "/custom/config",
        clis: {
          claude: {
            defaultArgs: ["--verbose"],
          },
        },
      })
    );

    const config = await loadCascadingConfig({ projectDir: testDir });
    expect(config.configDir).toBe("/custom/config");
    expect(config.clis?.claude?.defaultArgs).toEqual(["--verbose"]);
  });

  it("should load YAML config", async () => {
    const configPath = path.join(testDir, ".agent-yes.config.yaml");
    await writeFile(
      configPath,
      `
configDir: /custom/yaml/config
clis:
  gemini:
    defaultArgs:
      - --resume
`
    );

    const config = await loadCascadingConfig({ projectDir: testDir });
    expect(config.configDir).toBe("/custom/yaml/config");
    expect(config.clis?.gemini?.defaultArgs).toEqual(["--resume"]);
  });

  it("should load YML config", async () => {
    const configPath = path.join(testDir, ".agent-yes.config.yml");
    await writeFile(
      configPath,
      `
logsDir: /custom/logs
`
    );

    const config = await loadCascadingConfig({ projectDir: testDir });
    expect(config.logsDir).toBe("/custom/logs");
  });

  it("should prefer JSON over YAML when both exist", async () => {
    await writeFile(
      path.join(testDir, ".agent-yes.config.json"),
      JSON.stringify({ configDir: "/json/config" })
    );
    await writeFile(
      path.join(testDir, ".agent-yes.config.yaml"),
      `configDir: /yaml/config`
    );

    const config = await loadCascadingConfig({ projectDir: testDir });
    expect(config.configDir).toBe("/json/config");
  });

  it("should return config paths", () => {
    const paths = getConfigPaths({ projectDir: testDir });
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((p) => p.includes(".agent-yes.config.json"))).toBe(true);
    expect(paths.some((p) => p.includes(".agent-yes.config.yml"))).toBe(true);
    expect(paths.some((p) => p.includes(".agent-yes.config.yaml"))).toBe(true);
  });

  it("should return empty config when no config files exist", async () => {
    const emptyDir = path.join(testDir, "empty");
    await mkdir(emptyDir, { recursive: true });

    const config = await loadCascadingConfig({
      projectDir: emptyDir,
      homeDir: emptyDir, // Use same empty dir to avoid loading actual home config
    });

    expect(config).toEqual({});
  });

  it("should merge configs with project taking precedence", async () => {
    const homeDir = path.join(testDir, "home");
    const projectDir = path.join(testDir, "project");
    await mkdir(homeDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });

    await writeFile(
      path.join(homeDir, ".agent-yes.config.json"),
      JSON.stringify({
        configDir: "/home/config",
        logsDir: "/home/logs",
      })
    );

    await writeFile(
      path.join(projectDir, ".agent-yes.config.json"),
      JSON.stringify({
        configDir: "/project/config",
      })
    );

    const config = await loadCascadingConfig({ projectDir, homeDir });
    expect(config.configDir).toBe("/project/config"); // Project takes precedence
    expect(config.logsDir).toBe("/home/logs"); // Home is used when not overridden
  });

  it("should add schema reference to JSON config without one", async () => {
    const configPath = path.join(testDir, ".agent-yes.config.json");
    await writeFile(
      configPath,
      JSON.stringify({ configDir: "/test" })
    );

    const result = await ensureSchemaInConfigFiles({ projectDir: testDir, homeDir: testDir });
    expect(result.modified).toContain(configPath);

    const content = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.$schema).toContain("agent-yes.config.schema.json");
    expect(parsed.configDir).toBe("/test"); // Original content preserved
  });

  it("should add schema comment to YAML config without one", async () => {
    const configPath = path.join(testDir, ".agent-yes.config.yaml");
    await writeFile(
      configPath,
      `configDir: /test
clis:
  claude:
    defaultArgs:
      - --verbose
`
    );

    const result = await ensureSchemaInConfigFiles({ projectDir: testDir, homeDir: testDir });
    expect(result.modified).toContain(configPath);

    const content = await readFile(configPath, "utf-8");
    expect(content).toContain("yaml-language-server:");
    expect(content).toContain("$schema=");
    expect(content).toContain("configDir: /test"); // Original content preserved
  });

  it("should skip JSON config that already has schema", async () => {
    const configPath = path.join(testDir, ".agent-yes.config.json");
    const originalContent = JSON.stringify({
      $schema: "https://example.com/schema.json",
      configDir: "/test",
    }, null, 2);
    await writeFile(configPath, originalContent);

    const result = await ensureSchemaInConfigFiles({ projectDir: testDir, homeDir: testDir });
    expect(result.skipped).toContain(configPath);
    expect(result.modified).not.toContain(configPath);

    const content = await readFile(configPath, "utf-8");
    expect(content).toBe(originalContent); // Unchanged
  });

  it("should skip YAML config that already has schema comment", async () => {
    const configPath = path.join(testDir, ".agent-yes.config.yaml");
    const originalContent = `# yaml-language-server: $schema=https://example.com/schema.json
configDir: /test
`;
    await writeFile(configPath, originalContent);

    const result = await ensureSchemaInConfigFiles({ projectDir: testDir, homeDir: testDir });
    expect(result.skipped).toContain(configPath);
    expect(result.modified).not.toContain(configPath);
  });
});
