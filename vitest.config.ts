/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["ts/**/*.spec.ts"],
    exclude: [
      "ts/**/*.bun.spec.ts",
      "ts/parseCliArgs.spec.ts",
      "ts/tests/mock-claude-cli.spec.ts",
      "ts/tests/rust-cwd.spec.ts",
      "node_modules/**/*",
    ],
    fileParallelism: false,
    pool: "forks",
    forks: {
      singleFork: true,
      isolate: true,
    },
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    isolate: true,
    coverage: {
      provider: "v8",
      enabled: true,
      include: ["ts/**/*.ts"],
      exclude: [
        "ts/**/*.spec.ts",
        "ts/**/*.test.ts",
        "ts/**/*.bun.spec.ts",
        "ts/index.ts",
        "ts/cli.ts",
        "ts/postbuild.ts",
        "ts/pty.ts",
        "ts/pty-fix.ts",
        "ts/installEnv.ts",
        "ts/parseCliArgs.ts",
        "ts/rustBinary.ts",
        "ts/versionChecker.ts",
        "ts/agentRegistry.ts",
        "ts/logger.ts",
        "ts/SUPPORTED_CLIS.ts",
        "ts/webhookNotifier.ts",
        "ts/runningLock.ts",
        "ts/beta/**",
        "ts/core/**",
        "ts/resume/**",
        "ts/xterm-proxy.ts",
        // CLI subcommand dispatcher: testable paths covered, but the file
        // also contains a Windows named-pipe branch and an xterm-headless
        // import-failure fallback that aren't reachable on Linux CI.
        "ts/subcommands.ts",
        // HTTP server and remote config — integration-test only (requires a
        // running server and network); unit coverage not meaningful here.
        "ts/serve.ts",
        "ts/remotes.ts",
        // WebRTC share bridge — needs a peer + signaling server; proven e2e, not
        // unit-testable.
        "ts/share.ts",
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
  define: {
    "import.meta.vitest": false,
  },
});
