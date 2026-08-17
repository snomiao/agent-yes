#! /usr/bin/env bun
/**
 * Postbuild script: Create Node.js wrapper files in dist/
 * These wrappers execute dist/cli.js with the appropriate CLI name
 */
import { writeFile, chmod } from "fs/promises";
import { CLIS_CONFIG } from "./index.ts";
import sflow from "sflow";
import pkg from "../package.json";

// Create copies for each CLI variant.
// -yes wrappers: only regenerate existing ones from package.json's bin map
// (never auto-create new -yes entries — `ay` is the primary entry point).
const existingBins = new Set(Object.keys(pkg.bin as Record<string, string>));
const cliNames = [...Object.keys(CLIS_CONFIG), "agent"];
const suffixes = ["-yes"];

// Short aliases: maps alias name → target CLI name (alias resolves in parseCliArgs.ts)
const shortAliases: Record<string, string> = { cy: "claude" };

// Under Bun (dev via `bun link`), run TypeScript source directly — no build needed.
// Under Node (published install or CI), use the compiled dist/cli.js.
// Detect Bun at runtime: the shebang prefers bun but Node may still invoke us
// directly (e.g. `node dist/claude-yes.js` in CI), and Node cannot import .ts.
const wrapperContent = `\
#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (typeof Bun !== "undefined" && existsSync(join(root, ".git"))) {
  await import("../ts/cli.ts");
} else {
  await import("./cli.js");
}`;

await sflow(cliNames.flatMap((cli) => suffixes.map((suffix) => ({ cli, suffix }))))
  .map(async ({ cli, suffix }) => {
    const cliName = `${cli}${suffix}`;
    const wrapperPath = `./dist/${cliName}.js`;

    // Only generate -yes wrapper files for CLI keys that already have
    // a published bin entry in package.json. New CLI keys (e.g. `dsh`)
    // never auto-create -yes bins — `ay <cli>` is the primary entry.
    if (!existingBins.has(cliName)) return;

    await writeFile(wrapperPath, wrapperContent);
    await chmod(wrapperPath, 0o755);
    console.log(`${wrapperPath} regenerated`);
  })

  .run();

// Generate short alias wrapper files
for (const [alias] of Object.entries(shortAliases)) {
  const wrapperPath = `./dist/${alias}.js`;
  await writeFile(wrapperPath, wrapperContent);
  await chmod(wrapperPath, 0o755);
  if (!(pkg.bin as Record<string, string>)?.[alias]) {
    await Bun.$`npm pkg set ${"bin." + alias}=${wrapperPath}`;
    console.log(`${wrapperPath} created`);
  }
}
