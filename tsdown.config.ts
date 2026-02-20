import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./ts/cli.ts", "./ts/index.ts"],
  outDir: "dist",
  platform: "node",
  sourcemap: true,
  external: ["@snomiao/bun-pty", "bun-pty", "node-pty", "from-node-stream", "bun"],
  format: "esm",
  outExtensions: () => ({ js: ".js" }),
});
