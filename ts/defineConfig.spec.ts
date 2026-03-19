import { describe, expect, it } from "vitest";
import { defineCliYesConfig } from "./defineConfig";

describe("defineCliYesConfig", () => {
  it("should return a plain config object", async () => {
    const cfg = await defineCliYesConfig({ clis: {} });
    expect(cfg).toEqual({ clis: {} });
  });

  it("should accept a function that receives the default config", async () => {
    const cfg = await defineCliYesConfig((original) => {
      expect(original).toEqual({ clis: {} });
      return { ...original, clis: { claude: { bin: "claude" } } };
    });
    expect(cfg.clis).toHaveProperty("claude");
  });

  it("should accept an async function", async () => {
    const cfg = await defineCliYesConfig(async () => {
      return { clis: { test: { bin: "test-cli" } } };
    });
    expect(cfg.clis.test).toEqual({ bin: "test-cli" });
  });

  it("should accept a promise", async () => {
    const cfg = await defineCliYesConfig(Promise.resolve({ clis: {} }));
    expect(cfg).toEqual({ clis: {} });
  });
});
