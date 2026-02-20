#! /usr/bin/env bun
/**
 * Postbuild script: Create Node.js wrapper files in dist/
 * These wrappers execute dist/cli.js with the appropriate CLI name
 */
import { writeFile, chmod } from "fs/promises";
import { CLIS_CONFIG } from "./index.ts";
import sflow from "sflow";
import pkg from "../package.json";

// Create copies for each CLI variant (-yes versions only; use --auto=no flag to disable auto-yes)
const cliNames = [...Object.keys(CLIS_CONFIG), "agent"];
const suffixes = ["-yes"];

await sflow(cliNames.flatMap((cli) => suffixes.map((suffix) => ({ cli, suffix }))))
  .map(async ({ cli, suffix }) => {
    const cliName = `${cli}${suffix}`;

    const wrapperPath = `./dist/${cliName}.js`;
    await writeFile(
      wrapperPath,
      `
#!/usr/bin/env bun
await import('./cli.js')
`.trim(),
    );
    await chmod(wrapperPath, 0o755);

    // Only register -yes variants in package.json bin
    if (suffix === "-yes" && !(pkg.bin as Record<string, string>)?.[cliName]) {
      await Bun.$`npm pkg set ${"bin." + cliName}=${wrapperPath}`;
      console.log(`${wrapperPath} created`);
    }
  })

  .run();
