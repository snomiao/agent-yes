import { describe, expect, it } from "vitest";
import { daemonShareRuntime, planRustServe } from "./serveRust.ts";

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
    // Any room link spelling reaches ayrs as webrtc://; a non-link stays on TS.
    expect(planRustServe(["--webrtc", "https://agent-yes.com/room/#room=r1&s=e1.ab"], env)).toEqual(
      { kind: "rust", argv: ["serve", "--webrtc", "webrtc://r1:e1.ab@s.agent-yes.com"] },
    );
    expect(planRustServe(["--webrtc", "nonsense"], env)).toMatchObject({
      kind: "ts",
      reason: expect.stringContaining("not a room link"),
    });
    // Joining a room as a member is ayrs-only, and needs the room.
    expect(planRustServe(["--webrtc", "webrtc://r1:e1.ab@s.example", "--join"], env)).toEqual({
      kind: "rust-only",
      argv: ["serve", "--webrtc", "webrtc://r1:e1.ab@s.example", "--join"],
      feature: "--join",
    });
    expect(planRustServe(["--webrtc", "--join"], env)).toMatchObject({ kind: "ts" });
    expect(planRustServe(["join-secret"], env)).toEqual({
      kind: "rust-only",
      argv: ["serve", "join-secret"],
      feature: "join-secret",
    });
    expect(planRustServe(["join-secret", "--webrtc", "webrtc://r1:e1.ab@s.example"], env)).toEqual({
      kind: "rust-only",
      argv: ["serve", "--webrtc", "webrtc://r1:e1.ab@s.example", "join-secret"],
      feature: "join-secret",
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

// Every printed share link must come from the room file of the runtime that
// hosts the room: ayrs persists its room in .share-room-ayrs, TS in .share-room.
// A link derived from the wrong file points at a room nobody serves.
describe("daemonShareRuntime", () => {
  const env = {};
  const ayrs = () => true;
  const noAyrs = () => false;

  it("is rust for the args ayrs serve accepts, when the binary exists", () => {
    expect(daemonShareRuntime(["--webrtc"], ayrs, env)).toBe("rust");
    expect(daemonShareRuntime(["--webrtc", "--sighost", "s.example"], ayrs, env)).toBe("rust");
    expect(daemonShareRuntime(["--webrtc", "--port", "0"], ayrs, env)).toBe("rust");
  });

  it("is ts whenever cmdServe would fall back to the TypeScript host", () => {
    expect(daemonShareRuntime(["--webrtc"], noAyrs, env)).toBe("ts");
    expect(daemonShareRuntime(["--webrtc", "--no-rust"], ayrs, env)).toBe("ts");
    expect(daemonShareRuntime(["--webrtc"], ayrs, { AGENT_YES_NO_RUST: "1" })).toBe("ts");
    expect(daemonShareRuntime(["--share"], ayrs, env)).toBe("ts");
    expect(daemonShareRuntime([], ayrs, env)).toBe("ts");
  });
});
