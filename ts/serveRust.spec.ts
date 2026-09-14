import { describe, expect, it } from "vitest";
import { planRustServe } from "./serveRust.ts";

// `ay serve` runs the Rust daemon (`ayrs serve`) by default, like `ay <cli>`
// runs the Rust agent runtime — but only for invocations ayrs can express.
// Everything else must stay on the TypeScript server WITH a reason, never a
// silent downgrade of the flags the operator passed.
describe("planRustServe", () => {
  const env = {};

  it("delegates the flags ayrs serve accepts, in both spellings", () => {
    expect(planRustServe(["--webrtc"], env)).toEqual({ kind: "rust", argv: ["serve", "--webrtc"] });
    expect(planRustServe(["--webrtc", "webrtc://r1:e1.ab@s.example"], env)).toEqual({
      kind: "rust",
      argv: ["serve", "--webrtc", "webrtc://r1:e1.ab@s.example"],
    });
    expect(planRustServe(["--webrtc=webrtc://r1:e1.ab@s.example", "--port=0"], env)).toEqual({
      kind: "rust",
      argv: ["serve", "--webrtc", "webrtc://r1:e1.ab@s.example", "--port", "0"],
    });
    expect(planRustServe(["--port", "4546", "--sighost", "s.example"], env)).toEqual({
      kind: "rust",
      argv: ["serve", "--port", "4546", "--sighost", "s.example"],
    });
    // A bare --webrtc followed by another flag does not swallow that flag.
    expect(planRustServe(["--webrtc", "--port", "0"], env)).toEqual({
      kind: "rust",
      argv: ["serve", "--webrtc", "--port", "0"],
    });
  });

  it("honours the explicit opt-outs and strips --no-rust for the TS parser", () => {
    expect(planRustServe(["--webrtc", "--no-rust"], env)).toEqual({
      kind: "ts",
      reason: "--no-rust",
      rest: ["--webrtc"],
    });
    expect(planRustServe(["--webrtc"], { AGENT_YES_NO_RUST: "1" })).toMatchObject({
      kind: "ts",
      reason: "AGENT_YES_NO_RUST=1",
    });
  });

  it("keeps the bare `ay serve` (Portless console) on TypeScript", () => {
    expect(planRustServe([], env)).toMatchObject({ kind: "ts", rest: [] });
  });

  it("never delegates the daemon subcommands — ayrs has its own supervisor", () => {
    for (const sub of ["install", "uninstall", "status", "logs", "start", "stop", "healthcheck"]) {
      expect(planRustServe([sub, "--webrtc"], env)).toMatchObject({
        kind: "ts",
        reason: `\`ay serve ${sub}\``,
      });
    }
  });

  it("falls back, naming the flag, on anything ayrs cannot express", () => {
    expect(planRustServe(["--share"], env)).toMatchObject({ kind: "ts", reason: "--share" });
    expect(planRustServe(["--webrtc", "--http"], env)).toMatchObject({
      kind: "ts",
      reason: "--http",
    });
    expect(planRustServe(["-d", "--webrtc"], env)).toMatchObject({ kind: "ts", reason: "-d" });
    expect(planRustServe(["--port", "0", "--host", "0.0.0.0"], env)).toMatchObject({
      kind: "ts",
      reason: "--host",
    });
    // ayrs pins a room by webrtc:// url only; an https room link stays on TS,
    // which knows how to normalise it.
    expect(
      planRustServe(["--webrtc", "https://agent-yes.com/room/#room=r1&s=e1.ab"], env),
    ).toMatchObject({
      kind: "ts",
      reason: expect.stringContaining("webrtc:// urls only"),
    });
    expect(planRustServe(["--port", "abc"], env)).toMatchObject({
      kind: "ts",
      reason: "--port abc",
    });
    expect(planRustServe(["--port"], env)).toMatchObject({
      kind: "ts",
      reason: "--port (missing)",
    });
  });
});
