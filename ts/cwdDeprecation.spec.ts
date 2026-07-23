import { describe, expect, it } from "vitest";
import { detectCwdDeprecation } from "./cwdDeprecation.ts";

// argv shape is [exec, script, ...userArgs]; the script's basename is the
// program name the user typed (cy/ay/claude-yes/…).
const argv = (script: string, ...user: string[]) => ["/usr/bin/bun", script, ...user];

describe("detectCwdDeprecation", () => {
  it("returns null when --cwd is absent", () => {
    expect(detectCwdDeprecation(argv("/x/dist/cy.js", "claude", "-p", "hi"))).toBeNull();
  });

  it("detects `--cwd DIR` and rebuilds the command without it", () => {
    const dep = detectCwdDeprecation(argv("/x/dist/cy.js", "claude", "--cwd", "/ws/app", "-p", "fix"));
    expect(dep).not.toBeNull();
    expect(dep!.dir).toBe("/ws/app");
    expect(dep!.suggestion).toBe("cd /ws/app && cy claude -p fix");
  });

  it("detects `--cwd=DIR` form", () => {
    const dep = detectCwdDeprecation(argv("/x/dist/agent-yes.js", "codex", "--cwd=/tmp/x"));
    expect(dep!.dir).toBe("/tmp/x");
    expect(dep!.suggestion).toBe("cd /tmp/x && agent-yes codex");
  });

  it("keeps a home-relative dir bare so the shell still expands ~", () => {
    const dep = detectCwdDeprecation(argv("/x/dist/cy.js", "--cwd", "~/ws/product"));
    expect(dep!.suggestion).toBe("cd ~/ws/product && cy");
  });

  it("preserves the prompt after `--` and quotes tokens with spaces", () => {
    // The shell splits `-- solve all todos` into one argv token per word.
    const dep = detectCwdDeprecation(
      argv("/x/dist/claude-yes.js", "--cwd", "/ws/app", "--", "solve", "all", "todos"),
    );
    // A single already-quoted token keeping its space is re-quoted for display.
    const dep2 = detectCwdDeprecation(
      argv("/x/dist/claude-yes.js", "--cwd", "/ws/app", "--", "a b"),
    );
    expect(dep!.suggestion).toBe("cd /ws/app && claude-yes -- solve all todos");
    expect(dep2!.suggestion).toBe("cd /ws/app && claude-yes -- 'a b'");
  });

  it("quotes a dir containing spaces", () => {
    const dep = detectCwdDeprecation(argv("/x/dist/cy.js", "--cwd", "/my ws/app"));
    expect(dep!.suggestion).toBe("cd '/my ws/app' && cy");
  });

  it("handles `--cwd` given as the last token with no value", () => {
    const dep = detectCwdDeprecation(argv("/x/dist/cy.js", "claude", "--cwd"));
    expect(dep).not.toBeNull();
    expect(dep!.dir).toBeUndefined();
    expect(dep!.suggestion).toBe("cd <dir> && cy claude");
  });

  it("includes the deprecation notice in the message", () => {
    const dep = detectCwdDeprecation(argv("/x/dist/cy.js", "--cwd", "/ws"));
    expect(dep!.message).toContain("--cwd is deprecated");
    expect(dep!.message).toContain("cd /ws && cy");
  });
});
