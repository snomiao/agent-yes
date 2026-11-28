import { describe, expect, it } from "vitest";
import {
  daemonShareRuntime,
  ensureDaemonShareRuntime,
  iceEnv,
  joinRefusal,
  planRustServe,
} from "./serveRust.ts";
import { planDaemonArgs } from "./shareCore.ts";

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
    for (const sub of [
      "install",
      "uninstall",
      "status",
      "logs",
      "start",
      "stop",
      "restart",
      "healthcheck",
    ]) {
      expect(planRustServe([sub, "--webrtc"], env)).toMatchObject({
        kind: "ts",
        reason: `\`ay serve ${sub}\``,
      });
    }
  });

  it("drops --http and a loopback --host next to --port: ayrs's port IS that console", () => {
    // What `ay share webrtc` registers over an HTTP daemon.
    expect(planRustServe(["--port", "7432", "--http", "--webrtc"], env)).toEqual({
      kind: "rust",
      argv: ["serve", "--port", "7432", "--webrtc"],
    });
    expect(
      planRustServe(["--webrtc", "--http", "--host", "127.0.0.1", "--port=7432"], env),
    ).toEqual({ kind: "rust", argv: ["serve", "--webrtc", "--port", "7432"] });
    expect(planRustServe(["--host=localhost", "--port", "1"], env)).toEqual({
      kind: "rust",
      argv: ["serve", "--port", "1"],
    });
  });

  it("falls back, naming the flag, on anything ayrs cannot express", () => {
    expect(planRustServe(["--share"], env)).toMatchObject({ kind: "ts", reason: "--share" });
    // --http without a port is the Portless console, which ayrs lacks.
    expect(planRustServe(["--webrtc", "--http"], env)).toMatchObject({
      kind: "ts",
      reason: "--http without --port (Portless HTTPS console)",
    });
    expect(planRustServe(["-d", "--webrtc"], env)).toMatchObject({ kind: "ts", reason: "-d" });
    // ayrs listens on loopback only.
    expect(planRustServe(["--port", "0", "--host", "0.0.0.0"], env)).toMatchObject({
      kind: "ts",
      reason: "--host 0.0.0.0 (ayrs listens on loopback only)",
    });
    expect(
      planRustServe(["--webrtc", "--http", "--host", "100.64.0.1", "--port", "7432"], env),
    ).toMatchObject({ kind: "ts", reason: "--host 100.64.0.1 (ayrs listens on loopback only)" });
    expect(planRustServe(["--host", "127.0.0.1"], env)).toMatchObject({ kind: "ts" });
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
    // bare --webrtc: ayrs reads the link from AY_ROOM_URL / AY_ROOM
    expect(planRustServe(["--webrtc", "--join"], env)).toEqual({
      kind: "rust-only",
      argv: ["serve", "--webrtc", "--join"],
      feature: "--join",
    });
    expect(planRustServe(["--join"], env)).toMatchObject({ kind: "ts" });
    expect(planRustServe(["join-secret", "--new"], env)).toEqual({
      kind: "rust-only",
      argv: ["serve", "join-secret", "--new"],
      feature: "join-secret",
    });
    expect(planRustServe(["join-secret", "--new", "--sighost", "s.example"], env)).toEqual({
      kind: "rust-only",
      argv: ["serve", "--sighost", "s.example", "join-secret", "--new"],
      feature: "join-secret",
    });
    expect(
      planRustServe(["join-secret", "--new", "--webrtc", "webrtc://r1:e1.ab@s.example"], env),
    ).toMatchObject({ kind: "ts" });
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
    // `ay share webrtc` over an HTTP daemon keeps HTTP with --http; that must
    // not pin the room to the TypeScript host.
    expect(daemonShareRuntime(planDaemonArgs(["--port", "9000"], "webrtc"), ayrs, env)).toBe(
      "rust",
    );
  });

  it("is ts whenever cmdServe would fall back to the TypeScript host", () => {
    expect(daemonShareRuntime(["--webrtc"], noAyrs, env)).toBe("ts");
    expect(daemonShareRuntime(["--webrtc", "--no-rust"], ayrs, env)).toBe("ts");
    expect(daemonShareRuntime(["--webrtc"], ayrs, { AGENT_YES_NO_RUST: "1" })).toBe("ts");
    expect(daemonShareRuntime(["--share"], ayrs, env)).toBe("ts");
    expect(daemonShareRuntime([], ayrs, env)).toBe("ts");
  });
});

// The first `ay share webrtc` on a fresh box: ayrs is not downloaded yet, but
// the daemon about to start fetches it and hosts the Rust room. The minting
// side must fetch too, or it prints the TS room's link (a room nobody hosts).
describe("ensureDaemonShareRuntime", () => {
  const env = {};

  it("fetches ayrs before deciding, so a fresh install mints the Rust room", async () => {
    let fetched = 0;
    const ensure = async () => (fetched++, "/bin/ayrs");
    expect(await ensureDaemonShareRuntime(["--webrtc"], ensure, env)).toBe("rust");
    expect(fetched).toBe(1);
  });

  it("is ts when the fetch finds nothing, and never fetches for a TS-only daemon", async () => {
    expect(await ensureDaemonShareRuntime(["--webrtc"], async () => undefined, env)).toBe("ts");
    let fetched = 0;
    const ensure = async () => (fetched++, "/bin/ayrs");
    expect(await ensureDaemonShareRuntime(["--webrtc", "--no-rust"], ensure, env)).toBe("ts");
    expect(await ensureDaemonShareRuntime(["--share"], ensure, env)).toBe("ts");
    expect(fetched).toBe(0);
  });
});

// A host behind NAT (a Docker container) needs the address viewers reach it
// at. The flags ride in the daemon's args (so `ay serve install` persists
// them) and reach ayrs as the env it reads.
describe("--ice-public-ip / --ice-udp-port", () => {
  const env = {};

  it("delegate to ayrs with the ICE settings split off the argv", () => {
    const plan = planRustServe(
      [
        "--webrtc",
        "--ice-public-ip",
        "auto",
        "--ice-public-ip=192.0.2.10,100.64.0.7",
        "--ice-udp-port",
        "47000",
      ],
      env,
    );
    expect(plan).toEqual({
      kind: "rust",
      argv: ["serve", "--webrtc"],
      ice: { publicIps: ["auto", "192.0.2.10", "100.64.0.7"], udpPort: "47000" },
    });
  });

  it("fall back with a reason on a bad value or without --webrtc", () => {
    expect(planRustServe(["--webrtc", "--ice-public-ip", "box.local"], env).kind).toBe("ts");
    expect(planRustServe(["--webrtc", "--ice-public-ip", "300.1.1.1"], env).kind).toBe("ts");
    expect(planRustServe(["--webrtc", "--ice-udp-port", "0"], env).kind).toBe("ts");
    expect(planRustServe(["--webrtc", "--ice-udp-port"], env).kind).toBe("ts");
    expect(planRustServe(["--port", "9000", "--ice-udp-port", "47000"], env).kind).toBe("ts");
  });

  it("auto adds the tailnet IPv4 when tailscale has one", () => {
    expect(iceEnv({ publicIps: ["auto"], udpPort: "47000" }, () => "100.64.0.7")).toEqual({
      AGENT_YES_ICE_PUBLIC_IPS: "auto,100.64.0.7",
      AGENT_YES_ICE_UDP_PORT: "47000",
    });
    expect(iceEnv({ publicIps: ["AUTO"] }, () => undefined)).toEqual({
      AGENT_YES_ICE_PUBLIC_IPS: "auto",
    });
    expect(iceEnv({ publicIps: ["100.64.0.7", "auto"] }, () => "100.64.0.7")).toEqual({
      AGENT_YES_ICE_PUBLIC_IPS: "100.64.0.7,auto",
    });
    expect(iceEnv(undefined, () => "100.64.0.7")).toEqual({});
  });
});

// Only ayrs hosts as a room member, so a join the TypeScript side would run is
// refused. A daemon install only registers flags, and its daemon plans them
// again on start: `ay serve install --webrtc <link> --join` must go through.
describe("joinRefusal", () => {
  const env = {};
  const link = "webrtc://r1:e1.ab@s.example";

  it("lets a daemon install of a room join through, in both forms", () => {
    expect(joinRefusal(["install", "--webrtc", link, "--join", "--port", "7432"], env)).toBeNull();
    expect(joinRefusal(["--webrtc", link, "--join", "-d"], env)).toBeNull();
    expect(joinRefusal(["--daemon", "--webrtc", link, "--join"], env)).toBeNull();
  });

  it("refuses a daemon install whose flags would not run on ayrs", () => {
    expect(joinRefusal(["install", "--webrtc", "--join"], env)).toBe(
      "--join needs --webrtc <room link>",
    );
    expect(joinRefusal(["install", "--webrtc", link, "--join", "--token", "t"], env)).toBe(
      "--token",
    );
    expect(joinRefusal(["install", "--no-rust", "--webrtc", link, "--join"], env)).toBe(
      "--no-rust",
    );
    expect(joinRefusal(["install", "--webrtc", link, "--join"], { AGENT_YES_NO_RUST: "1" })).toBe(
      "AGENT_YES_NO_RUST=1",
    );
  });

  it("refuses a foreground join the TypeScript server would run", () => {
    expect(joinRefusal(["--no-rust", "--webrtc", link, "--join"], env)).toBe("--no-rust");
    expect(joinRefusal(["join-secret", "--port", "1"], env)).toContain("join-secret");
  });

  it("has nothing to say without a join", () => {
    expect(joinRefusal(["install", "--webrtc", link], env)).toBeNull();
    expect(joinRefusal(["--no-rust", "--webrtc", link], env)).toBeNull();
  });
});
