// Stage the agent-yes CLI into ./vendor/ay so electron-builder can ship it inside
// the app (extraResources → resources/ay). At runtime main.js runs
// `bun resources/ay/dist/agent-yes.js serve --http`.
//
// Requirements on the BUILD machine: `bun` on PATH, and the repo already built
// (`bun run build` at the repo root produces ../dist). Native deps are installed
// for the CLI's own runtime; running the CLI under `bun` keeps us on bun-pty's
// FFI path (no Node-ABI rebuild needed for the pty addon).
//
// NOTE (follow-up): for a truly self-contained app that does not require the user
// to have `bun` installed, bundle a `bun` binary into vendor/ and have main.js
// prefer it. Until then the desktop app expects `bun` (or a global `ay`) present.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const out = path.join(here, "vendor", "ay");

const dist = path.join(repo, "dist", "agent-yes.js");
if (!fs.existsSync(dist)) {
  console.error(`✗ ${dist} not found — run \`bun run build\` at the repo root first.`);
  process.exit(1);
}

// Fresh staging dir.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Everything the CLI reads at runtime: the built JS, the UI assets served by
// `--http` (serve.ts resolves ../lab/ui relative to dist/), the embedded default
// config, and the schema. Keep this list in sync with package.json "files".
const copy = [
  ["dist", "dist"],
  ["lab/ui", "lab/ui"],
  ["package.json", "package.json"],
  ["default.config.yaml", "default.config.yaml"],
  ["agent-yes.config.schema.json", "agent-yes.config.schema.json"],
];
for (const [src, dst] of copy) {
  const from = path.join(repo, src);
  if (!fs.existsSync(from)) {
    console.warn(`! skipping missing ${src}`);
    continue;
  }
  fs.cpSync(from, path.join(out, dst), { recursive: true });
}

// Install only runtime deps next to the staged package.json.
console.log("→ installing production deps into vendor/ay (bun) …");
execFileSync("bun", ["install", "--production"], { cwd: out, stdio: "inherit" });

console.log(`✓ staged agent-yes CLI → ${path.relative(here, out)}`);
