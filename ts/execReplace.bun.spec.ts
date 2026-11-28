import { describe, expect, it } from "bun:test";
import { execReplace } from "./execReplace.ts";

// The launcher replaces itself with the native binary (same pid) rather than
// staying resident as its parent.
describe("execReplace", () => {
  it("replaces the process: same pid, new image, env and args passed through", async () => {
    const script = `
      import { execReplace } from ${JSON.stringify(new URL("./execReplace.ts", import.meta.url).pathname)};
      console.log("before " + process.pid);
      const ok = execReplace("/bin/sh", ["-c", "echo after $$ $AY_X $0 $1", "zero", "one"], { AY_X: "env-ok", PATH: "/bin:/usr/bin" });
      console.log("still here " + ok);
    `;
    const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe" });
    const out = await new Response(p.stdout).text();
    const [before, after] = out.trim().split("\n");
    expect(after).toBeDefined();
    expect(after).not.toContain("still here");
    expect(after!.split(" ").slice(2).join(" ")).toBe("env-ok zero one");
    expect(after!.split(" ")[1]).toBe(before!.split(" ")[1]); // same pid
  });

  it("returns false when the target does not exist, so the caller can spawn instead", () => {
    expect(execReplace("/nonexistent/ay-binary", [])).toBe(false);
  });
});
