// Types for the shared WebCrypto e2e module (lab/ui/e2e.js), so the host
// (ts/share.ts, lab/ui/share-host.ts) can import it under TypeScript.

export const V: number;
export const PROTO: string;
export const MARKER: string;
export const MAX_CHUNK: number;
export const CONFIRM_TIMEOUT_MS: number;
export const ALLOW_LEGACY_PLAINTEXT: boolean;
export const FLAG_CONFIRM: number;

export interface SendState {
  sendCtr: bigint;
}
export interface RecvState {
  lastSeen: bigint;
}
export interface OpenResult {
  counter: bigint;
  flags: number;
  plaintext: Uint8Array;
}

export function validateS(s: string): string;
export function deriveAuthToken(s: string, room: string, sighost: string): Promise<string>;
export function deriveDirKeys(
  s: string,
  transcriptHash: Uint8Array,
): Promise<{ keyH2C: CryptoKey; keyC2H: CryptoKey }>;
export function computeTranscriptHash(offerSdp: string, answerSdp: string): Promise<Uint8Array>;
export function seal(
  key: CryptoKey,
  sendState: SendState,
  flags: number,
  transcriptHash: Uint8Array,
  plaintext: Uint8Array,
): Promise<ArrayBuffer>;
export function open(
  key: CryptoKey,
  frame: ArrayBuffer | Uint8Array,
  transcriptHash: Uint8Array,
  recvState: RecvState,
): Promise<OpenResult>;
export function packEnvelope(obj: unknown): Uint8Array;
export function unpackEnvelope(bytes: Uint8Array): any;
export function parseSecret(token: string): { s: string; v2: boolean };
export function randomHex(n: number): string;
