/**
 * The `ay notifyd` singleton lock's owner heartbeat, run on its OWN thread.
 *
 * Why a thread: the daemon proves it is alive by refreshing `ts` in the lock's
 * `owner.json`; another `ay notify watch` steals the lock once that stamp is
 * older than `OWNER_TTL`. On a single-threaded JS timer, a SYNCHRONOUS block in
 * the daemon longer than the TTL would stall the heartbeat, let a second daemon
 * take the lock, and leave two daemons writing the same inboxes. The loop is all
 * `await`s and the TTL sits far above any realistic block, so that was always
 * theoretical — but a single-threaded process can only bound it, never eliminate
 * it. A worker thread does: its timer keeps firing no matter what the main
 * thread is doing.
 *
 * The worker owns the whole beat (read token → verify → atomic rewrite), so a
 * blocked main thread contributes nothing to keeping the lock alive. The owner
 * payload is fixed for the daemon's lifetime — only `ts` moves — so there is no
 * state to synchronize back.
 *
 * FENCING is preserved exactly as on the main thread: the beat refreshes only
 * while `owner.json` still carries OUR token. Any other value — a different
 * token (superseded) or none (another daemon's mkdir→write window) — means we no
 * longer own the lock, so it stops rather than clobber an owner that isn't ours.
 *
 * Deliberately one-way: the beat never signals the daemon. Deciding to shut down
 * stays with the daemon loop, which already re-reads the owner token every tick
 * and exits when it isn't ours. Adding a second, cross-thread path to the same
 * decision would only create a way for the two to disagree.
 *
 * The worker source is passed inline (`eval: true`) rather than shipped as a
 * separate file: it needs no bundler entry, no dist path resolution, and works
 * identically under both `bun` and `node` (verified on both).
 *
 * Falls back to a main-thread timer if a Worker can't be created for any reason,
 * so this can only ever be as good as the previous behaviour — never worse.
 *
 * Issue #169 item 5.
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
// Static, not `require`: this module is ESM, where `require` is undefined — a
// lazy require would throw every time and silently pin us to the fallback.
// `node:worker_threads` is a builtin present in both bun and node.
import { Worker } from "node:worker_threads";

export interface OwnerHeartbeat {
  /** Stop beating and release the thread. */
  stop(): Promise<void>;
  /** True when the beat runs on its own thread (false = main-thread fallback). */
  isolated: boolean;
}

export interface OwnerHeartbeatOptions {
  /** Path of the lock's owner.json. */
  ownerPath: string;
  /** Our fencing token; the beat stops if the owner stops carrying it. */
  token: string;
  /** Fixed owner fields; the beat rewrites these with a fresh `ts`. */
  payload: Record<string, unknown>;
  intervalMs: number;
}

// Kept as a string so it can be handed to `new Worker(src, { eval: true })`.
// CommonJS `require` is used deliberately: it is what both bun and node accept
// inside an eval'd worker without any module-type negotiation.
const WORKER_SRC = `
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { ownerPath, token, payload, intervalMs } = workerData;

function currentToken() {
  try {
    return JSON.parse(fs.readFileSync(ownerPath, "utf8")).token ?? null;
  } catch {
    return null;
  }
}

function beat() {
  if (currentToken() !== token) return false;
  // Atomic (write temp + rename), so a concurrent reader never sees a torn owner
  // and a null read reliably means "no owner file" rather than "write in flight".
  const tmp = ownerPath + "." + token + ".beat.tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, payload, { ts: Date.now() })));
    fs.renameSync(tmp, ownerPath);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
  return true;
}

const timer = setInterval(() => {
  if (!beat()) clearInterval(timer);
}, intervalMs);
`;

/**
 * Main-thread fallback with identical semantics, used when a Worker can't be
 * created. Exported so the specs can exercise it directly on every platform —
 * it is the path that runs on any runtime where worker threads are unavailable.
 */
export function startInlineHeartbeat(opts: OwnerHeartbeatOptions): OwnerHeartbeat {
  const timer = setInterval(() => {
    // SYNCHRONOUS check-then-write, exactly like the worker. An `await` between
    // reading the token and rewriting the file is a TOCTOU: the lock can be
    // stolen (or removed by `notifyd stop`) in that gap, and the write would then
    // resurrect an owner file we no longer own — re-asserting a lock that now
    // belongs to another daemon, and making the removal invisible to us. The file
    // is a few dozen bytes written every OWNER_TTL/3, so blocking is immaterial.
    let cur: string | null = null;
    try {
      cur = (JSON.parse(readFileSync(opts.ownerPath, "utf8")) as { token?: string }).token ?? null;
    } catch {
      cur = null;
    }
    if (cur !== opts.token) {
      clearInterval(timer);
      return;
    }
    const tmp = `${opts.ownerPath}.${opts.token}.beat.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ ...opts.payload, ts: Date.now() }));
      renameSync(tmp, opts.ownerPath);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to clean up */
      }
    }
  }, opts.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return {
    isolated: false,
    stop: async () => {
      clearInterval(timer);
    },
  };
}

/** Upper bound on how long stop() waits for the worker thread to go away. Far
 *  longer than a terminate needs; short enough that shutdown never looks wedged.
 *  Overshooting only leaks an already-unref'd thread that cannot hold the
 *  process open. */
const STOP_TIMEOUT_MS = 2_000;

export function startOwnerHeartbeat(opts: OwnerHeartbeatOptions): OwnerHeartbeat {
  try {
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: {
        ownerPath: opts.ownerPath,
        token: opts.token,
        payload: opts.payload,
        intervalMs: opts.intervalMs,
      },
    });
    // A heartbeat thread must never be the reason the process stays up, and a
    // worker error must never crash the daemon — it just means we're back to
    // relying on the main loop's own token check.
    worker.on("error", () => {});
    if (typeof worker.unref === "function") worker.unref();

    // The worker EXITS ON ITS OWN whenever fencing fails: losing the token
    // clears its interval, which drains its event loop. That is the normal,
    // expected end for a superseded beat — so by the time anyone calls stop(),
    // the thread is very often already gone, and `terminate()` on an
    // already-exited worker does not reliably settle (it hangs under bun).
    // Track the exit and race it, with a bounded fallback, so stop() ALWAYS
    // resolves: it is awaited on the daemon's shutdown path, where hanging would
    // wedge the process instead of merely leaking a thread.
    let exited = false;
    const exitedPromise = new Promise<void>((resolve) => {
      worker.once("exit", () => {
        exited = true;
        resolve();
      });
    });
    return {
      isolated: true,
      stop: async () => {
        if (exited) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STOP_TIMEOUT_MS);
          if (typeof timer.unref === "function") timer.unref();
        });
        try {
          await Promise.race([
            worker.terminate().then(
              () => {},
              () => {},
            ),
            exitedPromise,
            timeout,
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    };
  } catch {
    return startInlineHeartbeat(opts);
  }
}
