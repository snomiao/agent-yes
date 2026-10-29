#! /usr/bin/env bun
/**
 * Build step: ship liagent (https://github.com/snolab/liagent) inside
 * agent-yes as `agent-yes/liagent`. liagent is a devDependency pinned to a
 * release tag ("github:snolab/liagent#vX.Y.Z"), whose tag commit holds its
 * built dist/. This copies the .js and .d.ts files (no source maps) into
 * dist/liagent/, which the ./liagent* exports and the `liagent` bin point at.
 * To move to a new liagent release, bump that one pin in package.json.
 */
import { chmod, copyFile, mkdir, readdir } from "fs/promises";
import path from "path";

const from = path.join(import.meta.dir, "..", "node_modules", "liagent", "dist");
const to = path.join(import.meta.dir, "..", "dist", "liagent");
// What the exports and the bin need; the build fails without any of them.
const required = ["index", "box", "client", "protocol", "hub", "cli"].flatMap((n) => [
  `${n}.js`,
  `${n}.d.ts`,
]);

const files = await readdir(from).catch(() => {
  throw new Error(
    `liagent's dist is missing at ${from}: run \`bun install\` (devDependency "liagent").`,
  );
});
const missing = required.filter((f) => !files.includes(f));
if (missing.length) throw new Error(`liagent's dist lacks ${missing.join(", ")} (${from})`);

await mkdir(to, { recursive: true });
const shipped = files.filter((f) => /\.(js|d\.ts)$/.test(f));
for (const f of shipped) await copyFile(path.join(from, f), path.join(to, f));
await chmod(path.join(to, "cli.js"), 0o755);
console.log(`dist/liagent: ${shipped.length} files from liagent`);
