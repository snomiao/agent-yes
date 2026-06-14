import { defineConfig } from "vitest/config";

// Deterministic DOM test of the real console (Playwright, hermetic). Kept in its
// own config so it isn't pulled into the unit suite's coverage gate; it runs via
// `bun run test:ui-dom` and in the UI Test workflow.
export default defineConfig({
  test: {
    include: ["tests/ui-dom/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: { enabled: false },
    reporters: ["verbose"],
  },
});
