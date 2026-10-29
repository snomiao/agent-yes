import { defineConfig } from "tsdown";

// The npm package: one ES module per public entry, with type declarations.
// The standalone browser bundle (dist/liagent.js, for import() from a URL)
// is built separately by `bun build` (see package.json "build").
export default defineConfig({
  entry: {
    index: "./src/browser.ts",
    box: "./src/box.ts",
    client: "./src/client.ts",
    hub: "./src/hub.ts",
    protocol: "./src/protocol.ts",
    cli: "./src/cli.ts",
  },
  outDir: "dist",
  format: "esm",
  platform: "neutral",
  dts: true,
  sourcemap: true,
  clean: false,
  external: [/^node:/, "bun"],
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
