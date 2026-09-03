import { describe, expect, it } from "bun:test";
import { SEND_BODY_MAX_CHARS, sendPayloadCapError } from "./subcommands.ts";

describe("sendPayloadCapError", () => {
  it("measures the cap on the TRANSMITTED payload, not the body alone", () => {
    // The defect: a body under the cap was accepted and then transmitted with a
    // ~134-char envelope on top, so the enforced number was never the sent one.
    const body = SEND_BODY_MAX_CHARS - 50;
    expect(sendPayloadCapError(body, 0)).toBeNull();
    expect(sendPayloadCapError(body, 134)).toContain("would transmit");
  });

  it("passes a send that fits once the envelope is counted", () => {
    expect(sendPayloadCapError(SEND_BODY_MAX_CHARS - 134, 134)).toBeNull();
    expect(sendPayloadCapError(SEND_BODY_MAX_CHARS, 0)).toBeNull();
  });

  it("names the sender's real budget, which depends on their own envelope", () => {
    // The envelope carries the sender's cwd, branch and pid, so no constant
    // body budget can be quoted — it has to be computed per send.
    const short = sendPayloadCapError(SEND_BODY_MAX_CHARS, 100)!;
    const long = sendPayloadCapError(SEND_BODY_MAX_CHARS, 200)!;
    expect(short).toContain(`${SEND_BODY_MAX_CHARS - 100} chars of body`);
    expect(long).toContain(`${SEND_BODY_MAX_CHARS - 200} chars of body`);
  });

  it("reports the split so the sender can see where the overflow came from", () => {
    const err = sendPayloadCapError(1000, 134)!;
    expect(err).toContain("1134");
    expect(err).toContain("1000 of body");
    expect(err).toContain("134 of <ay-msg");
  });

  it("says nothing about an envelope when there is none", () => {
    // --raw and slash commands go out unwrapped; the whole cap is theirs.
    const err = sendPayloadCapError(SEND_BODY_MAX_CHARS + 1, 0)!;
    expect(err).not.toContain("envelope");
    expect(err).toContain(`≤${SEND_BODY_MAX_CHARS} chars`);
  });

  it("still points at the remedy that works — a path, not `-`", () => {
    const err = sendPayloadCapError(5000, 0)!;
    expect(err).toContain("the PATH");
    expect(err).toMatch(/'-' hits this same/);
  });

  it("never quotes a negative budget for an envelope larger than the cap", () => {
    const err = sendPayloadCapError(1, SEND_BODY_MAX_CHARS + 500)!;
    expect(err).toContain("≤0 chars");
  });
});
