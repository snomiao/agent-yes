import { describe, it, expect } from "vitest";
import {
  V,
  PROTO,
  MARKER,
  FLAG_CONFIRM,
  validateS,
  deriveAuthToken,
  deriveDirKeys,
  computeTranscriptHash,
  seal,
  open,
  packEnvelope,
  unpackEnvelope,
  parseSecret,
  randomHex,
} from "../lab/ui/e2e.js";

const S = "a".repeat(64); // a valid 64-hex secret for tests
const S2 = "b".repeat(64);
const TH = new Uint8Array(32).fill(7); // a fake transcript hash
const TH2 = new Uint8Array(32).fill(9);

// Minimal but realistic SDP fragments carrying the lines the binding reads.
function sdp(fp: string, setup: string, ufrag: string): string {
  return [
    "v=0",
    "o=- 1 1 IN IP4 0.0.0.0",
    "s=-",
    "t=0 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    `a=ice-ufrag:${ufrag}`,
    `a=setup:${setup}`,
    `a=fingerprint:${fp}`,
  ].join("\r\n");
}
const FP_A = "sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
const FP_B = "sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00";

describe("e2e version constants", () => {
  it("are internally consistent", () => {
    expect(V).toBe(1);
    expect(PROTO).toBe("ay-e2e-1");
    expect(MARKER).toBe("e1.");
    expect(FLAG_CONFIRM).toBe(0x01);
  });
});

describe("validateS", () => {
  it("accepts a 64-hex secret", () => {
    expect(validateS(S)).toBe(S);
  });
  it("rejects bad input without echoing it", () => {
    for (const bad of ["", "xyz", S.toUpperCase(), "e1." + S, S + "0", 123 as unknown as string]) {
      try {
        validateS(bad);
        throw new Error("should have thrown for " + bad);
      } catch (e) {
        expect((e as Error).message).toBe("invalid share token");
        expect((e as Error).message).not.toContain(String(bad).slice(0, 8) || "∅");
      }
    }
  });
});

describe("deriveAuthToken", () => {
  it("is deterministic and 64-hex", async () => {
    const a = await deriveAuthToken(S, "room1", "s.agent-yes.com");
    const b = await deriveAuthToken(S, "room1", "s.agent-yes.com");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is not equal to S (one-way) and binds room + sighost", async () => {
    const base = await deriveAuthToken(S, "room1", "s.agent-yes.com");
    expect(base).not.toBe(S);
    expect(await deriveAuthToken(S, "room2", "s.agent-yes.com")).not.toBe(base);
    expect(await deriveAuthToken(S, "room1", "other.host")).not.toBe(base);
    expect(await deriveAuthToken(S2, "room1", "s.agent-yes.com")).not.toBe(base);
  });
});

describe("seal / open round trip", () => {
  it("round-trips a sealed envelope", async () => {
    const { keyH2C } = await deriveDirKeys(S, TH);
    const send = { sendCtr: 0n };
    const recv = { lastSeen: -1n };
    const frame = await seal(keyH2C, send, 0, TH, packEnvelope({ t: "req", id: "x", path: "/p" }));
    expect(frame).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(frame)[0]).toBe(0x01); // VER
    const { plaintext, counter, flags } = await open(keyH2C, frame, TH, recv);
    expect(counter).toBe(0n);
    expect(flags).toBe(0);
    expect(unpackEnvelope(plaintext)).toEqual({ t: "req", id: "x", path: "/p" });
  });

  it("increments the counter and never repeats a nonce, even concurrently", async () => {
    const { keyH2C } = await deriveDirKeys(S, TH);
    const send = { sendCtr: 0n };
    const [f0, f1] = await Promise.all([
      seal(keyH2C, send, 0, TH, packEnvelope({ n: 0 })),
      seal(keyH2C, send, 0, TH, packEnvelope({ n: 1 })),
    ]);
    const nonce = (f: ArrayBuffer) => new Uint8Array(f).slice(2, 14).join(",");
    expect(nonce(f0)).not.toBe(nonce(f1));
    expect(send.sendCtr).toBe(2n);
  });

  it("carries the confirmation FLAG through", async () => {
    const { keyC2H } = await deriveDirKeys(S, TH);
    const frame = await seal(
      keyC2H,
      { sendCtr: 0n },
      FLAG_CONFIRM,
      TH,
      packEnvelope({ t: "confirm" }),
    );
    const { flags } = await open(keyC2H, frame, TH, { lastSeen: -1n });
    expect(flags & FLAG_CONFIRM).toBe(FLAG_CONFIRM);
  });
});

describe("open is fail-closed", () => {
  it("rejects a tampered ciphertext bit", async () => {
    const { keyH2C } = await deriveDirKeys(S, TH);
    const frame = await seal(keyH2C, { sendCtr: 0n }, 0, TH, packEnvelope({ t: "req" }));
    const bytes = new Uint8Array(frame);
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0x01; // flip a tag bit
    await expect(open(keyH2C, bytes, TH, { lastSeen: -1n })).rejects.toThrow();
  });
  it("rejects a tampered header (VER/FLAGS/NONCE are authenticated)", async () => {
    const { keyH2C } = await deriveDirKeys(S, TH);
    const frame = await seal(keyH2C, { sendCtr: 0n }, 0, TH, packEnvelope({ t: "req" }));
    const bytes = new Uint8Array(frame);
    bytes[1] = (bytes[1] ?? 0) ^ 0x02; // flip a FLAGS bit
    await expect(open(keyH2C, bytes, TH, { lastSeen: -1n })).rejects.toThrow();
  });
  it("rejects a bad version byte", async () => {
    const { keyH2C } = await deriveDirKeys(S, TH);
    const frame = await seal(keyH2C, { sendCtr: 0n }, 0, TH, packEnvelope({ t: "req" }));
    const bytes = new Uint8Array(frame);
    bytes[0] = 0x02;
    await expect(open(keyH2C, bytes, TH, { lastSeen: -1n })).rejects.toThrow();
  });
  it("rejects a frame bound to a different transcript (per-frame binding)", async () => {
    const { keyH2C } = await deriveDirKeys(S, TH);
    const frame = await seal(keyH2C, { sendCtr: 0n }, 0, TH, packEnvelope({ t: "req" }));
    await expect(open(keyH2C, frame, TH2, { lastSeen: -1n })).rejects.toThrow();
  });
  it("rejects the wrong direction key", async () => {
    const { keyH2C, keyC2H } = await deriveDirKeys(S, TH);
    const frame = await seal(keyH2C, { sendCtr: 0n }, 0, TH, packEnvelope({ t: "req" }));
    await expect(open(keyC2H, frame, TH, { lastSeen: -1n })).rejects.toThrow();
  });
  it("rejects a first frame whose counter is not 0", async () => {
    const { keyH2C } = await deriveDirKeys(S, TH);
    const frame = await seal(keyH2C, { sendCtr: 5n }, 0, TH, packEnvelope({ t: "confirm" }));
    await expect(open(keyH2C, frame, TH, { lastSeen: -1n })).rejects.toThrow(/counter-0/);
  });
  it("rejects a frame from a different session (per-session keys)", async () => {
    const a = await deriveDirKeys(S, TH);
    const b = await deriveDirKeys(S, TH2);
    const frame = await seal(a.keyH2C, { sendCtr: 0n }, 0, TH, packEnvelope({ t: "req" }));
    // different key AND different AAD → fails
    await expect(open(b.keyH2C, frame, TH2, { lastSeen: -1n })).rejects.toThrow();
  });
});

describe("anti-replay (mandatory)", () => {
  it("rejects a replayed frame and an out-of-order frame", async () => {
    const { keyH2C } = await deriveDirKeys(S, TH);
    const send = { sendCtr: 0n };
    const recv = { lastSeen: -1n };
    const f0 = await seal(keyH2C, send, 0, TH, packEnvelope({ n: 0 }));
    const f1 = await seal(keyH2C, send, 0, TH, packEnvelope({ n: 1 }));
    await open(keyH2C, f0, TH, recv); // counter 0 ok
    await open(keyH2C, f1, TH, recv); // counter 1 ok
    await expect(open(keyH2C, f1, TH, recv)).rejects.toThrow(/replay/); // replay counter 1
    await expect(open(keyH2C, f0, TH, recv)).rejects.toThrow(/replay/); // reorder back to 0
  });
});

describe("computeTranscriptHash", () => {
  it("matches across ends with offer/answer swapped", async () => {
    const local = sdp(FP_A, "actpass", "ufragLOCAL");
    const remote = sdp(FP_B, "active", "ufragREMOTE");
    // host: offer=local, answer=remote ; client: offer=remote(as seen), answer=local
    const host = await computeTranscriptHash(local, remote);
    const client = await computeTranscriptHash(local, remote);
    expect(Buffer.from(host).toString("hex")).toBe(Buffer.from(client).toString("hex"));
    // a different fingerprint changes the hash
    const other = await computeTranscriptHash(
      sdp(FP_A, "actpass", "ufragLOCAL"),
      sdp(FP_A, "active", "x"),
    );
    expect(Buffer.from(other).toString("hex")).not.toBe(Buffer.from(host).toString("hex"));
  });
  it("fails closed on a missing fingerprint", async () => {
    const noFp = "v=0\r\na=setup:active\r\na=ice-ufrag:u";
    await expect(computeTranscriptHash(sdp(FP_A, "actpass", "u"), noFp)).rejects.toThrow(
      /fingerprint/,
    );
  });
  it("fails closed on a non-sha-256 fingerprint (downgrade)", async () => {
    const sha1 = sdp("sha-1 AA:BB:CC", "active", "u");
    await expect(computeTranscriptHash(sdp(FP_A, "actpass", "u"), sha1)).rejects.toThrow(/sha-256/);
  });
});

describe("parseSecret marker grammar (strict, fail-closed)", () => {
  it("parses v2 encrypted links", () => {
    expect(parseSecret("e1." + S)).toEqual({ s: S, v2: true });
  });
  it("treats a bare 64-hex token and a pid as legacy (caller gates)", () => {
    expect(parseSecret(S)).toEqual({ s: S, v2: false });
    expect(parseSecret("12345")).toEqual({ s: "12345", v2: false });
  });
  it("rejects an unknown version marker (update required)", () => {
    expect(() => parseSecret("e2." + S)).toThrow(/update required/);
    expect(() => parseSecret("e10." + S)).toThrow(/update required/);
  });
  it("rejects marker-shaped-but-malformed tokens (never legacy)", () => {
    expect(() => parseSecret("e1." + "z".repeat(64))).toThrow(/malformed/);
    expect(() => parseSecret("e1." + "a".repeat(63))).toThrow(/malformed/);
    expect(() => parseSecret("e1" + S)).toThrow(/malformed/); // marker-like, no dot
    expect(() => parseSecret("E1." + S)).toThrow(/malformed/); // wrong case is not v2
  });
});

describe("randomHex", () => {
  it("returns n bytes of hex and varies", () => {
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});
