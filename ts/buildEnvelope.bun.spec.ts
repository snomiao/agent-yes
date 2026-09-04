import { describe, expect, it } from "bun:test";
import { buildEnvelope } from "./subcommands.ts";

const base = {
  nonce: "deadbeef",
  cli: "claude" as const,
  identity: "alice@box:/repo/alpha:main#1111",
  replyTarget: "24db968a3ab1",
  via: "env" as const,
};

describe("buildEnvelope", () => {
  it("wraps a local send with a reply route that works locally", () => {
    const { prefix, suffix } = buildEnvelope(base);
    expect(prefix).toContain("<ay-msg deadbeef from claude alice@box:/repo/alpha:main#1111");
    expect(prefix).toContain(`reply: ay send 24db968a3ab1 "..."`);
    expect(suffix).toBe("\n</ay-msg deadbeef>");
  });

  it("marks a message that crossed a host boundary", () => {
    // The receiver has to know the sender is not on its own host, because that
    // changes how it can answer.
    const { prefix } = buildEnvelope({ ...base, remote: { senderHost: "box" } });
    expect(prefix).toContain("via remote");
  });

  it("does NOT hand a remote receiver a bare local reply command", () => {
    // The regression that matters: the sender's agent id resolves on the
    // SENDER's host. A bare `ay send <id>` on the receiving side addresses
    // nothing there — or, worse, a local agent whose id shares the prefix.
    const { prefix } = buildEnvelope({ ...base, remote: { senderHost: "box" } });
    expect(prefix).not.toMatch(/reply: ay send 24db968a3ab1 "/);
    expect(prefix).toContain("24db968a3ab1"); // the id is still there to route to
    expect(prefix).toContain("box"); // and the host to route through
  });

  it("never puts a capability token in the envelope", () => {
    // The receiver's route back is its own to hold; the sender's token for the
    // far side would be a credential leak into a message body.
    const { prefix, suffix } = buildEnvelope({ ...base, remote: { senderHost: "box" } });
    for (const secret of ["tok", "Bearer", "token", "webrtc://"]) {
      expect(prefix + suffix).not.toContain(secret);
    }
  });

  it("carries the attribution strength through, remote or not", () => {
    // A weakly-attributed sender must not be laundered into a strong one by
    // crossing a host boundary.
    expect(buildEnvelope({ ...base, via: "ancestry" }).prefix).toContain("via process-tree");
    expect(
      buildEnvelope({ ...base, via: "env-uncorroborated", remote: { senderHost: "box" } }).prefix,
    ).toContain("UNCORROBORATED-SENDER");
  });

  it("closes with the same nonce it opened with", () => {
    // Nonce match, not tag syntax, is what makes the block's boundaries
    // unforgeable by text inside the body.
    const { prefix, suffix } = buildEnvelope({ ...base, remote: { senderHost: "box" } });
    expect(prefix).toContain("deadbeef");
    expect(suffix).toContain("deadbeef");
  });
});
