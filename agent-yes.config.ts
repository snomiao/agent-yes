import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineCliYesConfig } from "./ts/defineConfig.ts";
import { loadSharedCliDefaults } from "./ts/configShared.ts";
import { deepMixin } from "./ts/utils.ts";
import { logger } from "./ts/logger.ts";
import { loadCascadingConfig, ensureSchemaInConfigFiles } from "./ts/configLoader.ts";

logger.debug("loading cli-yes.config.ts from " + import.meta.url);

// Auto-inject schema reference into config files for IDE support
// This runs in the background and doesn't block startup
ensureSchemaInConfigFiles().catch(() => {
  // Silently ignore errors - this is a nice-to-have feature
});

// Config loading priority (highest to lowest):
// 1. [project-dir]/.agent-yes.config.[json/yml/yaml]
// 2. [home-dir]/.agent-yes.config.[json/yml/yaml]
// 3. [package-dir]/.agent-yes.config.[json/yml/yaml]
// 4. Legacy TS configs: ~/.agent-yes/config.ts, ./node_modules/.agent-yes/config.ts, ./.agent-yes/config.ts
// 5. Default config (defined below)

// Determine config directory with 3-tier fallback
const configDir = await (async () => {
  // 1. Try ~/.agent-yes as default
  const homeConfigDir = path.resolve(os.homedir(), ".agent-yes");
  const isHomeWritable = await mkdir(homeConfigDir, { recursive: true })
    .then(() => true)
    .catch(() => false);
  if (isHomeWritable) {
    logger.debug("[config] Using home directory:", homeConfigDir);
    return homeConfigDir;
  }

  // 2. Fallback to tmp dir
  const tmpConfigDir = path.resolve("/tmp/.agent-yes");
  const isWritable = await mkdir(tmpConfigDir, { recursive: true });
  if (isWritable) {
    logger.debug("[config] Using workspace directory:", tmpConfigDir);
    return tmpConfigDir;
  }

  return undefined;
})();

// Load cascading JSON/YAML configs (new style)
const cascadingConfig = await loadCascadingConfig();

// For backwards compatibility: also load legacy TS configs
const legacyConfigs = await Promise.all([
  import(path.resolve(os.homedir(), ".agent-yes/config.ts"))
    .catch(() => ({ default: {} }))
    .then((mod) => mod.default),
  import(path.resolve(process.cwd(), "node_modules/.agent-yes/config.ts"))
    .catch(() => ({ default: {} }))
    .then((mod) => mod.default),
  import(path.resolve(process.cwd(), ".agent-yes/config.ts"))
    .catch(() => ({ default: {} }))
    .then((mod) => mod.default),
]);

// Merge all configs: default -> cascading -> legacy TS
export default deepMixin(await getDefaultConfig(), cascadingConfig, ...legacyConfigs);

async function getDefaultConfig() {
  return defineCliYesConfig({
    configDir,
    logsDir: configDir && path.resolve(configDir, "logs"),
    clis: await loadSharedCliDefaults(import.meta.url),
  });
}
