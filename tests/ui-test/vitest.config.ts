import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/ui-test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    coverage: { enabled: false },
    reporters: ["verbose"],
  },
});
