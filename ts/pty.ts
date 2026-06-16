import { logger } from "./logger.ts";
import type { IPty as IPtyNode } from "node-pty";
import type { IPty as IPtyBun } from "bun-pty";
// its recommened to use bun-pty in windows, since node-pty is super complex to install there, requires a 10G M$ build tools

async function getPty(): Promise<typeof import("node-pty") | typeof import("bun-pty")> {
  return globalThis.Bun
    ? await import("bun-pty").catch((error) => {
        logger.error("Failed to load bun-pty:", error);
        throw error;
      })
    : await import("node-pty").catch((error) => {
        logger.error("Failed to load node-pty:", error);
        throw error;
      });
}
export type IPty = IPtyNode | IPtyBun;
type PtyModule = typeof import("node-pty") | typeof import("bun-pty");

// Loading node-pty/bun-pty pulls in a native addon. Failing here at import time
// would crash anything that merely imports this module's graph — including unit
// tests that never spawn a PTY (e.g. on a machine where the prebuilt binary is
// missing). So if the load fails, defer the error to first actual use: hand back
// a proxy that re-throws the original load error the moment `pty.spawn` (or any
// member) is touched. Production paths that do spawn still fail loudly, with the
// same error and the same `logger.error` already emitted by getPty().
let pty: PtyModule;
try {
  pty = await getPty();
} catch (error) {
  pty = new Proxy({} as PtyModule, {
    get() {
      throw error;
    },
  });
}
export const ptyPackage = globalThis.Bun ? "bun-pty" : "node-pty";
export default pty;
