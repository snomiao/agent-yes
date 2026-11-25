#!/usr/bin/env bun
// Build the /rgui page (lab/ui/rgui) — bundles main.ts + @snomiao/rgui into a
// single browser module, then copies index.html beside it.
//
// rgui is consumed FROM SOURCE, never the npm package, so the page tracks rgui's
// heavy dev. Source resolution order:
//   1. $RGUI_LOCAL                         (explicit override)
//   2. ~/ws/snomiao/rgui/tree/main         (the local dev worktree, if present)
//   3. lib/rgui                            (the committed git submodule — CI/other machines)
// The chosen dir's node_modules must have d3-selection/d3-zoom; we `bun install`
// there once if missing (matters for the submodule / a fresh CI checkout).
//
// Usage:  bun scripts/build-rgui.ts [outdir]
//   outdir defaults to lab/ui/rgui/dist
import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { $ } from "bun";

const root = path.join(import.meta.dir, "..");

function resolveRguiDir(): string {
  const candidates = [
    process.env.RGUI_LOCAL,
    path.join(homedir(), "ws/snomiao/rgui/tree/main"),
    path.join(root, "lib/rgui"),
  ].filter((d): d is string => !!d);
  for (const d of candidates) {
    if (existsSync(path.join(d, "src/index.ts"))) return d;
  }
  throw new Error(
    "rgui source not found — run `git submodule update --init lib/rgui` " +
      "(or set RGUI_LOCAL to a rgui checkout).",
  );
}

const RGUI_DIR = resolveRguiDir();
const isSubmodule = RGUI_DIR === path.join(root, "lib/rgui");
console.log(`[build-rgui] rgui source: ${RGUI_DIR}${isSubmodule ? " (submodule)" : " (local)"}`);

// rgui imports d3-selection/d3-zoom; ensure its deps exist (fresh submodule/CI)
if (!existsSync(path.join(RGUI_DIR, "node_modules/d3-selection"))) {
  console.log("[build-rgui] installing rgui deps…");
  await $`bun install --cwd ${RGUI_DIR}`;
}

const outdir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, "lab/ui/rgui/dist");
await mkdir(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(root, "lab/ui/rgui/main.ts")],
  outdir,
  target: "browser",
  minify: true,
  sourcemap: "linked",
  naming: "[name].js",
  plugins: [
    {
      // alias the bare "@snomiao/rgui" specifier to the resolved source entry so
      // d3 (rgui's own dep) resolves from RGUI_DIR/node_modules, not agent-yes's.
      name: "rgui-source-alias",
      setup(b) {
        b.onResolve({ filter: /^@snomiao\/rgui$/ }, () => ({
          path: path.join(RGUI_DIR, "src/index.ts"),
        }));
      },
    },
  ],
});

if (!result.success) {
  for (const m of result.logs) console.error(m);
  throw new Error("[build-rgui] bundle failed");
}

await cp(path.join(root, "lab/ui/rgui/index.html"), path.join(outdir, "index.html"));
console.log(`[build-rgui] → ${path.relative(root, outdir)}/ (index.html + main.js)`);
