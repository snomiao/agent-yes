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
const pty = await getPty();
export const ptyPackage = globalThis.Bun ? "bun-pty" : "node-pty";
export default pty;
