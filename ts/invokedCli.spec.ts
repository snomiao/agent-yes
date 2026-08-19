import { describe, expect, it } from "vitest";
import { invokedCliName } from "./invokedCli.ts";

// argv[1] is the invoked binary path; argv[0] is the runtime (node/bun).
const argv = (bin: string) => ["/usr/bin/bun", bin];

describe("invokedCliName", () => {
  it("resolves cli-bound aliases to their agent", () => {
    expect(invokedCliName(argv("/root/.bun/bin/cy"))).toBe("claude");
    expect(invokedCliName(argv("/usr/local/bin/claude-yes"))).toBe("claude");
    expect(invokedCliName(argv("/usr/local/bin/codex-yes"))).toBe("codex");
    expect(invokedCliName(argv("gemini-yes"))).toBe("gemini");
  });

  it("returns undefined for the generic manager entry", () => {
    expect(invokedCliName(argv("/root/.bun/bin/ay"))).toBeUndefined();
    expect(invokedCliName(argv("/usr/local/bin/agent-yes"))).toBeUndefined();
    expect(invokedCliName(argv("/path/to/cli"))).toBeUndefined();
  });

  it("ignores the .js / .ts extension the wrapper bins carry", () => {
    expect(invokedCliName(argv("/app/dist/cy.js"))).toBe("claude");
    expect(invokedCliName(argv("/app/dist/codex-yes.js"))).toBe("codex");
    expect(invokedCliName(argv("/app/dist/agent-yes.js"))).toBeUndefined();
  });

  it("is undefined when argv[1] is missing", () => {
    expect(invokedCliName(["/usr/bin/bun"])).toBeUndefined();
  });
});
