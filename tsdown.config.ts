import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./ts/cli.ts", "./ts/index.ts"],
  outDir: "dist",
  platform: "node",
  sourcemap: true,
  external: [
    "@snomiao/bun-pty",
    "bun-pty",
    "node-pty",
    "from-node-stream",
    "bun",
    "systray2",
    // codehost/provision is resolved at runtime (bun link) — never bundle it,
    // so a missing link degrades to a 501 instead of breaking the build.
    // codehost/tunnel is the opposite: a pure-TS devDependency that MUST be
    // bundled (ay expose runs on machines that never install codehost).
    /^codehost\/provision(\/|$)/,
  ],
  format: "esm",
  outExtensions: () => ({ js: ".js" }),
  inlineOnly: false,
});
